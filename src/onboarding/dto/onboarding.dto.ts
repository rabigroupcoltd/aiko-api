import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export const ONBOARDING_STEPS = [
  'PHONE',
  'PROFILE',
  'PHOTO',
  'LIVENESS',
  'USER_TYPE',
  'RIDER_DOCS',
  'AWAITING_APPROVAL',
  'DONE',
] as const;

export const ACCOUNT_TYPES = ['PASSENGER', 'RIDER'] as const;

export class UpdateOnboardingDto {
  @ApiPropertyOptional({
    enum: ONBOARDING_STEPS,
    example: 'PHOTO',
    description:
      'The step the client believes it has reached. Recorded as-is, but `resumeStep` in the response is derived from the data and always wins.',
  })
  @IsOptional()
  @IsEnum(ONBOARDING_STEPS)
  step?: (typeof ONBOARDING_STEPS)[number];

  @ApiPropertyOptional({ example: 'Ada', minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Obi', minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({
    example: 'ada@example.com',
    description: 'Required for phone-only accounts, which arrive without one.',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '1998-04-12', description: 'ISO date. The app enforces 18+.' })
  @IsOptional()
  @IsISO8601()
  dob?: string;

  @ApiPropertyOptional({
    example: '+2348012345678',
    description: 'Needed for Google accounts, which carry no phone number.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone must be a valid phone number' })
  phone?: string;

  @ApiPropertyOptional({
    example: 'http://localhost:3000/uploads/selfies/3f2a7c1e.jpg',
    description: 'URL of the already-uploaded selfie.',
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  profilePhotoUrl?: string;

  @ApiPropertyOptional({
    example: 'selfies/3f2a7c1e.jpg',
    description: 'Storage key, kept so the object can be deleted later.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  profilePhotoKey?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Set once the on-device liveness check passes. false clears it.',
  })
  @IsOptional()
  @IsBoolean()
  livenessPassed?: boolean;

  @ApiPropertyOptional({
    enum: ACCOUNT_TYPES,
    example: 'PASSENGER',
    description:
      'PASSENGER finishes onboarding here. RIDER continues on to register a vehicle (`POST /api/drivers/register`) and then wait for admin approval. RIDER is additive — the USER role is kept, because every driver is a passenger by default and can book trips while waiting.',
  })
  @IsOptional()
  @IsEnum(ACCOUNT_TYPES)
  accountType?: (typeof ACCOUNT_TYPES)[number];
}
