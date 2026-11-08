import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DriversModule } from '../drivers/drivers.module';
import { PricingModule } from '../pricing/pricing.module';
import { AdminDispatchController } from './admin-dispatch.controller';
import { AdminDispatchService } from './admin-dispatch.service';
import { DispatchService } from './dispatch.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { OrderCompatibilityService } from './order-compatibility.service';
import { RouteOptimizerService } from './route-optimizer.service';

@Module({
  imports: [AuthModule, DriversModule, PricingModule],
  controllers: [MarketplaceController, AdminDispatchController],
  providers: [
    AdminDispatchService,
    DispatchService,
    MarketplaceService,
    OrderCompatibilityService,
    RouteOptimizerService,
  ],
  exports: [DispatchService, MarketplaceService, RouteOptimizerService, OrderCompatibilityService],
})
export class DispatchModule {}
