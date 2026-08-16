/**
 * A disposable Postgres for handler tests.
 *
 * Deliberately NOT the development database. AGENTS.md non-negotiable 3: never run a
 * destructive command against a database you have not confirmed is disposable,
 * because a dev database accumulates real usage data between sessions and is not
 * fixtures. A container is disposable by construction.
 *
 * Running the real migrations rather than a hand-written CREATE TABLE is the point:
 * these tests exercise the actual constraints, so a migration that fails to carry an
 * invariant fails the suite rather than passing against a convenient schema. They now
 * run once per RUN rather than once per file - see `global-setup.ts` - and the schema
 * a file gets is a copy of that one.
 */

import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { inject } from 'vitest';
import type pg from 'pg';
import { accessContextOf, type AccessContext } from '../policy/context.ts';
import { createDb, createPool, type Db } from '../db/client.ts';
import { channels, clubMemberships, clubs, users } from '../db/schema.ts';
import { CONTAINER_STARTUP_TIMEOUT_MS, TEMPLATE_DATABASE, withDatabase } from './containers.ts';

export type TestDb = {
  db: Db;
  pool: pg.Pool;
  stop: () => Promise<void>;
};

/**
 * Distinct within a worker, which is all it has to be.
 *
 * The pid is in the name because `fileParallelism` is a configuration setting rather than a law:
 * turn it on and two workers allocate from two counters that both start at one.
 */
let databaseCounter = 0;

/**
 * A database of this file's own, copied from the migrated template.
 *
 * > **This started a container of its own until 2026-08-16**, which is what made the suite start
 * > 36 postmasters per run and lose one to Docker's port-bind ceiling every so often. The
 * > container moved to `global-setup.ts`; a file's isolation did not change, because a database
 * > per file isolates exactly what a container per file did - no shared channel row, sequence or
 * > cursor - and the postmaster was never the part being isolated.
 *
 * The signature is deliberately unchanged, so no test file knew about this.
 *
 * **The database is not dropped on `stop`.** The container goes at the end of the run and takes
 * every copy with it, and a drop would have to survive a hung file to be worth anything - which
 * is exactly the case where `afterAll` does not run.
 */
export async function startTestDb(): Promise<TestDb> {
  const adminUri = inject('pgAdminUri');
  databaseCounter += 1;
  const database = `clubchat_test_${process.pid}_${databaseCounter}`;

  const admin = createPool(adminUri);
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${TEMPLATE_DATABASE}"`);
  } finally {
    await admin.end();
  }

  const pool = createPool(withDatabase(adminUri, database));

  return {
    db: createDb(pool),
    pool,
    stop: async () => {
      await pool.end();
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
    // Same contention, same reasoning as `CONTAINER_STARTUP_TIMEOUT_MS` above.
    .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
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
      // The member link, distinct from the admin one - the whole of ADR-0025 is which string
      // was redeemed, so a fixture where they matched could not express the difference.
      memberInviteToken: `member-tok-${ownerId}`,
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

/**
 * A viewer who has cleared nothing and pinned nothing.
 *
 * The reads that return messages take an access context so they can apply that viewer's own
 * clear floor - see `visibleToViewer`. Most tests are asserting what a channel CONTAINS rather
 * than what one person can see of it, and this says so in one word instead of a context literal
 * in fourteen places. A test that actually cares about the floor builds its own.
 */
export function anyViewer(userId: string = crypto.randomUUID()): AccessContext {
  return accessContextOf({ userId });
}
