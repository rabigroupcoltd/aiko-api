import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class DeletionRequestDto {
  @ApiProperty({ example: 'ada@example.com', description: 'The email or phone number on the account.' })
  @IsString()
  @MinLength(5)
  @MaxLength(120)
  contact: string;

  @ApiPropertyOptional({ example: 'I no longer use the app', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ProcessDeletionDto {
  @ApiPropertyOptional({ description: 'The account to delete, when the request did not match one automatically.' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class RejectDeletionDto {
  @ApiPropertyOptional({ example: 'Could not verify the account owner', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListDeletionRequestsDto {
  @ApiPropertyOptional({ enum: ['PENDING', 'COMPLETED', 'REJECTED'] })
  @IsOptional()
  @IsEnum(['PENDING', 'COMPLETED', 'REJECTED'])
  status?: 'PENDING' | 'COMPLETED' | 'REJECTED';
}
