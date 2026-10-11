import { Module } from '@nestjs/common';
import { DispatchModule } from '../dispatch/dispatch.module';
import { RideModule } from '../ride/ride.module';
import { DriverLocationWorker } from './workers/driver-location.worker';
import { DriverWatchdogWorker } from './workers/driver-watchdog.worker';
import { OrderDispatchWorker } from './workers/order-dispatch.worker';
import { RideMatchingWorker } from './workers/ride-matching.worker';
import { RideTimeoutWorker } from './workers/ride-timeout.worker';

@Module({
  imports: [RideModule, DispatchModule],
  providers: [
    DriverLocationWorker,
    RideMatchingWorker,
    RideTimeoutWorker,
    OrderDispatchWorker,
    DriverWatchdogWorker,
  ],
})
export class WorkersModule {}
