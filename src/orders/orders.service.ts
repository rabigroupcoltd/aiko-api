import { Injectable, Logger } from '@nestjs/common';
import {
  Driver,
  KycStatus,
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PricingRule,
  Prisma,
  VehicleType,
} from '@prisma/client';
import { JwtUser } from '../common/current-user.decorator';
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
import { DispatchService } from '../dispatch/dispatch.service';
import {
  DRIVER_ACTIVE_STATUSES,
  INITIAL_DRIVER_RADIUS_KM,
  MAX_RESERVED_ORDERS_PER_DRIVER,
} from '../dispatch/dispatch.constants';
import { RouteOptimizerService } from '../dispatch/route-optimizer.service';
import { DriversService } from '../drivers/drivers.service';
import { RideEventsService } from '../events/ride-events.service';
import { FareQuote, PricingService } from '../pricing/pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreateOrderDto, ListOrdersQueryDto, RateOrderDto, SendMessageDto } from './dto/order.dto';

/**
 * Two lanes, one map. Terminal states have no outgoing transitions.
 *
 * The ride lane (PENDING → … → COMPLETED) is unchanged. The marketplace lane
 * (SEARCHING_FOR_DRIVER → … → DELIVERED) is added alongside it rather than
 * replacing it, because the bid flow still produces the first kind.
 *
 * Note SEARCHING_FOR_DRIVER has no direct edge to RESERVED: reserving is not a
 * status update, it is the atomic claim in MarketplaceService, and routing it
 * through here would reintroduce the read-then-write race that claim exists to
 * eliminate.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
  [OrderStatus.ACCEPTED]: [OrderStatus.ARRIVED, OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED],
  [OrderStatus.ARRIVED]: [OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED],
  [OrderStatus.IN_PROGRESS]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],

  [OrderStatus.SEARCHING_FOR_DRIVER]: [OrderStatus.CANCELLED, OrderStatus.NO_DRIVER_FOUND],
  [OrderStatus.RESERVED]: [
    OrderStatus.DRIVER_ARRIVING_PICKUP,
    // A driver already at the pickup can collect without announcing the leg.
    OrderStatus.PICKED_UP,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.DRIVER_ARRIVING_PICKUP]: [OrderStatus.PICKED_UP, OrderStatus.CANCELLED],
  [OrderStatus.PICKED_UP]: [OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.IN_TRANSIT]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.NO_DRIVER_FOUND]: [],
};

/** Statuses that settle the order's money and free the driver's capacity slot. */
const SETTLING_STATUSES: OrderStatus[] = [OrderStatus.COMPLETED, OrderStatus.DELIVERED];

/**
 * Past this point the customer can no longer call it off themselves.
 *
 * §31: once the driver physically holds the order, unwinding it is an operations
 * problem, not a button.
 */
const CUSTOMER_CANCELLABLE: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.SEARCHING_FOR_DRIVER,
  OrderStatus.ACCEPTED,
  OrderStatus.ARRIVED,
  OrderStatus.RESERVED,
  OrderStatus.DRIVER_ARRIVING_PICKUP,
];

/** Stages only the driver holding the order may declare. */
const DRIVER_ONLY_TRANSITIONS: OrderStatus[] = [
  OrderStatus.DRIVER_ARRIVING_PICKUP,
  OrderStatus.PICKED_UP,
  OrderStatus.IN_TRANSIT,
  OrderStatus.DELIVERED,
  OrderStatus.ARRIVED,
  OrderStatus.IN_PROGRESS,
  OrderStatus.COMPLETED,
];

/** Nothing more happens on an order in one of these. */
const CLOSED_STATUSES: OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.NO_DRIVER_FOUND,
];

const ORDER_INCLUDE = {
  user: { select: CONTACT_USER_SELECT },
  driver: { include: { user: { select: CONTACT_USER_SELECT } } },
} satisfies Prisma.OrderInclude;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private prisma: PrismaService,
    private pricing: PricingService,
    private drivers: DriversService,
    private redis: RedisService,
    private events: RideEventsService,
    private dispatch: DispatchService,
    private routes: RouteOptimizerService,
    private response: ResponsesService,
  ) {}

  /**
   * Fare, platform fee and driver earnings all come from the pricing rule.
   *
   * `dispatch` is what separates the two lanes. Left off, this is the original
   * direct booking and the order sits at PENDING. Set — which is what the
   * customer's Confirm Order button sends — the order opens at
   * SEARCHING_FOR_DRIVER and is announced to nearby drivers, who claim it
   * themselves.
   */
  async create(userId: string, dto: CreateOrderDto): Promise<ServiceResult> {
    try {
      const quoted = await this.pricing.estimate({
        vehicleType: dto.vehicleType,
        pickupLat: dto.pickupLat,
        pickupLng: dto.pickupLng,
        dropoffLat: dto.dropoffLat,
        dropoffLng: dto.dropoffLng,
      });
      if (quoted.error) return quoted as ServiceResult<string>;

      const quote = quoted.body as FareQuote;
      const toMarketplace = dto.dispatch === true;

      const order = await this.prisma.order.create({
        data: {
          userId,
          vehicleType: dto.vehicleType as VehicleType,
          description: dto.description,
          pickupLocation: dto.pickupLocation,
          dropoffLocation: dto.dropoffLocation,
          pickupLat: dto.pickupLat,
          pickupLng: dto.pickupLng,
          dropoffLat: dto.dropoffLat,
          dropoffLng: dto.dropoffLng,
          pickupPhone: dto.pickupPhone,
          dropoffPhone: dto.dropoffPhone,
          distanceKm: quote.distanceKm,
          durationMins: quote.durationMins,
          fare: quote.fare,
          currency: quote.currency,
          // Frozen so a later admin price change never rewrites a past trip.
          pricingSnapshot: quote.breakdown as unknown as Prisma.InputJsonValue,
          platformFee: quote.platformFee,
          driverEarnings: quote.driverEarnings,
          paymentMethod: dto.paymentMethod as PaymentMethod,
          ...(toMarketplace
            ? {
                status: OrderStatus.SEARCHING_FOR_DRIVER,
                searchRadiusKm: INITIAL_DRIVER_RADIUS_KM,
              }
            : {}),
          ...(dto.rideRequestId ? { rideRequest: { connect: { id: dto.rideRequestId } } } : {}),
        },
        include: ORDER_INCLUDE,
      });

      this.events.emit('order.created', order);

      // Fire and forget: the customer's order exists either way, and a dispatch
      // failure must not turn a created order into a 500. The widening worker
      // picks up anything the first pass missed.
      if (toMarketplace) {
        this.dispatch.dispatch(order).catch((e) =>
          this.logger.error(`Dispatch for order ${order.id} failed: ${e?.message ?? e}`),
        );
      }

      return ok(order);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Creates an order that is already assigned to a driver, off the back of an
   * accepted bid. `fareOverride` is only ever passed when bid pricing is on.
   */
  async createFromRideRequest(
    requestId: string,
    driverId: string,
    fareOverride?: number,
  ): Promise<ServiceResult> {
    try {
      const request = await this.prisma.rideRequest.findUnique({ where: { id: requestId } });
      if (!request) return notFound('Ride request not found');

      const ruleResult = await this.pricing.getActiveRule(request.vehicleType);
      if (ruleResult.error) return ruleResult as ServiceResult<string>;

      const rule = ruleResult.body as PricingRule;
      const quote = this.pricing.quoteFromRule(rule, request.distanceKm);

      const fare = fareOverride ?? quote.fare;
      const platformFee = Math.round((fare * rule.platformFeePercent) / 100);

      const order = await this.prisma.order.create({
        data: {
          userId: request.userId,
          driverId,
          vehicleType: request.vehicleType,
          pickupLocation: request.pickupLocation,
          dropoffLocation: request.dropoffLocation,
          pickupLat: request.pickupLat,
          pickupLng: request.pickupLng,
          dropoffLat: request.dropoffLat,
          dropoffLng: request.dropoffLng,
          distanceKm: request.distanceKm,
          durationMins: request.durationMins,
          fare,
          currency: quote.currency,
          pricingSnapshot: {
            ...quote.breakdown,
            fareOverridden: fareOverride != null,
          } as unknown as Prisma.InputJsonValue,
          platformFee,
          driverEarnings: fare - platformFee,
          paymentMethod: request.paymentMethod,
          status: OrderStatus.ACCEPTED,
          acceptedAt: new Date(),
        },
        include: ORDER_INCLUDE,
      });

      await this.prisma.driver.update({
        where: { id: driverId },
        data: { acceptedTrips: { increment: 1 } },
      });

      this.events.emit('order.accepted', order);
      return ok(order);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findAll(query: ListOrdersQueryDto, user: JwtUser): Promise<ServiceResult> {
    try {
      const where: Prisma.OrderWhereInput = {};

      if (query.status) where.status = query.status as OrderStatus;
      if (query.vehicleType) where.vehicleType = query.vehicleType as VehicleType;
      if (query.userId) where.userId = query.userId;
      if (query.driverId) where.driverId = query.driverId;

      // Non-admins only ever see their own trips, whichever side they are on.
      if (!user.roles?.includes('ADMIN')) {
        const driver = await this.prisma.driver.findUnique({ where: { userId: user.sub } });
        where.OR = driver ? [{ userId: user.sub }, { driverId: driver.id }] : [{ userId: user.sub }];
      }

      const limit = query.limit ?? 20;
      const offset = query.offset ?? 0;

      const [totalItems, result] = await this.prisma.$transaction([
        this.prisma.order.count({ where }),
        this.prisma.order.findMany({
          where,
          include: ORDER_INCLUDE,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
      ]);

      return ok(
        this.response.pagingData({ totalItems, result }, Math.floor(offset / limit) + 1, limit),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findOne(id: string, user?: JwtUser): Promise<ServiceResult> {
    try {
      const order = await this.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
      if (!order) return notFound('Order not found');

      if (user) {
        const allowed = await this.assertParticipant(order, user);
        if (allowed.error) return allowed;
      }

      return ok(order);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Atomic claim: the status guard inside updateMany means only one driver can
   * win a PENDING order, even with concurrent accepts.
   */
  async acceptOrder(orderId: string, userId: string): Promise<ServiceResult> {
    try {
      const found = await this.drivers.requireDriverForUser(userId);
      if (found.error) return found;

      const driver = found.body as Driver;

      if (driver.kycStatus !== KycStatus.APPROVED) return badRequest('Driver KYC not approved');
      if (driver.isBlocked) return badRequest('Driver is blocked due to debt');
      if (!driver.isAvailable) return badRequest('Driver is not available');

      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return notFound('Order not found');
      if (order.status !== OrderStatus.PENDING) return badRequest('Order is not available');

      if (order.vehicleType !== driver.vehicleType) {
        return badRequest(
          `This order requires a ${order.vehicleType}, your vehicle is a ${driver.vehicleType}`,
        );
      }

      const claim = await this.prisma.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING, driverId: null },
        data: { driverId: driver.id, status: OrderStatus.ACCEPTED, acceptedAt: new Date() },
      });

      if (claim.count === 0) return conflict('Order was already accepted by another driver');

      await this.prisma.driver.update({
        where: { id: driver.id },
        data: { acceptedTrips: { increment: 1 } },
      });

      const accepted = await this.findOne(orderId);
      if (accepted.error) return accepted;

      this.events.emit('order.accepted', accepted.body);
      return accepted;
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async updateStatus(
    orderId: string,
    status: OrderStatus,
    user: JwtUser,
    reason?: string,
  ): Promise<ServiceResult> {
    try {
      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return notFound('Order not found');

      const allowed = await this.assertParticipant(order, user);
      if (allowed.error) return allowed;

      if (!TRANSITIONS[order.status].includes(status)) {
        return badRequest(`Cannot move an order from ${order.status} to ${status}`);
      }

      // Everything past a reservation is the driver's to declare. A customer
      // must not be able to mark their own order picked up or delivered.
      if (DRIVER_ONLY_TRANSITIONS.includes(status)) {
        const isDriver = await this.isAssignedDriver(order, user);
        if (!isDriver && !user.roles?.includes('ADMIN')) {
          return forbidden('Only the assigned driver can move the order to this stage');
        }
      }

      if (SETTLING_STATUSES.includes(status)) return this.complete(order, status);
      if (status === OrderStatus.CANCELLED) return this.cancel(order, user, reason);

      const now = new Date();

      const updated = await this.prisma.order.update({
        where: { id: orderId },
        data: {
          status,
          ...(status === OrderStatus.ARRIVED ? { arrivedAt: now } : {}),
          ...(status === OrderStatus.IN_PROGRESS ? { startedAt: now } : {}),
          // The RESERVED → PICKED_UP boundary: the driver physically has it now.
          ...(status === OrderStatus.PICKED_UP ? { pickedUpAt: now, startedAt: now } : {}),
        },
        include: ORDER_INCLUDE,
      });

      this.events.emit('order.status-changed', updated);
      if (status === OrderStatus.PICKED_UP) this.events.emit('order.picked-up', updated);

      return ok(updated);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * The route across everything the caller's driver profile is holding, plus
   * ETAs — the same plan the marketplace's active view returns, exposed here so
   * a customer's tracking screen can be told when *their* order lands without
   * learning anything about the others on the route.
   */
  async customerEta(orderId: string, user: JwtUser): Promise<ServiceResult> {
    try {
      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return notFound('Order not found');

      const allowed = await this.assertParticipant(order, user);
      if (allowed.error) return allowed;

      const eta = await this.routes.customerEta(order);

      // §20: the customer learns that their driver has other work, and how long
      // it costs them — never what that other work is or who it belongs to.
      const otherOrders = order.driverId
        ? await this.prisma.order.count({
            where: {
              driverId: order.driverId,
              id: { not: order.id },
              status: { in: DRIVER_ACTIVE_STATUSES },
            },
          })
        : 0;

      return ok({ ...eta, driverHandlingOtherOrders: otherOrders > 0 });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Settlement runs in one transaction so the order, driver counters, wallet
   * and ledger entry can never disagree.
   *
   * CASH: the driver already holds the money, so the platform fee becomes debt.
   * BANK_TRANSFER: the platform holds the money, so earnings are credited.
   *
   * Scoped to one order, always. A driver finishing the second of three orders
   * settles exactly that order's fare and frees exactly one capacity slot — §22
   * and §34. There is no notion of settling a route.
   */
  private async complete(order: Order, status: OrderStatus): Promise<ServiceResult> {
    if (!order.driverId) return badRequest('Order has no assigned driver');

    const isCash = order.paymentMethod === PaymentMethod.CASH;

    const updated = await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.driverWallet.upsert({
        where: { driverId: order.driverId! },
        create: { driverId: order.driverId! },
        update: {},
      });

      const balanceAfter = isCash
        ? wallet.availableBalance
        : wallet.availableBalance + order.driverEarnings;

      await tx.driverWallet.update({
        where: { driverId: order.driverId! },
        data: isCash
          ? { totalDebt: { increment: order.platformFee } }
          : {
              totalEarnings: { increment: order.driverEarnings },
              availableBalance: { increment: order.driverEarnings },
            },
      });

      const driver = await tx.driver.update({
        where: { id: order.driverId! },
        data: {
          totalTrips: { increment: 1 },
          ...(isCash ? { currentDebt: { increment: order.platformFee } } : {}),
        },
      });

      await tx.ledgerTransaction.create({
        data: {
          driverId: order.driverId!,
          type: isCash ? 'PLATFORM_FEE' : 'RIDE_EARNINGS',
          amount: isCash ? -order.platformFee : order.driverEarnings,
          balanceAfter,
          reference: `ORDER-${order.id}`,
          description: isCash
            ? `Platform fee owed on cash trip ${order.id}`
            : `Ride earnings for trip ${order.id}`,
        },
      });

      // Debt gate: once over the limit the driver cannot take new trips.
      if (driver.currentDebt >= driver.debtLimit && !driver.isBlocked) {
        await tx.driver.update({
          where: { id: driver.id },
          data: { isBlocked: true, isAvailable: false },
        });
      }

      const now = new Date();

      return tx.order.update({
        where: { id: order.id },
        data: {
          status,
          completedAt: now,
          ...(status === OrderStatus.DELIVERED ? { deliveredAt: now } : {}),
          paymentStatus: PaymentStatus.PAID,
        },
        include: ORDER_INCLUDE,
      });
    });

    if (updated.driver?.isBlocked) {
      await this.redis.removeDriver(updated.driver.id);
    }

    this.events.emit('order.status-changed', updated);
    if (status === OrderStatus.DELIVERED) this.events.emit('order.delivered', updated);

    // A slot just freed. BUSY → AVAILABLE is derived, not stored, but the driver
    // still needs telling so their grid repopulates without a manual refresh —
    // and `driver.available` is the event the marketplace sweep already listens
    // for, so this reuses that path rather than inventing a second one.
    await this.announceCapacityFreed(updated.driverId);

    return ok(updated);
  }

  /**
   * Tells the dispatcher a driver has room again.
   *
   * Silent when the driver is still full, offline, or has no known position —
   * the sweep would find nothing to offer in any of those cases.
   */
  private async announceCapacityFreed(driverId: string | null): Promise<void> {
    if (!driverId) return;

    const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver?.isAvailable || driver.isBlocked) return;

    const held = await this.prisma.order.count({
      where: { driverId, status: { in: DRIVER_ACTIVE_STATUSES } },
    });
    if (held >= MAX_RESERVED_ORDERS_PER_DRIVER) return;

    const position = await this.redis.getDriverLocation(driverId, driver.vehicleType);
    if (!position) return;

    this.events.emit('driver.available', {
      driverId,
      userId: driver.userId,
      vehicleType: driver.vehicleType,
      lat: position.lat,
      lng: position.lng,
    });
  }

  /**
   * Cancellation rules, by who is asking and how far the order has gone — §31.
   *
   * Before a driver commits, a customer may simply withdraw. Once reserved they
   * still can, but it costs the driver a wasted trip, so it is attributed. Once
   * the driver physically has the parcel the customer cannot unwind it at all —
   * only the driver or an admin, who have to account for where it ended up.
   */
  private async cancel(order: Order, user: JwtUser, reason?: string): Promise<ServiceResult> {
    // Attribute the cancellation to the driver only when the driver is the one
    // cancelling — an admin cancelling on their behalf must not cost them.
    const assignedDriver = order.driverId
      ? await this.prisma.driver.findUnique({ where: { id: order.driverId } })
      : null;
    const cancelledByDriver = assignedDriver?.userId === user.sub;
    const isAdmin = Boolean(user.roles?.includes('ADMIN'));
    const cancelledByCustomer = order.userId === user.sub && !cancelledByDriver;

    if (cancelledByCustomer && !isAdmin && !CUSTOMER_CANCELLABLE.includes(order.status)) {
      return badRequest(
        'Your order has already been collected — contact support to sort it out',
      );
    }

    const uncommitted =
      order.status === OrderStatus.PENDING || order.status === OrderStatus.SEARCHING_FOR_DRIVER;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Only count it against the driver if they had already committed to the trip.
      if (order.driverId && cancelledByDriver && !uncommitted) {
        await tx.driver.update({
          where: { id: order.driverId },
          data: { cancelledTrips: { increment: 1 } },
        });
      }

      return tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason: reason,
        },
        include: ORDER_INCLUDE,
      });
    });

    this.events.emit('order.cancelled', updated);

    // A driver who dropped an order has a slot free again.
    if (order.driverId) await this.announceCapacityFreed(order.driverId);

    return ok(updated);
  }

  // -------------------------------------------------------------- messages

  async sendMessage(orderId: string, user: JwtUser, dto: SendMessageDto): Promise<ServiceResult> {
    try {
      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return notFound('Order not found');

      const allowed = await this.assertParticipant(order, user);
      if (allowed.error) return allowed;

      // §29: chat opens the moment a driver reserves and closes when the order
      // does. There is nobody on the other end before or after.
      if (CLOSED_STATUSES.includes(order.status)) return badRequest('This order is closed');
      if (!order.driverId) return badRequest('Chat opens once a driver takes your order');

      const message = await this.prisma.rideMessage.create({
        data: { orderId, senderId: user.sub, content: dto.content },
        include: { sender: { select: CONTACT_USER_SELECT } },
      });

      this.events.emit('order.message', message);
      return ok(message);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async getMessages(orderId: string, user: JwtUser): Promise<ServiceResult> {
    try {
      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return notFound('Order not found');

      const allowed = await this.assertParticipant(order, user);
      if (allowed.error) return allowed;

      const messages = await this.prisma.rideMessage.findMany({
        where: { orderId },
        include: { sender: { select: CONTACT_USER_SELECT } },
        orderBy: { createdAt: 'asc' },
      });

      return ok(messages);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  // --------------------------------------------------------------- ratings

  /** Rates the other party; a driver's aggregate is recomputed as a running mean. */
  async rate(orderId: string, user: JwtUser, dto: RateOrderDto): Promise<ServiceResult> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { driver: true },
      });
      if (!order) return notFound('Order not found');

      const allowed = await this.assertParticipant(order, user);
      if (allowed.error) return allowed;

      if (!SETTLING_STATUSES.includes(order.status)) {
        return badRequest('You can only rate a completed order');
      }

      const isPassenger = order.userId === user.sub;
      const rateeId = isPassenger ? order.driver?.userId : order.userId;
      if (!rateeId) return badRequest('Nobody to rate on this trip');

      const existing = await this.prisma.rideRating.findUnique({
        where: { orderId_raterId: { orderId, raterId: user.sub } },
      });
      if (existing) return conflict('You already rated this trip');

      const rating = await this.prisma.$transaction(async (tx) => {
        const created = await tx.rideRating.create({
          data: { orderId, raterId: user.sub, rateeId, score: dto.score, comment: dto.comment },
        });

        if (isPassenger && order.driver) {
          const { rating: current, ratingCount } = order.driver;
          const nextCount = ratingCount + 1;
          const nextRating = (current * ratingCount + dto.score) / nextCount;

          await tx.driver.update({
            where: { id: order.driver.id },
            data: { rating: Math.round(nextRating * 100) / 100, ratingCount: nextCount },
          });
        }

        return created;
      });

      this.events.emit('order.rated', rating);
      return ok(rating);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  // ----------------------------------------------------------------- guards

  private async assertParticipant(order: Order, user: JwtUser): Promise<ServiceResult> {
    if (user.roles?.includes('ADMIN')) return ok(true);
    if (order.userId === user.sub) return ok(true);

    if (order.driverId) {
      const driver = await this.prisma.driver.findUnique({ where: { id: order.driverId } });
      if (driver?.userId === user.sub) return ok(true);
    }

    return forbidden('You are not a participant in this trip');
  }

  /** True when the caller is the driver this order is assigned to. */
  private async isAssignedDriver(order: Order, user: JwtUser): Promise<boolean> {
    if (!order.driverId) return false;
    const driver = await this.prisma.driver.findUnique({ where: { id: order.driverId } });
    return driver?.userId === user.sub;
  }
}
