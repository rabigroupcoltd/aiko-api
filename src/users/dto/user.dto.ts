import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Ada Obi', minLength: 2, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: '+2348012345678', description: '7-15 digits, optional leading +.' })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be a valid phone number' })
  phone?: string;
}

export class BlockUserDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  isBlocked: boolean;

  @ApiPropertyOptional({
    example: 'Reported for harassment by three drivers',
    description: 'Shown to admins reviewing this account later. Not shown to the blocked user.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** The two roles an admin can hand out from the dashboard. Never USER or RIDER — those come from the app's own sign-up flow. */
export const STAFF_ROLES = ['ADMIN', 'SUPPORT'] as const;

export class CreateStaffDto {
  @ApiProperty({ example: 'support@aiko.ng' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'ChangeMe123!', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ example: 'Amina Yusuf', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({ enum: STAFF_ROLES, example: 'SUPPORT' })
  @IsEnum(STAFF_ROLES)
  role: (typeof STAFF_ROLES)[number];
}
