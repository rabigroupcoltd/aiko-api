import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RideService } from '../../ride/ride.service';
import { MATCHING_RETRIES, QUEUE_RIDE_MATCHING } from '../queues.constants';
import { QueuesService } from '../queues.service';

/**
 * Second chance for requests that found no driver. Each attempt widens the
 * radius; after MATCHING_RETRIES the request is left to time out.
 */
@Processor(QUEUE_RIDE_MATCHING)
export class RideMatchingWorker extends WorkerHost {
  private readonly logger = new Logger(RideMatchingWorker.name);

  constructor(
    private ride: RideService,
    private queues: QueuesService,
  ) {
    super();
  }

  async process(job: Job<{ requestId: string; attempt: number }>) {
    const { requestId, attempt } = job.data;

    const matched = await this.ride.rematch(requestId, attempt);
    if (matched === null) return { stopped: 'request-closed' };

    if (matched.length > 0) {
      this.logger.log(`Request ${requestId} matched ${matched.length} driver(s) on attempt ${attempt}`);
      return { matched: matched.length };
    }

    if (attempt < MATCHING_RETRIES) {
      await this.queues.scheduleRematch(requestId, attempt + 1);
    } else {
      this.logger.warn(`Request ${requestId} found no driver after ${attempt} attempts`);
    }

    return { matched: 0, attempt };
  }
}
