import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class MarketplaceQueryDto {
  @ApiPropertyOptional({ example: 9.6139, description: "The driver's current latitude." })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: 6.5569 })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({
    example: 5,
    minimum: 0.5,
    maximum: 50,
    description: 'Defaults to INITIAL_DRIVER_RADIUS_KM.',
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
