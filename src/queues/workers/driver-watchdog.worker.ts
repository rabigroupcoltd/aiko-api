import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { AuditEntity } from '@prisma/client';
import { Queue } from 'bullmq';
import { AuditService } from '../../audit/audit.service';
import {
  DRIVER_ACTIVE_STATUSES,
  LEGACY_ACTIVE_STATUSES,
} from '../../dispatch/dispatch.constants';
import { RideEventsService } from '../../events/ride-events.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  DRIVER_WATCHDOG_IDLE_RECHECK_MS,
  DRIVER_WATCHDOG_INTERVAL_MS,
  JOB_CHECK_DRIVER_WATCHDOG,
  QUEUE_DRIVER_WATCHDOG,
  WORKER_OPTIONS,
} from '../queues.constants';

interface HeldOrder {
  id: string;
  userId: string;
  driverId: string | null;
  pickupLocation: string;
  dropoffLocation: string;
}

@Processor(QUEUE_DRIVER_WATCHDOG, WORKER_OPTIONS)
export class DriverWatchdogWorker extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DriverWatchdogWorker.name);
  private lastPassHadHeldOrders = true;
  private lastQueriedAt = 0;

  constructor(
    @InjectQueue(QUEUE_DRIVER_WATCHDOG) private queue: Queue,
    private prisma: PrismaService,
    private redis: RedisService,
    private audit: AuditService,
    private events: RideEventsService,
  ) {
    super();
  }

  async onModuleInit() {
    try {
      await this.queue.add(
        JOB_CHECK_DRIVER_WATCHDOG,
        {},
        {
          repeat: { every: DRIVER_WATCHDOG_INTERVAL_MS },
          jobId: JOB_CHECK_DRIVER_WATCHDOG,
          removeOnComplete: true,
        },
      );
    } catch (error: any) {
      this.logger.warn(`Could not schedule the driver watchdog job: ${error?.message}`);
    }
  }

  async process(): Promise<{ flagged: number; cleared: number }> {
    // A driver must be online to take an order, and heartbeats outlive one watchdog
    // interval, so if nobody is online and nothing was held last pass, nothing new is held.
    const idleRecheckDue = Date.now() - this.lastQueriedAt >= DRIVER_WATCHDOG_IDLE_RECHECK_MS;
    if (!this.lastPassHadHeldOrders && !idleRecheckDue && !(await this.redis.hasAnyOnlineDriver())) {
      return { flagged: 0, cleared: 0 };
    }

    this.lastQueriedAt = Date.now();
    const held = await this.prisma.order.findMany({
      where: {
        driverId: { not: null },
        status: { in: [...DRIVER_ACTIVE_STATUSES, ...LEGACY_ACTIVE_STATUSES] },
      },
      select: {
        id: true,
        userId: true,
        driverId: true,
        pickupLocation: true,
        dropoffLocation: true,
      },
    });

    this.lastPassHadHeldOrders = held.length > 0;
    if (held.length === 0) return { flagged: 0, cleared: 0 };

    const byDriver = new Map<string, HeldOrder[]>();
    for (const order of held) {
      const driverId = order.driverId!;
      const list = byDriver.get(driverId);
      if (list) list.push(order);
      else byDriver.set(driverId, [order]);
    }

    let flagged = 0;
    let cleared = 0;

    await Promise.all(
      Array.from(byDriver.entries()).map(async ([driverId, orders]) => {
        const [online, alreadyFlagged] = await Promise.all([
          this.redis.isOnline(driverId),
          this.redis.isDriverFlaggedDark(driverId),
        ]);

        if (!online && !alreadyFlagged) {
          await this.redis.flagDriverDark(driverId);

          await this.audit.record({
            action: 'driver.went-dark',
            entity: AuditEntity.SYSTEM,
            entityId: driverId,
            summary: `Driver stopped reporting location while holding ${orders.length} active order(s)`,
            metadata: { driverId, orderIds: orders.map((order) => order.id) },
          });

          this.events.emit('driver.went-dark', { driverId, orders });
          flagged += 1;
          return;
        }

        if (online && alreadyFlagged) {
          await this.redis.clearDriverDarkFlag(driverId);
          cleared += 1;
        }
      }),
    );

    if (flagged > 0 || cleared > 0) {
      this.logger.debug(`Watchdog pass: ${flagged} newly dark, ${cleared} recovered`);
    }

    return { flagged, cleared };
  }
}
