import { Prisma, VehicleType } from '@prisma/client';
import { SupportedVehicleType } from '../common/vehicle-types';

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
