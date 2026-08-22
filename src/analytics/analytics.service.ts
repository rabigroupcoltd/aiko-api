import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, ok } from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * An order that finished and earned money, in either lane.
 *
 * The two lanes end at different statuses — the legacy bid flow at COMPLETED,
 * the marketplace at DELIVERED — and every figure here originally counted only
 * the first. That was correct when the bid flow was the product; it silently
 * reports zero revenue now that dispatch runs through the marketplace, because
 * no marketplace order ever reaches COMPLETED.
 *
 * Both, therefore. A delivery is a delivery whichever way the driver got it.
 */
const EARNING_STATUSES: OrderStatus[] = [OrderStatus.COMPLETED, OrderStatus.DELIVERED];

@Injectable()
export class AnalyticsService {
  constructor(
    private prisma: PrismaService,
    private response: ResponsesService,
  ) {}

  async getOverview(): Promise<ServiceResult> {
    try {
      const [
        totalUsers,
        totalDrivers,
        activeDrivers,
        totalOrders,
        completedOrders,
        cancelledOrders,
        cashRevenue,
        transferRevenue,
        outstandingDebt,
        platformEarnings,
      ] = await Promise.all([
        this.prisma.user.count(),
        this.prisma.driver.count(),
        this.prisma.driver.count({ where: { isAvailable: true, kycStatus: 'APPROVED' } }),
        this.prisma.order.count(),
        this.prisma.order.count({ where: { status: { in: EARNING_STATUSES } } }),
        this.prisma.order.count({ where: { status: 'CANCELLED' } }),
        this.prisma.order.aggregate({
          where: { paymentMethod: 'CASH', status: { in: EARNING_STATUSES } },
          _sum: { fare: true },
        }),
        this.prisma.order.aggregate({
          where: { paymentMethod: 'BANK_TRANSFER', status: { in: EARNING_STATUSES } },
          _sum: { fare: true },
        }),
        this.prisma.driver.aggregate({ _sum: { currentDebt: true } }),
        this.prisma.order.aggregate({
          where: { status: { in: EARNING_STATUSES } },
          _sum: { platformFee: true },
        }),
      ]);

      const cash = cashRevenue._sum.fare || 0;
      const transfer = transferRevenue._sum.fare || 0;

      return ok({
        totalUsers,
        totalDrivers,
        activeDrivers,
        totalOrders,
        completedOrders,
        cancelledOrders,
        completionRate: totalOrders > 0 ? ((completedOrders / totalOrders) * 100).toFixed(1) : '0.0',
        cancellationRate:
          totalOrders > 0 ? ((cancelledOrders / totalOrders) * 100).toFixed(1) : '0.0',
        cashRevenue: cash,
        transferRevenue: transfer,
        totalRevenue: cash + transfer,
        platformEarnings: platformEarnings._sum.platformFee || 0,
        outstandingDebt: outstandingDebt._sum.currentDebt || 0,
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async getDriverAnalytics(): Promise<ServiceResult> {
    try {
      const drivers = await this.prisma.driver.findMany({
        include: {
          user: { select: { name: true, email: true, phone: true } },
          orders: { where: { status: { in: EARNING_STATUSES } } },
        },
      });

      return ok(
        drivers.map((driver) => {
          const attempted = driver.acceptedTrips + driver.cancelledTrips;

          return {
            id: driver.id,
            name: driver.user.name,
            email: driver.user.email,
            phone: driver.user.phone,
            vehicleType: driver.vehicleType,
            vehicle: `${driver.vehicleModel} (${driver.vehiclePlate})`,
            status: driver.kycStatus,
            isAvailable: driver.isAvailable,
            isBlocked: driver.isBlocked,
            totalTrips: driver.totalTrips,
            completedTrips: driver.orders.length,
            cancelledTrips: driver.cancelledTrips,
            earnings: driver.orders.reduce((sum, order) => sum + order.driverEarnings, 0),
            platformFeePaid: driver.orders.reduce((sum, order) => sum + order.platformFee, 0),
            currentDebt: driver.currentDebt,
            debtLimit: driver.debtLimit,
            rating: driver.rating,
            acceptanceRate:
              attempted > 0 ? ((driver.acceptedTrips / attempted) * 100).toFixed(1) : '0.0',
            cancellationRate:
              attempted > 0 ? ((driver.cancelledTrips / attempted) * 100).toFixed(1) : '0.0',
          };
        }),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async getOrderAnalytics(): Promise<ServiceResult> {
    try {
      const today = startOfToday();

      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);

      const monthAgo = new Date(today);
      monthAgo.setMonth(monthAgo.getMonth() - 1);

      const [todayOrders, weekOrders, monthOrders, allTimeTotal, allTimeRevenue] =
        await Promise.all([
          this.prisma.order.findMany({ where: { createdAt: { gte: today } } }),
          this.prisma.order.findMany({ where: { createdAt: { gte: weekAgo } } }),
          this.prisma.order.findMany({ where: { createdAt: { gte: monthAgo } } }),
          this.prisma.order.count(),
          this.prisma.order.aggregate({
            where: { status: { in: EARNING_STATUSES } },
            _sum: { fare: true },
          }),
        ]);

      const stats = (orders: { status: string; fare: number }[]) => ({
        total: orders.length,
        completed: orders.filter((order) => isEarning(order.status)).length,
        cancelled: orders.filter((order) => order.status === 'CANCELLED').length,
        pending: orders.filter((order) => order.status === 'PENDING').length,
        revenue: orders
          .filter((order) => isEarning(order.status))
          .reduce((sum, order) => sum + order.fare, 0),
      });

      return ok({
        today: stats(todayOrders),
        thisWeek: stats(weekOrders),
        thisMonth: stats(monthOrders),
        // Counted in the database rather than from a capped page of rows.
        allTime: { total: allTimeTotal, revenue: allTimeRevenue._sum.fare || 0 },
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async getRevenueAnalytics(): Promise<ServiceResult> {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const orders = await this.prisma.order.findMany({
        where: { createdAt: { gte: thirtyDaysAgo }, status: { in: EARNING_STATUSES } },
        orderBy: { createdAt: 'asc' },
      });

      const daily: Record<string, { cash: number; transfer: number; total: number }> = {};

      for (const order of orders) {
        const date = order.createdAt.toISOString().split('T')[0];
        daily[date] ??= { cash: 0, transfer: 0, total: 0 };

        if (order.paymentMethod === 'CASH') daily[date].cash += order.fare;
        else daily[date].transfer += order.fare;

        daily[date].total += order.fare;
      }

      const totalRevenue = orders.reduce((sum, order) => sum + order.fare, 0);

      return ok({
        chartData: Object.entries(daily).map(([date, values]) => ({ date, ...values })),
        summary: {
          totalRevenue,
          cashRevenue: orders
            .filter((order) => order.paymentMethod === 'CASH')
            .reduce((sum, order) => sum + order.fare, 0),
          transferRevenue: orders
            .filter((order) => order.paymentMethod === 'BANK_TRANSFER')
            .reduce((sum, order) => sum + order.fare, 0),
          averageOrderValue: orders.length > 0 ? Math.round(totalRevenue / orders.length) : 0,
        },
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Per-vehicle-type breakdown — how tricycle demand compares to bicycle. */
  async getVehicleTypeAnalytics(): Promise<ServiceResult> {
    try {
      const [rules, orderStats, driverStats] = await Promise.all([
        this.prisma.pricingRule.findMany(),
        this.prisma.order.groupBy({
          by: ['vehicleType', 'status'],
          _count: { _all: true },
          _sum: { fare: true, platformFee: true },
        }),
        this.prisma.driver.groupBy({ by: ['vehicleType'], _count: { _all: true } }),
      ]);

      return ok(
        rules.map((rule) => {
          const rows = orderStats.filter((row) => row.vehicleType === rule.vehicleType);
          const completed = rows.filter((row) => isEarning(row.status));

          return {
            vehicleType: rule.vehicleType,
            isActive: rule.isActive,
            baseFare: rule.baseFare,
            perKm: rule.perKm,
            drivers:
              driverStats.find((row) => row.vehicleType === rule.vehicleType)?._count._all ?? 0,
            totalOrders: rows.reduce((sum, row) => sum + row._count._all, 0),
            completedOrders: completed.reduce((sum, row) => sum + row._count._all, 0),
            cancelledOrders: rows
              .filter((row) => row.status === 'CANCELLED')
              .reduce((sum, row) => sum + row._count._all, 0),
            revenue: completed.reduce((sum, row) => sum + (row._sum.fare ?? 0), 0),
            platformEarnings: completed.reduce((sum, row) => sum + (row._sum.platformFee ?? 0), 0),
          };
        }),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async getTopDrivers(limit = 10): Promise<ServiceResult> {
    try {
      const drivers = await this.prisma.driver.findMany({
        include: {
          user: { select: { name: true } },
          orders: { where: { status: { in: EARNING_STATUSES } } },
        },
        orderBy: { totalTrips: 'desc' },
        take: limit,
      });

      return ok(
        drivers.map((driver) => ({
          id: driver.id,
          name: driver.user.name,
          vehicleType: driver.vehicleType,
          totalTrips: driver.totalTrips,
          totalEarnings: driver.orders.reduce((sum, order) => sum + order.driverEarnings, 0),
          rating: driver.rating,
        })),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async getLowPerformingDrivers(limit = 10): Promise<ServiceResult> {
    try {
      const drivers = await this.prisma.driver.findMany({
        where: { totalTrips: { gt: 0 } },
        include: { user: { select: { name: true } } },
        orderBy: { rating: 'asc' },
        take: limit,
      });

      return ok(
        drivers.map((driver) => ({
          id: driver.id,
          name: driver.user.name,
          vehicleType: driver.vehicleType,
          totalTrips: driver.totalTrips,
          rating: driver.rating,
          currentDebt: driver.currentDebt,
        })),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

/** The string form of EARNING_STATUSES, for rows already loaded into memory. */
function isEarning(status: string): boolean {
  return (EARNING_STATUSES as string[]).includes(status);
}
