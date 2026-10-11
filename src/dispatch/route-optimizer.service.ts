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

@Injectable()
export class RouteOptimizerService {
  private readonly logger = new Logger(RouteOptimizerService.name);

  private speeds = new Map<VehicleType, number>();

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private pricing: PricingService,
  ) {}

  async driverPosition(driverId: string, vehicleType?: VehicleType): Promise<Point | null> {
    const live = await this.redis.getDriverLocation(driverId, vehicleType);
    if (live?.lat != null && live.lng != null) return { lat: live.lat, lng: live.lng };

    const stored = await this.prisma.driverLocation.findUnique({ where: { driverId } });
    return stored ? { lat: stored.latitude, lng: stored.longitude } : null;
  }

  async activeOrders(driverId: string): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { driverId, status: { in: DRIVER_ACTIVE_STATUSES } },
      orderBy: { reservedAt: 'asc' },
    });
  }

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

  async planFor(
    driverId: string,
    vehicleType: VehicleType,
    options: { orders?: Order[]; origin?: Point | null; extra?: RoutableOrder } = {},
  ): Promise<RoutePlan | null> {
    const origin = options.origin ?? (await this.driverPosition(driverId, vehicleType));
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
