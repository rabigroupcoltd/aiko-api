import { Injectable, Logger } from '@nestjs/common';
import { Order, VehicleType } from '@prisma/client';
import { PricingService } from '../pricing/pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { DEFAULT_AVG_SPEED_KPH, DRIVER_ACTIVE_STATUSES } from './dispatch.constants';
import {
  Point,
  RoutePlan,
  RoutableOrder,
  planRoute,
  stopsFor,
} from './route.util';

/**
 * The driver's current plan: which stop next, and when everything lands.
 *
 * Owns the two things `route.util` cannot compute on its own — where the driver
 * actually is, and how fast their vehicle is assumed to travel — so callers only
 * ever hand it a driver id.
 *
 * Recomputed on demand rather than stored. §47 asks for compatibility work only
 * at the moments it can change, and the route is cheap enough (six stops) that
 * caching it would cost more in staleness than it saves in CPU.
 */
@Injectable()
export class RouteOptimizerService {
  private readonly logger = new Logger(RouteOptimizerService.name);

  /** Per-vehicle planning speed, from the pricing rule. Refreshed lazily. */
  private speeds = new Map<VehicleType, number>();

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private pricing: PricingService,
  ) {}

  /** Where the driver is right now, from Redis, falling back to the last flush. */
  async driverPosition(driverId: string): Promise<Point | null> {
    const live = await this.redis.getDriverLocation(driverId);
    // The Redis response types lat/lng as nullable — GEOPOS answers for a driver
    // it has never seen. `live` being non-null does not mean it has coordinates.
    if (live?.lat != null && live.lng != null) return { lat: live.lat, lng: live.lng };

    const stored = await this.prisma.driverLocation.findUnique({ where: { driverId } });
    return stored ? { lat: stored.latitude, lng: stored.longitude } : null;
  }

  /** Every order occupying a capacity slot, oldest commitment first. */
  async activeOrders(driverId: string): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { driverId, status: { in: DRIVER_ACTIVE_STATUSES } },
      orderBy: { reservedAt: 'asc' },
    });
  }

  /**
   * Planning speed for a vehicle type.
   *
   * The same `avgSpeedKph` the fare quote uses, so a driver's ETA and the
   * customer's quoted duration cannot contradict each other.
   */
  async speedFor(vehicleType: VehicleType): Promise<number> {
    const cached = this.speeds.get(vehicleType);
    if (cached) return cached;

    const rule = await this.pricing.getActiveRule(vehicleType);
    const speed =
      rule.error || !rule.body || typeof rule.body === 'string'
        ? DEFAULT_AVG_SPEED_KPH
        : rule.body.avgSpeedKph || DEFAULT_AVG_SPEED_KPH;

    this.speeds.set(vehicleType, speed);
    return speed;
  }

  /**
   * The route as it stands, optionally with a candidate order folded in.
   *
   * `extra` is how the compatibility check asks "what would this look like if I
   * took that job" without writing anything.
   */
  async planFor(
    driverId: string,
    vehicleType: VehicleType,
    options: { orders?: Order[]; origin?: Point | null; extra?: RoutableOrder } = {},
  ): Promise<RoutePlan | null> {
    const origin = options.origin ?? (await this.driverPosition(driverId));
    if (!origin) return null;

    const orders = options.orders ?? (await this.activeOrders(driverId));
    const speed = await this.speedFor(vehicleType);

    const stops = orders.flatMap((order) => stopsFor(order as unknown as RoutableOrder));
    if (options.extra) stops.push(...stopsFor(options.extra));

    if (stops.length === 0) {
      return { stops: [], totalKm: 0, totalMinutes: 0, deliveryEtaByOrder: {}, pickupEtaByOrder: {} };
    }

    return planRoute(origin, stops, speed);
  }

  /**
   * When this order's customer should expect their driver — §39.
   *
   * Deliberately not `driver → pickup`: a driver carrying two other orders will
   * reach this pickup after whatever the route puts in front of it, and quoting
   * the straight line would promise a time the driver cannot keep.
   */
  async customerEta(order: Order): Promise<{ pickupMinutes: number | null; deliveryMinutes: number | null }> {
    if (!order.driverId) return { pickupMinutes: null, deliveryMinutes: null };

    const plan = await this.planFor(order.driverId, order.vehicleType);
    if (!plan) return { pickupMinutes: null, deliveryMinutes: null };

    return {
      pickupMinutes: plan.pickupEtaByOrder[order.id] ?? null,
      deliveryMinutes: plan.deliveryEtaByOrder[order.id] ?? null,
    };
  }
}
