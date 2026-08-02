import { Injectable, Logger } from '@nestjs/common';
import { DevicePlatform } from '@prisma/client';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, ok } from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDeviceDto } from './dto/notification.dto';

/**
 * Where a user's push notifications go.
 *
 * Registration is idempotent: the client re-registers on every launch and on
 * every token refresh, and both land on the same row.
 */
@Injectable()
export class DeviceTokensService {
  private readonly logger = new Logger(DeviceTokensService.name);

  constructor(
    private prisma: PrismaService,
    private response: ResponsesService,
  ) {}

  async register(userId: string, dto: RegisterDeviceDto): Promise<ServiceResult> {
    try {
      // Clear anything else claiming this handset first. It covers two cases
      // at once: a token that rotated under the same user, and a phone that
      // changed hands — the previous owner must stop receiving its pushes
      // immediately, not whenever FCM gets round to invalidating the token.
      if (dto.deviceId) {
        await this.prisma.deviceToken.deleteMany({
          where: { deviceId: dto.deviceId, token: { not: dto.token } },
        });
      }

      const device = await this.prisma.deviceToken.upsert({
        where: { token: dto.token },
        create: {
          userId,
          token: dto.token,
          platform: (dto.platform ?? 'ANDROID') as DevicePlatform,
          deviceId: dto.deviceId,
          deviceName: dto.deviceName,
          appVersion: dto.appVersion,
        },
        // userId is written on update too: the same token under a new account
        // means somebody else signed in on that device.
        update: {
          userId,
          platform: (dto.platform ?? 'ANDROID') as DevicePlatform,
          deviceId: dto.deviceId,
          deviceName: dto.deviceName,
          appVersion: dto.appVersion,
        },
      });

      return ok(device);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Called on sign-out. Scoped to the caller so one user cannot silence another. */
  async unregister(userId: string, token: string): Promise<ServiceResult> {
    try {
      const removed = await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
      return ok({ removed: removed.count });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async listForUser(userId: string): Promise<ServiceResult> {
    try {
      const devices = await this.prisma.deviceToken.findMany({
        where: { userId },
        // The token itself is deliberately not selected — it is a send-only
        // credential and the client has no use for a list of them.
        select: {
          id: true,
          platform: true,
          deviceId: true,
          deviceName: true,
          appVersion: true,
          lastUsedAt: true,
          createdAt: true,
        },
        orderBy: { updatedAt: 'desc' },
      });

      return ok(devices);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}
