import { VehicleType } from '@prisma/client';

/** Geospatial index of every driver that has reported a position. */
export const GEO_KEY = 'drivers:locations';

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

/** Availability is tracked per vehicle type so a tricycle booking never matches a bicycle. */
export const availableKey = (vehicleType: VehicleType) => `drivers:available:${vehicleType}`;

export const ALL_AVAILABLE_KEYS = Object.values(VehicleType).map(availableKey);
