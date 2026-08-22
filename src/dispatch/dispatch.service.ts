import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Order, OrderStatus } from '@prisma/client';
import { haversineKm } from '../common/geo.util';
import { DriversService } from '../drivers/drivers.service';
import { RideEventsService } from '../events/ride-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { RedisService } from '../redis/redis.service';
import {
  DRIVER_ACTIVE_STATUSES,
  DISPATCH_EXPAND_DELAY_MS,
  INITIAL_DRIVER_RADIUS_KM,
  MAX_DISPATCH_ATTEMPTS,
  MAX_DRIVER_RADIUS_KM,
  MAX_RESERVED_ORDERS_PER_DRIVER,
  RADIUS_EXPANSION_FACTOR,
} from './dispatch.constants';

/** A driver the order should be announced to. */
export interface DispatchTarget {
  driverId: string;
  distanceKm: number | null;
}

/**
 * How long we remember having told a driver about an order.
 *
 * An hour — comfortably longer than any order stays open, so within one order's
 * life a driver is notified exactly once no matter how many widening passes and
 * sweeps reach them.
 */
const ANNOUNCE_MEMORY_SECONDS = 3600;
const announcedKey = (driverId: string, orderId: string) =>
  `dispatch:announced:${driverId}:${orderId}`;

/**
 * Shortest gap between two marketplace sweeps for one driver.
 *
 * `driver.available` fires on every position heartbeat — up to three a minute.
 * Nothing new can appear that fast which the ordinary fan-out would not already
 * have caught, so sweeping on each one is pure waste.
 */
const SWEEP_THROTTLE_SECONDS = Number(process.env.DRIVER_SWEEP_THROTTLE || 30);
const sweepKey = (driverId: string) => `dispatch:sweep:${driverId}`;

/** Most orders one sweep will announce to a single driver. */
const MAX_SWEEP_ANNOUNCEMENTS = Number(process.env.MAX_SWEEP_ANNOUNCEMENTS || 3);

/**
 * The push half of the marketplace.
 *
 * The grid is a pull — a driver asks what is near them. This is what makes an
 * order appear without that ask (§28): on creation it finds nearby drivers with
 * free capacity and announces the order to them, and when nobody bites it widens
 * the ring on a timer until it runs out of room and gives up.
 *
 * It also closes the other half of the same gap. A driver who comes online after
 * an order was raised was never announced to, so `driver.available` — the event
 * the location heartbeat already publishes — triggers a sweep towards them.
 */
@Injectable()
export class DispatchService implements OnModuleInit {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private prisma: PrismaService,
    private drivers: DriversService,
    private events: RideEventsService,
    private queues: QueuesService,
    private redis: RedisService,
  ) {}

  onModuleInit() {
    // Reuses the announcement DriversService already makes on every location
    // heartbeat. RideService listens to the same event for the bid flow; the two
    // sweeps are independent and neither knows about the other.
    this.events.on<any>('driver.available').subscribe(({ payload }) => {
      this.sweepForDriver(payload).catch((e) =>
        this.logger.warn(`Marketplace sweep for ${payload?.driverId} failed: ${e?.message}`),
      );
    });
  }

  // ---------------------------------------------------------------- dispatch

  /**
   * Announce a newly created order and arm the widening timer.
   *
   * Called once, from OrdersService, the moment the customer confirms.
   */
  async dispatch(order: Order): Promise<DispatchTarget[]> {
    const radiusKm = order.searchRadiusKm ?? INITIAL_DRIVER_RADIUS_KM;

    const targets = await this.eligibleDrivers(order, radiusKm);
    await this.announce(order, targets, radiusKm);

    // Armed whether or not anyone was found: drivers come and go, and the pass
    // that widens the ring is also the pass that eventually gives up.
    await this.queues.scheduleOrderExpansion(order.id, 1, DISPATCH_EXPAND_DELAY_MS);

    this.logger.log(
      `Order ${order.id} dispatched to ${targets.length} driver(s) within ${radiusKm} km`,
    );

    return targets;
  }

  /**
   * Raises `order.available`, but only for drivers who have not already been
   * told about this order.
   *
   * Without this the same driver is notified repeatedly for one job: the
   * initial fan-out reaches them, then every widening pass reaches them again
   * because a wider ring is a superset of a narrower one, and the online sweep
   * reaches them a third time. On the socket that is merely wasteful; as a push
   * it is a phone buzzing every forty-five seconds about a job the driver has
   * already decided not to take.
   *
   * `SET NX` in Redis is the record. It is per (driver, order) and expires an
   * hour later, which is far longer than any order stays open — the key exists
   * to suppress repeats within one order's life, not to remember anything.
   */
  private async announce(
    order: Order,
    targets: DispatchTarget[],
    radiusKm: number,
  ): Promise<DispatchTarget[]> {
    if (targets.length === 0) return [];

    const fresh: DispatchTarget[] = [];

    for (const target of targets) {
      const claimed = await this.redis.client.set(
        announcedKey(target.driverId, order.id),
        '1',
        'EX',
        ANNOUNCE_MEMORY_SECONDS,
        'NX',
      );
      if (claimed === 'OK') fresh.push(target);
    }

    if (fresh.length === 0) return [];

    // Remembered as a set so the losers are addressable when someone wins.
    // `announcedKey` above already records the same pair, but one key per
    // (driver, order) cannot be enumerated — and "who else saw this card" is
    // exactly the question REQUEST_LOST has to answer.
    await this.redis.addOfferedDrivers(
      order.id,
      fresh.map((target) => target.driverId),
    );

    this.events.emit('order.available', { order, drivers: fresh, radiusKm });
    return fresh;
  }

  /**
   * One widening pass, run by the worker.
   *
   * Returns null once the order is no longer open, which is the worker's signal
   * to stop rescheduling.
   */
  async expandSearch(orderId: string, attempt: number): Promise<DispatchTarget[] | null> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });

    if (!order) return null;
    if (order.status !== OrderStatus.SEARCHING_FOR_DRIVER || order.driverId) return null;

    const previous = order.searchRadiusKm ?? INITIAL_DRIVER_RADIUS_KM;
    const widened = Math.min(previous * RADIUS_EXPANSION_FACTOR, MAX_DRIVER_RADIUS_KM);

    // Out of attempts, or the ring cannot grow any further — this is as hard as
    // the platform is willing to look.
    if (attempt > MAX_DISPATCH_ATTEMPTS || previous >= MAX_DRIVER_RADIUS_KM) {
      await this.giveUp(order);
      return null;
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { searchRadiusKm: widened, dispatchAttempts: attempt },
    });

    const targets = await this.eligibleDrivers(updated, widened);
    // Only the drivers the narrower rings did not already reach.
    const fresh = await this.announce(updated, targets, widened);

    await this.queues.scheduleOrderExpansion(orderId, attempt + 1, DISPATCH_EXPAND_DELAY_MS);

    this.logger.log(
      `Order ${orderId} widened to ${widened} km on attempt ${attempt} — ` +
        `${targets.length} eligible, ${fresh.length} newly notified`,
    );

    return fresh;
  }

  /**
   * Nobody took it. Guarded, so an order reserved a moment before the timer
   * fired is left exactly as it is.
   */
  private async giveUp(order: Order): Promise<void> {
    const closed = await this.prisma.order.updateMany({
      where: { id: order.id, status: OrderStatus.SEARCHING_FOR_DRIVER, driverId: null },
      data: { status: OrderStatus.NO_DRIVER_FOUND },
    });

    if (closed.count === 0) return;

    const final = await this.prisma.order.findUnique({ where: { id: order.id } });
    this.events.emit('order.no-driver-found', final);

    this.logger.warn(`Order ${order.id} closed as NO_DRIVER_FOUND`);
  }

  // ------------------------------------------------------------------ sweep

  /**
   * Offer a newly-online (or newly-freed) driver whatever is already open near
   * them, using the same `order.available` event the initial dispatch raises so
   * both paths reach the socket and push through one code path.
   *
   * Throttled hard, because `driver.available` is raised on *every* position
   * heartbeat — three times a minute in the foreground, and once every twenty
   * seconds from the background service. Without the throttle this would run a
   * bounding-box query per driver per heartbeat and fan out a push for each open
   * order it found, which for a driver parked in a busy area is a phone that
   * never stops buzzing.
   *
   * `SET NX` is the throttle, in Redis rather than in memory so two API
   * instances cannot both sweep the same driver. Whichever announcement wins
   * the key does the work; the rest are no-ops until it expires.
   */
  private async sweepForDriver(payload: {
    driverId: string;
    lat: number;
    lng: number;
  }): Promise<void> {
    const { driverId, lat, lng } = payload ?? ({} as any);
    if (!driverId || lat == null || lng == null) return;

    const claimed = await this.redis.client.set(
      sweepKey(driverId),
      '1',
      'EX',
      SWEEP_THROTTLE_SECONDS,
      'NX',
    );
    if (claimed !== 'OK') return;

    const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver || driver.isBlocked || driver.kycStatus !== 'APPROVED') return;

    const held = await this.prisma.order.count({
      where: { driverId, status: { in: DRIVER_ACTIVE_STATUSES } },
    });
    if (held >= MAX_RESERVED_ORDERS_PER_DRIVER) return;

    const open = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.SEARCHING_FOR_DRIVER,
        driverId: null,
        vehicleType: driver.vehicleType,
        userId: { not: driver.userId },
        // Never re-announce something this driver has already dismissed.
        driverActions: { none: { driverId, action: 'SKIPPED' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const within = open
      .filter((order) => {
        const radius = order.searchRadiusKm ?? INITIAL_DRIVER_RADIUS_KM;
        return haversineKm(lat, lng, order.pickupLat, order.pickupLng) <= radius;
      })
      // One notification per order, and a driver deciding at a junction can
      // hold about three of them in their head. The rest are in the grid the
      // moment they open the app — which the first notification prompts.
      .slice(0, MAX_SWEEP_ANNOUNCEMENTS);

    if (within.length === 0) return;

    let announced = 0;
    for (const order of within) {
      const fresh = await this.announce(
        order,
        [{ driverId, distanceKm: null }],
        order.searchRadiusKm ?? INITIAL_DRIVER_RADIUS_KM,
      );
      announced += fresh.length;
    }

    if (announced > 0) {
      this.logger.log(`Swept ${announced} open order(s) to driver ${driverId}`);
    }
  }

  // --------------------------------------------------------------- targeting

  /**
   * Drivers who could actually take this order right now.
   *
   * Redis answers "who is near and alive"; Postgres answers "who is approved,
   * unblocked, online and not already full". A driver at capacity is dropped
   * here rather than in the grid, so the announcement itself never reaches
   * someone who cannot act on it.
   */
  private async eligibleDrivers(order: Order, radiusKm: number): Promise<DispatchTarget[]> {
    const nearby = await this.drivers.nearbyDrivers({
      lat: order.pickupLat,
      lng: order.pickupLng,
      radiusKm,
      limit: 30,
      vehicleType: order.vehicleType,
    });

    if (nearby.length === 0) return [];

    const ids = nearby.map((driver) => driver.driverId);

    // One grouped count instead of a query per driver.
    const loads = await this.prisma.order.groupBy({
      by: ['driverId'],
      where: { driverId: { in: ids }, status: { in: DRIVER_ACTIVE_STATUSES } },
      _count: { _all: true },
    });

    const heldById = new Map(loads.map((row) => [row.driverId!, row._count._all]));

    // A driver must never be offered their own booking.
    const owner = await this.prisma.driver.findUnique({
      where: { userId: order.userId },
      select: { id: true },
    });

    return nearby
      .filter((driver) => driver.driverId !== owner?.id)
      .filter((driver) => (heldById.get(driver.driverId) ?? 0) < MAX_RESERVED_ORDERS_PER_DRIVER)
      .map((driver) => ({ driverId: driver.driverId, distanceKm: driver.distanceKm }));
  }
}
