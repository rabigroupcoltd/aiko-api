import { ApiProperty } from '@nestjs/swagger';
import { IsNumber } from 'class-validator';

export class UpdatePlatformSettingDto {
  @ApiProperty({ example: 10, description: 'The new numeric value for this setting.' })
  @IsNumber()
  value: number;
}
