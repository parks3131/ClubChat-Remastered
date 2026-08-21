/**
 * The load test, at ten times projected peak.
 *
 * > **Everything this project has ever measured is a laptop against a database on the same
 * > machine, and every cost recorded in `SPEC/TECH/18` is a round-trip COUNT read from code
 * > rather than a measurement.** A statement counter answers "how many"; it never answers "how
 * > fast", and it cannot answer "what happens when three hundred people send at once". A pilot
 * > club will be the first real load this system sees and it must not also be the first measured
 * > one. [The roadmap](../../../../SPEC/TECH/20-road-to-the-first-club.md) milestone 3.
 *
 * **The two numbers are not chosen here.** `SPEC/TECH/16-build-phases.md` has named them since
 * the phase plan was written: the per-channel `last_seq` row lock under concurrent sends, and the
 * access-context query now that it carries DM threads and blocks. This measures those two.
 *
 * **Deliberately not a test**, for the same reason `gate:surface` is not one. It takes minutes,
 * its output is numbers rather than a verdict, and a threshold that would make it pass or fail is
 * a property of the machine it ran on. `npm run load:test`.
 *
 * **It starts its own Postgres and takes nothing shared.** A load test pointed at the development
 * database would compete with the founder's phone for the same rows, and AGENTS.md section 2.5 is
 * explicit that the running stack is not ours by default. A container is disposable by
 * construction, which is also non-negotiable 3.
 *
 * ## What "ten times projected peak" means here
 *
 * `SPEC/TECH/00-overview.md` sizes the system at ~50 message writes per second at peak and 3,000
 * concurrent connections. Ten times the write peak is **500 sends per second**, and that is the
 * number both measurements below are held against.
 *
 * The connection count is deliberately NOT reproduced: 30,000 sockets is a property of the
 * gateway and the host's file descriptors rather than of these two queries, and pretending a
 * laptop measured it would be exactly the dishonesty this file exists to end. What is measured is
 * what a laptop can measure honestly, and what is not is said so.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, createPool, type Db } from '../db/client.ts';
import { channels, clubs, clubMemberships, eboardChannels, eboardMemberships, races, raceMemberships, users } from '../db/schema.ts';
import { appendMessage } from '../domain/append-message.ts';
import { loadAccessContext } from '../policy/context.ts';
import { seedRoster } from '../test/large-fixture.ts';

/** Ten times the ~50 writes/sec peak in `SPEC/TECH/00-overview.md`. */
const TARGET_SENDS_PER_SECOND = 500;

/**
 * How many sends to push through one channel.
 *
 * Two thousand at 500/sec is four seconds of sustained peak, which is long enough to be a rate
 * rather than a burst absorbed by an empty pool and short enough to run in a coffee break.
 */
const SEND_COUNT = 2_000;

/**
 * How many of those are in flight at once.
 *
 * Matched to the pool's `max: 20` rather than set higher, because a client that asks for more
 * connections than the pool holds is measuring the pool's queue instead of the row lock. Twenty
 * concurrent senders into one channel is already far more contention than a 300 member club
 * produces, since they all serialize behind the same `UPDATE channels` either way.
 */
const SEND_CONCURRENCY = 20;

/** Access-context loads, and how many at once. Same reasoning as above. */
const CONTEXT_LOADS = 3_000;
const CONTEXT_CONCURRENCY = 20;

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'migrations',
);

/** Percentiles, from a sorted copy. Nearest-rank, which needs no interpolation to explain. */
function percentile(samplesMs: readonly number[], p: number): number {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

function report(label: string, samplesMs: readonly number[], wallMs: number): void {
  const rate = (samplesMs.length / wallMs) * 1000;
  console.log(`\n  ${label}`);
  console.log(`    operations      ${samplesMs.length}`);
  console.log(`    wall clock      ${wallMs.toFixed(0)} ms`);
  console.log(`    throughput      ${rate.toFixed(0)} / sec`);
  console.log(`    p50             ${percentile(samplesMs, 50).toFixed(2)} ms`);
  console.log(`    p95             ${percentile(samplesMs, 95).toFixed(2)} ms`);
  console.log(`    p99             ${percentile(samplesMs, 99).toFixed(2)} ms`);
  console.log(`    max             ${percentile(samplesMs, 100).toFixed(2)} ms`);
}

/**
 * Run `total` operations with at most `concurrency` in flight, timing each one.
 *
 * Workers pulling from a shared counter rather than `Promise.all` over every operation at once:
 * the second shape queues every request inside the pool and measures the queue, which is how a
 * load test comes to report a p99 of several seconds and mean nothing by it.
 */
async function drive(
  total: number,
  concurrency: number,
  operation: (index: number) => Promise<unknown>,
): Promise<{ samplesMs: number[]; wallMs: number }> {
  const samplesMs: number[] = [];
  let next = 0;
  const started = performance.now();

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= total) return;
      const at = performance.now();
      await operation(index);
      samplesMs.push(performance.now() - at);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { samplesMs, wallMs: performance.now() - started };
}

/**
 * One club, one channel, 300 members.
 *
 * The roster is the same one `large-fixture.ts` builds, imported rather than restated so the two
 * cannot drift into measuring different things.
 */
async function seedChannel(db: Db): Promise<{ channelId: string; senderIds: string[] }> {
  const ownerId = crypto.randomUUID();
  await db.insert(users).values({
    id: ownerId,
    name: 'Load Owner',
    email: `load-owner-${ownerId.slice(0, 8)}@test.invalid`,
  });

  const clubRows = await db
    .insert(clubs)
    .values({
      name: 'Load Test Club',
      inviteToken: `tok-${ownerId}`,
      memberInviteToken: `member-tok-${ownerId}`,
    })
    .returning();
  const clubId = clubRows[0]!.id;
  await db.insert(clubMemberships).values({ clubId, userId: ownerId, role: 'owner' });

  const channelRows = await db
    .insert(channels)
    .values({ clubId, scope: 'club', scopeId: clubId })
    .returning();

  const memberIds = await seedRoster(db, clubId, 300);
  return { channelId: channelRows[0]!.id, senderIds: [ownerId, ...memberIds] };
}

/**
 * One account with a large access context, which is the thing being measured.
 *
 * The query is a nine-branch UNION over club, eboard, race, DM, block, pin and clear rows, and
 * every branch is keyed on the same user. A context of one club exercises one branch against one
 * row and tells you nothing, so this builds an account that is genuinely busy: in 20 clubs, on 5
 * eboards, on 10 race rosters, holding 40 DM threads and 20 blocks. That is a founder-shaped
 * account rather than a typical one, which is the right side to measure from.
 */
async function seedHeavyContext(db: Db): Promise<string> {
  const heavyId = crypto.randomUUID();
  await db.insert(users).values({
    id: heavyId,
    name: 'Busy Member',
    email: `busy-${heavyId.slice(0, 8)}@test.invalid`,
  });

  for (let i = 0; i < 20; i += 1) {
    const seed = crypto.randomUUID();
    const clubRows = await db
      .insert(clubs)
      .values({
        name: `Context Club ${i}`,
        inviteToken: `ctx-tok-${seed}`,
        memberInviteToken: `ctx-member-tok-${seed}`,
      })
      .returning();
    const clubId = clubRows[0]!.id;
    await db.insert(clubMemberships).values({ clubId, userId: heavyId, role: 'member' });
    await db.insert(channels).values({ clubId, scope: 'club', scopeId: clubId });

    if (i < 5) {
      const eboardRows = await db.insert(eboardChannels).values({ clubId }).returning();
      await db
        .insert(eboardMemberships)
        .values({ eboardId: eboardRows[0]!.id, userId: heavyId });
    }
    if (i < 10) {
      const raceRows = await db
        .insert(races)
        .values({ clubId, name: `Context Race ${i}` })
        .returning();
      await db.insert(raceMemberships).values({ raceId: raceRows[0]!.id, userId: heavyId });
    }
  }

  // Sixty counterparties: forty for DM threads, twenty to be blocked.
  const others: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    const id = crypto.randomUUID();
    others.push(id);
    await db.insert(users).values({
      id,
      name: `Counterparty ${i}`,
      email: `counter-${i}-${id.slice(0, 8)}@test.invalid`,
    });
  }

  for (let i = 0; i < 40; i += 1) {
    // `dm_conversations_canonical_order` is a check constraint, not a convention: the pair has
    // to be stored sorted or the insert is refused.
    const [a, b] = [heavyId, others[i]!].sort();
    const dmRows = await db.execute<{ id: string }>(
      sql`insert into dm_conversations (user_a, user_b) values (${a}, ${b}) returning id`,
    );
    await db.insert(channels).values({ scope: 'dm', scopeId: dmRows.rows[0]!.id });
  }

  for (let i = 40; i < 60; i += 1) {
    await db.execute(
      sql`insert into member_blocks (blocker_id, blocked_id) values (${heavyId}, ${others[i]!})`,
    );
  }

  return heavyId;
}

async function main(): Promise<void> {
  console.log('Starting Postgres 17 with pg_stat_statements preloaded...');
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine')
    .withStartupTimeout(120_000)
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

  const pool = createPool(container.getConnectionUri());
  const db = createDb(pool);

  try {
    await migrate(db, { migrationsFolder });
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');

    console.log('Seeding a 300 member club and a busy account...');
    const { channelId, senderIds } = await seedChannel(db);
    const heavyUserId = await seedHeavyContext(db);

    // Reset here rather than at startup, so the seed's own thousands of inserts do not drown
    // the statements actually under measurement.
    await pool.query('SELECT pg_stat_statements_reset()');

    console.log(
      `\n=== 1. The per-channel last_seq row lock, ${SEND_COUNT} sends into ONE channel ===`,
    );
    console.log(
      `    ${SEND_CONCURRENCY} concurrent senders. Every one takes the same row lock, held to commit.`,
    );
    const sends = await drive(SEND_COUNT, SEND_CONCURRENCY, (index) =>
      appendMessage(db, {
        channelId,
        senderId: senderIds[index % senderIds.length]!,
        clientMsgId: crypto.randomUUID(),
        type: 'text',
        body: `load test message ${index}`,
      }),
    );
    report(`appendMessage into one channel`, sends.samplesMs, sends.wallMs);

    /*
     * **Gaplessness under contention, which is the property the lock exists for.**
     *
     * A throughput number says nothing about correctness, and the whole reason `last_seq` is a
     * row lock rather than a Postgres SEQUENCE is that a sequence leaks gaps on rollback - and a
     * phantom gap sends every client syncing forever after a hole that does not exist. So the
     * measurement is only worth reporting alongside the assertion that what it produced is
     * still a gapless log.
     */
    const seqCheck = await db.execute<{ total: string; distinct: string; max: number }>(sql`
      SELECT count(*)::text AS total, count(DISTINCT seq)::text AS distinct, max(seq) AS max
        FROM messages WHERE channel_id = ${channelId}
    `);
    const row = seqCheck.rows[0]!;
    const gapless =
      Number(row.total) === SEND_COUNT &&
      Number(row.distinct) === SEND_COUNT &&
      row.max === SEND_COUNT;
    console.log(
      `    gapless         ${gapless ? 'yes' : 'NO'}  (${row.total} rows, ${row.distinct} distinct seqs, max ${row.max})`,
    );
    if (!gapless) throw new Error('the channel log is not gapless after concurrent sends');

    console.log(`\n=== 2. The access-context query, ${CONTEXT_LOADS} loads ===`);
    console.log('    One account in 20 clubs, 5 eboards, 10 races, 40 DM threads, 20 blocks.');
    const contexts = await drive(CONTEXT_LOADS, CONTEXT_CONCURRENCY, () =>
      loadAccessContext(db, heavyUserId),
    );
    report('loadAccessContext for a busy account', contexts.samplesMs, contexts.wallMs);

    console.log('\n=== What the database says it spent its time on ===');
    const top = await pool.query<{
      calls: string;
      total_exec_time: number;
      mean_exec_time: number;
      query: string;
    }>(
      `SELECT calls, total_exec_time, mean_exec_time, query
         FROM pg_stat_statements
        WHERE query NOT LIKE '%pg_stat_statements%'
        ORDER BY total_exec_time DESC
        LIMIT 8`,
    );
    for (const stat of top.rows) {
      console.log(
        `    ${stat.total_exec_time.toFixed(0).padStart(7)} ms total  ${stat.mean_exec_time
          .toFixed(3)
          .padStart(7)} ms mean  ${String(stat.calls).padStart(6)} calls  ${stat.query
          .replace(/\s+/g, ' ')
          .slice(0, 90)}`,
      );
    }

    const sendRate = (sends.samplesMs.length / sends.wallMs) * 1000;
    const contextRate = (contexts.samplesMs.length / contexts.wallMs) * 1000;
    console.log('\n=== Headroom against ten times projected peak ===');
    console.log(`    target                 ${TARGET_SENDS_PER_SECOND} sends / sec`);
    console.log(
      `    one channel sustained  ${sendRate.toFixed(0)} / sec  (${(sendRate / TARGET_SENDS_PER_SECOND).toFixed(1)}x)`,
    );
    console.log(
      `    access contexts        ${contextRate.toFixed(0)} / sec  (${(contextRate / TARGET_SENDS_PER_SECOND).toFixed(1)}x)`,
    );
    console.log(
      '\n    Measured on one machine with Postgres in a container beside it, so a network\n' +
        '    boundary between the app and the database is NOT in these numbers. Production is\n' +
        '    Fly.io against Neon; every round trip above gains that latency, which is why the\n' +
        '    statement COUNTS in SPEC/TECH/18 matter as much as these rates.\n',
    );
  } finally {
    await pool.end();
    await container.stop();
  }
}

await main();
