import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { RedisOptions } from 'ioredis';
import {
  createRetryStrategy,
  parseRedisUrl,
  RedisConfig,
} from '../../common/helpers';

export class WsRedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private redisConfig: RedisConfig;

  async connectToRedis(): Promise<void> {
    this.redisConfig = parseRedisUrl(process.env.REDIS_URL);

    const options: RedisOptions = {
      family: this.redisConfig.family,
      // Upstash `rediss://` requires TLS — the URL alone isn't
      // enough for ioredis. Without this, the pub/sub sockets
      // used for cross-instance Socket.IO fanout silently
      // drop (ECONNRESET) on the first command.
      tls: { rejectUnauthorized: false },
      keepAlive: 10000,
      maxRetriesPerRequest: null,
      retryStrategy: createRetryStrategy(),
    };

    const pubClient = new Redis(process.env.REDIS_URL, options);
    const subClient = new Redis(process.env.REDIS_URL, options);

    pubClient.on('error', (err) => () => {});
    subClient.on('error', (err) => () => {});

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
