import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DispatchService } from '../../dispatch/dispatch.service';
import {
  QUEUE_ORDER_DISPATCH,
  WORKER_OPTIONS,
} from '../queues.constants';

/**
 * Widens the driver search around an unclaimed marketplace order.
 *
 * `expandSearch` is guarded and re-arms itself, so this worker only has to fire
 * the pass: an order reserved a moment before the job ran returns null and the
 * chain simply stops.
 */
@Processor(QUEUE_ORDER_DISPATCH, WORKER_OPTIONS)
export class OrderDispatchWorker extends WorkerHost {
  private readonly logger = new Logger(OrderDispatchWorker.name);

  constructor(private dispatch: DispatchService) {
    super();
  }

  async process(job: Job<{ orderId: string; attempt: number }>) {
    const { orderId, attempt } = job.data;
    const targets = await this.dispatch.expandSearch(orderId, attempt);

    if (targets === null) {
      this.logger.debug(`Order ${orderId} no longer open — dispatch chain stopped`);
      return { stopped: true };
    }

    return { stopped: false, drivers: targets.length };
  }
}
