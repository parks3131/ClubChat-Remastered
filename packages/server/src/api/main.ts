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

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);
const auth = createAuth(db, {
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL,
  clientOrigin: config.CLIENT_ORIGIN,
  dev: process.env['NODE_ENV'] !== 'production',
});

const app = buildApp({ db, auth, config });

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
