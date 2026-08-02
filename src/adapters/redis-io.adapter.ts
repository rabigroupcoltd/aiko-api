import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { ServerOptions } from 'socket.io';
import { createRedisClient } from '../redis/redis.provider';

/**
 * Routes every Socket.IO emit through a Redis stream so any instance can reach
 * any socket. Without it, a passenger connected to instance A would never see
 * an event raised on instance B — and no sticky sessions are needed with it.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    // A dedicated connection: the adapter blocks on XREAD, which would stall
    // ordinary commands if it shared the application client.
    const client = createRedisClient('socket-adapter');
    this.adapterConstructor = createAdapter(client);
    this.logger.log('Socket.IO Redis Streams adapter ready');
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}
