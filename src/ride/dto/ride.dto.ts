import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { VEHICLE_TYPES } from '../../pricing/dto/pricing.dto';

export class CreateRideRequestDto {
  @ApiProperty({ enum: VEHICLE_TYPES, example: 'TRICYCLE' })
  @IsEnum(VEHICLE_TYPES)
  vehicleType: (typeof VEHICLE_TYPES)[number];

  @ApiProperty({ example: 'Ikeja City Mall, Alausa, Lagos', maxLength: 500 })
  @IsString()
  @MaxLength(500)
  pickupLocation: string;

  @ApiProperty({ example: 'Computer Village, Ikeja, Lagos', maxLength: 500 })
  @IsString()
  @MaxLength(500)
  dropoffLocation: string;

  @ApiProperty({ example: 6.6018 })
  @Type(() => Number)
  @IsLatitude()
  pickupLat: number;

  @ApiProperty({ example: 3.3515 })
  @Type(() => Number)
  @IsLongitude()
  pickupLng: number;

  @ApiProperty({ example: 6.5952 })
  @Type(() => Number)
  @IsLatitude()
  dropoffLat: number;

  @ApiProperty({ example: 3.3372 })
  @Type(() => Number)
  @IsLongitude()
  dropoffLng: number;

  @ApiPropertyOptional({ enum: ['CASH', 'BANK_TRANSFER'], example: 'CASH', default: 'CASH' })
  @IsOptional()
  @IsEnum(['CASH', 'BANK_TRANSFER'])
  paymentMethod?: 'CASH' | 'BANK_TRANSFER';

  @ApiPropertyOptional({
    example: 5,
    minimum: 0.5,
    description: 'How far to look for drivers. Defaults to SEARCH_RADIUS_KM.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  radiusKm?: number;
}

export class NearbyRequestsQueryDto {
  @ApiProperty({ example: 9.6139, description: 'The driver’s current latitude.' })
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 6.5569 })
  @Type(() => Number)
  @IsLongitude()
  lng: number;

  @ApiPropertyOptional({
    example: 5,
    minimum: 0.5,
    maximum: 50,
    default: 5,
    description: 'How far to look. Defaults to SEARCH_RADIUS_KM.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(50)
  radiusKm?: number;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class PlaceBidDto {
  @ApiProperty({ format: 'uuid', example: 'b5d9f0a3-7c21-4e88-9a16-2f3b6c8d1e04' })
  @IsUUID()
  requestId: string;

  @ApiPropertyOptional({
    example: 1300,
    minimum: 0,
    description:
      'Only used as the trip fare when ALLOW_BID_FARE_OVERRIDE=true; otherwise informational and the server quote stands.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({ example: 'I am 2 minutes away.', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class AcceptDriverDto {
  @ApiProperty({ format: 'uuid', example: 'b5d9f0a3-7c21-4e88-9a16-2f3b6c8d1e04' })
  @IsUUID()
  requestId: string;

  @ApiProperty({ format: 'uuid', example: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55' })
  @IsUUID()
  driverId: string;
}

export class CancelRideRequestDto {
  @ApiProperty({ format: 'uuid', example: 'b5d9f0a3-7c21-4e88-9a16-2f3b6c8d1e04' })
  @IsUUID()
  requestId: string;

  @ApiPropertyOptional({ example: 'Changed my mind.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class SubscribeDriverLocationDto {
  @ApiProperty({ format: 'uuid', example: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55' })
  @IsUUID()
  driverId: string;
}

export class UpdateRideStageDto {
  @ApiProperty({ format: 'uuid', example: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33' })
  @IsUUID()
  rideId: string;

  @ApiProperty({ enum: ['ARRIVED', 'IN_PROGRESS', 'COMPLETED'], example: 'ARRIVED' })
  @IsEnum(['ARRIVED', 'IN_PROGRESS', 'COMPLETED'])
  stage: 'ARRIVED' | 'IN_PROGRESS' | 'COMPLETED';
}

export class CancelTripDto {
  @ApiProperty({ format: 'uuid', example: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33' })
  @IsUUID()
  rideId: string;

  @ApiPropertyOptional({ example: 'Passenger did not show up.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RideMessageDto {
  @ApiProperty({ format: 'uuid', example: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33' })
  @IsUUID()
  rideId: string;

  @ApiProperty({ example: 'I am waiting by the main entrance.', maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  content: string;
}

export class SubmitRatingDto {
  @ApiProperty({ format: 'uuid', example: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33' })
  @IsUUID()
  rideId: string;

  @ApiProperty({ example: 5, minimum: 1 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  score: number;

  @ApiPropertyOptional({ example: 'Smooth ride, very polite driver.', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

export class OrderIdDto {
  @ApiProperty({ format: 'uuid', example: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33' })
  @IsUUID()
  orderId: string;
}
