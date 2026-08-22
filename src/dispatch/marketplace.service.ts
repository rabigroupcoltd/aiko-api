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

/** What a driver sees before they have committed to anything. */
export interface MarketplaceCard {
  id: string;
  vehicleType: string;
  /** What the passenger is sending. Null on orders raised before the field existed. */
  description: string | null;
  pickupLocation: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLocation: string;
  dropoffLat: number;
  dropoffLng: number;
  distanceKm: number;
  durationMins: number;
  /** What the driver keeps, not what the customer pays. */
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

/**
 * The driver-facing half of the marketplace: browse, reserve, skip, and the
 * route across everything currently held.
 *
 * The database is the source of truth throughout. Nothing here trusts a
 * client-supplied price, driver id, order ownership or capacity count — §46 —
 * and the one operation that can race is settled by a conditional UPDATE rather
 * than a read-then-write.
 */
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

  // --------------------------------------------------------------- browsing

  /**
   * Open orders around the driver, best fit first.
   *
   * Ranking is §17 in order of precedence: orders the engine rejected sink below
   * every order it accepted, and within each group the composite route score
   * decides — which already folds in pickup proximity, detour and the delay to
   * customers the driver has already taken on.
   */
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

      // At capacity the grid is empty by definition, and saying so is more use
      // to the driver than an unexplained blank screen.
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

      // Hoisted: every candidate is measured against the same baseline route and
      // the same planning speed, so neither is recomputed per order.
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

  // -------------------------------------------------------------- reserving

  /**
   * Claim an order.
   *
   * Two invariants, enforced in the only place that can enforce them:
   *
   * ONE ORDER → ONE DRIVER is the conditional UPDATE. Postgres takes a row lock
   * on the matched order; a second driver arriving mid-flight blocks, then
   * re-evaluates `status = SEARCHING_FOR_DRIVER AND driverId IS NULL` against the
   * committed row and matches nothing. `count === 0` is the loser, every time.
   * There is no read-then-write window for two winners to slip through.
   *
   * ONE DRIVER → AT MOST N ORDERS is the `SELECT … FOR UPDATE` on the driver row.
   * Two orders claimed by the same driver at the same instant lock different
   * order rows, so the first invariant says nothing about them — the driver row
   * is the shared object, and holding it makes the count-then-claim atomic.
   */
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

      /**
       * Checked here rather than trusted from the grid the driver was looking
       * at: that grid may be seconds old, and the route it was scored against
       * may have changed when they accepted something else in between.
       */
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

      // One event, three consumers: the customer's socket, the customer's push,
      // and every other driver's grid — which must drop this card immediately.
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

  /**
   * The atomic core of a reservation. Returns which invariant, if any, stopped it.
   *
   * Everything inside runs in one transaction so the capacity count, the claim
   * and the audit row either all land or none do.
   */
  private async claim(orderId: string, driverId: string): Promise<'OK' | 'TAKEN' | 'CAPACITY'> {
    return this.prisma.$transaction(async (tx) => {
      // Serialises this driver's own concurrent accepts. Nothing else in the
      // codebase locks a driver row, so this cannot deadlock against a peer.
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
          // Kept in step so everything that already reads acceptance — analytics,
          // the admin dashboard, the driver's acceptance rate — still works.
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

  /**
   * Take an order out of this driver's grid without touching the order itself.
   *
   * A skip is a private preference: the order stays SEARCHING_FOR_DRIVER and
   * every other driver still sees it.
   */
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

  // ----------------------------------------------------------- active orders

  /**
   * Everything the driver is currently holding, plus the route across all of it.
   *
   * Each order keeps its own status, customer, price and contact details — §45.
   * The route is the only thing that treats them as a group, and it is derived,
   * not stored.
   */
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

  /** OFFLINE / AVAILABLE / BUSY — §26, derived rather than stored. */
  async dispatchStatus(driver: Driver, heldCount?: number): Promise<DispatchStatus> {
    // Short-circuit before querying: a driver who is offline, blocked or
    // unapproved is OFFLINE whatever they are holding.
    if (!driver.isAvailable || driver.isBlocked || driver.kycStatus !== KycStatus.APPROVED) {
      return 'OFFLINE';
    }

    const held =
      heldCount ??
      (await this.prisma.order.count({
        where: { driverId: driver.id, status: { in: DRIVER_ACTIVE_STATUSES } },
      }));

    // Only reached when the driver is otherwise eligible, so the legacy count
    // is the one remaining question.
    const legacy =
      held >= MAX_RESERVED_ORDERS_PER_DRIVER
        ? 0
        : await this.prisma.order.count({
            where: { driverId: driver.id, status: { in: LEGACY_ACTIVE_STATUSES } },
          });

    return deriveDispatchStatus({
      isAvailable: driver.isAvailable,
      isBlocked: driver.isBlocked,
      kycStatus: driver.kycStatus,
      heldCount: held,
      legacyCount: legacy,
    });
  }

  /** Orders this driver skipped, for the history tab. */
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

  // ---------------------------------------------------------------- helpers

  /** A driver who is allowed to be offered work at all. */
  private async requireWorkingDriver(userId: string): Promise<ServiceResult<Driver | string>> {
    const found = await this.drivers.requireDriverForUser(userId);
    if (found.error) return found;

    const driver = found.body as Driver;

    if (driver.kycStatus !== KycStatus.APPROVED) return forbidden('Your KYC is not approved yet');
    if (driver.isBlocked) return forbidden('Your account is blocked due to outstanding debt');
    if (!driver.isAvailable) return badRequest('Go online to see available orders');

    return ok(driver);
  }

  /**
   * The driver's position for this request.
   *
   * A client-supplied fix is preferred when present — it is fresher than
   * anything the server has — but it is only ever used to place the driver, and
   * never to decide what they are allowed to do.
   */
  private async resolveOrigin(driver: Driver, query: MarketplaceQueryDto): Promise<Point | null> {
    if (query.lat != null && query.lng != null) return { lat: query.lat, lng: query.lng };
    return this.routes.driverPosition(driver.id, driver.vehicleType);
  }

  /**
   * Unclaimed orders whose pickup falls inside the radius.
   *
   * The bounding box narrows the read; haversine trims the corners it adds.
   * Orders this driver skipped never enter the set, and neither do their own.
   */
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
      // The box over-selects and the haversine pass can only shrink the list, so
      // this is bounded independently of `limit`.
      take: Math.max(limit * 4, 40),
    });

    return candidates.filter(
      (order) => haversineKm(origin.lat, origin.lng, order.pickupLat, order.pickupLng) <= radiusKm,
    );
  }

  /**
   * An open order as a driver may see it.
   *
   * §9: nothing identifying the customer. No name, no phone, no user id — those
   * arrive with the reservation, once this driver is the one handling it.
   */
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

/**
 * Compatible before incompatible, then best score, then closest pickup.
 *
 * The first key is what makes §38 work: a ₦3,500 order with a 6.8 km detour
 * sorts below a ₦2,000 one with 1.4 km, because the driver's take-home is the
 * fare minus the fuel to reach it — and the score already knows that.
 */
function rankCards(a: MarketplaceCard, b: MarketplaceCard): number {
  if (a.compatibility.compatible !== b.compatibility.compatible) {
    return a.compatibility.compatible ? -1 : 1;
  }
  if (b.compatibility.routeScore !== a.compatibility.routeScore) {
    return b.compatibility.routeScore - a.compatibility.routeScore;
  }
  return a.compatibility.pickupDistanceKm - b.compatibility.pickupDistanceKm;
}
