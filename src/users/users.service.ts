import { Injectable } from '@nestjs/common';
import {
  AccountType,
  AuditEntity,
  AuthProvider,
  KycStatus,
  OnboardingStep,
  OrderStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { JwtUser } from '../common/current-user.decorator';
import { PUBLIC_USER_SELECT } from '../common/prisma.selects';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, conflict, forbidden, notFound, ok } from '../common/responses/response.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { driverDebtStatus } from '../drivers/driver-debt.util';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { BlockUserDto, CreateStaffDto, UserDirectoryQueryDto } from './dto/user.dto';

const STAFF_WHERE: Prisma.UserWhereInput = {
  OR: [{ roles: { has: UserRole.ADMIN } }, { roles: { has: UserRole.SUPPORT } }],
};

/** How each user-management tab is defined. Staff never appear on the other two. */
const DIRECTORY_WHERE: Record<'PASSENGER' | 'DRIVER' | 'STAFF', Prisma.UserWhereInput> = {
  STAFF: STAFF_WHERE,
  DRIVER: {
    AND: [
      { NOT: STAFF_WHERE },
      { OR: [{ accountType: AccountType.RIDER }, { driver: { isNot: null } }] },
    ],
  },
  PASSENGER: {
    AND: [
      { NOT: STAFF_WHERE },
      { driver: null },
      { OR: [{ accountType: null }, { accountType: AccountType.PASSENGER }] },
    ],
  },
};

const DIRECTORY_DRIVER_SELECT = {
  id: true,
  kycStatus: true,
  kycRejectionReason: true,
  vehicleType: true,
  vehiclePlate: true,
  vehicleModel: true,
  isAvailable: true,
  isBlocked: true,
  currentDebt: true,
  debtLimit: true,
  rating: true,
  totalTrips: true,
  createdAt: true,
} satisfies Prisma.DriverSelect;

/** Where a would-be driver is with approval, including "never submitted". */
function driverApproval(
  accountType: AccountType | null,
  driver: { kycStatus: KycStatus } | null,
): 'NOT_SUBMITTED' | KycStatus | null {
  if (driver) return driver.kycStatus;
  return accountType === AccountType.RIDER ? 'NOT_SUBMITTED' : null;
}

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private response: ResponsesService,
    private audit: AuditService,
    private settings: PlatformSettingsService,
  ) {}

  async findAll(): Promise<ServiceResult> {
    try {
      const users = await this.prisma.user.findMany({
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: 'desc' },
      });
      return ok(users);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * The admin's user-management list, one tab at a time.
   *
   * Driven from users rather than driver rows, so the Drivers tab includes
   * people who chose to drive but never submitted documents — they have no
   * driver row yet and were invisible on a driver-based list.
   */
  async directory(query: UserDirectoryQueryDto = {}): Promise<ServiceResult> {
    try {
      const type = query.type ?? 'PASSENGER';
      const where: Prisma.UserWhereInput = { AND: [DIRECTORY_WHERE[type]] };
      const and = where.AND as Prisma.UserWhereInput[];

      const term = query.search?.trim();
      if (term) {
        and.push({
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { email: { contains: term, mode: 'insensitive' } },
            { phone: { contains: term } },
            { driver: { vehiclePlate: { contains: term, mode: 'insensitive' } } },
          ],
        });
      }

      if (type === 'DRIVER' && query.approval) {
        and.push(
          query.approval === 'NOT_SUBMITTED'
            ? { driver: null }
            : { driver: { kycStatus: query.approval as KycStatus } },
        );
      }

      const [users, passengers, drivers, staff, pendingDrivers, notSubmitted] = await Promise.all([
        this.prisma.user.findMany({
          where,
          select: {
            ...PUBLIC_USER_SELECT,
            driver: { select: DIRECTORY_DRIVER_SELECT },
            _count: { select: { orders: true } },
          },
          // Most recently active first — a rider who just resubmitted is on top.
          orderBy: { updatedAt: 'desc' },
          take: 500,
        }),
        this.prisma.user.count({ where: DIRECTORY_WHERE.PASSENGER }),
        this.prisma.user.count({ where: DIRECTORY_WHERE.DRIVER }),
        this.prisma.user.count({ where: DIRECTORY_WHERE.STAFF }),
        this.prisma.user.count({
          where: { AND: [DIRECTORY_WHERE.DRIVER, { driver: { kycStatus: KycStatus.PENDING } }] },
        }),
        this.prisma.user.count({ where: { AND: [DIRECTORY_WHERE.DRIVER, { driver: null }] } }),
      ]);

      const platformLimit = this.settings.getNumber('DRIVER_DEBT_LIMIT');

      return ok({
        counts: { passengers, drivers, staff, pendingDrivers, notSubmitted },
        result: users.map(({ _count, driver, ...user }) => ({
          ...user,
          passengerTrips: _count.orders,
          driverStatus: driverApproval(user.accountType, driver),
          driver: driver ? { ...driver, debt: driverDebtStatus(driver, platformLimit) } : null,
        })),
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Everything the user detail page needs in one call: the account, the
   * driver profile with its documents and wallet, and trip/money totals on
   * both sides — every driver is a passenger too.
   */
  async overview(id: string): Promise<ServiceResult> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id },
        select: {
          ...PUBLIC_USER_SELECT,
          driver: { include: { vehiclePhotos: { orderBy: { createdAt: 'asc' } }, wallet: true } },
        },
      });
      if (!user) return notFound('User not found');

      const driverId = user.driver?.id;
      const done = { in: [OrderStatus.COMPLETED, OrderStatus.DELIVERED] };

      const [asPassenger, passengerDone, asDriver, driverDone] = await Promise.all([
        this.prisma.order.count({ where: { userId: id } }),
        this.prisma.order.aggregate({
          where: { userId: id, status: done },
          _count: true,
          _sum: { fare: true },
        }),
        driverId ? this.prisma.order.count({ where: { driverId } }) : 0,
        driverId
          ? this.prisma.order.aggregate({
              where: { driverId, status: done },
              _count: true,
              _sum: { fare: true, driverEarnings: true, platformFee: true },
            })
          : null,
      ]);

      const { driver, ...account } = user;

      return ok({
        ...account,
        driverStatus: driverApproval(user.accountType, driver),
        driver: driver
          ? {
              ...driver,
              debt: driverDebtStatus(driver, this.settings.getNumber('DRIVER_DEBT_LIMIT')),
            }
          : null,
        stats: {
          passenger: {
            trips: asPassenger,
            completed: passengerDone._count,
            spent: passengerDone._sum.fare ?? 0,
          },
          driver: driverId
            ? {
                trips: asDriver,
                completed: driverDone?._count ?? 0,
                fares: driverDone?._sum.fare ?? 0,
                earnings: driverDone?._sum.driverEarnings ?? 0,
                commission: driverDone?._sum.platformFee ?? 0,
              }
            : null,
        },
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findOne(id: string): Promise<ServiceResult> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id },
        // Explicit select — an `include` would ship the password hash to the client.
        select: { ...PUBLIC_USER_SELECT, driver: { include: { vehiclePhotos: true } } },
      });

      if (!user) return notFound('User not found');
      return ok(user);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async update(
    id: string,
    data: { name?: string; phone?: string },
    currentUserId: string,
  ): Promise<ServiceResult> {
    try {
      if (id !== currentUserId) {
        const currentUser = await this.prisma.user.findUnique({ where: { id: currentUserId } });
        if (!currentUser?.roles.includes('ADMIN')) {
          return forbidden('You can only update your own profile');
        }
      }

      const user = await this.prisma.user.update({
        where: { id },
        data,
        select: PUBLIC_USER_SELECT,
      });

      return ok(user);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Blocks (or unblocks) any account — a passenger, a rider, or another staff
   * member. `JwtStrategy` re-checks `isBlocked` on every request, so this
   * takes effect immediately rather than at the account's next sign-in.
   *
   * Deliberately does not touch anything else: an order already in progress
   * is left alone, same as blocking a driver never un-assigns their held
   * orders. Only new activity by this account is what stops.
   */
  async block(id: string, dto: BlockUserDto, actor?: JwtUser): Promise<ServiceResult> {
    try {
      const existing = await this.prisma.user.findUnique({ where: { id } });
      if (!existing) return notFound('User not found');

      const user = await this.prisma.user.update({
        where: { id },
        data: {
          isBlocked: dto.isBlocked,
          blockedReason: dto.isBlocked ? (dto.reason ?? null) : null,
        },
        select: PUBLIC_USER_SELECT,
      });

      await this.audit.record({
        actor,
        action: dto.isBlocked ? 'user.block' : 'user.unblock',
        entity: AuditEntity.USER,
        entityId: id,
        summary: `${dto.isBlocked ? 'Blocked' : 'Unblocked'} ${existing.name ?? existing.email ?? id}`,
        metadata: { reason: dto.reason ?? null },
      });

      return ok(user);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Creates a password-authenticated staff account — the dashboard's own
   * equivalent of `prisma/seed.ts`'s admin bootstrap, for every account after
   * the first one.
   *
   * `USER` is added alongside whatever role is requested, the same way the
   * seed script does it: nothing else in the codebase should have to
   * special-case "a staff account with no base role".
   *
   * Staff never walk the onboarding stack — `OnboardingService.isStaff` keys
   * on `authProvider === PASSWORD`, which this sets, so the new account
   * resolves straight to DONE the first time anything asks.
   */
  async createStaff(dto: CreateStaffDto, actor?: JwtUser): Promise<ServiceResult> {
    try {
      const email = dto.email.trim().toLowerCase();

      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing) return conflict('A user with this email already exists');

      const user = await this.prisma.user.create({
        data: {
          email,
          password: await bcrypt.hash(dto.password, 10),
          name: dto.name,
          roles: [dto.role, 'USER'],
          authProvider: AuthProvider.PASSWORD,
          emailVerified: true,
          onboardingStep: OnboardingStep.DONE,
          onboardingCompletedAt: new Date(),
        },
        select: PUBLIC_USER_SELECT,
      });

      await this.audit.record({
        actor,
        action: 'user.create-staff',
        entity: AuditEntity.USER,
        entityId: user.id,
        summary: `Created ${dto.role.toLowerCase()} account for ${dto.name}`,
        metadata: { role: dto.role },
      });

      return ok(user);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}
