/**
 * A disposable Postgres for handler tests.
 *
 * Deliberately NOT the development database. AGENTS.md non-negotiable 3: never run a
 * destructive command against a database you have not confirmed is disposable,
 * because a dev database accumulates real usage data between sessions and is not
 * fixtures. A container is disposable by construction.
 *
 * Running the real migrations here rather than a hand-written CREATE TABLE is the
 * point: these tests exercise the actual constraints, so a migration that fails to
 * carry an invariant fails the suite rather than passing against a convenient
 * schema.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';
import { createDb, createPool, type Db } from '../db/client.ts';
import { channels, clubMemberships, clubs, users } from '../db/schema.ts';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'migrations',
);

export type TestDb = {
  db: Db;
  pool: pg.Pool;
  stop: () => Promise<void>;
};

export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:17-alpine',
  ).start();

  const pool = createPool(container.getConnectionUri());
  const db = createDb(pool);
  await migrate(db, { migrationsFolder });

  return {
    db,
    pool,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

export type TestRedis = {
  url: string;
  stop: () => Promise<void>;
};

/**
 * A disposable Redis.
 *
 * Also not the development instance. Redis holds no source of truth, so wiping it is
 * survivable - but a test that flushed the dev instance would still cost a developer
 * their live realtime state mid-session for no reason.
 */
export async function startTestRedis(): Promise<TestRedis> {
  const container: StartedTestContainer = await new GenericContainer('redis:8-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: () => container.stop().then(() => undefined),
  };
}

let counter = 0;
const nextSuffix = () => {
  counter += 1;
  return counter;
};

/**
 * Create a club the way the real bootstrap does, in the order the spec requires.
 *
 * The order is load-bearing and is the v1 lesson restated: create the channel BEFORE
 * adding the first member, or the first system message is silently swallowed.
 */
export async function seedClub(
  db: Db,
  opts: { ownerName?: string } = {},
): Promise<{ clubId: string; channelId: string; ownerId: string }> {
  const n = nextSuffix();
  const ownerId = crypto.randomUUID();

  await db.insert(users).values({
    id: ownerId,
    name: opts.ownerName ?? `Owner ${n}`,
    email: `owner-${n}-${ownerId.slice(0, 8)}@test.invalid`,
  });

  const clubRows = await db
    .insert(clubs)
    .values({
      name: `Test Club ${n}`,
      sport: 'running',
      inviteToken: `tok-${ownerId}`,
    })
    .returning();
  const club = clubRows[0];
  if (!club) throw new Error('club insert returned no row');

  await db.insert(clubMemberships).values({
    clubId: club.id,
    userId: ownerId,
    role: 'owner',
  });

  const channelRows = await db
    .insert(channels)
    .values({ clubId: club.id, scope: 'club', scopeId: club.id })
    .returning();
  const channel = channelRows[0];
  if (!channel) throw new Error('channel insert returned no row');

  return { clubId: club.id, channelId: channel.id, ownerId };
}

export async function seedUser(db: Db, name = 'Member'): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    name,
    email: `user-${id.slice(0, 8)}@test.invalid`,
  });
  return id;
}
