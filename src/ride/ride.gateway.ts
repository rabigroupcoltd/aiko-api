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

/**
 * ws://<host>/ride — a notification pipe, and nothing else.
 *
 * The socket has no client-to-server surface. Every mutation the app performs —
 * booking, reserving, skipping, cancelling, going online, publishing a position
 * — is an HTTP call, and this gateway exists purely to tell a client something
 * changed so it can update what is on screen.
 *
 * That split is what makes recovery trivial. A socket that only pushes holds no
 * in-flight request state, so a reconnect needs no replay: the client calls
 * `GET /api/drivers/state`, gets the whole world back, and carries on. It is
 * also what lets a backgrounded driver keep working — the same events that
 * arrive here arrive as FCM pushes when there is no socket to receive them, and
 * both carry the same codes.
 *
 * Three events go out. `connected` once at handshake, then `info` and `error`
 * forever — see `realtime/notification-codes.ts` for the vocabulary.
 */
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

  // ------------------------------------------------------------ driver grid

  /**
   * The fastest-finger loop, as four codes.
   *
   * A card appears on REQUEST_NEW and leaves on exactly one of REQUEST_WON,
   * REQUEST_LOST or REQUEST_CLOSED. The client needs no other rule: it never
   * decides for itself that a card is stale, never polls to check, and never
   * reconciles two sources of truth about whether a job is still open.
   */
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

      // The customer learns who is coming, and their sockets start following
      // that driver's position feed. Joined server-side because the client has
      // no way to ask — there are no client events.
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

    // A cancellation only clears cards while the order was still on the market.
    // Once a driver holds it, this is a trip being cancelled, and they are told
    // through ORDER_CANCELLED rather than losing a card they no longer have.
    this.events.on<any>('order.cancelled').subscribe(({ payload }) => {
      if (payload?.id && !payload.driverId) {
        void this.closeCard(payload.id, REMOVAL_REASONS.CANCELLED);
      }
    });
  }

  /**
   * Tell everyone still holding this card to drop it.
   *
   * The audience is read from Redis rather than broadcast to the namespace.
   * Broadcasting is simpler and is what this did before, but it hands every
   * connected client a stream of ids belonging to orders they were never shown
   * — passengers included, who have no grid at all. Reading the offer set
   * addresses only the drivers who actually saw the card.
   *
   * The read is non-destructive. RideNotificationsService answers the same
   * question to raise the push half of this, and a read that cleared the set
   * would starve whichever of the two subscribers happened to run second. The
   * set expires on its own instead — see OFFERED_TTL_SECONDS.
   */
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
      // A card that fails to clear is a card the driver can tap and be refused
      // by the reserve endpoint, which is recoverable. Losing the event loop
      // over it is not.
      this.logger.error(`Could not clear card ${orderId}: ${e?.message}`);
    }
  }

  // ----------------------------------------------------------------- trips

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

    // Raised by DriversService for both transports, so a driver whose phone is
    // locked and reporting over REST still moves on the passenger's map.
    this.events.on<any>('driver.location').subscribe(({ payload }) => {
      this.server
        .to(driverWatchRoom(payload.driverId))
        .emit(SOCKET_EVENTS.INFO, info(INFO_CODES.DRIVER_LOCATION, 'Driver moved', payload));
    });

    // Both parties are in the trip room, and the reader ignores its own receipt
    // by comparing `readerId` — cheaper than excluding one socket server-side
    // when a driver may have the same order open on two devices.
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
    // CANCELLED has its own code; letting it through here would send both.
    if (order.status === OrderStatus.CANCELLED) return;

    this.toTrip(order, info(INFO_CODES.ORDER_STATUS, `Order ${order.status}`, { order }));
  }

  /** Both parties of one trip, plus the trip room for anything already joined. */
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

  /** Subscribes one user's sockets to a driver's position feed. */
  private watchDriver(userId: string, driverId?: string) {
    if (!driverId) return;
    this.server.in(userRoom(userId)).socketsJoin(driverWatchRoom(driverId));
  }

  /**
   * An open order as a driver may see it.
   *
   * Redacted like the REST grid — a place and a price, never a customer. No
   * compatibility score either: that is per-driver and this card goes to many
   * at once, so the client scores against its own position from the grid it
   * already holds.
   */
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

  // ------------------------------------------------------------- lifecycle

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

  /**
   * Re-join the rooms of every trip still in flight.
   *
   * This is the whole of reconnect handling. A driver holding three orders
   * re-joins all three rooms, and a passenger re-joins their driver's position
   * feed, so a dropped connection needs no special case on the client.
   */
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
    // Presence is not cleared here. The heartbeat TTL decides when a driver is
    // offline, which survives a tunnel, a lock screen, or a brief reconnect —
    // none of which mean the driver stopped working.
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
