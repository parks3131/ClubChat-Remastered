/**
 * One Postgres for the whole suite, and the migrations replayed into it once.
 *
 * > **This is the standing fix `SPEC/PRD/17` item 15 has been asking for.** The harness used to
 * > start a container per test file - 36 of them per run, serially - and intermittently lost one
 * > to `Timed out after 10000ms while waiting for container ports to be bound to the host`. That
 * > ceiling is a hardcoded default inside testcontainers and is not reachable from configuration,
 * > so the only real fix was to stop asking Docker to bind 36 ports. It was a **predicted** flake
 * > until 2026-08-15, when a run on a laptop failed one file with 20 tests skipped and three clean
 * > runs either side of it, which is the shape of a container that never bound rather than an
 * > assertion that failed.
 *
 * A file still gets a database of its own, so the isolation that made a container-per-file
 * attractive is unchanged: nothing shares a channel row, a sequence, or a cursor with another
 * file. What is shared is the postmaster, which is the part that was expensive.
 *
 * **The migrations still run for real**, once, into the template - which is the whole reason the
 * harness never used a hand-written `CREATE TABLE`. A migration that fails to carry an invariant
 * now fails the run at setup instead of failing every file, which is a better failure and the
 * same coverage.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { createDb, createPool } from '../db/client.ts';
import { CONTAINER_STARTUP_TIMEOUT_MS, TEMPLATE_DATABASE, withDatabase } from './containers.ts';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'migrations',
);

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine')
    .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
    /*
     * `pg_stat_statements`, preloaded, matching `docker-compose.yml`.
     *
     * The suite itself has no use for it - a test file gets a fresh database and asks a handful
     * of questions of it, which is what the per-request query counter already measures better.
     * It is here so the LOAD TEST can ask the database what it spent its time on rather than
     * only timing it from outside, and because a facility that exists in development and not in
     * the container the tests run against is a facility nobody can write a test for.
     *
     * Preloading is free when nothing queries the view; the counters are a fixed-size shared
     * memory block written on a path that is already taken.
     */
    .withCommand([
      'postgres',
      '-c',
      'shared_preload_libraries=pg_stat_statements',
      '-c',
      'pg_stat_statements.track=all',
      '-c',
      'pg_stat_statements.track_utility=off',
    ])
    .start();

  const adminUri = container.getConnectionUri();

  /*
   * `CREATE DATABASE` cannot run inside a transaction block, which is why this is a bare pool
   * query rather than anything the ORM would wrap.
   */
  const admin = createPool(adminUri);
  await admin.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
  await admin.end();

  const template = createPool(withDatabase(adminUri, TEMPLATE_DATABASE));
  try {
    await migrate(createDb(template), { migrationsFolder });
  } finally {
    /*
     * Ending this pool is load-bearing rather than tidy. Postgres refuses to copy a template that
     * another session is connected to, so a pool left open here would fail the first file's
     * `CREATE DATABASE ... TEMPLATE` with an error about the source being in use - and it would
     * fail whichever file happened to run first, which reads like a bad test.
     */
    await template.end();
  }

  project.provide('pgAdminUri', adminUri);

  return async () => {
    await container.stop();
  };
}
