import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { VEHICLE_TYPES } from '../../pricing/dto/pricing.dto';

export const ORDER_STATUSES = [
  // Ride lane — the broadcast-and-bid flow.
  'PENDING',
  'ACCEPTED',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  // Marketplace lane — drivers claim the order themselves.
  'SEARCHING_FOR_DRIVER',
  'RESERVED',
  'DRIVER_ARRIVING_PICKUP',
  'PICKED_UP',
  'IN_TRANSIT',
  'DELIVERED',
  'NO_DRIVER_FOUND',
  'CANCELLED',
] as const;

/**
 * `fare` is deliberately absent — it is computed server-side from the active
 * PricingRule for `vehicleType` so the client cannot set its own price.
 */
export class CreateOrderDto {
  @ApiProperty({ enum: VEHICLE_TYPES, example: 'TRICYCLE' })
  @IsEnum(VEHICLE_TYPES)
  vehicleType: (typeof VEHICLE_TYPES)[number];

  @ApiPropertyOptional({
    example: 'Two cartons of frozen chicken. Handle upright.',
    maxLength: 500,
    description:
      'What is being sent, in the passenger’s own words. Shown on the driver’s card: a laptop and a gas cylinder are the same distance and the same fare, and not the same decision.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

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

  @ApiPropertyOptional({
    example: '08031234567',
    maxLength: 20,
    description: 'Who to call at the pickup. Often not the account holder.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  pickupPhone?: string;

  @ApiPropertyOptional({
    example: '08037654321',
    maxLength: 20,
    description: 'Who to call at the drop-off — the recipient, not the sender.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  dropoffPhone?: string;

  @ApiProperty({ enum: ['CASH', 'BANK_TRANSFER'], example: 'CASH' })
  @IsEnum(['CASH', 'BANK_TRANSFER'])
  paymentMethod: 'CASH' | 'BANK_TRANSFER';

  @ApiPropertyOptional({
    example: true,
    default: false,
    description:
      'True opens the order at SEARCHING_FOR_DRIVER and announces it to nearby drivers, who claim it themselves. False (the default) creates a PENDING order for the original direct-booking flow.',
  })
  @IsOptional()
  @IsBoolean()
  dispatch?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    example: 'b5d9f0a3-7c21-4e88-9a16-2f3b6c8d1e04',
    description: 'Set when the order comes out of an accepted bid, so the quote is reused.',
  })
  @IsOptional()
  @IsUUID()
  rideRequestId?: string;
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: ORDER_STATUSES, example: 'IN_PROGRESS' })
  @IsEnum(ORDER_STATUSES)
  status: (typeof ORDER_STATUSES)[number];

  @ApiPropertyOptional({
    example: 'Passenger did not show up.',
    maxLength: 500,
    description: 'Recorded as cancellationReason when the status is CANCELLED.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CancelOrderDto {
  @ApiPropertyOptional({ example: 'Passenger no longer needs the trip.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListOrdersQueryDto {
  @ApiPropertyOptional({ enum: ORDER_STATUSES, example: 'COMPLETED' })
  @IsOptional()
  @IsEnum(ORDER_STATUSES)
  status?: (typeof ORDER_STATUSES)[number];

  @ApiPropertyOptional({
    format: 'uuid',
    example: '3f2a7c1e-9b64-4d2a-8f31-1c0d5e6a7b81',
    description: 'Admin only — non-admins are always scoped to their own trips.',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ format: 'uuid', example: 'd41c8b02-5e77-4a19-9c3b-6a2f8e0d4b55' })
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiPropertyOptional({ enum: VEHICLE_TYPES, example: 'TRICYCLE' })
  @IsOptional()
  @IsEnum(VEHICLE_TYPES)
  vehicleType?: (typeof VEHICLE_TYPES)[number];

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ example: 0, minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

export class SendMessageDto {
  @ApiProperty({ example: 'I am waiting by the main entrance.', minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content: string;
}

export class RateOrderDto {
  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  score: number;

  @ApiPropertyOptional({ example: 'Smooth ride, very polite driver.', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
