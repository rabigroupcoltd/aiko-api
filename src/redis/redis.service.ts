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
  GEO_KEY,
  HEARTBEAT_TTL_SECONDS,
  availableKey,
  heartbeatKey,
  metaKey,
} from './redis.keys';
import { REDIS_CLIENT } from './redis.provider';

type GeoSearchRow = [driverId: string, distance: string, coords: [string, string]];

/**
 * Real-time driver presence. Redis is the source of truth for "where is a
 * driver right now"; Postgres only holds the periodically flushed snapshot.
 */
@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  get client(): Redis {
    return this.redis;
  }

  /** GEOADD + metadata + heartbeat in a single round trip. */
  async saveDriverLocation(driverId: string, dto: DriverLocationDto): Promise<void> {
    const recordedAt = dto.recordedAt || new Date().toISOString();

    await this.redis
      .multi()
      .geoadd(GEO_KEY, dto.lng, dto.lat, driverId)
      .hset(metaKey(driverId), {
        heading: dto.heading ?? '',
        speedKph: dto.speedKph ?? '',
        accuracyMeters: dto.accuracyMeters ?? '',
        recordedAt,
      })
      .set(heartbeatKey(driverId), '1', 'EX', HEARTBEAT_TTL_SECONDS)
      .exec();
  }

  async getDriverLocation(driverId: string): Promise<DriverNearbyResponse | null> {
    const [positions, meta] = await Promise.all([
      this.redis.geopos(GEO_KEY, driverId),
      this.redis.hgetall(metaKey(driverId)),
    ]);

    const position = positions?.[0];
    if (!position) return null;

    return {
      driverId,
      lng: parseFloat(position[0]),
      lat: parseFloat(position[1]),
      distanceKm: null,
      ...parseMeta(meta),
    };
  }

  /**
   * GEOSEARCH, then drop anyone whose heartbeat expired or who is not in the
   * availability set for the requested vehicle type.
   */
  async getDriversNearby(query: NearbyDriversQueryDto): Promise<DriverNearbyResponse[]> {
    const limit = query.limit ?? 20;

    // Over-fetch: filtering happens after the radius query, so asking for
    // exactly `limit` would under-return once offline drivers are removed.
    const raw = (await this.redis.call(
      'GEOSEARCH',
      GEO_KEY,
      'FROMLONLAT',
      String(query.lng),
      String(query.lat),
      'BYRADIUS',
      String(query.radiusKm),
      'km',
      'ASC',
      'COUNT',
      String(limit * 4),
      'WITHDIST',
      'WITHCOORD',
    )) as GeoSearchRow[];

    if (!raw?.length) return [];

    const candidateIds = raw.map(([driverId]) => driverId);
    const online = await this.filterOnline(candidateIds, query.vehicleType as VehicleType | undefined);

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

  /** Intersects live heartbeats with the availability set. */
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

  async getAvailableDriverIds(vehicleType?: VehicleType): Promise<string[]> {
    if (vehicleType) return this.redis.smembers(availableKey(vehicleType));
    return this.redis.sunion(...ALL_AVAILABLE_KEYS);
  }

  /** Full teardown when a driver goes offline or is blocked. */
  async removeDriver(driverId: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.zrem(GEO_KEY, driverId);
    pipeline.del(metaKey(driverId));
    pipeline.del(heartbeatKey(driverId));
    ALL_AVAILABLE_KEYS.forEach((key) => pipeline.srem(key, driverId));
    await pipeline.exec();
  }

  /** Snapshot of every tracked driver — used by the location flush job. */
  async getAllTrackedDriverIds(): Promise<string[]> {
    return this.redis.zrange(GEO_KEY, 0, -1);
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
