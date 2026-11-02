import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, badRequest, ok } from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  PLATFORM_SETTINGS,
  PlatformSettingKey,
  isPlatformSettingKey,
} from './platform-settings.constants';
import { WorkHours, workHours } from './work-hours.util';

@Injectable()
export class PlatformSettingsService implements OnModuleInit {
  private readonly logger = new Logger(PlatformSettingsService.name);
  private readonly cache = new Map<PlatformSettingKey, number>();

  constructor(
    private prisma: PrismaService,
    private response: ResponsesService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureDefaults();
    } catch (e: any) {
      this.logger.warn(`Could not load platform settings: ${e?.message}`);
    }
  }

  async ensureDefaults() {
    const existing = await this.prisma.platformSetting.findMany({
      where: { key: { in: Object.keys(PLATFORM_SETTINGS) } },
    });
    const byKey = new Map(existing.map((row) => [row.key, row]));

    for (const key of Object.keys(PLATFORM_SETTINGS) as PlatformSettingKey[]) {
      const row = byKey.get(key);
      const definition = PLATFORM_SETTINGS[key];

      if (!row) {
        await this.prisma.platformSetting.create({
          data: { key, value: String(definition.default), description: definition.description },
        });
        this.cache.set(key, definition.default);
        continue;
      }

      const parsed = Number(row.value);
      this.cache.set(key, Number.isFinite(parsed) ? parsed : definition.default);
    }
  }

  getNumber(key: PlatformSettingKey): number {
    return this.cache.get(key) ?? PLATFORM_SETTINGS[key].default;
  }

  workHours(at: Date = new Date()): WorkHours {
    return workHours(
      this.getNumber('DRIVER_SHIFT_START_MINUTE'),
      this.getNumber('DRIVER_SHIFT_END_MINUTE'),
      at,
    );
  }

  private describe(key: PlatformSettingKey, value: number, updatedAt: Date | null) {
    const definition = PLATFORM_SETTINGS[key];
    return {
      key,
      label: definition.label,
      value,
      min: definition.min,
      max: definition.max,
      format: definition.format,
      description: definition.description,
      updatedAt: updatedAt?.toISOString() ?? null,
    };
  }

  async findAll(): Promise<ServiceResult> {
    try {
      const rows = await this.prisma.platformSetting.findMany({
        where: { key: { in: Object.keys(PLATFORM_SETTINGS) } },
        orderBy: { key: 'asc' },
      });
      const byKey = new Map(rows.map((row) => [row.key, row]));

      return ok(
        (Object.keys(PLATFORM_SETTINGS) as PlatformSettingKey[]).map((key) =>
          this.describe(key, this.getNumber(key), byKey.get(key)?.updatedAt ?? null),
        ),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async update(key: string, value: number): Promise<ServiceResult> {
    try {
      if (!isPlatformSettingKey(key)) return badRequest(`Unknown setting "${key}"`);
      if (!Number.isFinite(value)) return badRequest('value must be a finite number');

      const definition = PLATFORM_SETTINGS[key];
      if (value < definition.min) {
        return badRequest(`${definition.label} cannot be less than ${definition.min}`);
      }
      if (definition.max !== null && value > definition.max) {
        return badRequest(`${definition.label} cannot be more than ${definition.max}`);
      }
      if (definition.format === 'time' && !Number.isInteger(value)) {
        return badRequest(`${definition.label} must be a whole number of minutes`);
      }

      const row = await this.prisma.platformSetting.upsert({
        where: { key },
        create: { key, value: String(value), description: definition.description },
        update: { value: String(value) },
      });

      this.cache.set(key, value);

      return ok(this.describe(key, value, row.updatedAt));
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}
