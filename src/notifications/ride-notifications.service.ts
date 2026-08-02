import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KycStatus, Order, OrderStatus } from '@prisma/client';
import { RideEventsService } from '../events/ride-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_TYPES, OFFER_TTL_SECONDS, TRIP_TTL_SECONDS } from './notifications.constants';
import { PushService } from './push.service';

/**
 * Turns ride events into push notifications.
 *
 * Subscribes to the same in-process bus the WebSocket gateway listens on, which
 * is what keeps push out of the services entirely: nothing in RideService or
 * OrdersService knows notifications exist, and a new event only has to be
 * emitted once to reach both transports.
 *
 * Push is the fallback for a client that is backgrounded or off the socket. A
 * client in the foreground gets the socket event too, so the app is expected to
 * suppress a notification it has already acted on — see `dedupeKey` in the data
 * payload, which matches the socket event it duplicates.
 */
@Injectable()
export class RideNotificationsService implements OnModuleInit {
  private readonly logger = new Logger(RideNotificationsService.name);

  constructor(
    private events: RideEventsService,
    private prisma: PrismaService,
    private push: PushService,
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

    this.logger.log('Ride push notifications wired');
  }

  /**
   * The bus is synchronous and has no error channel, so a handler that rejected
   * would surface as an unhandled rejection and take the process down. Every
   * subscription is wrapped here rather than in each handler.
   */
  private subscribe(name: Parameters<RideEventsService['on']>[0], handler: (payload: any) => Promise<unknown>) {
    this.events.on<any>(name).subscribe(({ payload }) => {
      handler(payload).catch((e) =>
        this.logger.error(`Push for ${name} failed: ${e?.message ?? e}`),
      );
    });
  }

  // ------------------------------------------------------------- matching

  /** A new job, to the drivers the matcher just picked. */
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
        // One offer, one tray entry: a re-broadcast from the rematch worker
        // replaces the earlier card instead of stacking a second one.
        collapseKey: `request:${request.id}`,
        // Worthless the moment the request expires.
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

  /** A driver offered to take the trip. */
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
      // Several drivers bidding should not bury the passenger — one entry per
      // request, refreshed as offers come in.
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

  /** The passenger picked a driver — tell the driver they have the job. */
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

  /**
   * Silent on purpose. The offer is gone, so the driver's inbox has to drop it
   * — but buzzing a phone to say "never mind" is the fastest way to get push
   * turned off entirely.
   */
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

  /** Nobody took it inside the TTL. The passenger is the one left waiting. */
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

    // The drivers who were offered it should stop showing the card too.
    await this.onRequestCancelled(request);
  }

  // ----------------------------------------------------------------- trip

  /**
   * ARRIVED, IN_PROGRESS and COMPLETED. ACCEPTED is skipped: it is the same
   * moment as the accepted bid, which the driver has already been told about
   * and the passenger triggered themselves.
   */
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

  /**
   * Both parties. The event carries no record of who pressed the button, and
   * whoever did is looking at the confirmation anyway — a duplicate on their
   * own screen is a smaller failure than the other party never being told.
   */
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

  /** Chat on an active trip, to whichever party did not write it. */
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
      // Per conversation, not per message — a burst of chat is one tray entry.
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

  // ------------------------------------------------------------------ kyc

  /**
   * The one notification a driver is actively waiting for — they sit on the
   * approval screen until it arrives, so without push they have to keep
   * reopening the app to find out.
   */
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

/**
 * Money as a driver reads it on a lock screen.
 *
 * Intl is used for the grouping only — its NGN output is "NGN 1,250" on a
 * server with no locale data, and the symbol is what makes the number scannable
 * at a glance.
 */
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
