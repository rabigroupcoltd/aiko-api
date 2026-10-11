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

export interface DispatchTarget {
  driverId: string;
  distanceKm: number | null;
}

const ANNOUNCE_MEMORY_SECONDS = 3600;
const announcedKey = (driverId: string, orderId: string) =>
  `dispatch:announced:${driverId}:${orderId}`;

const SWEEP_THROTTLE_SECONDS = Number(process.env.DRIVER_SWEEP_THROTTLE || 30);
const sweepKey = (driverId: string) => `dispatch:sweep:${driverId}`;

const MAX_SWEEP_ANNOUNCEMENTS = Number(process.env.MAX_SWEEP_ANNOUNCEMENTS || 3);

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
    this.events.on<any>('driver.available').subscribe(({ payload }) => {
      this.sweepForDriver(payload).catch((e) =>
        this.logger.warn(`Marketplace sweep for ${payload?.driverId} failed: ${e?.message}`),
      );
    });
  }

  async dispatch(order: Order): Promise<DispatchTarget[]> {
    const radiusKm = order.searchRadiusKm ?? INITIAL_DRIVER_RADIUS_KM;

    const targets = await this.eligibleDrivers(order, radiusKm);
    await this.announce(order, targets, radiusKm);

    await this.queues.scheduleOrderExpansion(order.id, 1, DISPATCH_EXPAND_DELAY_MS);

    this.logger.log(
      `Order ${order.id} dispatched to ${targets.length} driver(s) within ${radiusKm} km`,
    );

    return targets;
  }

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

    await this.redis.addOfferedDrivers(
      order.id,
      fresh.map((target) => target.driverId),
    );

    this.events.emit('order.available', { order, drivers: fresh, radiusKm });
    return fresh;
  }

  async expandSearch(orderId: string, attempt: number): Promise<DispatchTarget[] | null> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });

    if (!order) return null;
    if (order.status !== OrderStatus.SEARCHING_FOR_DRIVER || order.driverId) return null;

    const previous = order.searchRadiusKm ?? INITIAL_DRIVER_RADIUS_KM;
    const widened = Math.min(previous * RADIUS_EXPANSION_FACTOR, MAX_DRIVER_RADIUS_KM);

    if (attempt > MAX_DISPATCH_ATTEMPTS || previous >= MAX_DRIVER_RADIUS_KM) {
      await this.giveUp(order);
      return null;
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { searchRadiusKm: widened, dispatchAttempts: attempt },
    });

    const targets = await this.eligibleDrivers(updated, widened);
    const fresh = await this.announce(updated, targets, widened);

    await this.queues.scheduleOrderExpansion(orderId, attempt + 1, DISPATCH_EXPAND_DELAY_MS);

    this.logger.log(
      `Order ${orderId} widened to ${widened} km on attempt ${attempt} — ` +
        `${targets.length} eligible, ${fresh.length} newly notified`,
    );

    return fresh;
  }

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
    if (!driver || this.drivers.workBlockReason(driver)) return;

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

    const loads = await this.prisma.order.groupBy({
      by: ['driverId'],
      where: { driverId: { in: ids }, status: { in: DRIVER_ACTIVE_STATUSES } },
      _count: { _all: true },
    });

    const heldById = new Map(loads.map((row) => [row.driverId!, row._count._all]));

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
