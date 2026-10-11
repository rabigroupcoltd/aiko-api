import { Injectable, Logger } from '@nestjs/common';
import {
  AccountType,
  AuditEntity,
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
import {
  DRIVER_ACTIVE_STATUSES,
  LEGACY_ACTIVE_STATUSES,
  MAX_RESERVED_ORDERS_PER_DRIVER,
} from '../dispatch/dispatch.constants';
import { deriveDispatchStatus } from '../dispatch/driver-status.util';
import { AuditService } from '../audit/audit.service';
import { RideEventsService } from '../events/ride-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { DriverLocationDto, NearbyDriversQueryDto } from '../redis/dto/driver-location.dto';
import { HEARTBEAT_TTL_SECONDS } from '../redis/redis.keys';
import { RedisService } from '../redis/redis.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { StorageService } from '../storage/storage.service';
import { UploadFile } from '../storage/storage.types';
import { DriverDebtStatus, driverDebtStatus } from './driver-debt.util';
import { ListDriversQueryDto, RegisterDriverDto, UpdateDriverDto } from './dto/driver.dto';

@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private redis: RedisService,
    private events: RideEventsService,
    private audit: AuditService,
    private response: ResponsesService,
    private settings: PlatformSettingsService,
  ) {}

  debtStatus(driver: Pick<Driver, 'currentDebt' | 'debtLimit'>): DriverDebtStatus {
    return driverDebtStatus(driver, this.settings.getNumber('DRIVER_DEBT_LIMIT'));
  }

  workBlockReason(
    driver: Pick<Driver, 'kycStatus' | 'isBlocked' | 'currentDebt' | 'debtLimit'>,
  ): string | null {
    if (driver.kycStatus !== KycStatus.APPROVED) return 'Your KYC is not approved yet';
    if (driver.isBlocked) return 'Your account has been blocked. Please contact support.';

    const debt = this.debtStatus(driver);
    if (debt.locked) {
      return `You owe ₦${debt.current.toLocaleString()} in commission, which has reached your limit of ₦${debt.limit.toLocaleString()}. Pay it to an admin to start taking trips again.`;
    }
    return null;
  }

  private withDebt<T extends Pick<Driver, 'currentDebt' | 'debtLimit'>>(driver: T) {
    return { ...driver, debt: this.debtStatus(driver) };
  }

  async register(
    userId: string,
    dto: RegisterDriverDto,
    files: UploadFile[] = [],
  ): Promise<ServiceResult> {
    let uploads: Awaited<ReturnType<StorageService['uploadMany']>> = [];

    try {
      if (!dto.vehicleBrand?.trim() && !dto.vehicleModel?.trim()) {
        return badRequest('Tell us the brand of your vehicle');
      }

      const existing = await this.prisma.driver.findUnique({ where: { userId } });
      if (existing) {
        if (existing.kycStatus === KycStatus.REJECTED) {
          return this.resubmit(existing, dto, files);
        }
        return conflict(
          existing.kycStatus === KycStatus.PENDING
            ? 'Your documents are already with us and waiting for review'
            : 'Driver profile already exists',
        );
      }

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
            vehicleBrand: dto.vehicleBrand?.trim() || null,
            vehicleModel: dto.vehicleModel?.trim() || null,
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

      return ok(drivers.map((driver) => this.withDebt(driver)));
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async incompleteApplications(): Promise<ServiceResult> {
    try {
      const users = await this.prisma.user.findMany({
        where: { accountType: AccountType.RIDER, driver: null },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          profilePhotoUrl: true,
          onboardingStep: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
      });

      return ok(users);
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
      return ok(this.withDebt(driver));
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

  async requireDriverForUser(userId: string): Promise<ServiceResult<Driver | string>> {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) return forbidden('You do not have a driver profile');
    return ok(driver);
  }

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

  private async resubmit(
    existing: Driver,
    dto: RegisterDriverDto,
    files: UploadFile[],
  ): Promise<ServiceResult> {
    let uploads: Awaited<ReturnType<StorageService['uploadMany']>> = [];

    try {
      const plate = dto.vehiclePlate.toUpperCase();
      const plateTaken = await this.prisma.driver.findFirst({
        where: { vehiclePlate: plate, id: { not: existing.id } },
      });
      if (plateTaken) return conflict('Vehicle plate is already registered');

      uploads = await this.storage.uploadMany(files, { folder: `vehicles/${existing.userId}` });
      const photoTypes = parsePhotoTypes(dto.photoTypes, files.length);

      const previous = await this.prisma.vehiclePhoto.findMany({
        where: { driverId: existing.id },
        select: { key: true, provider: true },
      });

      const driver = await this.prisma.$transaction(async (tx) => {
        await tx.vehiclePhoto.deleteMany({ where: { driverId: existing.id } });

        const updated = await tx.driver.update({
          where: { id: existing.id },
          data: {
            vehicleType: dto.vehicleType as VehicleType,
            vehiclePlate: plate,
            vehicleBrand: dto.vehicleBrand?.trim() || null,
            vehicleModel: dto.vehicleModel?.trim() || null,
            vehicleColor: dto.vehicleColor,
            vehicleYear: dto.vehicleYear,
            kycStatus: KycStatus.PENDING,
            kycRejectionReason: null,
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
          include: { user: { select: PUBLIC_USER_SELECT }, wallet: true, vehiclePhotos: true },
        });

        await tx.user.update({
          where: { id: existing.userId },
          data: { onboardingStep: OnboardingStep.AWAITING_APPROVAL },
        });

        return updated;
      });

      await this.discardUploads(previous).catch((e) =>
        this.logger.warn(`Could not delete replaced KYC photos: ${e?.message}`),
      );

      await this.audit.record({
        action: 'driver.kyc.resubmit',
        entity: AuditEntity.DRIVER,
        entityId: existing.id,
        summary: `${driver.user?.name ?? 'A driver'} resubmitted their documents`,
        metadata: { photos: uploads.length, newStatus: KycStatus.PENDING },
      });

      return ok(driver);
    } catch (e) {
      await this.discardUploads(uploads);
      return this.response.errorHandler(e);
    }
  }

  private async discardUploads(uploads: { key: string; provider: any }[]) {
    if (uploads.length === 0) return;
    await Promise.all(uploads.map((upload) => this.storage.delete(upload.key, upload.provider)));
  }

  async approveKyc(id: string, actor?: JwtUser): Promise<ServiceResult> {
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
          ...(driver.user.onboardingCompletedAt ? {} : { onboardingCompletedAt: new Date() }),
        },
      });

      this.events.emit('driver.kyc-updated', driver);

      await this.audit.record({
        actor,
        action: 'driver.kyc.approve',
        entity: AuditEntity.DRIVER,
        entityId: id,
        summary: `Approved KYC for ${driver.user?.name ?? 'a driver'}`,
        metadata: { vehicleType: driver.vehicleType, newStatus: KycStatus.APPROVED },
      });

      return ok(driver);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async rejectKyc(id: string, reason: string, actor?: JwtUser): Promise<ServiceResult> {
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

      await this.audit.record({
        actor,
        action: 'driver.kyc.reject',
        entity: AuditEntity.DRIVER,
        entityId: id,
        summary: `Rejected KYC for ${driver.user?.name ?? 'a driver'}`,
        metadata: { reason, newStatus: KycStatus.REJECTED },
      });

      return ok(driver);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async setAvailability(id: string, isAvailable: boolean, user: JwtUser): Promise<ServiceResult> {
    try {
      const allowed = await this.assertCanManage(id, user);
      if (allowed.error) return allowed;

      const driver = allowed.body as Driver;

      if (isAvailable) {
        const blocked = this.workBlockReason(driver);
        if (blocked) return forbidden(blocked);
        await this.redis.setAvailable(id, driver.vehicleType);
        await this.redis.heartbeat(id);
      } else {
        await this.redis.setUnavailable(id, driver.vehicleType);
      }

      const updated = await this.prisma.driver.update({ where: { id }, data: { isAvailable } });

      if (isAvailable) {
        const position = await this.redis.getDriverLocation(id, driver.vehicleType);
        this.announceAvailable(updated, position?.lat ?? null, position?.lng ?? null);
      }

      return ok(updated);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

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

  async goOnline(userId: string): Promise<ServiceResult> {
    const found = await this.requireDriverForUser(userId);
    if (found.error) return found;
    return this.setAvailability((found.body as Driver).id, true, asSelf(userId));
  }

  async goOffline(userId: string): Promise<ServiceResult> {
    const found = await this.requireDriverForUser(userId);
    if (found.error) return found;
    return this.setAvailability((found.body as Driver).id, false, asSelf(userId));
  }

  async heartbeat(userId: string): Promise<ServiceResult> {
    try {
      const found = await this.requireDriverForUser(userId);
      if (found.error) return found;

      const driver = found.body as Driver;
      if (driver.isBlocked) return forbidden('Driver is blocked');
      if (!driver.isAvailable) return badRequest('You are offline — go online first');

      await this.redis.heartbeat(driver.id);
      if (this.workBlockReason(driver)) {
        await this.redis.setUnavailable(driver.id, driver.vehicleType);
      } else {
        await this.redis.setAvailable(driver.id, driver.vehicleType);
      }

      return ok({
        driverId: driver.id,
        online: true,
        expiresInSeconds: HEARTBEAT_TTL_SECONDS,
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async getState(userId: string): Promise<ServiceResult> {
    try {
      const found = await this.requireDriverForUser(userId);
      if (found.error) return found;

      const driver = found.body as Driver;

      const [heldCount, legacyCount, online, position, activeOrders] = await Promise.all([
        this.prisma.order.count({
          where: { driverId: driver.id, status: { in: DRIVER_ACTIVE_STATUSES } },
        }),
        this.prisma.order.count({
          where: { driverId: driver.id, status: { in: LEGACY_ACTIVE_STATUSES } },
        }),
        this.redis.isOnline(driver.id),
        this.redis.getDriverLocation(driver.id, driver.vehicleType),
        this.prisma.order.findMany({
          where: {
            driverId: driver.id,
            status: { in: [...DRIVER_ACTIVE_STATUSES, ...LEGACY_ACTIVE_STATUSES] },
          },
          select: {
            id: true,
            status: true,
            description: true,
            pickupLocation: true,
            pickupLat: true,
            pickupLng: true,
            dropoffLocation: true,
            dropoffLat: true,
            dropoffLng: true,
            distanceKm: true,
            fare: true,
            driverEarnings: true,
            currency: true,
            reservedAt: true,
            createdAt: true,
          },
          orderBy: { reservedAt: 'asc' },
        }),
      ]);

      const debt = this.debtStatus(driver);
      const blockReason = this.workBlockReason(driver);

      const status = deriveDispatchStatus({
        isAvailable: driver.isAvailable,
        isBlocked: driver.isBlocked,
        debtLocked: debt.locked,
        kycStatus: driver.kycStatus,
        heldCount,
        legacyCount,
      });

      return ok({
        driverId: driver.id,
        vehicleType: driver.vehicleType,

        status,

        isAvailable: driver.isAvailable,

        presence: { online, heartbeatTtlSeconds: HEARTBEAT_TTL_SECONDS },

        kycStatus: driver.kycStatus,
        isBlocked: driver.isBlocked,
        canGoOnline: blockReason === null,
        blockReason,
        debt,

        held: heldCount + legacyCount,
        capacity: MAX_RESERVED_ORDERS_PER_DRIVER,
        atCapacity: heldCount >= MAX_RESERVED_ORDERS_PER_DRIVER,
        activeOrders,

        lastLocation: position
          ? { lat: position.lat, lng: position.lng, recordedAt: position.recordedAt ?? null }
          : null,
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async updateLocation(userId: string, dto: DriverLocationDto): Promise<ServiceResult> {
    try {
      const found = await this.requireDriverForUser(userId);
      if (found.error) return found;

      const driver = found.body as Driver;
      if (driver.isBlocked) return forbidden('Driver is blocked');

      await this.redis.saveDriverLocation(driver.id, driver.vehicleType, dto);

      const recordedAt = dto.recordedAt || new Date().toISOString();

      this.events.emit('driver.location', {
        driverId: driver.id,
        lat: dto.lat,
        lng: dto.lng,
        heading: dto.heading,
        speedKph: dto.speedKph,
        recordedAt,
      });

      if (driver.isAvailable && !this.workBlockReason(driver)) {
        await this.redis.setAvailable(driver.id, driver.vehicleType);

        this.announceAvailable(driver, dto.lat, dto.lng);
      }

      return ok({ driverId: driver.id, lat: dto.lat, lng: dto.lng, recordedAt });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findNearby(query: NearbyDriversQueryDto): Promise<ServiceResult> {
    try {
      return ok({ drivers: await this.nearbyDrivers(query) });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

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

    const byId = new Map(
      drivers
        .filter((driver) => !this.debtStatus(driver).locked)
        .map((driver) => [driver.id, driver]),
    );

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
        debtLimit: this.debtStatus(driver).limit,
        debt: this.debtStatus(driver),
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

  async updateDebtLimit(
    id: string,
    debtLimit: number | null,
    actor?: JwtUser,
  ): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.update({ where: { id }, data: { debtLimit } });
      const debt = this.debtStatus(driver);

      if (debt.locked) await this.redis.setUnavailable(id, driver.vehicleType);

      await this.audit.record({
        actor,
        action: 'driver.debt-limit',
        entity: AuditEntity.DRIVER,
        entityId: id,
        summary:
          debtLimit == null
            ? `Reset debt limit for driver ${id} to the platform default`
            : `Set debt limit for driver ${id} to ${debtLimit}`,
        metadata: { debtLimit, effectiveLimit: debt.limit, currentDebt: driver.currentDebt },
      });

      return ok(this.withDebt(driver));
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async blockDriver(id: string, isBlocked: boolean, actor?: JwtUser): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.update({
        where: { id },
        data: { isBlocked, ...(isBlocked ? { isAvailable: false } : {}) },
      });

      if (isBlocked) await this.redis.removeDriver(id);

      await this.audit.record({
        actor,
        action: isBlocked ? 'driver.block' : 'driver.unblock',
        entity: AuditEntity.DRIVER,
        entityId: id,
        summary: `${isBlocked ? 'Blocked' : 'Unblocked'} driver ${id}`,
        metadata: { isBlocked, currentDebt: driver.currentDebt, debtLimit: driver.debtLimit },
      });

      return ok(driver);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async payDebt(id: string, requestedAmount: number, actor?: JwtUser): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.findUnique({
        where: { id },
        include: { wallet: true },
      });

      if (!driver) return notFound('Driver not found');
      if (driver.currentDebt <= 0) return badRequest('No outstanding debt');

      const amount = Math.min(requestedAmount, driver.currentDebt);
      const balanceAfter = driver.wallet?.availableBalance ?? 0;

      const [updated] = await this.prisma.$transaction([
        this.prisma.driver.update({
          where: { id },
          data: {
            currentDebt: { decrement: amount },
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

      await this.audit.record({
        actor,
        action: 'driver.debt-payment',
        entity: AuditEntity.DRIVER,
        entityId: id,
        summary: `Recorded a debt payment of ${amount} for driver ${id}`,
        metadata: { amount, debtBefore: driver.currentDebt, debtAfter: updated.currentDebt },
      });

      return ok(this.withDebt(updated));
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

function asSelf(userId: string): JwtUser {
  return { sub: userId } as JwtUser;
}
