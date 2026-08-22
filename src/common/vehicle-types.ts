import { VehicleType } from '@prisma/client';

/**
 * The vehicles Aiko actually dispatches.
 *
 * Aiko is a dispatch and delivery product: a parcel goes across Minna on an
 * okada or a keke, and nothing else. CAR, TRUCK and BICYCLE stay in the Prisma
 * enum because removing an enum value is a destructive migration that would
 * break any historical row referencing it, and because "no ride or truck yet"
 * is a scope decision rather than a permanent one. They are simply not
 * offered: this list is what every DTO validates against, what pricing seeds
 * and keeps active, and what the driver presence index is partitioned by.
 *
 * Adding a vehicle later means adding it here and giving it a pricing rule.
 * Nothing else in the codebase enumerates vehicle types by hand.
 */
export const SUPPORTED_VEHICLE_TYPES = [VehicleType.BIKE, VehicleType.TRICYCLE] as const;

export type SupportedVehicleType = (typeof SUPPORTED_VEHICLE_TYPES)[number];

/** The same list as plain strings, for `@IsEnum` and Swagger `enum:`. */
export const SUPPORTED_VEHICLE_TYPE_NAMES = SUPPORTED_VEHICLE_TYPES.map(String) as [
  'BIKE',
  'TRICYCLE',
];

const SUPPORTED = new Set<string>(SUPPORTED_VEHICLE_TYPES);

export function isSupportedVehicleType(value: string | null | undefined): value is SupportedVehicleType {
  return value != null && SUPPORTED.has(value);
}
