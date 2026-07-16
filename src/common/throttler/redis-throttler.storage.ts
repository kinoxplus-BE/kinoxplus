import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type Redis from 'ioredis';

/**
 * Redis-backed throttler storage so rate limits are shared across
 * instances and survive restarts (the default storage is in-memory,
 * which silently breaks the moment the service scales past one dyno).
 *
 * Single atomic Lua script per hit: INCR + window expiry + block tracking,
 * mirroring the semantics of the built-in ThrottlerStorageService.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private static readonly SCRIPT = `
    local totalHits = redis.call('INCR', KEYS[1])
    local timeToExpire = redis.call('PTTL', KEYS[1])
    if timeToExpire <= 0 then
      redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
      timeToExpire = tonumber(ARGV[1])
    end
    local isBlocked = redis.call('EXISTS', KEYS[2])
    local timeToBlockExpire = 0
    if isBlocked == 0 and totalHits > tonumber(ARGV[2]) then
      redis.call('SET', KEYS[2], 1, 'PX', tonumber(ARGV[3]))
      isBlocked = 1
    end
    if isBlocked == 1 then
      timeToBlockExpire = redis.call('PTTL', KEYS[2])
    end
    return { totalHits, timeToExpire, isBlocked, timeToBlockExpire }
  `;

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `${hitsKey}:blocked`;

    const [totalHits, timeToExpireMs, isBlocked, timeToBlockExpireMs] =
      (await this.redis.eval(
        RedisThrottlerStorage.SCRIPT,
        2,
        hitsKey,
        blockKey,
        ttl,
        limit,
        blockDuration > 0 ? blockDuration : ttl,
      )) as [number, number, number, number];

    return {
      totalHits,
      timeToExpire: Math.ceil(timeToExpireMs / 1000),
      isBlocked: isBlocked === 1,
      timeToBlockExpire: Math.ceil(timeToBlockExpireMs / 1000),
    };
  }
}
