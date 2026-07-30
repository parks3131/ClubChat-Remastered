/**
 * Worker entrypoint. Every async server-side effect runs here and nowhere else.
 */

import pino from 'pino';
import { loadConfig } from '../config.ts';
import { createDb, createPool } from '../db/client.ts';
import { createRedis } from '../bus/redis.ts';
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

const deps: EffectDeps = {
  db,
  redis,
  // One adapter, three platforms: Expo Push fronts APNs, FCM and web push.
  push: new ExpoPushSender(),
  media: new S3MediaStore({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  }),
  log: (level, message, extra) => logger[level](extra ?? {}, message),
};

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  controller.abort();
  await redis.quit().catch(() => undefined);
  await pool.end();
  process.exit(0);
};

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
