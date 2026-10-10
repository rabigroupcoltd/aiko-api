import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, badRequest, ok } from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  PLATFORM_SETTINGS,
  PlatformSettingKey,
  isPlatformSettingKey,
} from './platform-settings.constants';

/**
 * Admin-editable numeric knobs, backed by `PlatformSetting` and cached in
 * memory — `getNumber` is called from the pricing hot path, so it has to be a
 * synchronous read rather than a query per fare quote.
 *
 * The cache is this service's own writes and its own boot-time load; nothing
 * else touches the table, so there is no staleness to guard against beyond
 * restarting a second instance onto rows the first one just changed — an
 * acceptable gap for a value an admin tunes rarely, not one this app assumes
 * is instantaneous across a fleet of instances.
 */
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
      // A cold database must not stop the app from booting — every reader
      // falls back to the literal default while the cache is empty.
      this.logger.warn(`Could not load platform settings: ${e?.message}`);
    }
  }

  /** Creates any row that has never been set, and warms the cache from what's there. */
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

  /** Synchronous — safe to call from pricing's own arithmetic, not just its I/O. */
  getNumber(key: PlatformSettingKey): number {
    return this.cache.get(key) ?? PLATFORM_SETTINGS[key].default;
  }

  async findAll(): Promise<ServiceResult> {
    try {
      const rows = await this.prisma.platformSetting.findMany({
        where: { key: { in: Object.keys(PLATFORM_SETTINGS) } },
        orderBy: { key: 'asc' },
      });
      const byKey = new Map(rows.map((row) => [row.key, row]));

      return ok(
        (Object.keys(PLATFORM_SETTINGS) as PlatformSettingKey[]).map((key) => {
          const row = byKey.get(key);
          return {
            key,
            label: PLATFORM_SETTINGS[key].label,
            value: this.getNumber(key),
            min: PLATFORM_SETTINGS[key].min,
            description: PLATFORM_SETTINGS[key].description,
            updatedAt: row?.updatedAt.toISOString() ?? null,
          };
        }),
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

      const row = await this.prisma.platformSetting.upsert({
        where: { key },
        create: { key, value: String(value), description: definition.description },
        update: { value: String(value) },
      });

      this.cache.set(key, value);

      return ok({
        key,
        label: definition.label,
        value,
        min: definition.min,
        description: definition.description,
        updatedAt: row.updatedAt.toISOString(),
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}
