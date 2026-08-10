import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { DriversModule } from '../drivers/drivers.module';
import { OrdersModule } from '../orders/orders.module';
import { PricingModule } from '../pricing/pricing.module';
import { RideController } from './ride.controller';
import { RideGateway } from './ride.gateway';
import { RideService } from './ride.service';

@Module({
  imports: [AuthModule, PricingModule, DriversModule, OrdersModule, DispatchModule],
  controllers: [RideController],
  providers: [RideService, RideGateway],
  exports: [RideService],
})
export class RideModule {}
