import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { OrderStatus } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { JwtUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import { DriversService } from '../drivers/drivers.service';
import { RideEventsService } from '../events/ride-events.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { DriverLocationDto } from '../redis/dto/driver-location.dto';
import {
  AcceptDriverDto,
  CancelRideRequestDto,
  CancelTripDto,
  CreateRideRequestDto,
  NearbyRequestsQueryDto,
  PlaceBidDto,
  RideMessageDto,
  SubmitRatingDto,
  SubscribeDriverLocationDto,
  UpdateRideStageDto,
} from './dto/ride.dto';
import { RideService } from './ride.service';
import { driverRoom, driverWatchRoom, requestRoom, rideRoom, userRoom } from './ride.rooms';

interface SocketUser extends JwtUser {
  driverId?: string;
}

/**
 * ws://<host>/ride — authenticate with `auth: { token }` on connect.
 *
 * Acks use the same `{ code, message, data | error }` envelope as the REST API,
 * so a client can share one response handler across both transports.
 *
 * Every server-originated broadcast goes through the Redis Streams adapter, so
 * a passenger on instance A still receives events raised on instance B.
 */
@WebSocketGateway({
  namespace: '/ride',
  cors: { origin: '*' },
})
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class RideGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RideGateway.name);

  constructor(
    private jwt: JwtService,
    private prisma: PrismaService,
    private drivers: DriversService,
    private orders: OrdersService,
    private ride: RideService,
    private events: RideEventsService,
    private response: ResponsesService,
  ) {}

  /** Bridges the in-process event bus onto Socket.IO rooms. */
  afterInit() {
    this.events.on<any>('ride-request.created').subscribe(({ payload }) => {
      const { request, quote, matched } = payload;
      matched.forEach((driver: { driverId: string }) =>
        this.server.to(driverRoom(driver.driverId)).emit('ride-request', {
          requestId: request.id,
          vehicleType: request.vehicleType,
          pickup: { location: request.pickupLocation, lat: request.pickupLat, lng: request.pickupLng },
          dropoff: {
            location: request.dropoffLocation,
            lat: request.dropoffLat,
            lng: request.dropoffLng,
          },
          distanceKm: request.distanceKm,
          fare: quote.fare,
          expiresAt: request.expiresAt,
        }),
      );
    });

    this.events.on<any>('ride-request.bid').subscribe(({ payload }) => {
      this.server.to(userRoom(payload.request.userId)).emit('driver-bid-placed', payload.bid);
      this.server.to(requestRoom(payload.request.id)).emit('driver-bid-placed', payload.bid);
    });

    this.events.on<any>('ride-request.bid-accepted').subscribe(({ payload }) => {
      const { order } = payload;
      this.server.to(userRoom(order.userId)).emit('driver-accepted', order);
      if (order.driverId) this.server.to(driverRoom(order.driverId)).emit('driver-accepted', order);
    });

    this.events.on<any>('ride-request.expired').subscribe(({ payload }) => {
      if (payload) this.server.to(userRoom(payload.userId)).emit('ride-request-expired', payload);
    });

    this.events.on<any>('ride-request.cancelled').subscribe(({ payload }) => {
      payload.matchedDriverIds?.forEach((driverId: string) =>
        this.server.to(driverRoom(driverId)).emit('ride-request-cancelled', { requestId: payload.id }),
      );
    });

    ['order.created', 'order.accepted', 'order.status-changed', 'order.cancelled'].forEach((name) =>
      this.events.on<any>(name as any).subscribe(({ payload }) => this.broadcastOrder(payload)),
    );

    this.events.on<any>('order.message').subscribe(({ payload }) => {
      this.server.to(rideRoom(payload.orderId)).emit('new-message', payload);
    });

    this.logger.log('Ride gateway initialised');
  }

  private broadcastOrder(order: any) {
    const event = order.status === OrderStatus.CANCELLED ? 'trip-cancelled' : 'ride-stage-changed';
    this.server.to(rideRoom(order.id)).emit(event, order);
    this.server.to(userRoom(order.userId)).emit(event, order);
    if (order.driverId) this.server.to(driverRoom(order.driverId)).emit(event, order);
  }

  // ------------------------------------------------------------ lifecycle

  async handleConnection(client: Socket) {
    try {
      const token = extractToken(client);
      if (!token) throw new Error('Missing token');

      const payload = this.jwt.verify<JwtUser>(token, {
        secret: process.env.JWT_SECRET || 'rabi-secret-key',
      });

      const driver = await this.prisma.driver.findUnique({
        where: { userId: payload.sub },
        select: { id: true },
      });

      const user: SocketUser = { ...payload, driverId: driver?.id };
      client.data.user = user;

      await client.join(userRoom(user.sub));
      if (user.driverId) await client.join(driverRoom(user.driverId));

      // Rejoin the rooms of any trip still in flight so a reconnect is seamless.
      await this.joinActiveRides(client, user);

      client.emit(
        'connected',
        this.response.success({ userId: user.sub, driverId: user.driverId ?? null }, 'Connected'),
      );
    } catch (e: any) {
      this.logger.warn(`Rejected socket ${client.id}: ${e?.message}`);
      client.emit('connected', this.response.unauthorized('Invalid or missing token'));
      client.disconnect(true);
    }
  }

  private async joinActiveRides(client: Socket, user: SocketUser) {
    const active = await this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.ACCEPTED, OrderStatus.ARRIVED, OrderStatus.IN_PROGRESS] },
        OR: [{ userId: user.sub }, ...(user.driverId ? [{ driverId: user.driverId }] : [])],
      },
      select: { id: true, driverId: true },
    });

    for (const order of active) {
      await client.join(rideRoom(order.id));
      // Passengers follow the assigned driver's position feed.
      if (order.driverId && order.driverId !== user.driverId) {
        await client.join(driverWatchRoom(order.driverId));
      }
    }
  }

  async handleDisconnect(client: Socket) {
    const user: SocketUser | undefined = client.data?.user;
    this.logger.debug(`Socket ${client.id} disconnected (user ${user?.sub ?? 'unknown'})`);
    // Presence is not cleared here: the heartbeat TTL decides when a driver is
    // offline, which survives a brief reconnect.
  }

  // --------------------------------------------------------------- driver

  @SubscribeMessage('driver-live-location')
  async onDriverLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: DriverLocationDto,
  ) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();
    if (!user.driverId) return this.response.forbidden('Only drivers can publish a location');

    try {
      const result = await this.drivers.updateLocation(user.sub, dto);
      if (result.error) return this.response.handle(result);

      this.server.to(driverWatchRoom(user.driverId)).emit('driver-location-update', {
        driverId: user.driverId,
        lat: dto.lat,
        lng: dto.lng,
        heading: dto.heading,
        speedKph: dto.speedKph,
        recordedAt: dto.recordedAt ?? new Date().toISOString(),
      });

      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @SubscribeMessage('subscribe-driver-location')
  async onSubscribeDriver(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SubscribeDriverLocationDto,
  ) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      await client.join(driverWatchRoom(dto.driverId));
      return this.response.success({ driverId: dto.driverId }, 'Subscribed');
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @SubscribeMessage('unsubscribe-driver-location')
  async onUnsubscribeDriver(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SubscribeDriverLocationDto,
  ) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      await client.leave(driverWatchRoom(dto.driverId));
      return this.response.success({ driverId: dto.driverId }, 'Unsubscribed');
    } catch (e) {
      return this.response.exception(e);
    }
  }

  // ------------------------------------------------------------ matching

  @SubscribeMessage('passenger-trip-request')
  async onTripRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: CreateRideRequestDto,
  ) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      const result = await this.ride.createRequest(user.sub, dto);
      if (!result.error) await client.join(requestRoom(result.body.request.id));

      return this.response.handle(result, { message: 'Looking for a driver' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  /**
   * The pull half of matching. Fan-out reaches whoever was online when a
   * request was raised; this is how a driver who arrived afterwards finds it.
   */
  @SubscribeMessage('nearby-requests')
  async onNearbyRequests(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: NearbyRequestsQueryDto,
  ) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();
    if (!user.driverId) return this.response.forbidden('Only drivers can browse open requests');

    try {
      const result = await this.ride.findNearbyOpen(user.sub, dto);
      if (result.error) return this.response.handle(result);

      // Joining each request's room means a bid placed by anyone else, and the
      // passenger's own cancellation, land here without a second round trip.
      for (const request of result.body as { id: string }[]) {
        await client.join(requestRoom(request.id));
      }

      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @SubscribeMessage('driver-bid')
  async onDriverBid(@ConnectedSocket() client: Socket, @MessageBody() dto: PlaceBidDto) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      await client.join(requestRoom(dto.requestId));
      const result = await this.ride.placeBid(user.sub, dto);
      return this.response.handle(result, { message: 'Bid placed' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @SubscribeMessage('accept-driver')
  async onAcceptDriver(@ConnectedSocket() client: Socket, @MessageBody() dto: AcceptDriverDto) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      const result = await this.ride.acceptDriver(user.sub, dto);
      if (result.error) return this.response.handle(result);

      await client.join(rideRoom(result.body.id));
      await client.join(driverWatchRoom(dto.driverId));

      return this.response.handle(result, { message: 'Driver accepted' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @SubscribeMessage('cancel-request')
  async onCancelRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: CancelRideRequestDto,
  ) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      const result = await this.ride.cancelRequest(user.sub, dto);
      return this.response.handle(result, { message: 'Request cancelled' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  // ---------------------------------------------------------------- trip

  @SubscribeMessage('subscribe-ride')
  async onSubscribeRide(@ConnectedSocket() client: Socket, @MessageBody() dto: { rideId: string }) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      const result = await this.orders.findOne(dto.rideId, user);
      if (result.error) return this.response.handle(result);

      await client.join(rideRoom(result.body.id));
      if (result.body.driverId) await client.join(driverWatchRoom(result.body.driverId));

      return this.response.handle(result, { message: 'Subscribed' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @SubscribeMessage('update-ride-stage')
  async onUpdateStage(@ConnectedSocket() client: Socket, @MessageBody() dto: UpdateRideStageDto) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      const result = await this.orders.updateStatus(dto.rideId, dto.stage as OrderStatus, user);
      return this.response.handle(result, { message: `Trip is now ${dto.stage}` });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @SubscribeMessage('cancel-trip')
  async onCancelTrip(@ConnectedSocket() client: Socket, @MessageBody() dto: CancelTripDto) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      const result = await this.orders.updateStatus(
        dto.rideId,
        OrderStatus.CANCELLED,
        user,
        dto.reason,
      );
      return this.response.handle(result, { message: 'Trip cancelled' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @SubscribeMessage('message')
  async onMessage(@ConnectedSocket() client: Socket, @MessageBody() dto: RideMessageDto) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      const result = await this.orders.sendMessage(dto.rideId, user, { content: dto.content });
      return this.response.handle(result, { message: 'Message sent' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @SubscribeMessage('submit-rating')
  async onRating(@ConnectedSocket() client: Socket, @MessageBody() dto: SubmitRatingDto) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      const result = await this.orders.rate(dto.rideId, user, {
        score: dto.score,
        comment: dto.comment,
      });
      return this.response.handle(result, { message: 'Rating submitted' });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}

function extractToken(client: Socket): string | undefined {
  const fromAuth = client.handshake.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) {
    return fromAuth.replace(/^Bearer\s+/i, '');
  }

  const header = client.handshake.headers?.authorization;
  return typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : undefined;
}

function getUser(client: Socket): SocketUser | undefined {
  return client.data?.user;
}
