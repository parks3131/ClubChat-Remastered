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
import { assertProductionMailer, LoggingMailer, ResendMailer } from '../mail.ts';
import { initMonitoring } from '../monitoring.ts';
import {
  parseModeratorList,
  reconcilePlatformModerators,
} from '../domain/platform-moderators.ts';
import { buildApp } from './app.ts';
import { instrumentPool } from '../dev/queries.ts';
import { createTracer, devTraceEnabled } from '../dev/trace.ts';
import { S3MediaStore } from '../media/store.ts';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
/*
 * Count the statements each request runs, in development only.
 *
 * Before `createDb`, because drizzle keeps its own reference to the pool from that moment on.
 * Behind the same gate as the tracer, and for the same reason: this is the only place that
 * decides, so a production boot and every test get the plain pool. See `dev/queries.ts`.
 */
if (devTraceEnabled()) instrumentPool(pool);
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
 * Outbound mail - ADR-0019 for the port, ADR-0020 for the provider behind it.
 *
 * The key picks the transport, and its absence is the laptop default rather than a mistake:
 * `LoggingMailer` writes the reset URL to the log, which is what makes the flow runnable with no
 * provider account and no DNS.
 *
 * Testing `MAIL_FROM` as well is what TypeScript needs to narrow, not a second policy - a key
 * without a From address was already rejected by `loadConfig` above, so this branch cannot be
 * reached half-configured.
 *
 * The assert is still the load-bearing half. Development's transport reaching production would
 * mean members told to check an inbox that never receives anything while the working link sat in
 * a log stream. Failing at boot is the honest version of that, and it happens before the process
 * takes traffic.
 */
const mailer =
  config.RESEND_API_KEY && config.MAIL_FROM
    ? new ResendMailer({ apiKey: config.RESEND_API_KEY, from: config.MAIL_FROM })
    : new LoggingMailer(logger);
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
 * Make the platform-moderator flag agree with the configured list.
 *
 * Here rather than in the gateway or the worker because there should be exactly one writer, and
 * the API is the process that serves the queue this staffs. Idempotent, so several instances
 * booting together is a no-op rather than a race.
 *
 * **Reported and survivable rather than fatal.** A database hiccup at boot should not stop the
 * API taking traffic, and the flag it failed to write is already whatever it was. But it must not
 * be silent either: an unreconciled list means the person named in config cannot open the queue,
 * which presents as "moderation is broken" with nothing anywhere saying why.
 */
const moderators = parseModeratorList(config.PLATFORM_MODERATORS);
try {
  const outcome = await reconcilePlatformModerators(db, moderators);
  if (outcome.skipped) {
    logger.warn(
      'PLATFORM_MODERATORS is not set, so nobody can read the direct-message report queue. ' +
        'Reports will be filed and never seen. Set it to a comma-separated list of emails.',
    );
  } else {
    logger.info(
      {
        configured: moderators.length,
        granted: outcome.grant.length,
        revoked: outcome.revoke.length,
        // Named, not counted: a typo here grants nobody and is otherwise indistinguishable from
        // having worked.
        unmatched: outcome.unmatched,
      },
      'platform moderators reconciled',
    );
  }
} catch (error) {
  monitor.capture(error, 'api.platformModerators.reconcile');
}

/*
 * Its own Redis connection, not the gateway's: these are separate processes. Failing open is
 * reported rather than silent - an unreachable Redis means the API is briefly unlimited, and that
 * is a window somebody should know about rather than infer.
 */
const redis = createRedis(config.REDIS_URL);
const limiter = createKeyedRateLimiter(redis, {
  onFailOpen: (error) => monitor.capture(error, 'api.rateLimiter.failOpen'),
});

/*
 * The development trace, and nothing at all in production.
 *
 * Two connections rather than one: ioredis puts a client into subscriber mode exclusively, so
 * the dashboard's reader cannot be the publisher and cannot be the limiter's. Both are extra
 * sockets to Redis that exist only on a laptop.
 *
 * `devTraceEnabled()` is checked here as well as inside `createTracer` so the CONNECTIONS are
 * not opened either. A disabled observer should cost nothing, not merely do nothing.
 */
const traceOn = devTraceEnabled();
const devSubscriber = traceOn ? createRedis(config.REDIS_URL) : undefined;
const tracer = createTracer(traceOn ? createRedis(config.REDIS_URL) : null, 'api');
if (traceOn) logger.info('dev trace: dashboard at http://localhost:' + config.API_PORT + '/dev/trace');

const app = buildApp({
  db,
  auth,
  config,
  mediaStore,
  monitor,
  limiter,
  logger,
  tracer,
  devSubscriber,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  // Reports leave BEFORE the process does. Whatever knocked it over is the thing most worth
  // seeing, and also the thing most likely to be still sitting in the queue.
  await monitor.flush();
  await redis.quit().catch(() => undefined);
  await devSubscriber?.quit().catch(() => undefined);
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
