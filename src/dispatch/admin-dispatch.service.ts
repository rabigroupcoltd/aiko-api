import { Injectable, Logger } from '@nestjs/common';
import { AuditEntity, Driver, KycStatus, Order, OrderStatus, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { JwtUser } from '../common/current-user.decorator';
import { haversineKm } from '../common/geo.util';
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
import { RedisService } from '../redis/redis.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import {
  ASSIGNMENT_DECLINE_MINUTES,
  DRIVER_ACTIVE_STATUSES,
  DRIVER_LOCATION_STALE_SECONDS,
  MAX_RESERVED_ORDERS_PER_DRIVER,
  NO_DRIVER_REVIVE_MINUTES,
} from './dispatch.constants';
import { DispatchService } from './dispatch.service';
import { MarketplaceService } from './marketplace.service';
import { RouteOptimizerService } from './route-optimizer.service';

const ORDER_INCLUDE = {
  user: { select: CONTACT_USER_SELECT },
  driver: { include: { user: { select: CONTACT_USER_SELECT } } },
} satisfies Prisma.OrderInclude;

export interface AssignableRider {
  driverId: string;
  userId: string;
  name: string | null;
  phone: string | null;
  photoUrl: string | null;
  vehicleType: string;
  vehicle: string;
  vehiclePlate: string | null;
  rating: number;
  online: boolean;
  onShift: boolean;
  distanceKm: number | null;
  locationAt: string | null;
  held: number;
  capacity: number;
  /** Reasons the admin should think twice. Assigning anyway needs confirmation. */
  warnings: string[];
  /** Set when the rider cannot be assigned at all. */
  blockedReason: string | null;
}

function searchStart(order: Pick<Order, 'searchStartedAt' | 'createdAt'>): Date {
  return order.searchStartedAt ?? order.createdAt;
}

@Injectable()
export class AdminDispatchService {
  private readonly logger = new Logger(AdminDispatchService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private drivers: DriversService,
    private marketplace: MarketplaceService,
    private dispatch: DispatchService,
    private routes: RouteOptimizerService,
    private events: RideEventsService,
    private audit: AuditService,
    private settings: PlatformSettingsService,
    private response: ResponsesService,
  ) {}

  /** Orders with no rider: still searching, or closed recently enough to revive. */
  async unassigned(): Promise<ServiceResult> {
    try {
      const reviveSince = new Date(Date.now() - NO_DRIVER_REVIVE_MINUTES * 60_000);
      const orders = await this.prisma.order.findMany({
        where: {
          driverId: null,
          OR: [
            { status: OrderStatus.SEARCHING_FOR_DRIVER },
            { status: OrderStatus.NO_DRIVER_FOUND, updatedAt: { gte: reviveSince } },
          ],
        },
        include: { user: { select: CONTACT_USER_SELECT } },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });

      const declinedIds = [
        ...new Set(orders.map((o) => o.declinedByDriverId).filter((id): id is string => !!id)),
      ];
      const decliners = declinedIds.length
        ? await this.prisma.driver.findMany({
            where: { id: { in: declinedIds } },
            include: { user: { select: { name: true } } },
          })
        : [];
      const declinerName = new Map(decliners.map((d) => [d.id, d.user?.name ?? null]));

      const now = Date.now();
      const searchMs = this.settings.getNumber('DISPATCH_SEARCH_MINUTES') * 60_000;

      return ok(
        orders.map((order) => {
          const closed = order.status === OrderStatus.NO_DRIVER_FOUND;
          const started = searchStart(order).getTime();
          return {
            id: order.id,
            status: order.status,
            vehicleType: order.vehicleType,
            pickupLocation: order.pickupLocation,
            dropoffLocation: order.dropoffLocation,
            pickupLat: order.pickupLat,
            pickupLng: order.pickupLng,
            fare: order.fare,
            currency: order.currency,
            paymentMethod: order.paymentMethod,
            createdAt: order.createdAt.toISOString(),
            customer: order.user,
            waitingSeconds: Math.max(0, Math.round((now - started) / 1000)),
            searchEndsAt: closed ? null : new Date(started + searchMs).toISOString(),
            closedAt: closed ? order.updatedAt.toISOString() : null,
            reviveUntil: closed
              ? new Date(order.updatedAt.getTime() + NO_DRIVER_REVIVE_MINUTES * 60_000).toISOString()
              : null,
            declinedBy: order.declinedByDriverId
              ? {
                  driverId: order.declinedByDriverId,
                  name: declinerName.get(order.declinedByDriverId) ?? null,
                  at: order.declinedAt?.toISOString() ?? null,
                }
              : null,
          };
        }),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Approved riders on the right vehicle, nearest to the pickup first. */
  async riders(orderId: string): Promise<ServiceResult> {
    try {
      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return notFound('Order not found');

      const drivers = await this.prisma.driver.findMany({
        where: { kycStatus: KycStatus.APPROVED, vehicleType: order.vehicleType },
        include: {
          user: { select: { id: true, name: true, phone: true, profilePhotoUrl: true } },
          location: true,
        },
      });

      const riders = await Promise.all(drivers.map((driver) => this.describeRider(driver, order)));

      riders.sort((a, b) => {
        const rank = (r: AssignableRider) => (r.blockedReason ? 2 : r.warnings.length ? 1 : 0);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
      });

      return ok({
        order: {
          id: order.id,
          status: order.status,
          vehicleType: order.vehicleType,
          pickupLocation: order.pickupLocation,
          dropoffLocation: order.dropoffLocation,
        },
        riders,
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async assign(
    orderId: string,
    driverId: string,
    actor: JwtUser,
    confirmWarnings = false,
  ): Promise<ServiceResult> {
    try {
      let order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return notFound('Order not found');

      const driver = await this.prisma.driver.findUnique({
        where: { id: driverId },
        include: {
          user: { select: { id: true, name: true, phone: true, profilePhotoUrl: true } },
          location: true,
        },
      });
      if (!driver) return notFound('Rider not found');
      if (driver.vehicleType !== order.vehicleType) {
        return badRequest(
          `This order needs a ${order.vehicleType.toLowerCase()} and this rider drives a ${driver.vehicleType.toLowerCase()}`,
        );
      }
      if (driver.userId === order.userId) return badRequest('A rider cannot deliver their own order');

      const rider = await this.describeRider(driver, order);
      if (rider.blockedReason) return forbidden(rider.blockedReason);
      if (rider.warnings.length && !confirmWarnings) {
        return badRequest(`Confirm to assign anyway: ${rider.warnings.join('; ')}`);
      }

      let revived = false;
      if (order.status === OrderStatus.NO_DRIVER_FOUND && !order.driverId) {
        const reviveBy = order.updatedAt.getTime() + NO_DRIVER_REVIVE_MINUTES * 60_000;
        if (Date.now() > reviveBy) {
          return badRequest(
            `This order closed more than ${NO_DRIVER_REVIVE_MINUTES} minutes ago. Ask the customer to place it again.`,
          );
        }
        const reopened = await this.prisma.order.updateMany({
          where: { id: orderId, status: OrderStatus.NO_DRIVER_FOUND, driverId: null },
          data: { status: OrderStatus.SEARCHING_FOR_DRIVER, searchStartedAt: new Date() },
        });
        if (reopened.count === 0) return conflict('ORDER_ALREADY_RESERVED');
        revived = true;
        order = (await this.prisma.order.findUnique({ where: { id: orderId } }))!;
      }

      if (order.status !== OrderStatus.SEARCHING_FOR_DRIVER || order.driverId) {
        return conflict('ORDER_ALREADY_RESERVED');
      }

      const outcome = await this.marketplace.claim(orderId, driverId, {
        assignedById: actor.sub,
        ignoreCapacity: confirmWarnings,
      });

      if (outcome !== 'OK') {
        // A revived order must not sit open with no search running behind it.
        if (revived) await this.dispatch.restartSearch(order);
        return outcome === 'CAPACITY'
          ? badRequest('MAX_ORDER_CAPACITY_REACHED')
          : conflict('ORDER_ALREADY_RESERVED');
      }

      const reserved = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: ORDER_INCLUDE,
      });
      const eta = reserved ? await this.routes.customerEta(reserved) : null;

      this.events.emit('order.reserved', {
        order: reserved,
        driverId,
        eta,
        heldByDriver: rider.held + 1,
        assignedByAdmin: true,
      });

      await this.audit.record({
        actor,
        action: revived ? 'order.revive-assign' : 'order.assign',
        entity: AuditEntity.ORDER,
        entityId: orderId,
        summary: `${revived ? 'Revived and assigned' : 'Assigned'} order to ${driver.user?.name ?? 'a rider'}`,
        metadata: { driverId, revived, warnings: rider.warnings },
      });

      this.logger.log(`Order ${orderId} assigned to ${driverId} by admin ${actor.sub}`);

      return ok({ order: reserved, revived, warnings: rider.warnings });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** A rider hands back an order an admin gave them, and it goes back on the market. */
  async release(orderId: string, userId: string): Promise<ServiceResult> {
    try {
      const found = await this.drivers.requireDriverForUser(userId);
      if (found.error) return found;
      const driver = found.body as Driver;

      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order || order.driverId !== driver.id) return notFound('Order not found');

      const windowMs = ASSIGNMENT_DECLINE_MINUTES * 60_000;
      if (
        !order.assignedById ||
        !order.assignedAt ||
        order.status !== OrderStatus.RESERVED ||
        Date.now() - order.assignedAt.getTime() > windowMs
      ) {
        return badRequest(
          `You can only hand back an order Aiko assigned to you, within ${ASSIGNMENT_DECLINE_MINUTES} minutes and before heading to pickup. Contact support for help.`,
        );
      }

      const now = new Date();
      const released = await this.prisma.$transaction(async (tx) => {
        const reset = await tx.order.updateMany({
          where: { id: orderId, driverId: driver.id, status: OrderStatus.RESERVED },
          data: {
            status: OrderStatus.SEARCHING_FOR_DRIVER,
            driverId: null,
            reservedAt: null,
            acceptedAt: null,
            assignedById: null,
            assignedAt: null,
            declinedByDriverId: driver.id,
            declinedAt: now,
            searchStartedAt: now,
            searchRadiusKm: null,
          },
        });
        if (reset.count === 0) return null;

        await tx.driverOrderAction.upsert({
          where: { orderId_driverId: { orderId, driverId: driver.id } },
          create: { orderId, driverId: driver.id, action: 'SKIPPED' },
          update: { action: 'SKIPPED', hiddenUntil: null },
        });
        await tx.driver.update({
          where: { id: driver.id },
          data: { acceptedTrips: { decrement: 1 } },
        });

        return tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
      });

      if (!released) return conflict('This order has already moved on');

      this.events.emit('order.status-changed', released);
      this.events.emit('order.assignment-declined', { order: released, driverId: driver.id });
      await this.dispatch.restartSearch(released, driver.id);

      await this.audit.record({
        actor: { sub: userId, email: '', roles: ['DRIVER'] },
        action: 'order.assignment-declined',
        entity: AuditEntity.ORDER,
        entityId: orderId,
        summary: 'Rider handed back an assigned order',
        metadata: { driverId: driver.id },
      });

      return ok({ orderId, released: true });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  private async describeRider(
    driver: Driver & {
      user: { id: string; name: string | null; phone: string | null; profilePhotoUrl: string | null } | null;
      location: { latitude: number; longitude: number; recordedAt: Date } | null;
    },
    order: Order,
  ): Promise<AssignableRider> {
    const [online, live, held] = await Promise.all([
      this.redis.isOnline(driver.id).catch(() => false),
      this.redis.getDriverLocation(driver.id, driver.vehicleType).catch(() => null),
      this.prisma.order.count({ where: { driverId: driver.id, status: { in: DRIVER_ACTIVE_STATUSES } } }),
    ]);

    const position =
      live?.lat != null && live.lng != null
        ? { lat: live.lat, lng: live.lng, at: live.recordedAt }
        : driver.location
          ? {
              lat: driver.location.latitude,
              lng: driver.location.longitude,
              at: driver.location.recordedAt.toISOString(),
            }
          : null;

    const distanceKm = position
      ? Math.round(haversineKm(position.lat, position.lng, order.pickupLat, order.pickupLng) * 10) / 10
      : null;

    const warnings: string[] = [];
    if (!driver.isAvailable) warnings.push('Off shift');
    else if (!online) warnings.push('App not connected');
    if (!position) warnings.push('No location yet');
    else if (!position.at || Date.now() - Date.parse(position.at) > DRIVER_LOCATION_STALE_SECONDS * 1000) {
      warnings.push('Location out of date');
    }
    if (!this.settings.workHours().open) warnings.push('Outside work hours');
    const debt = this.drivers.debtStatus(driver);
    if (debt.locked) warnings.push(`Owes ₦${debt.current.toLocaleString()} (over limit)`);
    if (held >= MAX_RESERVED_ORDERS_PER_DRIVER) warnings.push(`Already carrying ${held} orders`);
    if (order.declinedByDriverId === driver.id) warnings.push('Handed this order back earlier');

    return {
      driverId: driver.id,
      userId: driver.userId,
      name: driver.user?.name ?? null,
      phone: driver.user?.phone ?? null,
      photoUrl: driver.user?.profilePhotoUrl ?? null,
      vehicleType: driver.vehicleType,
      vehicle: [driver.vehicleColor, driver.vehicleBrand, driver.vehicleModel].filter(Boolean).join(' '),
      vehiclePlate: driver.vehiclePlate,
      rating: driver.rating,
      online,
      onShift: driver.isAvailable,
      distanceKm,
      locationAt: position?.at ?? null,
      held,
      capacity: MAX_RESERVED_ORDERS_PER_DRIVER,
      warnings,
      blockedReason: driver.isBlocked ? 'This rider is blocked' : null,
    };
  }
}
