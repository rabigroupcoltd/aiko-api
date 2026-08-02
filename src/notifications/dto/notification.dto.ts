import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const DEVICE_PLATFORMS = ['ANDROID', 'IOS', 'WEB'] as const;

export class RegisterDeviceDto {
  @ApiProperty({
    example: 'fzT9k2rQS0iN…:APA91bH8x_long_fcm_registration_token',
    description: 'The FCM registration token from the client SDK.',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(4096)
  token: string;

  @ApiPropertyOptional({ enum: DEVICE_PLATFORMS, default: 'ANDROID' })
  @IsOptional()
  @IsEnum(DEVICE_PLATFORMS)
  platform?: (typeof DEVICE_PLATFORMS)[number];

  @ApiPropertyOptional({
    example: 'a3f1c8e0d94b27e5',
    description:
      'Stable per install. Lets a rotated token replace the previous one for the same handset instead of leaving a dead registration behind.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;

  @ApiPropertyOptional({ example: 'Tecno Spark 10' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceName?: string;

  @ApiPropertyOptional({ example: '1.0.0' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}

export class UnregisterDeviceDto {
  @ApiProperty({ description: 'The token to forget. Only the caller’s own devices can be removed.' })
  @IsString()
  @MinLength(10)
  @MaxLength(4096)
  token: string;
}

export class TestPushDto {
  @ApiPropertyOptional({ example: 'Aiko', default: 'Aiko' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  title?: string;

  @ApiPropertyOptional({ example: 'Push notifications are working.', default: 'Push notifications are working.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  body?: string;
}
