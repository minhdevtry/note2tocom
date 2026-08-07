import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { Injectable, Logger } from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';
import { Redis } from 'ioredis';

@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private environmentService: EnvironmentService,
  ) {}

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      const redisUrl = this.environmentService.getRedisUrl();
      // Upstash `rediss://` requires TLS. The URL alone is not
      // enough for ioredis — without this the health check would
      // silently drop on first PING and report "down" forever.
      const redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 5,
        tls: { rejectUnauthorized: false },
        connectTimeout: 5000,
      });

      await redis.ping();
      redis.disconnect();
      return indicator.up();
    } catch (e) {
      this.logger.error(e);
      return indicator.down(`${key} is not available`);
    }
  }
}
