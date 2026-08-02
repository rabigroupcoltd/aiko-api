import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  JOB_CANCEL_UNACCEPTED,
  JOB_FIND_NEARBY_DRIVERS,
  MATCHING_RETRY_DELAY_MS,
  QUEUE_RIDE_MATCHING,
  QUEUE_RIDE_TIMEOUT,
} from './queues.constants';

/**
 * Producer side of the queues. Kept free of any feature-service dependency so
 * that services can enqueue without pulling the workers into their module graph.
 */
@Injectable()
export class QueuesService {
  private readonly logger = new Logger(QueuesService.name);

  constructor(
    @InjectQueue(QUEUE_RIDE_MATCHING) private matchingQueue: Queue,
    @InjectQueue(QUEUE_RIDE_TIMEOUT) private timeoutQueue: Queue,
  ) {}

  /** Expires the request if nobody has been accepted by the time it fires. */
  async scheduleRequestTimeout(requestId: string, delayMs: number) {
    await this.timeoutQueue.add(
      JOB_CANCEL_UNACCEPTED,
      { requestId },
      {
        delay: delayMs,
        jobId: `timeout:${requestId}`,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  /** Re-runs the nearby search for a request that found nobody first time. */
  async scheduleRematch(requestId: string, attempt = 1) {
    await this.matchingQueue.add(
      JOB_FIND_NEARBY_DRIVERS,
      { requestId, attempt },
      {
        delay: MATCHING_RETRY_DELAY_MS,
        jobId: `match:${requestId}:${attempt}`,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }
}
