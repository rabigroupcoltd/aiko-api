import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { SUPPORTED_VEHICLE_TYPE_NAMES } from '../../common/vehicle-types';

export const VEHICLE_TYPES = SUPPORTED_VEHICLE_TYPE_NAMES;

export class UpsertPricingRuleDto {
  @ApiProperty({ example: 300, minimum: 0, description: 'Flat charge applied to every trip.' })
  @IsNumber()
  @Min(0)
  baseFare: number;

  @ApiProperty({ example: 120, minimum: 0, description: 'Charge per kilometre of road distance.' })
  @IsNumber()
  @Min(0)
  perKm: number;

  @ApiProperty({ example: 15, minimum: 0, description: 'Charge per minute of estimated duration.' })
  @IsNumber()
  @Min(0)
  perMinute: number;

  @ApiProperty({ example: 600, minimum: 0, description: 'Floor applied before surge and booking fee.' })
  @IsNumber()
  @Min(0)
  minimumFare: number;

  @ApiPropertyOptional({ example: 50, minimum: 0, description: 'Added after surge. Defaults to 0.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  bookingFee?: number;

  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 10, description: 'Multiplies the subtotal. 1 means no surge.' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  surgeMultiplier?: number;

  @ApiPropertyOptional({
    example: 25,
    minimum: 1,
    maximum: 200,
    description: 'Turns distance into an ETA — a bicycle and a car quote very differently.',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(200)
  avgSpeedKph?: number;

  @ApiPropertyOptional({ example: 10, minimum: 0, maximum: 100, description: 'Platform cut of the fare, as a percentage.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  platformFeePercent?: number;

  @ApiPropertyOptional({ example: 'NGN', default: 'NGN' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ example: true, description: 'Inactive rules are hidden from estimate/all.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePricingRuleDto {
  @ApiPropertyOptional({ example: 350, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  baseFare?: number;

  @ApiPropertyOptional({ example: 130, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  perKm?: number;

  @ApiPropertyOptional({ example: 15, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  perMinute?: number;

  @ApiPropertyOptional({ example: 600, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minimumFare?: number;

  @ApiPropertyOptional({ example: 50, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  bookingFee?: number;

  @ApiPropertyOptional({ example: 1.5, minimum: 1, maximum: 10 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  surgeMultiplier?: number;

  @ApiPropertyOptional({ example: 25, minimum: 1, maximum: 200 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(200)
  avgSpeedKph?: number;

  @ApiPropertyOptional({ example: 10, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  platformFeePercent?: number;

  @ApiPropertyOptional({ example: 'NGN' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class FareEstimateDto {
  @ApiProperty({ enum: VEHICLE_TYPES, example: 'TRICYCLE' })
  @IsEnum(VEHICLE_TYPES)
  vehicleType: (typeof VEHICLE_TYPES)[number];

  @ApiProperty({ example: 6.6018, description: 'Pickup latitude.' })
  @Type(() => Number)
  @IsLatitude()
  pickupLat: number;

  @ApiProperty({ example: 3.3515, description: 'Pickup longitude.' })
  @Type(() => Number)
  @IsLongitude()
  pickupLng: number;

  @ApiProperty({ example: 6.5952, description: 'Drop-off latitude.' })
  @Type(() => Number)
  @IsLatitude()
  dropoffLat: number;

  @ApiProperty({ example: 3.3372, description: 'Drop-off longitude.' })
  @Type(() => Number)
  @IsLongitude()
  dropoffLng: number;
}

export class VehicleTypeParamDto {
  @ApiProperty({ enum: VEHICLE_TYPES, example: 'TRICYCLE' })
  @IsEnum(VEHICLE_TYPES)
  vehicleType: (typeof VEHICLE_TYPES)[number];
}
