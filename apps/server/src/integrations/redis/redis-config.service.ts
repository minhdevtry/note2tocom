import { Injectable } from '@nestjs/common';
import {
  RedisModuleOptions,
  RedisOptionsFactory,
} from '@nestjs-labs/nestjs-ioredis';
import { createRetryStrategy, parseRedisUrl } from '../../common/helpers';
import { EnvironmentService } from '../environment/environment.service';

@Injectable()
export class RedisConfigService implements RedisOptionsFactory {
  constructor(private readonly environmentService: EnvironmentService) {}
  createRedisOptions(): RedisModuleOptions {
    const redisConfig = parseRedisUrl(this.environmentService.getRedisUrl());
    return {
      readyLog: true,
      config: {
        host: redisConfig.host,
        port: redisConfig.port,
        password: redisConfig.password,
        db: redisConfig.db,
        family: redisConfig.family,
        tls: { rejectUnauthorized: false },
        retryStrategy: createRetryStrategy(),
        // Reconnect aggressively on TLS idle drops (Upstash closes
        // idle connections after a few minutes). The default retry
        // strategy has a 20-attempt cap which we want to bypass.
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: false,
        keepAlive: 10000,
      },
    };
  }
}
