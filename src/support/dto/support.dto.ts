import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportPriority, SupportStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const SUPPORT_STATUSES = Object.values(SupportStatus);
export const SUPPORT_PRIORITIES = Object.values(SupportPriority);

export class CreateTicketDto {
  @ApiProperty({ example: 'Driver never arrived at the pickup', maxLength: 200 })
  @IsString()
  @MinLength(4)
  @MaxLength(200)
  subject: string;

  @ApiProperty({ example: 'I waited forty minutes and nobody came.', maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The delivery this is about. Must be one the caller was party to.',
  })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({ example: 'DELIVERY', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @ApiPropertyOptional({ enum: SUPPORT_PRIORITIES, default: 'NORMAL' })
  @IsOptional()
  @IsEnum(SupportPriority)
  priority?: SupportPriority;
}

export class ReplyTicketDto {
  @ApiProperty({ example: 'We have refunded the fare in full.', maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;

  @ApiPropertyOptional({
    example: false,
    description: 'Staff-only note. Never shown to the requester; refused for non-staff.',
  })
  @IsOptional()
  @IsBoolean()
  internal?: boolean;
}

export class UpdateTicketDto {
  @ApiPropertyOptional({ enum: SUPPORT_STATUSES })
  @IsOptional()
  @IsEnum(SupportStatus)
  status?: SupportStatus;

  @ApiPropertyOptional({ enum: SUPPORT_PRIORITIES })
  @IsOptional()
  @IsEnum(SupportPriority)
  priority?: SupportPriority;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'The admin who owns it. Send null to put it back in the unassigned pile.',
  })
  @IsOptional()
  @IsUUID()
  assigneeId?: string | null;
}

export class SupportQueryDto {
  @ApiPropertyOptional({ enum: SUPPORT_STATUSES })
  @IsOptional()
  @IsEnum(SupportStatus)
  status?: SupportStatus;

  @ApiPropertyOptional({ enum: SUPPORT_PRIORITIES })
  @IsOptional()
  @IsEnum(SupportPriority)
  priority?: SupportPriority;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional({ example: true, description: 'Only tickets nobody has picked up.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unassigned?: boolean;

  @ApiPropertyOptional({ example: 'AIK-1042', description: 'Matches reference or subject.' })
  @IsOptional()
  @IsString()
  q?: string;

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
