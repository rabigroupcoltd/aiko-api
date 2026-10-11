import { Logger, Provider } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

export function createRedisClient(namespace: string): Redis {
  const logger = new Logger(`Redis:${namespace}`);
  const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });

  client.on('error', (error) => logger.error(`Connection error: ${error.message}`));
  client.on('ready', () => logger.log('Connected'));

  return client;
}

export const RedisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: () => createRedisClient('app'),
};
