import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { DriversModule } from '../drivers/drivers.module';
import { PricingModule } from '../pricing/pricing.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [AuthModule, PricingModule, DriversModule, DispatchModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
