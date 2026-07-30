/**
 * API entrypoint.
 *
 * Gateway, API and Worker are three ROLES, not necessarily three deployables. They
 * live in one codebase with three entrypoints so the boundary that matters is the
 * CODE boundary - splitting them across services later is a deploy change rather than
 * a refactor. See SPEC/TECH/00-overview.md.
 */

import { createAuth } from '../auth.ts';
import { loadConfig } from '../config.ts';
import { createDb, createPool } from '../db/client.ts';
import { buildApp } from './app.ts';
import { S3MediaStore } from '../media/store.ts';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);
const auth = createAuth(db, {
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL,
  clientOrigin: config.CLIENT_ORIGIN,
  dev: process.env['NODE_ENV'] !== 'production',
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

const app = buildApp({ db, auth, config, mediaStore });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
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
