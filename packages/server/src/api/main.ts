/**
 * API entrypoint.
 *
 * Gateway, API and Worker are three ROLES, not necessarily three deployables. They
 * live in one codebase with three entrypoints so the boundary that matters is the
 * CODE boundary - splitting them across services later is a deploy change rather than
 * a refactor. See SPEC/TECH/00-overview.md.
 */

import { pino } from 'pino';
import { createAuth } from '../auth.ts';
import { loadConfig } from '../config.ts';
import { createDb, createPool } from '../db/client.ts';
import { createKeyedRateLimiter, createRedis } from '../bus/redis.ts';
import { assertProductionMailer, LoggingMailer } from '../mail.ts';
import { initMonitoring } from '../monitoring.ts';
import { buildApp } from './app.ts';
import { S3MediaStore } from '../media/store.ts';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);

/*
 * One logger, given to Fastify, the monitor and the mailer.
 *
 * Built here rather than inside `buildApp` because the others need it too, and two loggers would
 * mean a captured error and the request that caused it printed in two different shapes.
 *
 * (It moved above `createAuth` when mail arrived, which is the first thing constructed before the
 * app that needs to write a line.)
 */
const logger = pino({ level: config.LOG_LEVEL });

/*
 * Outbound mail, which today has no production transport - ADR-0019.
 *
 * The assert is the load-bearing half. `LoggingMailer` writes reset URLs to the log instead of
 * mailing them, which is exactly what makes the flow runnable on a laptop and exactly what must
 * never reach production: members would be told to check an inbox that never receives anything,
 * while the working link sat in a log stream. Failing at boot is the honest version of that, and
 * it happens before the process takes traffic.
 */
const mailer = new LoggingMailer(logger);
assertProductionMailer(mailer, process.env['NODE_ENV']);

const auth = createAuth(db, {
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL,
  clientOrigin: config.CLIENT_ORIGIN,
  dev: process.env['NODE_ENV'] !== 'production',
  mailer,
});

const mediaStore = new S3MediaStore({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  accessKeyId: config.S3_ACCESS_KEY_ID,
  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
});

// Development convenience. In production the buckets are provisioned by infrastructure, not
// by the application - an app that can create buckets is an app whose credentials can.
if (process.env['NODE_ENV'] !== 'production') {
  await mediaStore
    .ensureBuckets([config.S3_BUCKET_PUBLIC, config.S3_BUCKET_PRIVATE])
    .catch((error) => console.warn('[media] could not ensure buckets', error));
}

const monitor = initMonitoring(config, 'api', logger);

/*
 * Its own Redis connection, not the gateway's: these are separate processes. Failing open is
 * reported rather than silent - an unreachable Redis means the API is briefly unlimited, and that
 * is a window somebody should know about rather than infer.
 */
const redis = createRedis(config.REDIS_URL);
const limiter = createKeyedRateLimiter(redis, {
  onFailOpen: (error) => monitor.capture(error, 'api.rateLimiter.failOpen'),
});

const app = buildApp({ db, auth, config, mediaStore, monitor, limiter, logger });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  // Reports leave BEFORE the process does. Whatever knocked it over is the thing most worth
  // seeing, and also the thing most likely to be still sitting in the queue.
  await monitor.flush();
  await redis.quit().catch(() => undefined);
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error, 'failed to start');
  process.exit(1);
}
