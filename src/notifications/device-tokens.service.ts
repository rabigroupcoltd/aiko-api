import { Injectable, Logger } from '@nestjs/common';
import { DevicePlatform } from '@prisma/client';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, ok } from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDeviceDto } from './dto/notification.dto';

@Injectable()
export class DeviceTokensService {
  private readonly logger = new Logger(DeviceTokensService.name);

  constructor(
    private prisma: PrismaService,
    private response: ResponsesService,
  ) {}

  async register(userId: string, dto: RegisterDeviceDto): Promise<ServiceResult> {
    try {
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
