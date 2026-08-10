import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Query for the driver's available-orders grid.
 *
 * Position is optional: the server already tracks the driver through the
 * location heartbeat, and a client that has a fresher fix may pass it. Radius
 * and limit are bounded here so a client cannot ask the server to scan the
 * whole country.
 */
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
