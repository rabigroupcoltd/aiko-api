import { VehicleType } from '@prisma/client';

/** Geospatial index of every driver that has reported a position. */
export const GEO_KEY = 'drivers:locations';

/** Driver is considered offline once this key expires. */
export const HEARTBEAT_TTL_SECONDS = Number(process.env.DRIVER_HEARTBEAT_TTL || 15);

export const heartbeatKey = (driverId: string) => `driver:heartbeat:${driverId}`;
export const metaKey = (driverId: string) => `driver:${driverId}:meta`;

/** Availability is tracked per vehicle type so a tricycle booking never matches a bicycle. */
export const availableKey = (vehicleType: VehicleType) => `drivers:available:${vehicleType}`;

export const ALL_AVAILABLE_KEYS = Object.values(VehicleType).map(availableKey);
