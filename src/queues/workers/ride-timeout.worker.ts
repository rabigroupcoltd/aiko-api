import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RideService } from '../../ride/ride.service';
import {
  QUEUE_RIDE_TIMEOUT,
  WORKER_OPTIONS,
} from '../queues.constants';

@Processor(QUEUE_RIDE_TIMEOUT, WORKER_OPTIONS)
export class RideTimeoutWorker extends WorkerHost {
  private readonly logger = new Logger(RideTimeoutWorker.name);

  constructor(private ride: RideService) {
    super();
  }

  async process(job: Job<{ requestId: string }>) {
    const expired = await this.ride.expireRequest(job.data.requestId);

    if (expired) this.logger.log(`Ride request ${job.data.requestId} expired unaccepted`);
    return { expired: Boolean(expired) };
  }
}
