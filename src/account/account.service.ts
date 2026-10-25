import { Injectable, Logger } from '@nestjs/common';
import {
  AuditEntity,
  DeletionRequestStatus,
  OrderStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { JwtUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, badRequest, forbidden, notFound, ok } from '../common/responses/response.types';
import { FirebaseService } from '../firebase/firebase.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { StorageService } from '../storage/storage.service';

const OPEN_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.SEARCHING_FOR_DRIVER,
  OrderStatus.RESERVED,
  OrderStatus.DRIVER_ARRIVING_PICKUP,
  OrderStatus.PICKED_UP,
  OrderStatus.IN_TRANSIT,
  OrderStatus.ACCEPTED,
  OrderStatus.ARRIVED,
  OrderStatus.IN_PROGRESS,
];

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private redis: RedisService,
    private firebase: FirebaseService,
    private audit: AuditService,
    private response: ResponsesService,
  ) {}

  async deleteOwnAccount(user: JwtUser): Promise<ServiceResult> {
    try {
      const result = await this.erase(user.sub, user, 'Deleted their own account from the app');
      if (result.error) return result;
      await this.prisma.accountDeletionRequest.updateMany({
        where: { userId: user.sub, status: DeletionRequestStatus.PENDING },
        data: { status: DeletionRequestStatus.COMPLETED, processedAt: new Date(), note: 'Deleted in app' },
      });
      return ok({ deleted: true });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async requestDeletion(contact: string, reason?: string): Promise<ServiceResult> {
    try {
      const value = contact.trim();
      const user = await this.findByContact(value);

      const recent = await this.prisma.accountDeletionRequest.findFirst({
        where: {
          contact: { equals: value, mode: 'insensitive' },
          status: DeletionRequestStatus.PENDING,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });

      if (!recent) {
        await this.prisma.accountDeletionRequest.create({
          data: { contact: value, reason: reason?.trim() || null, userId: user?.id ?? null, source: 'WEB' },
        });
      }

      return ok({ received: true });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async listRequests(status?: DeletionRequestStatus): Promise<ServiceResult> {
    try {
      const requests = await this.prisma.accountDeletionRequest.findMany({
        where: status ? { status } : {},
        include: {
          user: { select: { id: true, name: true, email: true, phone: true, roles: true, deletedAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      const pending = await this.prisma.accountDeletionRequest.count({
        where: { status: DeletionRequestStatus.PENDING },
      });
      return ok({ pending, result: requests });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async processRequest(id: string, actor: JwtUser, userId?: string): Promise<ServiceResult> {
    try {
      const request = await this.prisma.accountDeletionRequest.findUnique({ where: { id } });
      if (!request) return notFound('Request not found');
      if (request.status !== DeletionRequestStatus.PENDING) return badRequest('This request is already closed');

      const targetId = userId ?? request.userId ?? (await this.findByContact(request.contact))?.id;
      if (!targetId) {
        return badRequest('No account matches this request — reject it, or choose the account to delete');
      }

      const erased = await this.erase(targetId, actor, `Deleted account on request ${request.id}`);
      if (erased.error) return erased;

      const updated = await this.prisma.accountDeletionRequest.update({
        where: { id },
        data: { status: DeletionRequestStatus.COMPLETED, processedAt: new Date(), userId: targetId },
      });
      return ok(updated);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async rejectRequest(id: string, note: string | undefined, actor: JwtUser): Promise<ServiceResult> {
    try {
      const request = await this.prisma.accountDeletionRequest.findUnique({ where: { id } });
      if (!request) return notFound('Request not found');
      if (request.status !== DeletionRequestStatus.PENDING) return badRequest('This request is already closed');

      const updated = await this.prisma.accountDeletionRequest.update({
        where: { id },
        data: { status: DeletionRequestStatus.REJECTED, processedAt: new Date(), note: note?.trim() || null },
      });
      await this.audit.record({
        actor,
        action: 'account.deletion.reject',
        entity: AuditEntity.USER,
        entityId: request.userId ?? request.id,
        summary: `Rejected deletion request ${request.id}`,
        metadata: { note: note ?? null },
      });
      return ok(updated);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  private async findByContact(contact: string) {
    const value = contact.trim();
    if (!value) return null;
    if (value.includes('@')) {
      return this.prisma.user.findFirst({
        where: { email: { equals: value.toLowerCase(), mode: 'insensitive' }, deletedAt: null },
      });
    }
    const digits = value.replace(/\D/g, '');
    if (digits.length < 7) return null;
    const tail = digits.slice(-10);
    return this.prisma.user.findFirst({
      where: { phone: { endsWith: tail }, deletedAt: null },
    });
  }

  private async erase(userId: string, actor: JwtUser, summary: string): Promise<ServiceResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { driver: { include: { vehiclePhotos: true } } },
    });
    if (!user) return notFound('User not found');
    if (user.deletedAt) return ok({ deleted: true });
    if (user.roles.includes(UserRole.ADMIN) || user.roles.includes(UserRole.SUPPORT)) {
      return forbidden('Staff accounts cannot be deleted this way');
    }

    const openAsPassenger = await this.prisma.order.count({
      where: { userId, status: { in: OPEN_ORDER_STATUSES } },
    });
    const openAsDriver = user.driver
      ? await this.prisma.order.count({ where: { driverId: user.driver.id, status: { in: OPEN_ORDER_STATUSES } } })
      : 0;
    if (openAsPassenger + openAsDriver > 0) {
      return badRequest('Finish or cancel your orders in progress before deleting the account');
    }

    const files: { key: string; provider: any }[] = [];
    if (user.profilePhotoKey) files.push({ key: user.profilePhotoKey, provider: this.storage.activeProvider });
    for (const photo of user.driver?.vehiclePhotos ?? []) files.push({ key: photo.key, provider: photo.provider });

    await this.prisma.$transaction(async (tx) => {
      await tx.deviceToken.deleteMany({ where: { userId } });
      await tx.address.deleteMany({ where: { userId } });

      if (user.driver) {
        await tx.vehiclePhoto.deleteMany({ where: { driverId: user.driver.id } });
        await tx.driverLocation.deleteMany({ where: { driverId: user.driver.id } });
        await tx.driver.update({
          where: { id: user.driver.id },
          data: {
            isAvailable: false,
            isBlocked: true,
            vehiclePlate: `DELETED-${user.driver.id.slice(0, 8)}`,
            vehicleBrand: null,
            vehicleModel: null,
            vehicleColor: null,
            vehicleYear: null,
            kycRejectionReason: null,
          },
        });
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          name: 'Deleted user',
          firstName: null,
          lastName: null,
          email: null,
          phone: null,
          dob: null,
          photoUrl: null,
          profilePhotoUrl: null,
          profilePhotoKey: null,
          password: null,
          firebaseUid: null,
          isBlocked: true,
          blockedReason: 'Account deleted',
          deletedAt: new Date(),
        } satisfies Prisma.UserUpdateInput,
      });
    });

    if (user.driver) await this.redis.removeDriver(user.driver.id).catch(() => undefined);
    await Promise.all(files.map((file) => this.storage.delete(file.key, file.provider)));
    if (user.firebaseUid) await this.firebase.deleteUser(user.firebaseUid);

    await this.audit.record({
      actor,
      action: 'account.delete',
      entity: AuditEntity.USER,
      entityId: userId,
      summary,
      metadata: { wasDriver: Boolean(user.driver), filesRemoved: files.length },
    });

    this.logger.log(`Account ${userId} erased`);
    return ok({ deleted: true });
  }
}
