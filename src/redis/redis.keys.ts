import { VehicleType } from '@prisma/client';
import { SUPPORTED_VEHICLE_TYPES } from '../common/vehicle-types';

/**
 * Geospatial index of drivers who have reported a position, one sorted set per
 * vehicle type.
 *
 * Partitioned rather than pooled because every search Aiko performs already
 * knows the vehicle it wants: an order for a keke can only be served by a keke.
 * With one shared index, GEOSEARCH walks every okada in the city and the
 * vehicle filter runs afterwards in application code — work proportional to the
 * whole fleet to answer a question about half of it. Per-type keys push the
 * filter into the radius query itself, so a search reads only candidates that
 * could actually win.
 *
 * The cost is that a driver must be removed from their old set when they change
 * vehicle type, which `saveDriverLocation` and `removeDriver` both handle.
 */
export const geoKey = (vehicleType: VehicleType) => `drivers:locations:${vehicleType}`;

/**
 * Every geo index that could hold a member.
 *
 * The full enum, not the supported list. These keys drive teardown and the
 * unfiltered fallback search, and a driver row left over from the ride-hailing
 * days may still say CAR — leaving their partition out would strand them in the
 * index with nothing able to evict them, because a sorted set member has no
 * TTL of its own.
 *
 * The hot path never touches this: a dispatch search always names a vehicle
 * type and reads exactly one key.
 */
export const ALL_GEO_KEYS = Object.values(VehicleType).map(geoKey);

/** The unpartitioned index this replaced. Safe to `DEL` once deployed. */
export const LEGACY_GEO_KEY = 'drivers:locations';

/**
 * Driver is considered offline once this key expires.
 *
 * Ninety seconds, not fifteen. A driver with the app backgrounded reports
 * through the Android foreground service, and the OS is entitled to defer those
 * fixes — a doze window, a poor GPS lock in traffic, a moment of no signal. At
 * a 15s TTL any of those drops the driver out of the dispatch pool and they
 * silently stop being offered work while the app still says "online".
 *
 * The cost of the longer window is a driver who force-quit staying eligible for
 * up to 90s. That is the cheaper mistake: the order simply goes unclaimed and
 * the widening pass re-announces it, whereas a driver who cannot be found earns
 * nothing and has no way to tell why.
 */
export const HEARTBEAT_TTL_SECONDS = Number(process.env.DRIVER_HEARTBEAT_TTL || 90);

export const heartbeatKey = (driverId: string) => `driver:heartbeat:${driverId}`;
export const metaKey = (driverId: string) => `driver:${driverId}:meta`;

/** Availability is tracked per vehicle type so a keke order never matches an okada. */
export const availableKey = (vehicleType: VehicleType) => `drivers:available:${vehicleType}`;

/** Full enum, for the same reason as ALL_GEO_KEYS — teardown must miss nothing. */
export const ALL_AVAILABLE_KEYS = Object.values(VehicleType).map(availableKey);

/**
 * The partitions the hot path sweeps.
 *
 * `saveDriverLocation` evicts a driver from every index that is not theirs, and
 * that eviction runs on every position fix — the single most frequent write in
 * the system. Sweeping the full enum costs a ZREM per unoffered vehicle on
 * every fix, to protect against a driver drifting into an index that dispatch
 * never reads: a search always names a supported type, so a stale CAR member is
 * inert rather than wrong.
 *
 * Teardown still uses ALL_GEO_KEYS, which is where a legacy member actually
 * gets removed. This list only decides what the per-fix sweep bothers with.
 */
export const HOT_GEO_KEYS = SUPPORTED_VEHICLE_TYPES.map(geoKey);

/**
 * Which drivers were shown a given order.
 *
 * Dispatch fans an order out to the drivers inside the current ring, and when
 * one of them wins, the others have to be told — both to drop the card and to
 * raise a push. Neither the order row nor the geo index can answer "who saw
 * this": the ring widens over time, so the audience is the union of several
 * passes, and by the time someone reserves it the drivers who saw the first
 * pass may have moved out of range.
 *
 * A set, so re-announcing to a driver already in it is idempotent. Expires on
 * its own — an order that is never claimed leaves nothing behind.
 */
export const offeredKey = (orderId: string) => `order:${orderId}:offered`;

/**
 * How long the offered-drivers set outlives its last write.
 *
 * Comfortably longer than a full dispatch cycle (MAX_DISPATCH_ATTEMPTS passes
 * at DISPATCH_EXPAND_DELAY_MS apart), because the set must still be readable at
 * the moment the last pass gives up and closes the order.
 */
export const OFFERED_TTL_SECONDS = Number(process.env.OFFERED_TTL_SECONDS || 900);
