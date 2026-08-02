import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  JOB_FLUSH_LOCATIONS,
  LOCATION_FLUSH_INTERVAL_MS,
  QUEUE_DRIVER_LOCATION,
} from '../queues.constants';

/**
 * Drivers report every ~10s. Writing each ping straight to Postgres would be
 * thousands of writes a minute, so Redis absorbs them and this job flushes the
 * latest position per driver on an interval.
 */
@Processor(QUEUE_DRIVER_LOCATION)
export class DriverLocationWorker extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DriverLocationWorker.name);

  constructor(
    @InjectQueue(QUEUE_DRIVER_LOCATION) private queue: Queue,
    private prisma: PrismaService,
    private redis: RedisService,
  ) {
    super();
  }

  async onModuleInit() {
    try {
      // A fixed jobId keeps repeat registrations idempotent across restarts
      // and across instances.
      await this.queue.add(
        JOB_FLUSH_LOCATIONS,
        {},
        {
          repeat: { every: LOCATION_FLUSH_INTERVAL_MS },
          jobId: JOB_FLUSH_LOCATIONS,
          removeOnComplete: true,
        },
      );
    } catch (error: any) {
      this.logger.warn(`Could not schedule the location flush job: ${error?.message}`);
    }
  }

  async process(): Promise<{ flushed: number }> {
    const driverIds = await this.redis.getAllTrackedDriverIds();
    if (driverIds.length === 0) return { flushed: 0 };

    const locations = await Promise.all(
      driverIds.map((driverId) => this.redis.getDriverLocation(driverId)),
    );

    const writable = locations.filter(
      (location): location is NonNullable<typeof location> =>
        location != null && location.lat != null && location.lng != null,
    );

    // Drivers deleted between the Redis read and this write would break a
    // batch insert, so each upsert stands on its own.
    const results = await Promise.allSettled(
      writable.map((location) =>
        this.prisma.driverLocation.upsert({
          where: { driverId: location.driverId },
          create: {
            driverId: location.driverId,
            latitude: location.lat!,
            longitude: location.lng!,
            heading: location.heading,
            speedKph: location.speedKph,
            accuracyMeters: location.accuracyMeters,
            recordedAt: location.recordedAt ? new Date(location.recordedAt) : new Date(),
          },
          update: {
            latitude: location.lat!,
            longitude: location.lng!,
            heading: location.heading,
            speedKph: location.speedKph,
            accuracyMeters: location.accuracyMeters,
            recordedAt: location.recordedAt ? new Date(location.recordedAt) : new Date(),
          },
        }),
      ),
    );

    const flushed = results.filter((result) => result.status === 'fulfilled').length;
    this.logger.debug(`Flushed ${flushed}/${writable.length} driver locations`);

    return { flushed };
  }
}
