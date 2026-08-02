import { Prisma, VehicleType } from '@prisma/client';

/**
 * Applied only for vehicle types that have no row yet, so a fresh database
 * can quote fares before an admin touches the pricing screen. Existing rows
 * are never overwritten.
 */
export const DEFAULT_PRICING: Record<VehicleType, Omit<Prisma.PricingRuleCreateInput, 'vehicleType'>> = {
  [VehicleType.BICYCLE]: {
    baseFare: 200,
    perKm: 80,
    perMinute: 5,
    minimumFare: 300,
    bookingFee: 0,
    avgSpeedKph: 15,
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
  [VehicleType.BIKE]: {
    baseFare: 300,
    perKm: 100,
    perMinute: 8,
    minimumFare: 400,
    bookingFee: 0,
    avgSpeedKph: 30,
    platformFeePercent: 10,
  },
  [VehicleType.CAR]: {
    baseFare: 700,
    perKm: 180,
    perMinute: 15,
    minimumFare: 1000,
    bookingFee: 0,
    avgSpeedKph: 35,
    platformFeePercent: 10,
  },
  [VehicleType.TRUCK]: {
    baseFare: 2000,
    perKm: 350,
    perMinute: 25,
    minimumFare: 3000,
    bookingFee: 0,
    avgSpeedKph: 30,
    platformFeePercent: 10,
  },
};

/** Fares are rounded up to a multiple of this so quotes look like real money. */
export const FARE_ROUNDING_STEP = Number(process.env.FARE_ROUNDING_STEP || 10);
