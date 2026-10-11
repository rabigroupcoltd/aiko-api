import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { VehicleType } from '@prisma/client';
import { VEHICLE_TYPES } from '../../pricing/dto/pricing.dto';

export class DriverLocationDto {
  @ApiProperty({ example: 6.5244 })
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 3.3792 })
  @Type(() => Number)
  @IsLongitude()
  lng: number;

  @ApiPropertyOptional({ example: 118.4, minimum: 0, maximum: 360, description: 'Compass bearing in degrees.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(360)
  heading?: number;

  @ApiPropertyOptional({ example: 24.6, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  speedKph?: number;

  @ApiPropertyOptional({ example: 8, minimum: 0, description: 'GPS accuracy radius in metres.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  accuracyMeters?: number;

  @ApiPropertyOptional({
    example: '2026-08-01T07:59:12.310Z',
    description: 'When the fix was taken. Defaults to server time.',
  })
  @IsOptional()
  @IsISO8601()
  recordedAt?: string;
}

export class NearbyDriversQueryDto {
  @ApiProperty({ example: 6.6018, description: 'Centre of the search.' })
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 3.3515 })
  @Type(() => Number)
  @IsLongitude()
  lng: number;

  @ApiPropertyOptional({ example: 5, minimum: 0.1, maximum: 100, default: 5 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(100)
  radiusKm: number = 5;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    enum: VEHICLE_TYPES,
    example: 'TRICYCLE',
    description: 'Restricts matching to drivers of this vehicle type.',
  })
  @IsOptional()
  @IsEnum(VEHICLE_TYPES)
  vehicleType?: VehicleType;
}

export interface DriverNearbyResponse {
  driverId: string;
  lat: number | null;
  lng: number | null;
  distanceKm: number | null;
  heading?: number;
  speedKph?: number;
  accuracyMeters?: number;
  recordedAt: string | null;
}
