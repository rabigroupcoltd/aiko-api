import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuditEntity } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export const AUDIT_ENTITIES = Object.values(AuditEntity);

export class AuditQueryDto {
  @ApiPropertyOptional({ enum: AUDIT_ENTITIES, example: 'DRIVER' })
  @IsOptional()
  @IsEnum(AuditEntity)
  entity?: AuditEntity;

  @ApiPropertyOptional({ format: 'uuid', description: 'Narrow to one record.' })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Narrow to one admin.' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({
    example: 'kyc',
    description: 'Substring match on the action verb, case-insensitive.',
  })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31T23:59:59.000Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 25, default: 25, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
