import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  JOB_FLUSH_LOCATIONS,
  LOCATION_FLUSH_INTERVAL_MS,
  QUEUE_DRIVER_LOCATION,
  WORKER_OPTIONS,
} from '../queues.constants';

@Processor(QUEUE_DRIVER_LOCATION, WORKER_OPTIONS)
export class DriverLocationWorker extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DriverLocationWorker.name);
  // recordedAt of the fix last written per driver, so offline drivers stop costing writes.
  private readonly flushedAt = new Map<string, string | null>();

  constructor(
    @InjectQueue(QUEUE_DRIVER_LOCATION) private queue: Queue,
    private prisma: PrismaService,
    private redis: RedisService,
  ) {
    super();
  }

  async onModuleInit() {
    try {
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
    const tracked = await this.redis.getAllTrackedDrivers();
    if (tracked.length === 0) return { flushed: 0 };

    const locations = await Promise.all(
      tracked.map(({ driverId, vehicleType }) =>
        this.redis.getDriverLocation(driverId, vehicleType),
      ),
    );

    const writable = locations.filter(
      (location): location is NonNullable<typeof location> =>
        location != null &&
        location.lat != null &&
        location.lng != null &&
        (!location.recordedAt || this.flushedAt.get(location.driverId) !== location.recordedAt),
    );
    if (writable.length === 0) return { flushed: 0 };

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

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        this.flushedAt.set(writable[index].driverId, writable[index].recordedAt);
      }
    });

    const flushed = results.filter((result) => result.status === 'fulfilled').length;
    this.logger.debug(`Flushed ${flushed}/${writable.length} driver locations`);

    return { flushed };
  }
}
