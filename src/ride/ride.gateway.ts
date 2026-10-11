import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { OrderStatus } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { JwtUser } from '../common/current-user.decorator';
import {
  DRIVER_ACTIVE_STATUSES,
  LEGACY_ACTIVE_STATUSES,
} from '../dispatch/dispatch.constants';
import { RideEventsService } from '../events/ride-events.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ERROR_CODES,
  INFO_CODES,
  InfoEnvelope,
  REMOVAL_REASONS,
  RemovalReason,
  SOCKET_EVENTS,
  info,
  socketError,
} from '../realtime/notification-codes';
import { RedisService } from '../redis/redis.service';
import { driverRoom, driverWatchRoom, rideRoom, userRoom } from './ride.rooms';

interface SocketUser extends JwtUser {
  driverId?: string;
}

@WebSocketGateway({
  namespace: '/ride',
  cors: { origin: '*' },
})
export class RideGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RideGateway.name);

  constructor(
    private jwt: JwtService,
    private prisma: PrismaService,
    private redis: RedisService,
    private events: RideEventsService,
  ) {}

  afterInit() {
    this.wireDriverGrid();
    this.wireTrips();
    this.logger.log('Ride gateway initialised — notifications only, no client events');
  }

  private wireDriverGrid() {
    this.events.on<any>('order.available').subscribe(({ payload }) => {
      const { order, drivers } = payload;
      const card = this.toCard(order);

      drivers?.forEach((driver: { driverId: string }) =>
        this.toDriver(
          driver.driverId,
          info(INFO_CODES.REQUEST_NEW, 'New request near you', { order: card }),
        ),
      );
    });

    this.events.on<any>('order.reserved').subscribe(({ payload }) => {
      const { order, driverId, eta } = payload;
      if (!order) return;

      this.toUser(
        order.userId,
        info(INFO_CODES.ORDER_RESERVED, 'Driver found', { order, eta: eta ?? null }),
      );
      this.watchDriver(order.userId, driverId);

      this.toDriver(driverId, info(INFO_CODES.REQUEST_WON, 'The request is yours', { order }));

      void this.closeCard(order.id, REMOVAL_REASONS.TAKEN, driverId);
    });

    this.events.on<any>('order.no-driver-found').subscribe(({ payload }) => {
      if (!payload) return;

      this.toUser(
        payload.userId,
        info(INFO_CODES.ORDER_NO_DRIVER, 'No driver was available', { order: payload }),
      );
      void this.closeCard(payload.id, REMOVAL_REASONS.NO_DRIVER_FOUND);
    });

    this.events.on<any>('order.cancelled').subscribe(({ payload }) => {
      if (payload?.id && !payload.driverId) {
        void this.closeCard(payload.id, REMOVAL_REASONS.CANCELLED);
      }
    });
  }

  private async closeCard(orderId: string, reason: RemovalReason, winnerId?: string) {
    try {
      const offered = await this.redis.getOfferedDrivers(orderId);
      const losers = winnerId ? offered.filter((id) => id !== winnerId) : offered;
      if (!losers.length) return;

      const message =
        reason === REMOVAL_REASONS.TAKEN
          ? 'Another driver took this request'
          : reason === REMOVAL_REASONS.CANCELLED
            ? 'The customer cancelled this request'
            : 'This request is no longer available';

      losers.forEach((driverId) =>
        this.toDriver(driverId, info(INFO_CODES.REQUEST_LOST, message, { orderId, reason })),
      );
    } catch (e: any) {
      this.logger.error(`Could not clear card ${orderId}: ${e?.message}`);
    }
  }

  private wireTrips() {
    ['order.created', 'order.accepted', 'order.status-changed'].forEach((name) =>
      this.events.on<any>(name as any).subscribe(({ payload }) => this.broadcastTrip(payload)),
    );

    this.events.on<any>('order.cancelled').subscribe(({ payload }) => {
      if (!payload) return;
      this.toTrip(
        payload,
        info(INFO_CODES.ORDER_CANCELLED, 'This trip was cancelled', { order: payload }),
      );
    });

    this.events.on<any>('order.message').subscribe(({ payload }) => {
      this.server
        .to(rideRoom(payload.orderId))
        .emit(SOCKET_EVENTS.INFO, info(INFO_CODES.MESSAGE, 'New message', { message: payload }));
    });

    this.events.on<any>('driver.location').subscribe(({ payload }) => {
      this.server
        .to(driverWatchRoom(payload.driverId))
        .emit(SOCKET_EVENTS.INFO, info(INFO_CODES.DRIVER_LOCATION, 'Driver moved', payload));
    });

    this.events.on<any>('order.messages-read').subscribe(({ payload }) => {
      this.server
        .to(rideRoom(payload.orderId))
        .emit(
          SOCKET_EVENTS.INFO,
          info(INFO_CODES.MESSAGE_READ, 'Messages read', payload),
        );
    });

    this.events.on<any>('driver.kyc-updated').subscribe(({ payload }) => {
      if (!payload?.userId) return;
      this.toUser(
        payload.userId,
        info(INFO_CODES.KYC_UPDATED, 'Your documents were reviewed', { driver: payload }),
      );
    });
  }

  private broadcastTrip(order: any) {
    if (!order) return;
    if (order.status === OrderStatus.CANCELLED) return;

    this.toTrip(order, info(INFO_CODES.ORDER_STATUS, `Order ${order.status}`, { order }));
  }

  private toTrip(order: any, envelope: InfoEnvelope) {
    this.server.to(rideRoom(order.id)).emit(SOCKET_EVENTS.INFO, envelope);
    this.server.to(userRoom(order.userId)).emit(SOCKET_EVENTS.INFO, envelope);
    if (order.driverId) {
      this.server.to(driverRoom(order.driverId)).emit(SOCKET_EVENTS.INFO, envelope);
    }
  }

  private toDriver(driverId: string, envelope: InfoEnvelope) {
    this.server.to(driverRoom(driverId)).emit(SOCKET_EVENTS.INFO, envelope);
  }

  private toUser(userId: string, envelope: InfoEnvelope) {
    this.server.to(userRoom(userId)).emit(SOCKET_EVENTS.INFO, envelope);
  }

  private watchDriver(userId: string, driverId?: string) {
    if (!driverId) return;
    this.server.in(userRoom(userId)).socketsJoin(driverWatchRoom(driverId));
  }

  private toCard(order: any) {
    return {
      id: order.id,
      vehicleType: order.vehicleType,
      description: order.description ?? null,
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
      await this.joinActiveTrips(client, user);

      client.emit(SOCKET_EVENTS.CONNECTED, {
        code: 'CONNECTED',
        message: 'Connected',
        data: { userId: user.sub, driverId: user.driverId ?? null },
      });
    } catch (e: any) {
      this.logger.warn(`Rejected socket ${client.id}: ${e?.message}`);
      client.emit(
        SOCKET_EVENTS.ERROR,
        socketError(ERROR_CODES.UNAUTHORIZED, 'Invalid or missing token'),
      );
      client.disconnect(true);
    }
  }

  private async joinActiveTrips(client: Socket, user: SocketUser) {
    const active = await this.prisma.order.findMany({
      where: {
        status: { in: [...LEGACY_ACTIVE_STATUSES, ...DRIVER_ACTIVE_STATUSES] },
        OR: [{ userId: user.sub }, ...(user.driverId ? [{ driverId: user.driverId }] : [])],
      },
      select: { id: true, driverId: true },
    });

    for (const order of active) {
      await client.join(rideRoom(order.id));
      if (order.driverId && order.driverId !== user.driverId) {
        await client.join(driverWatchRoom(order.driverId));
      }
    }
  }

  handleDisconnect(client: Socket) {
    const user: SocketUser | undefined = client.data?.user;
    this.logger.debug(`Socket ${client.id} disconnected (user ${user?.sub ?? 'unknown'})`);
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
