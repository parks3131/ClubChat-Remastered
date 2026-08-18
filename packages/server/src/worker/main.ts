/**
 * Worker entrypoint. Every async server-side effect runs here and nowhere else.
 */

import pino from 'pino';
import { loadConfig } from '../config.ts';
import { initMonitoring } from '../monitoring.ts';
import { createDb, createPool } from '../db/client.ts';
import { createRedis } from '../bus/redis.ts';
import { createTracer, devTraceEnabled } from '../dev/trace.ts';
import { startDrainLoop } from './drain.ts';
import { startScheduler } from './scheduled.ts';
import type { EffectDeps } from './effects.ts';
import { ExpoPushSender } from '../push/sender.ts';
import { S3MediaStore } from '../media/store.ts';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL, name: 'worker' });

const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);
const redis = createRedis(config.REDIS_URL);

const controller = new AbortController();

const monitor = initMonitoring(config, 'worker', logger);

const deps: EffectDeps = {
  db,
  redis,
  monitor,
  // One adapter, three platforms: Expo Push fronts APNs, FCM and web push.
  push: new ExpoPushSender(),
  media: new S3MediaStore({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  }),
  // Its own publisher, for the same isolation reason the gateway's is: a dev tool must not be
  // able to stall an effect by filling the connection the effect publishes fan-out on.
  tracer: createTracer(devTraceEnabled() ? createRedis(config.REDIS_URL) : null, 'worker'),
  log: (level, message, extra) => logger[level](extra ?? {}, message),
};

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  controller.abort();
  await redis.quit().catch(() => undefined);
  await monitor.flush();
  await pool.end();
  process.exit(0);
};

/*
 * The two failures that kill a Node process outright.
 *
 * Registered on the WORKER specifically because it is the one role with no request/response cycle
 * to surface a fault through: an API 500 at least reaches a caller, and a dead socket at least
 * disconnects somebody. A worker that throws asynchronously just stops doing effects, silently.
 */
process.on('uncaughtException', (error) => {
  monitor.capture(error, 'worker.uncaughtException');
  void monitor.flush(1000).then(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  monitor.capture(reason, 'worker.unhandledRejection');
});

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info('worker started, draining outbox and running the scheduler');

// Two loops, deliberately independent. The drain reacts to writes; the scheduler is
// timer-driven because poll closing-soon is the one effect with no data change to hang on. A
// slow drain must not delay a deadline reminder, and vice versa.
await Promise.all([
  startDrainLoop(db, deps, { signal: controller.signal }),
  startScheduler(db, deps, { signal: controller.signal }),
]);
