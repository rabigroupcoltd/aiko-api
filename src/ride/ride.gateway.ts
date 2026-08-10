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
import {
  DRIVER_ACTIVE_STATUSES,
  LEGACY_ACTIVE_STATUSES,
} from '../dispatch/dispatch.constants';
import { MarketplaceQueryDto } from '../dispatch/dto/marketplace.dto';
import { MarketplaceService } from '../dispatch/marketplace.service';
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
  OrderIdDto,
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
    private marketplace: MarketplaceService,
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

    // One broadcast for both transports. The socket handler below and
    // POST /api/drivers/location both reach this through DriversService, which
    // is what keeps a backgrounded driver's marker moving on the passenger's map.
    this.events.on<any>('driver.location').subscribe(({ payload }) => {
      this.server.to(driverWatchRoom(payload.driverId)).emit('driver-location-update', payload);
    });

    this.wireMarketplace();

    this.logger.log('Ride gateway initialised');
  }

  /**
   * The marketplace's realtime half — §28.
   *
   * Three broadcasts carry the whole dispatch loop. `order-available` puts a
   * card in a driver's grid, `order-reserved` tells the customer who won, and
   * `order-removed` tells every *other* driver to drop it. Without the third the
   * losing drivers keep a card they can no longer act on until their next poll.
   */
  private wireMarketplace() {
    this.events.on<any>('order.available').subscribe(({ payload }) => {
      const { order, drivers } = payload;
      const card = this.toMarketplaceCard(order);

      drivers?.forEach((driver: { driverId: string }) =>
        this.server.to(driverRoom(driver.driverId)).emit('order-available', card),
      );
    });

    this.events.on<any>('order.reserved').subscribe(({ payload }) => {
      const { order, driverId, eta } = payload;
      if (!order) return;

      // The customer learns who is coming.
      this.server.to(userRoom(order.userId)).emit('order-reserved', { order, eta });
      this.server.to(rideRoom(order.id)).emit('order-reserved', { order, eta });

      // The winner gets it as a trip; everyone else loses the card. Broadcast to
      // the whole namespace rather than tracking who saw it — a driver who never
      // had the card simply ignores an id they do not hold.
      this.server.to(driverRoom(driverId)).emit('ride-stage-changed', order);
      this.server.emit('order-removed', { orderId: order.id, reason: 'RESERVED' });
    });

    this.events.on<any>('order.no-driver-found').subscribe(({ payload }) => {
      if (!payload) return;
      this.server.to(userRoom(payload.userId)).emit('order-no-driver', payload);
      this.server.emit('order-removed', { orderId: payload.id, reason: 'NO_DRIVER_FOUND' });
    });

    // A cancelled order that never found a driver is still sitting in grids.
    this.events.on<any>('order.cancelled').subscribe(({ payload }) => {
      if (!payload?.driverId) {
        this.server.emit('order-removed', { orderId: payload?.id, reason: 'CANCELLED' });
      }
    });
  }

  /**
   * An open order as a driver may see it over the socket.
   *
   * The same redaction the REST grid applies — no customer name, no phone, no
   * user id. The card carries no compatibility score either: that depends on
   * where this particular driver is and what they are already carrying, and the
   * broadcast goes to many drivers at once. The client refetches the grid on
   * receipt, which is where the per-driver scoring happens.
   */
  private toMarketplaceCard(order: any) {
    return {
      id: order.id,
      vehicleType: order.vehicleType,
      pickupLocation: order.pickupLocation,
      pickupLat: order.pickupLat,
      pickupLng: order.pickupLng,
      dropoffLocation: order.dropoffLocation,
      dropoffLat: order.dropoffLat,
      dropoffLng: order.dropoffLng,
      distanceKm: order.distanceKm,
      earnings: order.driverEarnings,
      fare: order.fare,
      currency: order.currency,
      createdAt: order.createdAt,
    };
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
        // Both lanes. A driver holding three marketplace orders re-joins all
        // three rooms, so chat on any of them survives a reconnect.
        status: { in: [...LEGACY_ACTIVE_STATUSES, ...DRIVER_ACTIVE_STATUSES] },
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
      // The broadcast is raised by DriversService, not here — see the
      // `driver.location` subscription in afterInit. Emitting it a second time
      // would double every position update for anyone watching.
      const result = await this.drivers.updateLocation(user.sub, dto);
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

  // ----------------------------------------------------------- marketplace

  /**
   * The driver's available-orders grid, over the socket.
   *
   * Mirrors `GET /api/marketplace/orders` exactly — same service, same
   * redaction, same ranking. It exists so a driver who receives `order-available`
   * can refresh without an HTTP round trip.
   */
  @SubscribeMessage('marketplace-orders')
  async onMarketplaceOrders(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: MarketplaceQueryDto,
  ) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();
    if (!user.driverId) return this.response.forbidden('Only drivers can browse the marketplace');

    try {
      const result = await this.marketplace.available(user.sub, dto);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  /**
   * Claim an order. The ack is the whole answer — 409 ORDER_ALREADY_RESERVED for
   * the losers of a race, 400 MAX_ORDER_CAPACITY_REACHED at the limit.
   */
  @SubscribeMessage('reserve-order')
  async onReserveOrder(@ConnectedSocket() client: Socket, @MessageBody() dto: OrderIdDto) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      const result = await this.marketplace.reserve(dto.orderId, user.sub);
      if (result.error) return this.response.handle(result);

      // Joining now means the customer's first chat message reaches this driver
      // without waiting for them to open the order.
      await client.join(rideRoom(dto.orderId));

      return this.response.handle(result, { message: 'Order reserved' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @SubscribeMessage('skip-order')
  async onSkipOrder(@ConnectedSocket() client: Socket, @MessageBody() dto: OrderIdDto) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      const result = await this.marketplace.skip(dto.orderId, user.sub);
      return this.response.handle(result, { message: 'Order skipped' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @SubscribeMessage('active-orders')
  async onActiveOrders(@ConnectedSocket() client: Socket) {
    const user = getUser(client);
    if (!user) return this.response.unauthorized();

    try {
      const result = await this.marketplace.activeOrders(user.sub);
      if (result.error) return this.response.handle(result);

      // Re-join every held order's room in one go, so chat works across all of
      // them after a reconnect rather than only the one on screen.
      for (const order of (result.body as { orders: { id: string }[] }).orders) {
        await client.join(rideRoom(order.id));
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
