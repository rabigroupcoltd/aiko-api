import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DistanceService } from './distance.service';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

@Module({
  imports: [AuthModule],
  controllers: [PricingController],
  providers: [PricingService, DistanceService],
  exports: [PricingService],
})
export class PricingModule {}
