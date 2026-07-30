/**
 * Gateway entrypoint.
 *
 * Deployed behind an L4 load balancer, not L7: balancers that terminate HTTP break the
 * WebSocket upgrade or add proxy hops. The REST API keeps an ordinary L7 balancer.
 */

import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { createAuth } from '../auth.ts';
import { loadConfig } from '../config.ts';
import { createDb, createPool } from '../db/client.ts';
import { createRateLimiter, createRedis } from '../bus/redis.ts';
import { createGateway } from './server.ts';

const config = loadConfig();
const gatewayId = process.env['GATEWAY_ID'] ?? randomUUID();
const logger = pino({ level: config.LOG_LEVEL, name: 'gateway', base: { gatewayId } });

const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);
const auth = createAuth(db, {
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL,
  clientOrigin: config.CLIENT_ORIGIN,
  dev: process.env['NODE_ENV'] !== 'production',
});

const redis = createRedis(config.REDIS_URL);
// ioredis puts a connection into subscriber mode exclusively, so the subscriber needs
// its own connection or every publish and registry write on the shared one would fail.
const subscriber = createRedis(config.REDIS_URL);

const rateLimiter = createRateLimiter(redis, {
  burst: config.SEND_RATE_BURST,
  refillPerSec: config.SEND_RATE_REFILL_PER_SEC,
  onFailOpen: (error) =>
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'rate limiter failed OPEN - Redis unreachable',
    ),
});

const gateway = createGateway(
  {
    db,
    auth,
    redis,
    subscriber,
    rateLimiter,
    gatewayId,
    log: (level, message, extra) => logger[level](extra ?? {}, message),
  },
  { port: config.GATEWAY_PORT },
);

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await gateway.close();
  await Promise.all([
    redis.quit().catch(() => undefined),
    subscriber.quit().catch(() => undefined),
  ]);
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info({ port: config.GATEWAY_PORT }, 'gateway listening');
