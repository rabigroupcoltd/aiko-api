import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KycStatus, Order, OrderStatus } from '@prisma/client';
import { RideEventsService } from '../events/ride-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_TYPES, OFFER_TTL_SECONDS, TRIP_TTL_SECONDS } from './notifications.constants';
import { RedisService } from '../redis/redis.service';
import { PushService } from './push.service';

@Injectable()
export class RideNotificationsService implements OnModuleInit {
  private readonly logger = new Logger(RideNotificationsService.name);

  constructor(
    private events: RideEventsService,
    private prisma: PrismaService,
    private push: PushService,
    private redis: RedisService,
  ) {}

  onModuleInit() {
    this.subscribe('ride-request.created', (payload) => this.onRequestCreated(payload));
    this.subscribe('ride-request.bid', (payload) => this.onBidPlaced(payload));
    this.subscribe('ride-request.bid-accepted', (payload) => this.onBidAccepted(payload));
    this.subscribe('ride-request.cancelled', (payload) => this.onRequestCancelled(payload));
    this.subscribe('ride-request.expired', (payload) => this.onRequestExpired(payload));
    this.subscribe('order.status-changed', (payload) => this.onTripStatus(payload));
    this.subscribe('order.cancelled', (payload) => this.onTripCancelled(payload));
    this.subscribe('order.message', (payload) => this.onMessage(payload));
    this.subscribe('driver.kyc-updated', (payload) => this.onKycUpdated(payload));

    this.subscribe('order.available', (payload) => this.onOrderAvailable(payload));
    this.subscribe('order.reserved', (payload) => this.onOrderReserved(payload));
    this.subscribe('order.picked-up', (payload) => this.onOrderPickedUp(payload));
    this.subscribe('order.delivered', (payload) => this.onOrderDelivered(payload));
    this.subscribe('order.no-driver-found', (payload) => this.onNoDriverFound(payload));
    this.subscribe('driver.went-dark', (payload) => this.onDriverWentDark(payload));

    this.subscribe('order.reserved', (payload) =>
      this.clearOfferCards(payload?.order?.id, payload?.driverId),
    );
    this.subscribe('order.cancelled', async (payload) => {
      if (payload?.id && !payload.driverId) await this.clearOfferCards(payload.id);
    });

    this.logger.log('Ride push notifications wired');
  }

  private async onOrderAvailable(payload: {
    order: any;
    drivers: { driverId: string }[];
  }) {
    const { order, drivers } = payload;
    if (!drivers?.length) return;

    await this.push.sendToDrivers(
      drivers.map((driver) => driver.driverId),
      {
        type: PUSH_TYPES.ORDER_AVAILABLE,
        silent: true,
        collapseKey: `order:${order.id}:available`,
        ttlSeconds: OFFER_TTL_SECONDS,
        data: {
          dedupeKey: `order-available:${order.id}`,
          title: `New order · ${money(order.driverEarnings, order.currency)}`,
          body: `${order.pickupLocation} → ${order.dropoffLocation}`,
          orderId: order.id,
          description: order.description ?? undefined,
          vehicleType: order.vehicleType,
          pickupLocation: order.pickupLocation,
          dropoffLocation: order.dropoffLocation,
          pickupLat: order.pickupLat,
          pickupLng: order.pickupLng,
          distanceKm: order.distanceKm,
          earnings: order.driverEarnings,
        },
      },
    );
  }

  private async clearOfferCards(orderId?: string, winnerId?: string) {
    if (!orderId) return;

    const offered = await this.redis.getOfferedDrivers(orderId);
    const losers = winnerId ? offered.filter((id) => id !== winnerId) : offered;
    if (!losers.length) return;

    await this.push.sendToDrivers(losers, {
      type: PUSH_TYPES.ORDER_REMOVED,
      silent: true,
      collapseKey: `order:${orderId}:available`,
      ttlSeconds: OFFER_TTL_SECONDS,
      data: {
        dedupeKey: `order-removed:${orderId}`,
        orderId,
        reason: winnerId ? 'TAKEN' : 'CANCELLED',
      },
    });
  }

  private async onOrderReserved(payload: {
    order: any;
    eta?: { pickupMinutes: number | null } | null;
    heldByDriver?: number;
  }) {
    const order = payload?.order;
    if (!order?.driverId) return;

    const driver = order.driver;
    const driverName = driver?.user?.name?.split(' ')[0] ?? 'Your driver';
    const vehicle = [driver?.vehicleColor, driver?.vehicleModel].filter(Boolean).join(' ');
    const pickupMinutes = payload.eta?.pickupMinutes;

    const detail = [
      vehicle || null,
      driver?.vehiclePlate || null,
      pickupMinutes != null ? `${pickupMinutes} min away` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    await this.push.sendToUsers([order.userId], {
      type: PUSH_TYPES.ORDER_RESERVED,
      title: 'Driver found 🎉',
      body: detail ? `${driverName} · ${detail}` : `${driverName} is on the way`,
      collapseKey: `order:${order.id}`,
      ttlSeconds: TRIP_TTL_SECONDS,
      data: {
        dedupeKey: `order-reserved:${order.id}`,
        orderId: order.id,
        driverName: driver?.user?.name,
        vehiclePlate: driver?.vehiclePlate,
        pickupEtaMinutes: pickupMinutes ?? null,
        driverHandlingOtherOrders: (payload.heldByDriver ?? 1) > 1,
      },
    });
  }

  private async onOrderPickedUp(order: any) {
    await this.push.sendToUsers([order.userId], {
      type: PUSH_TYPES.ORDER_PICKED_UP,
      title: 'Your order is on the way',
      body: `Picked up from ${order.pickupLocation}.`,
      collapseKey: `order:${order.id}`,
      ttlSeconds: TRIP_TTL_SECONDS,
      data: { dedupeKey: `order-picked-up:${order.id}`, orderId: order.id, status: order.status },
    });
  }

  private async onOrderDelivered(order: any) {
    await this.push.sendToUsers([order.userId], {
      type: PUSH_TYPES.ORDER_DELIVERED,
      title: 'Delivered ✅',
      body: `Your order reached ${order.dropoffLocation}.`,
      collapseKey: `order:${order.id}`,
      ttlSeconds: TRIP_TTL_SECONDS,
      data: { dedupeKey: `order-delivered:${order.id}`, orderId: order.id },
    });

    if (order.driverId) {
      await this.push.sendToDrivers([order.driverId], {
        type: PUSH_TYPES.ORDER_DELIVERED,
        title: 'Order completed',
        body: `You earned ${money(order.driverEarnings, order.currency)}.`,
        collapseKey: `order:${order.id}:driver`,
        ttlSeconds: TRIP_TTL_SECONDS,
        data: { dedupeKey: `order-delivered-driver:${order.id}`, orderId: order.id },
      });
    }
  }

  private async onDriverWentDark(payload: {
    driverId: string;
    orders: { id: string; userId: string; pickupLocation: string; dropoffLocation: string }[];
  }) {
    const { driverId, orders } = payload ?? {};
    if (!orders?.length) return;

    await Promise.all(
      orders.map((order) =>
        this.push.sendToUsers([order.userId], {
          type: PUSH_TYPES.DRIVER_UNREACHABLE,
          title: 'Trouble reaching your driver',
          body: `We're having trouble reaching your driver for the trip to ${order.dropoffLocation}. We're on it.`,
          collapseKey: `order:${order.id}:driver-unreachable`,
          ttlSeconds: TRIP_TTL_SECONDS,
          data: { dedupeKey: `driver-unreachable:${order.id}`, orderId: order.id },
        }),
      ),
    );

    await this.alertOpsOfDarkDriver(driverId, orders);
  }

  private async alertOpsOfDarkDriver(
    driverId: string,
    orders: { id: string }[],
  ): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: 'ADMIN' } },
      select: { id: true },
    });
    if (admins.length === 0) return;

    await this.push.sendToUsers(
      admins.map((admin) => admin.id),
      {
        type: PUSH_TYPES.DRIVER_UNREACHABLE,
        title: 'Driver went dark mid-trip',
        body: `A driver stopped reporting location while holding ${orders.length} active order(s). Check the dispatch board.`,
        data: {
          dedupeKey: `driver-unreachable-ops:${driverId}`,
          driverId,
          orderIds: orders.map((order) => order.id).join(','),
        },
      },
    );
  }

  private async onNoDriverFound(order: any) {
    if (!order) return;

    await this.push.sendToUsers([order.userId], {
      type: PUSH_TYPES.ORDER_NO_DRIVER,
      title: 'No driver available',
      body: `Nobody took your order to ${order.dropoffLocation}. Tap to try again.`,
      collapseKey: `order:${order.id}`,
      ttlSeconds: TRIP_TTL_SECONDS,
      data: { dedupeKey: `order-no-driver:${order.id}`, orderId: order.id },
    });
  }

  private subscribe(name: Parameters<RideEventsService['on']>[0], handler: (payload: any) => Promise<unknown>) {
    this.events.on<any>(name).subscribe(({ payload }) => {
      handler(payload).catch((e) =>
        this.logger.error(`Push for ${name} failed: ${e?.message ?? e}`),
      );
    });
  }

  private async onRequestCreated(payload: {
    request: any;
    quote: { fare: number; currency?: string };
    matched: { driverId: string }[];
  }) {
    const { request, quote, matched } = payload;
    if (!matched?.length) return;

    const fare = money(quote?.fare ?? request.estimatedFare, quote?.currency);

    await this.push.sendToDrivers(
      matched.map((driver) => driver.driverId),
      {
        type: PUSH_TYPES.RIDE_REQUEST,
        title: `New ${request.vehicleType.toLowerCase()} trip · ${fare}`,
        body: `${request.pickupLocation} → ${request.dropoffLocation}`,
        collapseKey: `request:${request.id}`,
        ttlSeconds: OFFER_TTL_SECONDS,
        data: {
          dedupeKey: `ride-request:${request.id}`,
          requestId: request.id,
          vehicleType: request.vehicleType,
          pickupLocation: request.pickupLocation,
          dropoffLocation: request.dropoffLocation,
          pickupLat: request.pickupLat,
          pickupLng: request.pickupLng,
          dropoffLat: request.dropoffLat,
          dropoffLng: request.dropoffLng,
          distanceKm: request.distanceKm,
          fare: quote?.fare ?? request.estimatedFare,
          expiresAt: toIso(request.expiresAt),
        },
      },
    );
  }

  private async onBidPlaced(payload: { request: any; bid: any }) {
    const { request, bid } = payload;
    const driverName = bid?.driver?.user?.name ?? 'A driver';
    const vehicle = [bid?.driver?.vehicleColor, bid?.driver?.vehicleModel].filter(Boolean).join(' ');

    await this.push.sendToUsers([request.userId], {
      type: PUSH_TYPES.BID_PLACED,
      title: 'A driver is available',
      body: vehicle
        ? `${driverName} · ${vehicle} · ${money(bid.amount)}`
        : `${driverName} offered ${money(bid.amount)}`,
      collapseKey: `request:${request.id}:bids`,
      ttlSeconds: OFFER_TTL_SECONDS,
      data: {
        dedupeKey: `driver-bid-placed:${bid.id}`,
        requestId: request.id,
        bidId: bid.id,
        driverId: bid.driverId,
        driverName,
        amount: bid.amount,
        rating: bid?.driver?.rating,
      },
    });
  }

  private async onBidAccepted(payload: { requestId: string; order: any }) {
    const order = payload?.order;
    if (!order?.driverId) return;

    const passenger = order.user?.name ?? 'your passenger';

    await this.push.sendToDrivers([order.driverId], {
      type: PUSH_TYPES.BID_ACCEPTED,
      title: 'Trip confirmed 🎉',
      body: `Pick ${passenger} up at ${order.pickupLocation}`,
      collapseKey: `order:${order.id}`,
      ttlSeconds: TRIP_TTL_SECONDS,
      data: {
        dedupeKey: `driver-accepted:${order.id}`,
        orderId: order.id,
        requestId: payload.requestId,
        pickupLocation: order.pickupLocation,
        dropoffLocation: order.dropoffLocation,
        pickupLat: order.pickupLat,
        pickupLng: order.pickupLng,
        fare: order.fare,
        passengerName: order.user?.name,
        passengerPhone: order.user?.phone,
      },
    });
  }

  private async onRequestCancelled(request: any) {
    if (!request?.matchedDriverIds?.length) return;

    await this.push.sendToDrivers(request.matchedDriverIds, {
      type: PUSH_TYPES.RIDE_REQUEST_CANCELLED,
      silent: true,
      collapseKey: `request:${request.id}`,
      ttlSeconds: OFFER_TTL_SECONDS,
      data: { dedupeKey: `ride-request-cancelled:${request.id}`, requestId: request.id },
    });
  }

  private async onRequestExpired(request: any) {
    if (!request) return;

    await this.push.sendToUsers([request.userId], {
      type: PUSH_TYPES.RIDE_REQUEST_EXPIRED,
      title: 'No drivers available',
      body: `Nobody accepted your trip to ${request.dropoffLocation}. Tap to try again.`,
      collapseKey: `request:${request.id}`,
      ttlSeconds: TRIP_TTL_SECONDS,
      data: { dedupeKey: `ride-request-expired:${request.id}`, requestId: request.id },
    });

    await this.onRequestCancelled(request);
  }

  private async onTripStatus(order: any) {
    const copy = this.tripCopy(order);
    if (!copy) return;

    const base = {
      type: PUSH_TYPES.TRIP_STATUS,
      collapseKey: `order:${order.id}`,
      ttlSeconds: TRIP_TTL_SECONDS,
      data: {
        dedupeKey: `ride-stage-changed:${order.id}:${order.status}`,
        orderId: order.id,
        status: order.status,
      },
    };

    if (copy.passenger) {
      await this.push.sendToUsers([order.userId], { ...base, ...copy.passenger });
    }
    if (copy.driver && order.driverId) {
      await this.push.sendToDrivers([order.driverId], { ...base, ...copy.driver });
    }
  }

  private tripCopy(order: Order & { driver?: any }): {
    passenger?: { title: string; body: string };
    driver?: { title: string; body: string };
  } | null {
    const driverName = (order as any).driver?.user?.name ?? 'Your driver';

    switch (order.status) {
      case OrderStatus.ARRIVED:
        return {
          passenger: {
            title: 'Your driver has arrived',
            body: `${driverName} is waiting at ${order.pickupLocation}.`,
          },
        };
      case OrderStatus.IN_PROGRESS:
        return {
          passenger: {
            title: 'Trip started',
            body: `On the way to ${order.dropoffLocation}.`,
          },
        };
      case OrderStatus.COMPLETED:
        return {
          passenger: {
            title: 'Trip completed',
            body: `${money(order.fare, order.currency)} · tap to rate ${driverName}.`,
          },
          driver: {
            title: 'Trip completed',
            body: `You earned ${money(order.driverEarnings, order.currency)}.`,
          },
        };
      default:
        return null;
    }
  }

  private async onTripCancelled(order: any) {
    const reason = order.cancellationReason ? ` Reason: ${order.cancellationReason}` : '';

    const message = {
      type: PUSH_TYPES.TRIP_CANCELLED,
      title: 'Trip cancelled',
      body: `The trip to ${order.dropoffLocation} was cancelled.${reason}`,
      collapseKey: `order:${order.id}`,
      ttlSeconds: TRIP_TTL_SECONDS,
      data: {
        dedupeKey: `trip-cancelled:${order.id}`,
        orderId: order.id,
        reason: order.cancellationReason,
      },
    };

    await this.push.sendToUsers([order.userId], message);
    if (order.driverId) await this.push.sendToDrivers([order.driverId], message);
  }

  private async onMessage(message: any) {
    const order = await this.prisma.order.findUnique({
      where: { id: message.orderId },
      select: { userId: true, driverId: true, driver: { select: { userId: true } } },
    });
    if (!order) return;

    const recipientId =
      message.senderId === order.userId ? order.driver?.userId : order.userId;
    if (!recipientId) return;

    await this.push.sendToUsers([recipientId], {
      type: PUSH_TYPES.TRIP_MESSAGE,
      title: message.sender?.name ?? 'New message',
      body: message.content,
      collapseKey: `order:${message.orderId}:chat`,
      ttlSeconds: TRIP_TTL_SECONDS,
      data: {
        dedupeKey: `new-message:${message.id}`,
        orderId: message.orderId,
        messageId: message.id,
        senderId: message.senderId,
      },
    });
  }

  private async onKycUpdated(driver: any) {
    const approved = driver.kycStatus === KycStatus.APPROVED;

    await this.push.sendToUsers([driver.userId], {
      type: PUSH_TYPES.KYC_STATUS,
      title: approved ? 'You are approved ✅' : 'Documents need attention',
      body: approved
        ? 'Your documents cleared review. Go online to start taking trips.'
        : driver.kycRejectionReason || 'Please re-submit your documents.',
      collapseKey: `kyc:${driver.id}`,
      data: {
        dedupeKey: `kyc:${driver.id}:${driver.kycStatus}`,
        driverId: driver.id,
        kycStatus: driver.kycStatus,
        reason: driver.kycRejectionReason,
      },
    });
  }
}

const SYMBOLS: Record<string, string> = { NGN: '₦', USD: '$', GBP: '£', EUR: '€' };

function money(amount: number | null | undefined, currency = 'NGN'): string {
  const value = Math.round(amount ?? 0);
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${value.toLocaleString('en-US')}`;
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}
