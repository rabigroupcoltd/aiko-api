import { Prisma, VehicleType } from '@prisma/client';
import { SupportedVehicleType } from '../common/vehicle-types';

/**
 * Applied only for vehicle types that have no row yet, so a fresh database
 * can quote fares before an admin touches the pricing screen. Existing rows
 * are never overwritten.
 *
 * Keyed on the *supported* types only. Aiko dispatches parcels by okada and
 * keke; a car or a truck has no rate card because it cannot be booked. Adding
 * one back means adding it to SUPPORTED_VEHICLE_TYPES and giving it an entry
 * here — the compiler will insist on the second once you do the first.
 */
export const DEFAULT_PRICING: Record<
  SupportedVehicleType,
  Omit<Prisma.PricingRuleCreateInput, 'vehicleType'>
> = {
  [VehicleType.BIKE]: {
    baseFare: 300,
    perKm: 100,
    perMinute: 8,
    minimumFare: 400,
    bookingFee: 0,
    avgSpeedKph: 30,
    platformFeePercent: 10,
  },
  [VehicleType.TRICYCLE]: {
    baseFare: 400,
    perKm: 120,
    perMinute: 10,
    minimumFare: 500,
    bookingFee: 0,
    avgSpeedKph: 25,
    platformFeePercent: 10,
  },
};

/** Fares are rounded up to a multiple of this so quotes look like real money. */
export const FARE_ROUNDING_STEP = Number(process.env.FARE_ROUNDING_STEP || 10);
