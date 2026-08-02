import { Injectable, Logger } from '@nestjs/common';
import {
  AccountType,
  Driver,
  KycStatus,
  OnboardingStep,
  Prisma,
  VehiclePhotoType,
  VehicleType,
} from '@prisma/client';
import { JwtUser } from '../common/current-user.decorator';
import { CONTACT_USER_SELECT, PUBLIC_USER_SELECT } from '../common/prisma.selects';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ServiceResult,
  badRequest,
  conflict,
  forbidden,
  notFound,
  ok,
} from '../common/responses/response.types';
import { RideEventsService } from '../events/ride-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { DriverLocationDto, NearbyDriversQueryDto } from '../redis/dto/driver-location.dto';
import { RedisService } from '../redis/redis.service';
import { StorageService } from '../storage/storage.service';
import { UploadFile } from '../storage/storage.types';
import { ListDriversQueryDto, RegisterDriverDto, UpdateDriverDto } from './dto/driver.dto';

@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private redis: RedisService,
    private events: RideEventsService,
    private response: ResponsesService,
  ) {}

  /**
   * Photos go to object storage before the transaction opens, so a database
   * failure never leaves the driver row half-created; orphaned objects are
   * deleted on rollback instead.
   */
  async register(
    userId: string,
    dto: RegisterDriverDto,
    files: UploadFile[] = [],
  ): Promise<ServiceResult> {
    let uploads: Awaited<ReturnType<StorageService['uploadMany']>> = [];

    try {
      const existing = await this.prisma.driver.findUnique({ where: { userId } });
      if (existing) return conflict('Driver profile already exists');

      const plate = dto.vehiclePlate.toUpperCase();
      const plateTaken = await this.prisma.driver.findFirst({ where: { vehiclePlate: plate } });
      if (plateTaken) return conflict('Vehicle plate is already registered');

      uploads = await this.storage.uploadMany(files, { folder: `vehicles/${userId}` });
      const photoTypes = parsePhotoTypes(dto.photoTypes, files.length);

      const driver = await this.prisma.$transaction(async (tx) => {
        const created = await tx.driver.create({
          data: {
            userId,
            vehicleType: dto.vehicleType as VehicleType,
            vehiclePlate: plate,
            vehicleModel: dto.vehicleModel,
            vehicleColor: dto.vehicleColor,
            vehicleYear: dto.vehicleYear,
            kycStatus: KycStatus.PENDING,
            wallet: { create: {} },
            vehiclePhotos: {
              create: uploads.map((upload, index) => ({
                type: photoTypes[index],
                url: upload.url,
                key: upload.key,
                provider: upload.provider,
                mimeType: upload.mimeType,
                sizeBytes: upload.sizeBytes,
              })),
            },
          },
          include: {
            user: { select: PUBLIC_USER_SELECT },
            wallet: true,
            vehiclePhotos: true,
          },
        });

        const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });

        // Registering the vehicle IS the rider document step, so it also
        // advances onboarding — the driver leaves here for the waiting screen.
        // RIDER is pushed alongside USER rather than replacing it: every driver
        // is a passenger by default and must keep being able to book trips.
        await tx.user.update({
          where: { id: userId },
          data: {
            ...(user.roles.includes('RIDER') ? {} : { roles: { push: 'RIDER' } }),
            accountType: AccountType.RIDER,
            onboardingStep: OnboardingStep.AWAITING_APPROVAL,
          },
        });

        return created;
      });

      return ok(driver);
    } catch (e) {
      await this.discardUploads(uploads);
      return this.response.errorHandler(e);
    }
  }

  async findAll(query: ListDriversQueryDto = {}): Promise<ServiceResult> {
    try {
      const where: Prisma.DriverWhereInput = {};
      if (query.vehicleType) where.vehicleType = query.vehicleType as VehicleType;
      if (query.kycStatus) where.kycStatus = query.kycStatus as KycStatus;
      if (query.isAvailable !== undefined) where.isAvailable = query.isAvailable;

      const drivers = await this.prisma.driver.findMany({
        where,
        include: {
          user: { select: CONTACT_USER_SELECT },
          wallet: true,
          vehiclePhotos: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return ok(drivers);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findOne(id: string): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.findUnique({
        where: { id },
        include: {
          user: { select: PUBLIC_USER_SELECT },
          wallet: true,
          vehiclePhotos: true,
          location: true,
        },
      });

      if (!driver) return notFound('Driver not found');
      return ok(driver);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findByUserId(userId: string): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.findUnique({
        where: { userId },
        include: {
          user: { select: PUBLIC_USER_SELECT },
          wallet: true,
          vehiclePhotos: true,
          location: true,
        },
      });

      if (!driver) return notFound('You do not have a driver profile');
      return ok(driver);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Resolves the caller's own driver profile — JWT `sub` is a userId, not a
   * driverId. Returns a result so callers can propagate the 403 as-is.
   */
  async requireDriverForUser(userId: string): Promise<ServiceResult<Driver | string>> {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) return forbidden('You do not have a driver profile');
    return ok(driver);
  }

  /** A driver may act on their own record; an admin may act on any. */
  async assertCanManage(driverId: string, user: JwtUser): Promise<ServiceResult<Driver | string>> {
    const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) return notFound('Driver not found');

    if (driver.userId !== user.sub && !user.roles?.includes('ADMIN')) {
      return forbidden('You can only manage your own driver profile');
    }

    return ok(driver);
  }

  async update(id: string, dto: UpdateDriverDto, user: JwtUser): Promise<ServiceResult> {
    try {
      const allowed = await this.assertCanManage(id, user);
      if (allowed.error) return allowed;

      const driver = await this.prisma.driver.update({
        where: { id },
        data: {
          ...dto,
          vehicleType: dto.vehicleType as VehicleType | undefined,
          vehiclePlate: dto.vehiclePlate?.toUpperCase(),
        },
        include: { user: { select: PUBLIC_USER_SELECT }, vehiclePhotos: true },
      });

      return ok(driver);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  // ---------------------------------------------------------------- photos

  async addPhotos(
    driverId: string,
    files: UploadFile[],
    photoTypesRaw: string | undefined,
    user: JwtUser,
  ): Promise<ServiceResult> {
    let uploads: Awaited<ReturnType<StorageService['uploadMany']>> = [];

    try {
      const allowed = await this.assertCanManage(driverId, user);
      if (allowed.error) return allowed;

      if (files.length === 0) return badRequest('At least one photo is required');

      const driver = allowed.body as Driver;
      uploads = await this.storage.uploadMany(files, { folder: `vehicles/${driver.userId}` });
      const photoTypes = parsePhotoTypes(photoTypesRaw, files.length);

      await this.prisma.vehiclePhoto.createMany({
        data: uploads.map((upload, index) => ({
          driverId,
          type: photoTypes[index],
          url: upload.url,
          key: upload.key,
          provider: upload.provider,
          mimeType: upload.mimeType,
          sizeBytes: upload.sizeBytes,
        })),
      });

      return this.listPhotos(driverId);
    } catch (e) {
      await this.discardUploads(uploads);
      return this.response.errorHandler(e);
    }
  }

  async listPhotos(driverId: string): Promise<ServiceResult> {
    try {
      const photos = await this.prisma.vehiclePhoto.findMany({
        where: { driverId },
        orderBy: { createdAt: 'asc' },
      });
      return ok(photos);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async removePhoto(driverId: string, photoId: string, user: JwtUser): Promise<ServiceResult> {
    try {
      const allowed = await this.assertCanManage(driverId, user);
      if (allowed.error) return allowed;

      const photo = await this.prisma.vehiclePhoto.findUnique({ where: { id: photoId } });
      if (!photo || photo.driverId !== driverId) return notFound('Photo not found');

      await this.prisma.vehiclePhoto.delete({ where: { id: photoId } });
      await this.storage.delete(photo.key, photo.provider);

      return ok({ deleted: true, id: photoId });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Best-effort cleanup of objects written before a failed database write. */
  private async discardUploads(uploads: { key: string; provider: any }[]) {
    if (uploads.length === 0) return;
    await Promise.all(uploads.map((upload) => this.storage.delete(upload.key, upload.provider)));
  }

  // ------------------------------------------------------------------- kyc

  /**
   * Approval is the last onboarding step for a rider, so it closes their
   * onboarding out too. Without this the driver would sit on the waiting screen
   * until they happened to PATCH /api/onboarding — nothing else would ever
   * stamp `onboardingCompletedAt`.
   */
  async approveKyc(id: string): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.update({
        where: { id },
        data: { kycStatus: KycStatus.APPROVED, kycRejectionReason: null },
        include: { user: { select: PUBLIC_USER_SELECT } },
      });

      await this.prisma.user.update({
        where: { id: driver.userId },
        data: {
          onboardingStep: OnboardingStep.DONE,
          // COALESCE by hand — a re-approval must not move the original date.
          ...(driver.user.onboardingCompletedAt ? {} : { onboardingCompletedAt: new Date() }),
        },
      });

      // The driver is sitting on the approval screen waiting for exactly this.
      this.events.emit('driver.kyc-updated', driver);

      return ok(driver);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Puts the rider back on the document step so they can re-shoot and resubmit. */
  async rejectKyc(id: string, reason: string): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.update({
        where: { id },
        data: { kycStatus: KycStatus.REJECTED, kycRejectionReason: reason, isAvailable: false },
        include: { user: { select: PUBLIC_USER_SELECT } },
      });

      await this.prisma.user.update({
        where: { id: driver.userId },
        data: { onboardingStep: OnboardingStep.RIDER_DOCS },
      });

      await this.redis.removeDriver(id);

      this.events.emit('driver.kyc-updated', driver);

      return ok(driver);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  // --------------------------------------------------------- availability

  async setAvailability(id: string, isAvailable: boolean, user: JwtUser): Promise<ServiceResult> {
    try {
      const allowed = await this.assertCanManage(id, user);
      if (allowed.error) return allowed;

      const driver = allowed.body as Driver;

      if (isAvailable) {
        if (driver.kycStatus !== KycStatus.APPROVED) {
          return forbidden('KYC must be approved before going online');
        }
        if (driver.isBlocked) {
          return forbidden('Driver is blocked due to excessive debt');
        }
        await this.redis.setAvailable(id, driver.vehicleType);
        await this.redis.heartbeat(id);
      } else {
        await this.redis.setUnavailable(id, driver.vehicleType);
      }

      const updated = await this.prisma.driver.update({ where: { id }, data: { isAvailable } });

      // Coming online mid-search: requests raised before now already fanned out
      // to whoever was online then, and nothing would ever re-offer them to this
      // driver. Announce the arrival so RideService can sweep for open work.
      //
      // The last known position may be stale or missing — a driver who has not
      // moved since their last shift, or has not sent a fix yet. The sweep
      // tolerates both, and the next location heartbeat announces again.
      if (isAvailable) {
        const position = await this.redis.getDriverLocation(id);
        this.announceAvailable(updated, position?.lat ?? null, position?.lng ?? null);
      }

      return ok(updated);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Tells the rest of the system a driver is online at a known position.
   *
   * An event rather than a direct call: RideService already depends on this
   * service, so reaching back into it for the sweep would close a dependency
   * cycle. The bus is how that edge stays one-way.
   */
  private announceAvailable(driver: Driver, lat: number | null, lng: number | null) {
    if (lat == null || lng == null) return;

    this.events.emit('driver.available', {
      driverId: driver.id,
      userId: driver.userId,
      vehicleType: driver.vehicleType,
      lat,
      lng,
    });
  }

  // -------------------------------------------------------------- location

  /** Writes to Redis only — the flush job batches it into Postgres. */
  async updateLocation(userId: string, dto: DriverLocationDto): Promise<ServiceResult> {
    try {
      const found = await this.requireDriverForUser(userId);
      if (found.error) return found;

      const driver = found.body as Driver;
      if (driver.isBlocked) return forbidden('Driver is blocked');

      await this.redis.saveDriverLocation(driver.id, dto);

      if (driver.isAvailable && driver.kycStatus === KycStatus.APPROVED) {
        await this.redis.setAvailable(driver.id, driver.vehicleType);

        // Announced on every fix, not just the first. It costs one Redis SETNX
        // — RideService throttles the actual sweep — and it is what covers the
        // driver who toggled online before their GPS had a fix, as well as one
        // who simply drove into range of a request raised while they were away.
        this.announceAvailable(driver, dto.lat, dto.lng);
      }

      return ok({
        driverId: driver.id,
        lat: dto.lat,
        lng: dto.lng,
        recordedAt: dto.recordedAt || new Date().toISOString(),
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Redis answers "who is near"; Postgres answers "who are they". Drivers whose
   * database state disqualifies them (unapproved, blocked, offline) are dropped
   * even if Redis still lists them.
   */
  async findNearby(query: NearbyDriversQueryDto): Promise<ServiceResult> {
    try {
      return ok({ drivers: await this.nearbyDrivers(query) });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Raw list for internal callers (ride matching) that need the array itself. */
  async nearbyDrivers(query: NearbyDriversQueryDto) {
    const nearby = await this.redis.getDriversNearby(query);
    if (nearby.length === 0) return [];

    const drivers = await this.prisma.driver.findMany({
      where: {
        id: { in: nearby.map((entry) => entry.driverId) },
        kycStatus: KycStatus.APPROVED,
        isBlocked: false,
        isAvailable: true,
        ...(query.vehicleType ? { vehicleType: query.vehicleType as VehicleType } : {}),
      },
      include: { user: { select: CONTACT_USER_SELECT } },
    });

    const byId = new Map(drivers.map((driver) => [driver.id, driver]));

    return nearby
      .filter((entry) => byId.has(entry.driverId))
      .map((entry) => {
        const driver = byId.get(entry.driverId)!;
        return {
          ...entry,
          vehicleType: driver.vehicleType,
          vehicleModel: driver.vehicleModel,
          vehiclePlate: driver.vehiclePlate,
          vehicleColor: driver.vehicleColor,
          rating: driver.rating,
          totalTrips: driver.totalTrips,
          name: driver.user.name,
          phone: driver.user.phone,
        };
      });
  }

  // ----------------------------------------------------------------- money

  async getAnalytics(id: string): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.findUnique({ where: { id } });
      if (!driver) return notFound('Driver not found');

      const today = startOfToday();
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);

      const [allTime, todayAgg, weekAgg, activeTrips] = await Promise.all([
        this.prisma.order.aggregate({
          where: { driverId: id, status: 'COMPLETED' },
          _sum: { driverEarnings: true },
        }),
        this.prisma.order.aggregate({
          where: { driverId: id, status: 'COMPLETED', completedAt: { gte: today } },
          _sum: { driverEarnings: true },
        }),
        this.prisma.order.aggregate({
          where: { driverId: id, status: 'COMPLETED', completedAt: { gte: weekAgo } },
          _sum: { driverEarnings: true },
        }),
        this.prisma.order.count({
          where: { driverId: id, status: { in: ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] } },
        }),
      ]);

      // Rate over trips the driver actually engaged with, not lifetime completions.
      const attempted = driver.acceptedTrips + driver.cancelledTrips;

      return ok({
        totalEarnings: allTime._sum.driverEarnings ?? 0,
        todayEarnings: todayAgg._sum.driverEarnings ?? 0,
        weekEarnings: weekAgg._sum.driverEarnings ?? 0,
        tripsCompleted: driver.totalTrips,
        activeTrips,
        rating: driver.rating,
        acceptanceRate: attempted > 0 ? round1((driver.acceptedTrips / attempted) * 100) : 0,
        cancellationRate: attempted > 0 ? round1((driver.cancelledTrips / attempted) * 100) : 0,
        currentDebt: driver.currentDebt,
        debtLimit: driver.debtLimit,
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async getWallet(id: string): Promise<ServiceResult> {
    try {
      const wallet = await this.prisma.driverWallet.findUnique({ where: { driverId: id } });
      if (!wallet) return notFound('Wallet not found');
      return ok(wallet);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async updateDebtLimit(id: string, debtLimit: number): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.update({ where: { id }, data: { debtLimit } });
      return ok(driver);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async blockDriver(id: string, isBlocked: boolean): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.update({
        where: { id },
        data: { isBlocked, ...(isBlocked ? { isAvailable: false } : {}) },
      });

      if (isBlocked) await this.redis.removeDriver(id);
      return ok(driver);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Clears debt, records the ledger entry, and unblocks once back under the limit. */
  async payDebt(id: string, requestedAmount: number): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.findUnique({
        where: { id },
        include: { wallet: true },
      });

      if (!driver) return notFound('Driver not found');
      if (driver.currentDebt <= 0) return badRequest('No outstanding debt');

      const amount = Math.min(requestedAmount, driver.currentDebt);
      const balanceAfter = driver.wallet?.availableBalance ?? 0;
      const clearsBlock = driver.isBlocked && driver.currentDebt - amount < driver.debtLimit;

      const [updated] = await this.prisma.$transaction([
        this.prisma.driver.update({
          where: { id },
          data: {
            currentDebt: { decrement: amount },
            ...(clearsBlock ? { isBlocked: false } : {}),
          },
        }),
        this.prisma.driverWallet.update({
          where: { driverId: id },
          data: { totalDebt: { decrement: amount } },
        }),
        this.prisma.ledgerTransaction.create({
          data: {
            driverId: id,
            type: 'DEBT_PAYMENT',
            amount: -amount,
            balanceAfter,
            reference: `DEBT-${id}-${Date.now()}`,
            description: `Debt payment of ${amount}`,
          },
        }),
      ]);

      return ok(updated);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}

function parsePhotoTypes(raw: string | undefined, count: number): VehiclePhotoType[] {
  const provided = (raw || '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean) as VehiclePhotoType[];

  return Array.from({ length: count }, (_, index) => provided[index] ?? VehiclePhotoType.OTHER);
}

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
