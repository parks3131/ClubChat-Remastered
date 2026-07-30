/**
 * Redis: the gateways' shared coordination layer.
 *
 * Exactly three jobs, and nothing else:
 *   1. connection registry - which gateway holds which user's sockets
 *   2. pub/sub - the per-channel loudspeaker
 *   3. rate-limit token buckets
 *
 * **Redis is a cache and a bus, never a source of truth.** Flushing it must DEGRADE
 * the system, not corrupt it: realtime stops, clients fall back to REST plus sync,
 * rate limiting fails open, and push is unaffected because push never consults Redis.
 * That property is non-negotiable (SPEC/TECH/11-failure-modes.md).
 */

import { Redis } from 'ioredis';
import type { MessageEnvelope } from '@clubchat/shared';

/**
 * The fan-out topic.
 *
 * Per CHANNEL, not per user. One publish per message regardless of channel size, and
 * authorization happens once at subscribe time rather than once per message per
 * recipient. For a 300-member club that is 1 publish where the reference design needs
 * 300. See ADR-0007.
 */
export const channelTopic = (channelId: string): string => `chan:${channelId}`;

/** Registry key. A hash of session id -> connection metadata. */
export const registryKey = (userId: string): string => `conn:${userId}`;

/**
 * Registry TTL, in seconds.
 *
 * Must never exceed the reaper window, and both are 90s. An entry that outlives its
 * socket causes a publish to a gateway that no longer holds the connection, which is a
 * harmless no-op - the message is already durable in the channel log and the client
 * will sync on reconnect. An entry that outlived its socket while ALSO gating push
 * would cause silent missed notifications, which is exactly why that coupling does not
 * exist here (ADR-0008).
 */
export const REGISTRY_TTL_SECONDS = 90;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const REAPER_TIMEOUT_MS = 90_000;

export type Published = {
  channelId: string;
  seq: number;
  envelope: MessageEnvelope;
};

export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    // A gateway must start even if Redis is briefly unavailable: realtime degrades,
    // the API keeps serving, and nothing is lost.
    lazyConnect: false,
    enableOfflineQueue: true,
  });
}

/**
 * Token bucket, evaluated atomically in Redis.
 *
 * Burst 30, refill 1/sec per sender, enforced BEFORE the insert. The whole bucket
 * transition happens inside one script so two concurrent sends cannot both read the
 * same token count and both spend it.
 *
 * `now` is passed in rather than read from Redis's own clock so the script has no
 * source of nondeterminism, which keeps it safe to run against a replica.
 */
const TOKEN_BUCKET_SCRIPT = `
local key    = KEYS[1]
local burst  = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now    = tonumber(ARGV[3])

local state  = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])

if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end

local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(burst, tokens + elapsed * refill)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil((burst / refill) * 1000) + 1000)
return allowed
`;

export type RateLimiter = {
  /** True if the caller may proceed. Fails OPEN if Redis is unreachable. */
  tryConsume: (userId: string) => Promise<boolean>;
};

export function createRateLimiter(
  redis: Redis,
  opts: { burst: number; refillPerSec: number; onFailOpen?: (error: unknown) => void },
): RateLimiter {
  return {
    async tryConsume(userId: string): Promise<boolean> {
      try {
        const allowed = await redis.eval(
          TOKEN_BUCKET_SCRIPT,
          1,
          `rate:send:${userId}`,
          String(opts.burst),
          String(opts.refillPerSec),
          String(Date.now()),
        );
        return allowed === 1;
      } catch (error) {
        // Fail OPEN, and say so loudly. Redis holds no source of truth, so a Redis
        // outage must degrade the system rather than stop members talking to each
        // other. The alternative - failing closed - turns a cache outage into a
        // total chat outage.
        opts.onFailOpen?.(error);
        return true;
      }
    },
  };
}

/** Publish an envelope to a channel's topic. Gateways forward it to their sockets. */
export async function publishToChannel(
  redis: Redis,
  channelId: string,
  envelope: MessageEnvelope,
): Promise<void> {
  const payload: Published = { channelId, seq: envelope.seq, envelope };
  await redis.publish(channelTopic(channelId), JSON.stringify(payload));
}

export type ConnectionRegistry = {
  register: (userId: string, sessionId: string, meta: Record<string, string>) => Promise<void>;
  heartbeat: (userId: string) => Promise<void>;
  unregister: (userId: string, sessionId: string) => Promise<void>;
};

export function createConnectionRegistry(redis: Redis, gatewayId: string): ConnectionRegistry {
  return {
    async register(userId, sessionId, meta) {
      const key = registryKey(userId);
      await redis
        .multi()
        .hset(key, sessionId, JSON.stringify({ gatewayId, ...meta, connectedAt: Date.now() }))
        .expire(key, REGISTRY_TTL_SECONDS)
        .exec();
    },
    async heartbeat(userId) {
      await redis.expire(registryKey(userId), REGISTRY_TTL_SECONDS);
    },
    async unregister(userId, sessionId) {
      await redis.hdel(registryKey(userId), sessionId);
    },
  };
}
