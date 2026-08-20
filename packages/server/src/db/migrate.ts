/**
 * Apply pending migrations.
 *
 * Migrations are the schema's source of truth and must replay cleanly from zero. An
 * applied migration is never edited - a correction is always a new numbered one
 * (AGENTS.md non-negotiable 2).
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDb, createPool } from './client.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write('DATABASE_URL is not set. Copy .env.example to .env.\n');
  process.exit(1);
}

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/*
 * The one caller that opts out of both ceilings, and the reason they are a parameter at all.
 *
 * `createPool` sets `statement_timeout` and `idle_in_transaction_session_timeout` so that a
 * runaway query or a transaction stalled on external I/O cannot hold a connection forever. A
 * migration is neither. Building an index over a table with real rows in it is a single statement
 * that is SUPPOSED to run for minutes, and it is run deliberately, by somebody watching. Inheriting
 * a thirty-second ceiling would mean the first migration to touch a large table dies halfway
 * through, in production, for a reason with nothing to do with the migration.
 */
const pool = createPool(connectionString, {
  statementTimeoutMs: 0,
  idleInTransactionTimeoutMs: 0,
});
const db = createDb(pool);

try {
  await migrate(db, { migrationsFolder });
  process.stdout.write('migrations applied\n');
} catch (error) {
  process.stderr.write(`migration failed: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
