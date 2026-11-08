import { VehicleType } from '@prisma/client';
import { SUPPORTED_VEHICLE_TYPES } from '../common/vehicle-types';

export const geoKey = (vehicleType: VehicleType) => `drivers:locations:${vehicleType}`;

export const ALL_GEO_KEYS = Object.values(VehicleType).map(geoKey);

export const LEGACY_GEO_KEY = 'drivers:locations';

// How long a rider stays "connected" after their last location or heartbeat. The
// app sends a fix every 20 s even when minimised, so this allows ~6 misses on a
// patchy mobile network before they drop out of dispatch.
export const HEARTBEAT_TTL_SECONDS = Number(process.env.DRIVER_HEARTBEAT_TTL || 120);

export const heartbeatKey = (driverId: string) => `driver:heartbeat:${driverId}`;
export const metaKey = (driverId: string) => `driver:${driverId}:meta`;

export const darkFlagKey = (driverId: string) => `driver:${driverId}:dark`;

export const DARK_FLAG_TTL_SECONDS = Number(process.env.DRIVER_DARK_FLAG_TTL || 24 * 60 * 60);

export const availableKey = (vehicleType: VehicleType) => `drivers:available:${vehicleType}`;

export const ALL_AVAILABLE_KEYS = Object.values(VehicleType).map(availableKey);

export const HOT_GEO_KEYS = SUPPORTED_VEHICLE_TYPES.map(geoKey);

export const offeredKey = (orderId: string) => `order:${orderId}:offered`;

export const OFFERED_TTL_SECONDS = Number(process.env.OFFERED_TTL_SECONDS || 900);
