/**
 * The push that nobody was holding on to, and the publish that a retry skipped.
 *
 * Three defects, one file, all in the worker's effect handlers:
 *
 *  1. **A deferred push lived in a `setTimeout`.** The drain stamps `processed_at` the moment a
 *     handler returns, so the outbox row closed eight seconds before the push was evaluated. A
 *     transient failure inside that window threw into a `void` and left one log line; a deploy
 *     killed the timer outright. For a direct message and an ordinary chat message, which write
 *     no notification row by design, nothing anywhere recorded that a push had been attempted.
 *  2. **Two report handlers awaited the provider inline**, inside the drain's transaction, so a
 *     stalled Expo call froze the whole outbox rather than one push.
 *  3. **A deduplicated system message was treated as an already-published one.** Append and
 *     publish are two statements and are not atomic, so a crash between them meant the retry
 *     skipped the fan-out forever and the card only surfaced on the next sync.
 *
 * These assert on the outbox row, not on a timer, because the row is the whole fix: the eight
 * seconds are now counted in Postgres where a restart cannot forget them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createClub } from '../domain/create-club.ts';
import { drainOnce, MAX_ATTEMPTS } from '../worker/drain.ts';
import { registerDevice } from '../push/dispatch.ts';
import { RecordingPushSender, type PushMessage, type PushReceipt } from '../push/sender.ts';
import { channelTopic } from '../bus/redis.ts';
import { clubMemberships, users } from '../db/schema.ts';
import { startTestDb, type TestDb } from './harness.ts';
import type { EffectDeps } from '../worker/effects.ts';

let h: TestDb;
let push: RecordingPushSender;
let published: Array<{ topic: string; payload: string }>;
let captured: Array<{ error: unknown; where: string; context?: Record<string, unknown> }>;
let deps: EffectDeps;

/** A sender that refuses, which is what a provider having a bad minute looks like from here. */
class FailingPushSender {
  calls = 0;
  async send(_messages: readonly PushMessage[]): Promise<PushReceipt[]> {
    this.calls += 1;
    throw new Error('expo unreachable');
  }
}

beforeAll(async () => {
  h = await startTestDb();
});
afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(
    sql`TRUNCATE notifications, push_deliveries, devices, outbox RESTART IDENTITY CASCADE`,
  );
  push = new RecordingPushSender();
  published = [];
  captured = [];
  deps = {
    db: h.db,
    redis: {
      publish: async (topic: string, payload: string) => {
        published.push({ topic, payload });
        return 1;
      },
    } as never,
    push,
    log: () => undefined,
    monitor: {
      capture: (error, where, context) => captured.push({ error, where, ...(context ? { context } : {}) }),
      flush: async () => undefined,
    },
    // Zero, so the deferred row is claimable on the next pass instead of in eight real seconds.
    // The production path is otherwise identical - which is the point, since the defect this
    // file is about was a branch that only production ever took.
    pushDeferralMs: 0,
  };
});

type Fixture = {
  clubId: string;
  channelId: string;
  ownerId: string;
  memberId: string;
};

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db
    .insert(users)
    .values({ id, name, email: `${name}-${id.slice(0, 8)}@test.invalid` });
  return id;
}

async function setup(): Promise<Fixture> {
  const ownerId = await makeUser('DeferOwner');
  const memberId = await makeUser('DeferMember');
  const club = await createClub(h.db, { name: 'Deferral Running Club', creatorId: ownerId });
  await h.db
    .insert(clubMemberships)
    .values({ clubId: club.clubId, userId: memberId, role: 'member' });
  return { clubId: club.clubId, channelId: club.mainChannelId, ownerId, memberId };
}

/** Every deferred push row currently waiting, with the columns that say whether it is alive. */
async function deferredRows(): Promise<
  Array<{ id: string; attempts: number; processed: boolean; due: boolean; payload: Record<string, unknown> }>
> {
  const rows = await h.db.execute<{
    id: string;
    attempts: number;
    processed: boolean;
    due: boolean;
    payload: Record<string, unknown>;
  }>(sql`
    SELECT id::text AS id,
           attempts,
           processed_at IS NOT NULL AS processed,
           next_attempt_at <= now() AS due,
           payload
      FROM outbox
     WHERE event_type = 'push.deferred'
     ORDER BY id
  `);
  return rows.rows;
}

describe('a deferred push is a row, not a timer', () => {
  it('outlives the event that scheduled it, so a deploy cannot destroy the wait', async () => {
    const f = await setup();
    await registerDevice(h.db, {
      // The Owner reviews reports in a club channel; the member below files this one and is
      // dropped from its audience, which is why the device belongs to the Owner.
      userId: f.ownerId,
      pushToken: 'ExponentPushToken[defer-survives]',
      platform: 'ios',
    });

    // The report is the immediate case, but any push does: file one by hand so this test needs
    // no HTTP surface.
    await h.db.execute(sql`
      INSERT INTO outbox (partition_key, event_type, payload)
      VALUES (${f.channelId}, 'message.reported', ${JSON.stringify({
        channelId: f.channelId,
        seq: 1,
        reporterId: f.memberId,
      })}::jsonb)
    `);

    await drainOnce(h.db, deps);

    // The causing event is closed - which is exactly why the wait cannot be held in memory.
    const source = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM outbox
       WHERE event_type = 'message.reported' AND processed_at IS NOT NULL
    `);
    expect(Number(source.rows[0]?.n), 'the causing event was not processed').toBe(1);

    const waiting = await deferredRows();
    expect(waiting, 'the push evaluation left nothing durable behind').toHaveLength(1);
    expect(waiting[0]?.processed).toBe(false);
    expect(waiting[0]?.payload['type']).toBe('message_reported');

    // Nothing reached the provider from inside the drain's transaction.
    expect(push.sent, 'the provider was called inline, inside the drain transaction').toHaveLength(
      0,
    );

    // A second pass is the eight seconds elapsing.
    await drainOnce(h.db, deps);
    expect(push.sent.map((m) => m.token)).toEqual(['ExponentPushToken[defer-survives]']);
    expect((await deferredRows())[0]?.processed).toBe(true);
  });

  it('retries a push whose evaluation fails, instead of losing it into a void', async () => {
    const f = await setup();
    await registerDevice(h.db, {
      userId: f.ownerId,
      pushToken: 'ExponentPushToken[defer-retries]',
      platform: 'ios',
    });
    await h.db.execute(sql`
      INSERT INTO outbox (partition_key, event_type, payload)
      VALUES (${f.channelId}, 'message.reported', ${JSON.stringify({
        channelId: f.channelId,
        seq: 1,
        reporterId: f.memberId,
      })}::jsonb)
    `);

    await drainOnce(h.db, deps);

    // The provider is down for this pass.
    const failing = new FailingPushSender();
    await drainOnce(h.db, { ...deps, push: failing as never });
    expect(failing.calls, 'the deferred push never ran').toBe(1);

    const afterFailure = await deferredRows();
    expect(afterFailure[0]?.processed, 'a failed push was marked done').toBe(false);
    expect(afterFailure[0]?.attempts, 'a failed push was not counted as an attempt').toBe(1);

    // The provider recovers. The backoff has parked it for a few seconds, which a real worker
    // waits out; bring it forward rather than sleeping.
    await h.db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE event_type = 'push.deferred'`);
    await drainOnce(h.db, deps);

    expect(push.sent.map((m) => m.token), 'the retry never reached the phone').toEqual([
      'ExponentPushToken[defer-retries]',
    ]);
    expect((await deferredRows())[0]?.processed).toBe(true);
  });

  it('alarms with the notification type and the recipient count when it finally parks', async () => {
    const f = await setup();
    await registerDevice(h.db, {
      userId: f.ownerId,
      pushToken: 'ExponentPushToken[defer-parks]',
      platform: 'ios',
    });
    await h.db.execute(sql`
      INSERT INTO outbox (partition_key, event_type, payload)
      VALUES (${f.channelId}, 'message.reported', ${JSON.stringify({
        channelId: f.channelId,
        seq: 1,
        reporterId: f.memberId,
      })}::jsonb)
    `);
    await drainOnce(h.db, deps);

    // Spend the budget rather than living through it: the schedule covers over an hour.
    await h.db.execute(sql`
      UPDATE outbox
         SET attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now()
       WHERE event_type = 'push.deferred'
    `);
    const parkedRow = (await deferredRows())[0];
    await drainOnce(h.db, { ...deps, push: new FailingPushSender() as never });

    const alarm = captured.find((c) => c.where === 'worker.outbox.parked');
    expect(alarm, 'a push was lost with no alarm at all').toBeDefined();
    expect(alarm?.context?.['eventId']).toBe(Number(parkedRow?.id));
    // The alarm has to name what was lost. "push.deferred #41 failed" is not an incident anybody
    // can act on; the type and the size of the audience are.
    const message = alarm?.error instanceof Error ? alarm.error.message : String(alarm?.error);
    expect(message).toContain('message_reported');
    expect(message).toContain('1 recipient');
  });
});

describe('a redelivered system message is published again', () => {
  it('publishes on a deduplicated append, because append and publish are not atomic', async () => {
    const f = await setup();

    await drainOnce(h.db, deps);
    const topic = channelTopic(f.channelId);
    expect(published.filter((p) => p.topic === topic), 'the club line was never published').toHaveLength(1);

    // Redelivery, exactly as a consumer restart produces it. The message row already exists, so
    // `appendMessage` deduplicates - and the publish that a crash may have skipped last time must
    // happen now. The client's own `local_max + 1` rule drops a duplicate `msg.new`
    // (SPEC/TECH/03), so publishing twice is strictly cheaper than publishing never.
    await h.db.execute(sql`UPDATE outbox SET processed_at = NULL WHERE event_type = 'club.created'`);
    await drainOnce(h.db, deps);

    expect(
      published.filter((p) => p.topic === topic),
      'a deduplicated append skipped its publish, so a crash between the two loses the fan-out forever',
    ).toHaveLength(2);

    // And the message itself is still written once. Publishing twice must not append twice.
    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM messages WHERE channel_id = ${f.channelId}
    `);
    expect(Number(rows.rows[0]?.n), 'the redelivery appended a second copy').toBe(1);
  });
});
