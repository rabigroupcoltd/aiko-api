import { VehicleType } from '@prisma/client';

export const SUPPORTED_VEHICLE_TYPES = [VehicleType.BIKE, VehicleType.TRICYCLE] as const;

export type SupportedVehicleType = (typeof SUPPORTED_VEHICLE_TYPES)[number];

export const SUPPORTED_VEHICLE_TYPE_NAMES = SUPPORTED_VEHICLE_TYPES.map(String) as [
  'BIKE',
  'TRICYCLE',
];

const SUPPORTED = new Set<string>(SUPPORTED_VEHICLE_TYPES);

export function isSupportedVehicleType(value: string | null | undefined): value is SupportedVehicleType {
  return value != null && SUPPORTED.has(value);
}
