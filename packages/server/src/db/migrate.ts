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

const pool = createPool(connectionString);
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
