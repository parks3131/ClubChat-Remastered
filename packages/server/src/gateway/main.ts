/**
 * Gateway entrypoint.
 *
 * > **This used to say the gateway must sit behind an L4 balancer rather than L7, because a
 * > balancer that terminates HTTP breaks the WebSocket upgrade. That is true in general and
 * > false on Fly, and the correction is worth keeping** because the old claim is the more
 * > persuasive one and will be re-derived by anybody who reasons from first principles.
 * >
 * > A WebSocket upgrade is HTTP/1.1, and Fly's HTTP handler proxies it. What actually decided
 * > this deployment is the other end of the problem: a raw TLS service on Fly can carry only a
 * > TCP check, which proves a port is listening and cannot tell that apart from working. This
 * > role runs as an `http_service` precisely so `/ready` is reachable and a gateway that cannot
 * > reach Postgres never takes sockets. See ADR-0043.
 *
 * Still true, and not Fly-specific: a balancer that terminates HTTP is a real hazard for this
 * role, so the deployment is pinned in `fly/gateway.toml` rather than left to a default, and
 * `idle_timeout` is set explicitly there because the platform default is undocumented.
 */

import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { createAuth } from '../auth.ts';
import { loadConfig } from '../config.ts';
import { initMonitoring } from '../monitoring.ts';
import { createDb, createPool } from '../db/client.ts';
import { createRateLimiter, createRedis } from '../bus/redis.ts';
import { createTracer, devTraceEnabled } from '../dev/trace.ts';
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

const monitor = initMonitoring(config, 'gateway', logger);

const rateLimiter = createRateLimiter(redis, {
  burst: config.SEND_RATE_BURST,
  refillPerSec: config.SEND_RATE_REFILL_PER_SEC,
  onFailOpen: (error) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'rate limiter failed OPEN - Redis unreachable',
    );
    /*
     * Failing open is the right call - a send limiter that refuses everything when Redis blinks
     * would take chat down to protect it from spam. But "open" means UNLIMITED sends, so this is
     * a security control silently switching itself off, and it must never be only a log line.
     */
    monitor.capture(error, 'gateway.rateLimiter.failOpen');
  },
});

const gateway = createGateway(
  {
    db,
    auth,
    redis,
    subscriber,
    rateLimiter,
    gatewayId,
    monitor,
    // The development trace. A publisher of its own rather than the command connection above,
    // which is not about subscriber mode here but about isolation: a dev tool must not be able
    // to stall a publish or a registry write by filling a shared client's command queue.
    tracer: createTracer(devTraceEnabled() ? createRedis(config.REDIS_URL) : null, 'gateway'),
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
  await monitor.flush();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info({ port: config.GATEWAY_PORT }, 'gateway listening');
