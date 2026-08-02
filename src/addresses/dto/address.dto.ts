import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class SearchAddressDto {
  @ApiProperty({ example: 'Ikeja City Mall', minLength: 2, maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q: string;

  @ApiPropertyOptional({
    example: 6.6018,
    description: "Biases remote results towards the passenger's current position.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: 3.3515 })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({ example: 10, minimum: 1, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number = 10;
}

export class CreateAddressDto {
  @ApiPropertyOptional({ example: 'Home', maxLength: 100, description: 'Label shown in the app.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({ example: '12 Allen Avenue, Ikeja, Lagos', minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  address: string;

  @ApiPropertyOptional({ example: 6.6018 })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: 3.3515 })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({
    example: 'ChIJyWEHuEmuEmsRm9hTkapTCrk',
    description: 'Google place id, when the row came from search.',
  })
  @IsOptional()
  @IsString()
  placeId?: string;

  @ApiPropertyOptional({ example: true, description: 'Only one address per user stays default.' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @ApiPropertyOptional({ example: 'Work', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export interface AddressSearchResult {
  /** Present only when the row is one of the caller's saved addresses. */
  id: string | null;
  name: string | null;
  address: string;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  /**
   * landmark | market | campus | hospital | transport | government |
   * residential. Only seeded places carry one — a saved address or a row
   * written back from the Places API has none, so clients need a fallback icon.
   */
  category: string | null;
  source: 'SAVED' | 'CACHED' | 'REMOTE';
  isDefault: boolean;
}
