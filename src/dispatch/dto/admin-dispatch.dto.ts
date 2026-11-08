import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class AssignOrderDto {
  @ApiProperty({ format: 'uuid', description: 'The rider (driver profile id) to give the order to.' })
  @IsUUID()
  driverId: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Assign even though the rider has warnings (off shift, location out of date, over the debt limit, at capacity). Without it, such an assignment is refused with the warnings listed.',
  })
  @IsOptional()
  @IsBoolean()
  confirmWarnings?: boolean;
}
