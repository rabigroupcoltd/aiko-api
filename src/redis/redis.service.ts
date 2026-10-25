import { Inject, Injectable, Logger } from '@nestjs/common';
import { VehicleType } from '@prisma/client';
import Redis from 'ioredis';
import {
  DriverLocationDto,
  DriverNearbyResponse,
  NearbyDriversQueryDto,
} from './dto/driver-location.dto';
import {
  ALL_AVAILABLE_KEYS,
  ALL_GEO_KEYS,
  DARK_FLAG_TTL_SECONDS,
  HEARTBEAT_TTL_SECONDS,
  HOT_GEO_KEYS,
  OFFERED_TTL_SECONDS,
  availableKey,
  darkFlagKey,
  geoKey,
  heartbeatKey,
  metaKey,
  offeredKey,
} from './redis.keys';
import { REDIS_CLIENT } from './redis.provider';

type GeoSearchRow = [driverId: string, distance: string, coords: [string, string]];

export interface TrackedDriver {
  driverId: string;
  vehicleType: VehicleType;
}

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  get client(): Redis {
    return this.redis;
  }

  async saveDriverLocation(
    driverId: string,
    vehicleType: VehicleType,
    dto: DriverLocationDto,
  ): Promise<void> {
    const recordedAt = dto.recordedAt || new Date().toISOString();

    const pipeline = this.redis
      .multi()
      .geoadd(geoKey(vehicleType), dto.lng, dto.lat, driverId)
      .hset(metaKey(driverId), {
        heading: dto.heading ?? '',
        speedKph: dto.speedKph ?? '',
        accuracyMeters: dto.accuracyMeters ?? '',
        recordedAt,
      })
      .set(heartbeatKey(driverId), '1', 'EX', HEARTBEAT_TTL_SECONDS);

    HOT_GEO_KEYS.filter((key) => key !== geoKey(vehicleType)).forEach((key) =>
      pipeline.zrem(key, driverId),
    );

    await pipeline.exec();
  }

  async getDriverLocation(
    driverId: string,
    vehicleType?: VehicleType,
  ): Promise<DriverNearbyResponse | null> {
    const keys = vehicleType ? [geoKey(vehicleType)] : ALL_GEO_KEYS;

    const pipeline = this.redis.pipeline();
    keys.forEach((key) => pipeline.geopos(key, driverId));
    const [positions, meta] = await Promise.all([
      pipeline.exec(),
      this.redis.hgetall(metaKey(driverId)),
    ]);

    const found = positions
      ?.map((result) => (result?.[1] as [string, string][] | null)?.[0])
      .find((position) => position != null);

    if (!found) return null;

    return {
      driverId,
      lng: parseFloat(found[0]),
      lat: parseFloat(found[1]),
      distanceKm: null,
      ...parseMeta(meta),
    };
  }

  async getDriversNearby(query: NearbyDriversQueryDto): Promise<DriverNearbyResponse[]> {
    const limit = query.limit ?? 20;
    const vehicleType = query.vehicleType as VehicleType | undefined;
    const keys = vehicleType ? [geoKey(vehicleType)] : ALL_GEO_KEYS;

    const perKey = String(limit * 4);

    const results = await Promise.all(
      keys.map(
        (key) =>
          this.redis.call(
            'GEOSEARCH',
            key,
            'FROMLONLAT',
            String(query.lng),
            String(query.lat),
            'BYRADIUS',
            String(query.radiusKm),
            'km',
            'ASC',
            'COUNT',
            perKey,
            'WITHDIST',
            'WITHCOORD',
          ) as Promise<GeoSearchRow[]>,
      ),
    );

    const raw = results
      .flat()
      .filter(Boolean)
      .sort((a, b) => parseFloat(a[1]) - parseFloat(b[1]));

    if (raw.length === 0) return [];

    const candidateIds = raw.map(([driverId]) => driverId);
    const online = await this.filterOnline(candidateIds, vehicleType);

    const pipeline = this.redis.pipeline();
    raw.forEach(([driverId]) => pipeline.hgetall(metaKey(driverId)));
    const metas = await pipeline.exec();

    return raw
      .map(([driverId, distance, [lng, lat]], index) => ({
        driverId,
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        distanceKm: Math.round(parseFloat(distance) * 100) / 100,
        ...parseMeta(metas?.[index]?.[1] as Record<string, string> | undefined),
      }))
      .filter((driver) => online.has(driver.driverId))
      .slice(0, limit);
  }

  private async filterOnline(driverIds: string[], vehicleType?: VehicleType): Promise<Set<string>> {
    const pipeline = this.redis.pipeline();
    driverIds.forEach((driverId) => pipeline.exists(heartbeatKey(driverId)));
    const heartbeats = await pipeline.exec();

    const alive = driverIds.filter((_, index) => heartbeats?.[index]?.[1] === 1);
    if (alive.length === 0) return new Set();

    const keys = vehicleType ? [availableKey(vehicleType)] : ALL_AVAILABLE_KEYS;
    const membership = this.redis.pipeline();
    alive.forEach((driverId) => keys.forEach((key) => membership.sismember(key, driverId)));
    const results = await membership.exec();

    const available = new Set<string>();
    alive.forEach((driverId, driverIndex) => {
      const isMember = keys.some(
        (_, keyIndex) => results?.[driverIndex * keys.length + keyIndex]?.[1] === 1,
      );
      if (isMember) available.add(driverId);
    });

    return available;
  }

  async setAvailable(driverId: string, vehicleType: VehicleType): Promise<void> {
    await this.redis.sadd(availableKey(vehicleType), driverId);
  }

  async setUnavailable(driverId: string, vehicleType?: VehicleType): Promise<void> {
    const keys = vehicleType ? [availableKey(vehicleType)] : ALL_AVAILABLE_KEYS;
    const pipeline = this.redis.pipeline();
    keys.forEach((key) => pipeline.srem(key, driverId));
    await pipeline.exec();
  }

  async heartbeat(driverId: string): Promise<void> {
    await this.redis.set(heartbeatKey(driverId), '1', 'EX', HEARTBEAT_TTL_SECONDS);
  }

  async isOnline(driverId: string): Promise<boolean> {
    return (await this.redis.exists(heartbeatKey(driverId))) === 1;
  }

  async hasAnyOnlineDriver(): Promise<boolean> {
    const tracked = await this.getAllTrackedDrivers();
    if (tracked.length === 0) return false;
    return (await this.redis.exists(...tracked.map(({ driverId }) => heartbeatKey(driverId)))) > 0;
  }

  async flagDriverDark(driverId: string): Promise<void> {
    await this.redis.set(darkFlagKey(driverId), '1', 'EX', DARK_FLAG_TTL_SECONDS);
  }

  async isDriverFlaggedDark(driverId: string): Promise<boolean> {
    return (await this.redis.exists(darkFlagKey(driverId))) === 1;
  }

  async clearDriverDarkFlag(driverId: string): Promise<void> {
    await this.redis.del(darkFlagKey(driverId));
  }

  async getAvailableDriverIds(vehicleType?: VehicleType): Promise<string[]> {
    if (vehicleType) return this.redis.smembers(availableKey(vehicleType));
    return this.redis.sunion(...ALL_AVAILABLE_KEYS);
  }

  async removeDriver(driverId: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    ALL_GEO_KEYS.forEach((key) => pipeline.zrem(key, driverId));
    pipeline.del(metaKey(driverId));
    pipeline.del(heartbeatKey(driverId));
    ALL_AVAILABLE_KEYS.forEach((key) => pipeline.srem(key, driverId));
    await pipeline.exec();
  }

  async addOfferedDrivers(orderId: string, driverIds: string[]): Promise<void> {
    if (!driverIds.length) return;

    await this.redis
      .multi()
      .sadd(offeredKey(orderId), ...driverIds)
      .expire(offeredKey(orderId), OFFERED_TTL_SECONDS)
      .exec();
  }

  async getOfferedDrivers(orderId: string): Promise<string[]> {
    return this.redis.smembers(offeredKey(orderId));
  }

  async takeOfferedDrivers(orderId: string): Promise<string[]> {
    const [members] = await this.redis
      .multi()
      .smembers(offeredKey(orderId))
      .del(offeredKey(orderId))
      .exec() as [[Error | null, string[]], [Error | null, number]];

    return (members?.[1] as string[]) ?? [];
  }

  async getAllTrackedDrivers(): Promise<TrackedDriver[]> {
    const types = Object.values(VehicleType);

    const pipeline = this.redis.pipeline();
    types.forEach((vehicleType) => pipeline.zrange(geoKey(vehicleType), 0, -1));
    const results = await pipeline.exec();

    return types.flatMap((vehicleType, index) => {
      const ids = (results?.[index]?.[1] as string[] | undefined) ?? [];
      return ids.map((driverId) => ({ driverId, vehicleType }));
    });
  }
}

function parseMeta(meta?: Record<string, string>) {
  const num = (value?: string) => (value ? parseFloat(value) : undefined);
  return {
    heading: num(meta?.heading),
    speedKph: num(meta?.speedKph),
    accuracyMeters: num(meta?.accuracyMeters),
    recordedAt: meta?.recordedAt || null,
  };
}
