import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { VEHICLE_TYPES } from '../../pricing/dto/pricing.dto';

export const VEHICLE_PHOTO_TYPES = [
  'FRONT',
  'BACK',
  'SIDE',
  'INTERIOR',
  'PLATE_NUMBER',
  'OTHER',
] as const;

const PHOTO_TYPE_LIST = /^(FRONT|BACK|SIDE|INTERIOR|PLATE_NUMBER|OTHER)(,(FRONT|BACK|SIDE|INTERIOR|PLATE_NUMBER|OTHER))*$/;

/**
 * Submitted as multipart/form-data alongside the vehicle photos, so every
 * numeric field arrives as a string and needs an explicit @Type.
 */
export class RegisterDriverDto {
  @ApiProperty({ enum: VEHICLE_TYPES, example: 'TRICYCLE' })
  @IsEnum(VEHICLE_TYPES)
  vehicleType: (typeof VEHICLE_TYPES)[number];

  @ApiProperty({ example: 'LAG-482-KJA', minLength: 3, maxLength: 20, description: 'Stored upper-cased.' })
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  vehiclePlate: string;

  @ApiProperty({ example: 'Bajaj RE', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  vehicleModel: string;

  @ApiPropertyOptional({ example: 'Yellow', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  vehicleColor?: string;

  @ApiPropertyOptional({ example: 2022, minimum: 1950, maximum: 2100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1950)
  @Max(2100)
  vehicleYear?: number;

  @ApiPropertyOptional({
    example: 'FRONT,BACK,PLATE_NUMBER',
    description:
      'Comma-separated labels matched positionally to the uploaded files. Unlabelled files fall back to OTHER.',
  })
  @IsOptional()
  @Matches(PHOTO_TYPE_LIST, {
    message: 'photoTypes must be a comma-separated list of valid photo types',
  })
  photoTypes?: string;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string', format: 'binary' },
    description: 'Up to MAX_VEHICLE_PHOTOS image files, sent under the `photos` field.',
  })
  photos?: any[];
}

export class UpdateDriverDto {
  @ApiPropertyOptional({ enum: VEHICLE_TYPES, example: 'TRICYCLE' })
  @IsOptional()
  @IsEnum(VEHICLE_TYPES)
  vehicleType?: (typeof VEHICLE_TYPES)[number];

  @ApiPropertyOptional({ example: 'LAG-482-KJA', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  vehiclePlate?: string;

  @ApiPropertyOptional({ example: 'Bajaj RE', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vehicleModel?: string;

  @ApiPropertyOptional({ example: 'Yellow', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  vehicleColor?: string;

  @ApiPropertyOptional({ example: 2023, minimum: 1950, maximum: 2100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1950)
  @Max(2100)
  vehicleYear?: number;
}

export class UploadVehiclePhotosDto {
  @ApiPropertyOptional({
    example: 'SIDE,INTERIOR',
    description: 'Comma-separated labels matched positionally to the uploaded files.',
  })
  @IsOptional()
  @Matches(PHOTO_TYPE_LIST, {
    message: 'photoTypes must be a comma-separated list of valid photo types',
  })
  photoTypes?: string;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string', format: 'binary' },
    description: 'Image files sent under the `photos` field.',
  })
  photos?: any[];
}

export class UpdateAvailabilityDto {
  @ApiProperty({ example: true, description: 'true puts the driver online and into the matching pool.' })
  @IsBoolean()
  isAvailable: boolean;
}

export class KycApprovalDto {
  @ApiPropertyOptional({
    example: 'Plate number photo is unreadable.',
    maxLength: 500,
    description: 'Stored on the driver as kycRejectionReason.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PayDebtDto {
  @ApiProperty({ example: 2500, minimum: 1, description: 'Capped at the outstanding debt.' })
  @IsNumber()
  @Min(1)
  amount: number;
}

export class UpdateDebtLimitDto {
  @ApiProperty({
    example: 15000,
    minimum: 0,
    nullable: true,
    description:
      'This driver’s own limit; owing this much or more stops new trips. 0 means no limit. null follows the platform DRIVER_DEBT_LIMIT setting.',
  })
  @ValidateIf((dto) => dto.debtLimit !== null)
  @IsNumber()
  @Min(0)
  debtLimit: number | null;
}

export class BlockDriverDto {
  @ApiProperty({ example: true, description: 'Blocking also forces the driver offline.' })
  @IsBoolean()
  isBlocked: boolean;
}

export class ListDriversQueryDto {
  @ApiPropertyOptional({ enum: VEHICLE_TYPES, example: 'TRICYCLE' })
  @IsOptional()
  @IsEnum(VEHICLE_TYPES)
  vehicleType?: (typeof VEHICLE_TYPES)[number];

  @ApiPropertyOptional({ enum: ['PENDING', 'APPROVED', 'REJECTED'], example: 'APPROVED' })
  @IsOptional()
  @IsEnum(['PENDING', 'APPROVED', 'REJECTED'])
  kycStatus?: 'PENDING' | 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isAvailable?: boolean;
}
