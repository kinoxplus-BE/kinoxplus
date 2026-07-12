import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Shared ioredis client for app state: room playback state, presence,
 * member sets (see AGENTS.md §6 "Redis keys"). Socket.io fan-out and BullMQ
 * hold their own connections.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
