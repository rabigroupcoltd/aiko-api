import { Injectable } from '@nestjs/common';
import { KycStatus, OrderStatus, SupportStatus, VehicleType } from '@prisma/client';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, ok } from '../common/responses/response.types';
import {
  DRIVER_ACTIVE_STATUSES,
  LEGACY_ACTIVE_STATUSES,
  OPEN_MARKETPLACE_STATUSES,
} from '../dispatch/dispatch.constants';
import { driverDebtStatus } from '../drivers/driver-debt.util';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { SUPPORTED_VEHICLE_TYPES } from '../common/vehicle-types';
import { RedisService } from '../redis/redis.service';

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysAgo(days: number): Date {
  const from = startOfToday();
  from.setDate(from.getDate() - days);
  return from;
}

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private response: ResponsesService,
    private settings: PlatformSettingsService,
  ) {}

  async liveDrivers(includeOffline = false): Promise<ServiceResult> {
    try {
      const drivers = await this.prisma.driver.findMany({
        where: {
          kycStatus: KycStatus.APPROVED,
          ...(includeOffline ? {} : { isAvailable: true }),
        },
        include: {
          user: { select: { id: true, name: true, phone: true, profilePhotoUrl: true } },
          location: true,
        },
      });

      const ids = drivers.map((d) => d.id);
      const [held, live, presence] = await Promise.all([
        ids.length
          ? this.prisma.order.groupBy({
              by: ['driverId'],
              where: {
                driverId: { in: ids },
                status: { in: [...DRIVER_ACTIVE_STATUSES, ...LEGACY_ACTIVE_STATUSES] },
              },
              _count: true,
            })
          : [],
        Promise.all(drivers.map((d) => this.redis.getDriverLocation(d.id, d.vehicleType).catch(() => null))),
        Promise.all(drivers.map((d) => this.redis.isOnline(d.id).catch(() => false))),
      ]);

      const heldBy = new Map<string, number>(
        (held as { driverId: string | null; _count: number }[]).map((row) => [row.driverId ?? '', row._count]),
      );
      const platformLimit = this.settings.getNumber('DRIVER_DEBT_LIMIT');

      const result = drivers.map((driver, index) => {
        const fix = live[index];
        const position =
          fix?.lat != null && fix.lng != null
            ? { lat: fix.lat, lng: fix.lng, heading: fix.heading ?? null, recordedAt: fix.recordedAt, source: 'live' as const }
            : driver.location
              ? {
                  lat: driver.location.latitude,
                  lng: driver.location.longitude,
                  heading: driver.location.heading,
                  recordedAt: driver.location.recordedAt.toISOString(),
                  source: 'last-known' as const,
                }
              : null;
        const orders = heldBy.get(driver.id) ?? 0;
        const connected = presence[index];
        const debtLocked = driverDebtStatus(driver, platformLimit).locked;

        return {
          driverId: driver.id,
          userId: driver.userId,
          name: driver.user?.name ?? null,
          phone: driver.user?.phone ?? null,
          photoUrl: driver.user?.profilePhotoUrl ?? null,
          vehicleType: driver.vehicleType,
          vehiclePlate: driver.vehiclePlate,
          vehicleBrand: driver.vehicleBrand,
          vehicleModel: driver.vehicleModel,
          rating: driver.rating,
          heldOrders: orders,
          connected,
          status: !driver.isAvailable
            ? ('OFFLINE' as const)
            : !connected
              ? ('DISCONNECTED' as const)
            : driver.isBlocked || debtLocked
              ? ('RESTRICTED' as const)
              : orders > 0
                ? ('BUSY' as const)
                : ('AVAILABLE' as const),
          position,
        };
      });

      const count = (status: string) => result.filter((d) => d.status === status).length;

      return ok({
        generatedAt: new Date().toISOString(),
        counts: {
          online: result.filter((d) => d.status !== 'OFFLINE').length,
          offline: includeOffline
            ? count('OFFLINE')
            : await this.prisma.driver.count({
                where: { kycStatus: KycStatus.APPROVED, isAvailable: false },
              }),
          available: count('AVAILABLE'),
          busy: count('BUSY'),
          restricted: count('RESTRICTED'),
          disconnected: count('DISCONNECTED'),
          noLocation: result.filter((d) => !d.position).length,
        },
        drivers: result,
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

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

  private async onlineDriverCount(): Promise<number | null> {
    try {
      const ids = await this.redis.getAvailableDriverIds();
      return ids.length;
    } catch {
      return null;
    }
  }

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

function percentChange(current: number, previous: number): string | null {
  if (previous === 0) return current === 0 ? '0.0' : null;
  return (((current - previous) / previous) * 100).toFixed(1);
}
