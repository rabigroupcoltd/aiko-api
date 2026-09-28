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

/** A driver in the presence index, with the partition they live in. */
export interface TrackedDriver {
  driverId: string;
  vehicleType: VehicleType;
}

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

  /**
   * GEOADD + metadata + heartbeat in a single round trip.
   *
   * The position goes into the index for this driver's vehicle type, and is
   * removed from every other one. That ZREM is what keeps a driver who
   * re-registered their keke as an okada from lingering in the keke radius
   * searches — a sorted set member has no TTL, so nothing else would ever
   * evict them.
   */
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

    // Only the partitions dispatch actually reads — see HOT_GEO_KEYS. Teardown
    // in removeDriver still sweeps the full enum.
    HOT_GEO_KEYS.filter((key) => key !== geoKey(vehicleType)).forEach((key) =>
      pipeline.zrem(key, driverId),
    );

    await pipeline.exec();
  }

  /**
   * One driver's last known position.
   *
   * `vehicleType` narrows the read to a single index. Callers that already know
   * it — anything holding a Driver row — should pass it; the rest fall back to
   * checking every partition, which is two GEOPOS calls in one pipeline rather
   * than one, and still cheaper than looking the driver up in Postgres first.
   */
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

    // GEOPOS answers with a null entry for a member the key has never seen, so
    // the first non-null across the partitions is the driver's real position.
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

  /**
   * Drivers within a radius, nearest first.
   *
   * When `vehicleType` is given — which is every dispatch path, because an
   * order names the vehicle it needs — this reads exactly one partition. The
   * radius query then only ever walks candidates that could actually take the
   * job, instead of scanning the whole fleet and discarding the wrong vehicles
   * afterwards in application code.
   *
   * Heartbeat and availability are still checked after the fact: neither lives
   * in the geo index, and a sorted set member outlives the TTL of the keys that
   * say whether that driver is still online.
   */
  async getDriversNearby(query: NearbyDriversQueryDto): Promise<DriverNearbyResponse[]> {
    const limit = query.limit ?? 20;
    const vehicleType = query.vehicleType as VehicleType | undefined;
    const keys = vehicleType ? [geoKey(vehicleType)] : ALL_GEO_KEYS;

    // Over-fetch: filtering happens after the radius query, so asking for
    // exactly `limit` would under-return once offline drivers are removed.
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

    // Each partition comes back sorted, but a merge of two sorted lists is not.
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

  // ------------------------------------------------------- watchdog flag

  /** Marks this driver's current disappearance as already alerted on. */
  async flagDriverDark(driverId: string): Promise<void> {
    await this.redis.set(darkFlagKey(driverId), '1', 'EX', DARK_FLAG_TTL_SECONDS);
  }

  async isDriverFlaggedDark(driverId: string): Promise<boolean> {
    return (await this.redis.exists(darkFlagKey(driverId))) === 1;
  }

  /** A heartbeat arrived — whatever disappearance was flagged is over. */
  async clearDriverDarkFlag(driverId: string): Promise<void> {
    await this.redis.del(darkFlagKey(driverId));
  }

  async getAvailableDriverIds(vehicleType?: VehicleType): Promise<string[]> {
    if (vehicleType) return this.redis.smembers(availableKey(vehicleType));
    return this.redis.sunion(...ALL_AVAILABLE_KEYS);
  }

  /**
   * Full teardown when a driver goes offline or is blocked.
   *
   * Clears every partition rather than the one matching their current vehicle
   * type: a driver who changed vehicle at some point may be in either, and a
   * teardown that misses one leaves a ghost in the radius searches.
   */
  async removeDriver(driverId: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    ALL_GEO_KEYS.forEach((key) => pipeline.zrem(key, driverId));
    pipeline.del(metaKey(driverId));
    pipeline.del(heartbeatKey(driverId));
    ALL_AVAILABLE_KEYS.forEach((key) => pipeline.srem(key, driverId));
    await pipeline.exec();
  }

  /**
   * Snapshot of every tracked driver — used by the location flush job.
   *
   * Returns the partition alongside the id so the caller can read each
   * position from one key instead of probing all of them per driver.
   */
  // ------------------------------------------------------ offer bookkeeping

  /**
   * Record that these drivers were shown an order.
   *
   * Called on every dispatch pass, so the set accumulates the union of everyone
   * who ever saw the card rather than only the latest ring. That union is the
   * audience for REQUEST_LOST — a driver who saw the first pass and has since
   * driven out of range still holds the card, and still has to be told it is
   * gone.
   */
  async addOfferedDrivers(orderId: string, driverIds: string[]): Promise<void> {
    if (!driverIds.length) return;

    await this.redis
      .multi()
      .sadd(offeredKey(orderId), ...driverIds)
      .expire(offeredKey(orderId), OFFERED_TTL_SECONDS)
      .exec();
  }

  /** Everyone who was shown this order, winner included. */
  async getOfferedDrivers(orderId: string): Promise<string[]> {
    return this.redis.smembers(offeredKey(orderId));
  }

  /**
   * Read the audience and drop the set in one round trip.
   *
   * Read-then-delete rather than two calls because the order is closing either
   * way: whoever asks for the audience is about to notify it, and a second
   * caller arriving afterwards would otherwise re-notify everyone.
   */
  async takeOfferedDrivers(orderId: string): Promise<string[]> {
    const [members] = await this.redis
      .multi()
      .smembers(offeredKey(orderId))
      .del(offeredKey(orderId))
      .exec() as [[Error | null, string[]], [Error | null, number]];

    return (members?.[1] as string[]) ?? [];
  }

  async getAllTrackedDrivers(): Promise<TrackedDriver[]> {
    // Every partition, including unsupported ones — a legacy driver's position
    // should still reach Postgres.
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
