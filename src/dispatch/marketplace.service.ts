import { Injectable, Logger } from '@nestjs/common';
import { Driver, KycStatus, Order, OrderStatus, Prisma } from '@prisma/client';
import { boundingBox, haversineKm } from '../common/geo.util';
import { CONTACT_USER_SELECT } from '../common/prisma.selects';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ServiceResult,
  badRequest,
  conflict,
  forbidden,
  notFound,
  ok,
} from '../common/responses/response.types';
import { DriversService } from '../drivers/drivers.service';
import { RideEventsService } from '../events/ride-events.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALLOW_INCOMPATIBLE_RESERVATION,
  DRIVER_ACTIVE_STATUSES,
  INITIAL_DRIVER_RADIUS_KM,
  LEGACY_ACTIVE_STATUSES,
  MARKETPLACE_PAGE_SIZE,
  MAX_RESERVED_ORDERS_PER_DRIVER,
  SKIP_COOLDOWN_MINUTES,
} from './dispatch.constants';
import { DispatchStatus, deriveDispatchStatus } from './driver-status.util';
import { MarketplaceQueryDto } from './dto/marketplace.dto';
import { CompatibilityResult, OrderCompatibilityService } from './order-compatibility.service';
import { RouteOptimizerService } from './route-optimizer.service';
import { Point, RoutableOrder, bestRouteLengthKm, stopsFor } from './route.util';

export interface MarketplaceCard {
  id: string;
  vehicleType: string;
  description: string | null;
  pickupLocation: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLocation: string;
  dropoffLat: number;
  dropoffLng: number;
  distanceKm: number;
  durationMins: number;
  earnings: number;
  fare: number;
  currency: string;
  paymentMethod: string;
  createdAt: Date;
  ageSeconds: number;
  compatibility: CompatibilityResult;
}

const ACTIVE_ORDER_INCLUDE = {
  user: { select: CONTACT_USER_SELECT },
} satisfies Prisma.OrderInclude;

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);

  constructor(
    private prisma: PrismaService,
    private drivers: DriversService,
    private routes: RouteOptimizerService,
    private compatibility: OrderCompatibilityService,
    private events: RideEventsService,
    private response: ResponsesService,
  ) {}

  async available(userId: string, query: MarketplaceQueryDto): Promise<ServiceResult> {
    try {
      const gate = await this.requireWorkingDriver(userId);
      if (gate.error) return gate;

      const driver = gate.body as Driver;

      const origin = await this.resolveOrigin(driver, query);
      if (!origin) {
        return badRequest('We do not know where you are yet — turn location on and try again');
      }

      const currentOrders = await this.routes.activeOrders(driver.id);

      if (currentOrders.length >= MAX_RESERVED_ORDERS_PER_DRIVER) {
        return ok({
          orders: [],
          held: currentOrders.length,
          capacity: MAX_RESERVED_ORDERS_PER_DRIVER,
          atCapacity: true,
        });
      }

      const radiusKm = query.radiusKm ?? INITIAL_DRIVER_RADIUS_KM;
      const limit = query.limit ?? MARKETPLACE_PAGE_SIZE;

      const candidates = await this.openOrdersNear(driver, origin, radiusKm, limit);

      const speedKph = await this.routes.speedFor(driver.vehicleType);
      const baselineKm = bestRouteLengthKm(
        origin,
        currentOrders.flatMap((order) => stopsFor(order as unknown as RoutableOrder)),
      );

      const scored: MarketplaceCard[] = [];

      for (const order of candidates) {
        const compatibility = await this.compatibility.evaluate({
          driverId: driver.id,
          vehicleType: driver.vehicleType,
          origin,
          currentOrders,
          candidate: order as unknown as RoutableOrder,
          baselineKm,
          speedKph,
        });

        scored.push(this.toCard(order, compatibility));
      }

      scored.sort(rankCards);

      return ok({
        orders: scored.slice(0, limit),
        held: currentOrders.length,
        capacity: MAX_RESERVED_ORDERS_PER_DRIVER,
        atCapacity: false,
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async reserve(orderId: string, userId: string): Promise<ServiceResult> {
    try {
      const gate = await this.requireWorkingDriver(userId);
      if (gate.error) return gate;

      const driver = gate.body as Driver;

      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return notFound('Order not found');

      if (order.status !== OrderStatus.SEARCHING_FOR_DRIVER || order.driverId) {
        return conflict('ORDER_ALREADY_RESERVED');
      }
      if (order.userId === driver.userId) return badRequest('You cannot take your own order');
      if (order.vehicleType !== driver.vehicleType) {
        return badRequest(
          `This order needs a ${order.vehicleType.toLowerCase()}, you are driving a ${driver.vehicleType.toLowerCase()}`,
        );
      }

      const origin = await this.routes.driverPosition(driver.id, driver.vehicleType);
      if (!origin) return badRequest('We do not know where you are yet');

      const currentOrders = await this.routes.activeOrders(driver.id);

      const compatibility = await this.compatibility.evaluate({
        driverId: driver.id,
        vehicleType: driver.vehicleType,
        origin,
        currentOrders,
        candidate: order as unknown as RoutableOrder,
      });

      if (!compatibility.compatible && !ALLOW_INCOMPATIBLE_RESERVATION) {
        if (currentOrders.length >= MAX_RESERVED_ORDERS_PER_DRIVER) {
          return badRequest('MAX_ORDER_CAPACITY_REACHED');
        }
        return badRequest(compatibility.reason);
      }

      const outcome = await this.claim(orderId, driver.id);

      if (outcome === 'CAPACITY') return badRequest('MAX_ORDER_CAPACITY_REACHED');
      if (outcome === 'TAKEN') return conflict('ORDER_ALREADY_RESERVED');

      const reserved = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          user: { select: CONTACT_USER_SELECT },
          driver: { include: { user: { select: CONTACT_USER_SELECT } } },
        },
      });

      const eta = reserved ? await this.routes.customerEta(reserved) : null;

      this.events.emit('order.reserved', {
        order: reserved,
        driverId: driver.id,
        eta,
        heldByDriver: currentOrders.length + 1,
      });

      return ok({
        order: reserved,
        compatibility,
        held: currentOrders.length + 1,
        capacity: MAX_RESERVED_ORDERS_PER_DRIVER,
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  private async claim(orderId: string, driverId: string): Promise<'OK' | 'TAKEN' | 'CAPACITY'> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Driver" WHERE id = ${driverId} FOR UPDATE`;

      const held = await tx.order.count({
        where: { driverId, status: { in: DRIVER_ACTIVE_STATUSES } },
      });
      if (held >= MAX_RESERVED_ORDERS_PER_DRIVER) return 'CAPACITY';

      const now = new Date();

      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.SEARCHING_FOR_DRIVER, driverId: null },
        data: {
          driverId,
          status: OrderStatus.RESERVED,
          reservedAt: now,
          acceptedAt: now,
        },
      });

      if (claimed.count === 0) return 'TAKEN';

      await tx.driverOrderAction.upsert({
        where: { orderId_driverId: { orderId, driverId } },
        create: { orderId, driverId, action: 'RESERVED' },
        update: { action: 'RESERVED', hiddenUntil: null },
      });

      await tx.driver.update({
        where: { id: driverId },
        data: { acceptedTrips: { increment: 1 } },
      });

      return 'OK';
    });
  }

  async skip(orderId: string, userId: string): Promise<ServiceResult> {
    try {
      const found = await this.drivers.requireDriverForUser(userId);
      if (found.error) return found;

      const driver = found.body as Driver;

      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true },
      });
      if (!order) return notFound('Order not found');

      const hiddenUntil =
        SKIP_COOLDOWN_MINUTES > 0
          ? new Date(Date.now() + SKIP_COOLDOWN_MINUTES * 60_000)
          : null;

      await this.prisma.driverOrderAction.upsert({
        where: { orderId_driverId: { orderId, driverId: driver.id } },
        create: { orderId, driverId: driver.id, action: 'SKIPPED', hiddenUntil },
        update: { action: 'SKIPPED', hiddenUntil },
      });

      return ok({ orderId, skipped: true, hiddenUntil });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async activeOrders(userId: string): Promise<ServiceResult> {
    try {
      const found = await this.drivers.requireDriverForUser(userId);
      if (found.error) return found;

      const driver = found.body as Driver;

      const orders = await this.prisma.order.findMany({
        where: { driverId: driver.id, status: { in: DRIVER_ACTIVE_STATUSES } },
        include: ACTIVE_ORDER_INCLUDE,
        orderBy: { reservedAt: 'asc' },
      });

      const plan = await this.routes.planFor(driver.id, driver.vehicleType, { orders });

      return ok({
        orders: orders.map((order) => ({
          ...order,
          deliveryEtaMinutes: plan?.deliveryEtaByOrder[order.id] ?? null,
          pickupEtaMinutes: plan?.pickupEtaByOrder[order.id] ?? null,
        })),
        route: plan,
        held: orders.length,
        capacity: MAX_RESERVED_ORDERS_PER_DRIVER,
        status: await this.dispatchStatus(driver, orders.length),
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async dispatchStatus(driver: Driver, heldCount?: number): Promise<DispatchStatus> {
    if (!driver.isAvailable || driver.isBlocked || driver.kycStatus !== KycStatus.APPROVED) {
      return 'OFFLINE';
    }

    const held =
      heldCount ??
      (await this.prisma.order.count({
        where: { driverId: driver.id, status: { in: DRIVER_ACTIVE_STATUSES } },
      }));

    const legacy =
      held >= MAX_RESERVED_ORDERS_PER_DRIVER
        ? 0
        : await this.prisma.order.count({
            where: { driverId: driver.id, status: { in: LEGACY_ACTIVE_STATUSES } },
          });

    return deriveDispatchStatus({
      isAvailable: driver.isAvailable,
      isBlocked: driver.isBlocked,
      debtLocked: this.drivers.debtStatus(driver).locked,
      kycStatus: driver.kycStatus,
      heldCount: held,
      legacyCount: legacy,
    });
  }

  async skipped(userId: string, limit = 50): Promise<ServiceResult> {
    try {
      const found = await this.drivers.requireDriverForUser(userId);
      if (found.error) return found;

      const driver = found.body as Driver;

      const actions = await this.prisma.driverOrderAction.findMany({
        where: { driverId: driver.id, action: 'SKIPPED' },
        include: { order: { select: SKIPPED_ORDER_SELECT } },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });

      return ok(actions);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  private async requireWorkingDriver(userId: string): Promise<ServiceResult<Driver | string>> {
    const found = await this.drivers.requireDriverForUser(userId);
    if (found.error) return found;

    const driver = found.body as Driver;

    const blocked = this.drivers.workBlockReason(driver);
    if (blocked) return forbidden(blocked);
    if (!driver.isAvailable) return badRequest('Go online to see available orders');

    return ok(driver);
  }

  private async resolveOrigin(driver: Driver, query: MarketplaceQueryDto): Promise<Point | null> {
    if (query.lat != null && query.lng != null) return { lat: query.lat, lng: query.lng };
    return this.routes.driverPosition(driver.id, driver.vehicleType);
  }

  private async openOrdersNear(
    driver: Driver,
    origin: Point,
    radiusKm: number,
    limit: number,
  ): Promise<Order[]> {
    const box = boundingBox(origin.lat, origin.lng, radiusKm);
    const now = new Date();

    const candidates = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.SEARCHING_FOR_DRIVER,
        driverId: null,
        vehicleType: driver.vehicleType,
        userId: { not: driver.userId },
        pickupLat: { gte: box.minLat, lte: box.maxLat },
        pickupLng: { gte: box.minLng, lte: box.maxLng },
        driverActions: {
          none: {
            driverId: driver.id,
            action: 'SKIPPED',
            OR: [{ hiddenUntil: null }, { hiddenUntil: { gt: now } }],
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(limit * 4, 40),
    });

    return candidates.filter(
      (order) => haversineKm(origin.lat, origin.lng, order.pickupLat, order.pickupLng) <= radiusKm,
    );
  }

  private toCard(order: Order, compatibility: CompatibilityResult): MarketplaceCard {
    return {
      id: order.id,
      vehicleType: order.vehicleType,
      description: order.description,
      pickupLocation: order.pickupLocation,
      pickupLat: order.pickupLat,
      pickupLng: order.pickupLng,
      dropoffLocation: order.dropoffLocation,
      dropoffLat: order.dropoffLat,
      dropoffLng: order.dropoffLng,
      distanceKm: order.distanceKm,
      durationMins: order.durationMins,
      earnings: order.driverEarnings,
      fare: order.fare,
      currency: order.currency,
      paymentMethod: order.paymentMethod,
      createdAt: order.createdAt,
      ageSeconds: Math.max(0, Math.round((Date.now() - order.createdAt.getTime()) / 1000)),
      compatibility,
    };
  }
}

const SKIPPED_ORDER_SELECT = {
  id: true,
  pickupLocation: true,
  dropoffLocation: true,
  distanceKm: true,
  fare: true,
  driverEarnings: true,
  currency: true,
  status: true,
  createdAt: true,
} satisfies Prisma.OrderSelect;

function rankCards(a: MarketplaceCard, b: MarketplaceCard): number {
  if (a.compatibility.compatible !== b.compatibility.compatible) {
    return a.compatibility.compatible ? -1 : 1;
  }
  if (b.compatibility.routeScore !== a.compatibility.routeScore) {
    return b.compatibility.routeScore - a.compatibility.routeScore;
  }
  return a.compatibility.pickupDistanceKm - b.compatibility.pickupDistanceKm;
}
