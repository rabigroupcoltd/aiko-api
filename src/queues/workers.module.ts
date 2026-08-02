import { Module } from '@nestjs/common';
import { RideModule } from '../ride/ride.module';
import { DriverLocationWorker } from './workers/driver-location.worker';
import { RideMatchingWorker } from './workers/ride-matching.worker';
import { RideTimeoutWorker } from './workers/ride-timeout.worker';

/**
 * Consumer side of the queues, split from QueuesModule so feature modules can
 * depend on the producers without a circular import back through the workers.
 *
 * Skip importing this module to run a producer-only API instance and host the
 * workers in a separate process.
 */
@Module({
  imports: [RideModule],
  providers: [DriverLocationWorker, RideMatchingWorker, RideTimeoutWorker],
})
export class WorkersModule {}
