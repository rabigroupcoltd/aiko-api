import { Injectable } from '@nestjs/common';
import { KycStatus, OrderStatus, SupportStatus, VehicleType } from '@prisma/client';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, ok } from '../common/responses/response.types';
import {
  DRIVER_ACTIVE_STATUSES,
  OPEN_MARKETPLACE_STATUSES,
} from '../dispatch/dispatch.constants';
import { PrismaService } from '../prisma/prisma.service';
import { SUPPORTED_VEHICLE_TYPES } from '../common/vehicle-types';
import { RedisService } from '../redis/redis.service';

/** Midnight today, in server time. */
function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysAgo(days: number): Date {
  const from = startOfToday();
  from.setDate(from.getDate() - days);
  return from;
}

/**
 * The admin dashboard's own reads.
 *
 * Separate from AnalyticsService, which answers "how is the business doing" over
 * a period. This answers "what is happening right now" — the numbers that go
 * stale in minutes and drive the operator's next action, not the ones you put in
 * a monthly report.
 */
@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private response: ResponsesService,
  ) {}

  /**
   * The headline tiles.
   *
   * One round trip for the whole top of the dashboard. Every count here is
   * cheap and indexed; the expensive per-driver and per-period breakdowns stay
   * in AnalyticsService where they are asked for deliberately.
   */
  async summary(): Promise<ServiceResult> {
    try {
      const today = startOfToday();
      const yesterday = daysAgo(1);
      const weekAgo = daysAgo(7);

      const paid = { status: OrderStatus.DELIVERED };

      const [
        ordersToday,
        ordersYesterday,
        ordersWeek,
        ordersTotal,
        revenueToday,
        revenueWeek,
        revenueTotal,
        driversTotal,
        driversApproved,
        driversPendingKyc,
        driversBlocked,
        usersTotal,
        usersNewThisWeek,
        supportOpen,
        supportPending,
        supportUrgent,
        searching,
        reserved,
        inTransit,
      ] = await Promise.all([
        this.prisma.order.count({ where: { createdAt: { gte: today } } }),
        this.prisma.order.count({ where: { createdAt: { gte: yesterday, lt: today } } }),
        this.prisma.order.count({ where: { createdAt: { gte: weekAgo } } }),
        this.prisma.order.count(),

        this.prisma.order.aggregate({ where: { ...paid, createdAt: { gte: today } }, _sum: { fare: true } }),
        this.prisma.order.aggregate({ where: { ...paid, createdAt: { gte: weekAgo } }, _sum: { fare: true } }),
        this.prisma.order.aggregate({ where: paid, _sum: { fare: true } }),

        this.prisma.driver.count(),
        this.prisma.driver.count({ where: { kycStatus: KycStatus.APPROVED } }),
        this.prisma.driver.count({ where: { kycStatus: KycStatus.PENDING } }),
        this.prisma.driver.count({ where: { isBlocked: true } }),

        this.prisma.user.count(),
        this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),

        this.prisma.supportTicket.count({ where: { status: SupportStatus.OPEN } }),
        this.prisma.supportTicket.count({ where: { status: SupportStatus.PENDING } }),
        this.prisma.supportTicket.count({
          where: { priority: 'URGENT', status: { in: [SupportStatus.OPEN, SupportStatus.PENDING] } },
        }),

        this.prisma.order.count({ where: { status: { in: OPEN_MARKETPLACE_STATUSES } } }),
        this.prisma.order.count({ where: { status: OrderStatus.RESERVED } }),
        this.prisma.order.count({
          where: { status: { in: [OrderStatus.PICKED_UP, OrderStatus.IN_TRANSIT] } },
        }),
      ]);

      // Presence lives in Redis, not Postgres — `isAvailable` is the shift
      // switch, which stays true for a driver whose app was killed.
      const online = await this.onlineDriverCount();

      return ok({
        orders: {
          today: ordersToday,
          yesterday: ordersYesterday,
          week: ordersWeek,
          total: ordersTotal,
          changePercent: percentChange(ordersToday, ordersYesterday),
        },
        revenue: {
          today: revenueToday._sum.fare ?? 0,
          week: revenueWeek._sum.fare ?? 0,
          total: revenueTotal._sum.fare ?? 0,
          currency: 'NGN',
        },
        drivers: {
          total: driversTotal,
          approved: driversApproved,
          online,
          pendingKyc: driversPendingKyc,
          blocked: driversBlocked,
        },
        users: { total: usersTotal, newThisWeek: usersNewThisWeek },
        support: { open: supportOpen, pending: supportPending, urgent: supportUrgent },
        liveOrders: { searching, reserved, inTransit },
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * How many drivers Redis currently considers reachable.
   *
   * Degrades to null rather than throwing: Redis being down should grey out one
   * tile, not take the whole dashboard with it.
   */
  private async onlineDriverCount(): Promise<number | null> {
    try {
      const ids = await this.redis.getAvailableDriverIds();
      return ids.length;
    } catch {
      return null;
    }
  }

  /**
   * Orders per day, for the dashboard chart.
   *
   * Grouped in application code rather than with a raw `date_trunc`: the range
   * is a fortnight at most, so the row count is trivial, and keeping it in
   * Prisma means this does not have to be rewritten if the database moves.
   */
  async orderTrend(days = 14): Promise<ServiceResult> {
    try {
      const span = Math.min(Math.max(days, 1), 90);
      const from = daysAgo(span - 1);

      const orders = await this.prisma.order.findMany({
        where: { createdAt: { gte: from } },
        select: { createdAt: true, status: true, fare: true },
      });

      const buckets = new Map<string, { date: string; orders: number; delivered: number; revenue: number }>();

      for (let i = 0; i < span; i += 1) {
        const day = new Date(from);
        day.setDate(from.getDate() + i);
        const key = day.toISOString().slice(0, 10);
        buckets.set(key, { date: key, orders: 0, delivered: 0, revenue: 0 });
      }

      for (const order of orders) {
        const key = order.createdAt.toISOString().slice(0, 10);
        const bucket = buckets.get(key);
        if (!bucket) continue;

        bucket.orders += 1;
        if (order.status === OrderStatus.DELIVERED) {
          bucket.delivered += 1;
          bucket.revenue += order.fare;
        }
      }

      return ok([...buckets.values()]);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Order split by vehicle type, for the dashboard's donut. */
  async vehicleSplit(): Promise<ServiceResult> {
    try {
      const grouped = await this.prisma.order.groupBy({
        by: ['vehicleType'],
        _count: { _all: true },
        _sum: { fare: true },
      });

      return ok(
        grouped.map((row) => ({
          vehicleType: row.vehicleType,
          orders: row._count._all,
          revenue: row._sum.fare ?? 0,
        })),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * The live activity feed.
   *
   * Assembled from the domain tables rather than from the audit log, because
   * the feed is about what the *platform* did — an order delivered, a driver
   * signing up — and the audit log only records what an *admin* did. Merging
   * them would bury real activity under administrative noise.
   */
  async activity(limit = 20): Promise<ServiceResult> {
    try {
      const take = Math.min(Math.max(limit, 1), 50);

      const [orders, drivers, tickets] = await Promise.all([
        this.prisma.order.findMany({
          where: { status: { in: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] } },
          select: {
            id: true,
            status: true,
            fare: true,
            dropoffLocation: true,
            deliveredAt: true,
            cancelledAt: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: 'desc' },
          take,
        }),
        this.prisma.driver.findMany({
          select: {
            id: true,
            vehicleType: true,
            kycStatus: true,
            createdAt: true,
            user: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        this.prisma.supportTicket.findMany({
          select: { id: true, reference: true, subject: true, priority: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take,
        }),
      ]);

      const feed = [
        ...orders.map((order) => ({
          type: order.status === OrderStatus.DELIVERED ? 'ORDER_COMPLETED' : 'ORDER_CANCELLED',
          at: order.deliveredAt ?? order.cancelledAt ?? order.updatedAt,
          summary:
            order.status === OrderStatus.DELIVERED
              ? `Order delivered to ${order.dropoffLocation}`
              : `Order to ${order.dropoffLocation} was cancelled`,
          entityId: order.id,
          amount: order.status === OrderStatus.DELIVERED ? order.fare : null,
        })),
        ...drivers.map((driver) => ({
          type: 'DRIVER_REGISTERED',
          at: driver.createdAt,
          summary: `${driver.user?.name ?? 'A driver'} registered a ${driver.vehicleType}`,
          entityId: driver.id,
          amount: null,
        })),
        ...tickets.map((ticket) => ({
          type: 'SUPPORT_TICKET',
          at: ticket.createdAt,
          summary: `${ticket.reference}: ${ticket.subject}`,
          entityId: ticket.id,
          amount: null,
        })),
      ]
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, take);

      return ok(feed);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * What the realtime layer is doing.
   *
   * Read from Redis and Postgres rather than from the gateway's own memory: the
   * gateway holds socket handles for the instance it runs on, and the moment
   * there are two instances that number stops being the answer. Presence and
   * open orders are shared state and stay correct either way.
   */
  async socketActivity(): Promise<ServiceResult> {
    try {
      const poolByVehicle: Record<string, number> = {};
      let driversInPool = 0;

      for (const vehicleType of SUPPORTED_VEHICLE_TYPES) {
        const ids = await this.redis.getAvailableDriverIds(vehicleType as VehicleType);
        poolByVehicle[vehicleType] = ids.length;
        driversInPool += ids.length;
      }

      const [openOrders, activeTrips] = await Promise.all([
        this.prisma.order.findMany({
          where: { status: { in: OPEN_MARKETPLACE_STATUSES } },
          select: {
            id: true,
            vehicleType: true,
            pickupLocation: true,
            dropoffLocation: true,
            fare: true,
            searchRadiusKm: true,
            dispatchAttempts: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
          take: 25,
        }),
        this.prisma.order.count({ where: { status: { in: DRIVER_ACTIVE_STATUSES } } }),
      ]);

      // Who each open order has actually reached. This is the question the
      // socket-activity screen exists to answer: an order sitting unclaimed is
      // either being seen by nobody or being ignored by everybody, and the
      // remedy differs.
      const withReach = await Promise.all(
        openOrders.map(async (order) => ({
          ...order,
          ageSeconds: Math.round((Date.now() - order.createdAt.getTime()) / 1000),
          offeredTo: (await this.redis.getOfferedDrivers(order.id)).length,
        })),
      );

      return ok({
        dispatch: {
          openOrders: openOrders.length,
          activeTrips,
          driversInPool,
          poolByVehicle,
        },
        orders: withReach,
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}

/** Signed percentage change, to one decimal place. Null when there is no base. */
function percentChange(current: number, previous: number): string | null {
  if (previous === 0) return current === 0 ? '0.0' : null;
  return (((current - previous) / previous) * 100).toFixed(1);
}
