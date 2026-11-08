import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DispatchService } from '../../dispatch/dispatch.service';
import {
  QUEUE_ORDER_DISPATCH,
  WORKER_OPTIONS,
} from '../queues.constants';

@Processor(QUEUE_ORDER_DISPATCH, WORKER_OPTIONS)
export class OrderDispatchWorker extends WorkerHost {
  private readonly logger = new Logger(OrderDispatchWorker.name);

  constructor(private dispatch: DispatchService) {
    super();
  }

  async process(job: Job<{ orderId: string; attempt: number; startedAt?: number }>) {
    const { orderId, attempt, startedAt } = job.data;
    const targets = await this.dispatch.expandSearch(orderId, attempt, startedAt);

    if (targets === null) {
      this.logger.debug(`Order ${orderId} no longer open — dispatch chain stopped`);
      return { stopped: true };
    }

    return { stopped: false, drivers: targets.length };
  }
}
