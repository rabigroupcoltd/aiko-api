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
import { DriversService } from '../drivers/drivers.service';
import { RideEventsService } from '../events/ride-events.service';
import { FareQuote, PricingService } from '../pricing/pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreateOrderDto, ListOrdersQueryDto, RateOrderDto, SendMessageDto } from './dto/order.dto';

/** Terminal states have no outgoing transitions. */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
  [OrderStatus.ACCEPTED]: [OrderStatus.ARRIVED, OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED],
  [OrderStatus.ARRIVED]: [OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED],
  [OrderStatus.IN_PROGRESS]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
};

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
    private response: ResponsesService,
  ) {}

  /** Fare, platform fee and driver earnings all come from the pricing rule. */
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

      const order = await this.prisma.order.create({
        data: {
          userId,
          vehicleType: dto.vehicleType as VehicleType,
          pickupLocation: dto.pickupLocation,
          dropoffLocation: dto.dropoffLocation,
          pickupLat: dto.pickupLat,
          pickupLng: dto.pickupLng,
          dropoffLat: dto.dropoffLat,
          dropoffLng: dto.dropoffLng,
          distanceKm: quote.distanceKm,
          durationMins: quote.durationMins,
          fare: quote.fare,
          currency: quote.currency,
          // Frozen so a later admin price change never rewrites a past trip.
          pricingSnapshot: quote.breakdown as unknown as Prisma.InputJsonValue,
          platformFee: quote.platformFee,
          driverEarnings: quote.driverEarnings,
          paymentMethod: dto.paymentMethod as PaymentMethod,
          ...(dto.rideRequestId ? { rideRequest: { connect: { id: dto.rideRequestId } } } : {}),
        },
        include: ORDER_INCLUDE,
      });

      this.events.emit('order.created', order);
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

      if (status === OrderStatus.COMPLETED) return this.complete(order);
      if (status === OrderStatus.CANCELLED) return this.cancel(order, user, reason);

      const updated = await this.prisma.order.update({
        where: { id: orderId },
        data: {
          status,
          ...(status === OrderStatus.ARRIVED ? { arrivedAt: new Date() } : {}),
          ...(status === OrderStatus.IN_PROGRESS ? { startedAt: new Date() } : {}),
        },
        include: ORDER_INCLUDE,
      });

      this.events.emit('order.status-changed', updated);
      return ok(updated);
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
   */
  private async complete(order: Order): Promise<ServiceResult> {
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

      return tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.COMPLETED,
          completedAt: new Date(),
          paymentStatus: PaymentStatus.PAID,
        },
        include: ORDER_INCLUDE,
      });
    });

    if (updated.driver?.isBlocked) {
      await this.redis.removeDriver(updated.driver.id);
    }

    this.events.emit('order.status-changed', updated);
    return ok(updated);
  }

  private async cancel(order: Order, user: JwtUser, reason?: string): Promise<ServiceResult> {
    // Attribute the cancellation to the driver only when the driver is the one
    // cancelling — an admin cancelling on their behalf must not cost them.
    const assignedDriver = order.driverId
      ? await this.prisma.driver.findUnique({ where: { id: order.driverId } })
      : null;
    const cancelledByDriver = assignedDriver?.userId === user.sub;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Only count it against the driver if they had already committed to the trip.
      if (order.driverId && cancelledByDriver && order.status !== OrderStatus.PENDING) {
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
    return ok(updated);
  }

  // -------------------------------------------------------------- messages

  async sendMessage(orderId: string, user: JwtUser, dto: SendMessageDto): Promise<ServiceResult> {
    try {
      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return notFound('Order not found');

      const allowed = await this.assertParticipant(order, user);
      if (allowed.error) return allowed;

      if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED) {
        return badRequest('This trip is closed');
      }

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

      if (order.status !== OrderStatus.COMPLETED) {
        return badRequest('You can only rate a completed trip');
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
}
