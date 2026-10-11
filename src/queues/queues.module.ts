import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import {
  QUEUE_DRIVER_LOCATION,
  QUEUE_DRIVER_WATCHDOG,
  QUEUE_ORDER_DISPATCH,
  QUEUE_RIDE_MATCHING,
  QUEUE_RIDE_TIMEOUT,
} from './queues.constants';
import { QueuesService } from './queues.service';

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    }),
    BullModule.registerQueue(
      { name: QUEUE_DRIVER_LOCATION },
      { name: QUEUE_RIDE_MATCHING },
      { name: QUEUE_RIDE_TIMEOUT },
      { name: QUEUE_ORDER_DISPATCH },
      { name: QUEUE_DRIVER_WATCHDOG },
    ),
  ],
  providers: [QueuesService],
  exports: [BullModule, QueuesService],
})
export class QueuesModule {}
