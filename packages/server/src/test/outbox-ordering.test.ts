/**
 * Per-partition ordering, and the attempt that has to be counted before the handler runs.
 *
 * > **`TECH/04` promised ordering within a partition and the claim query did not implement it.**
 * > The claim was `WHERE processed_at IS NULL AND attempts < MAX AND next_attempt_at <= now()
 * > ORDER BY id`, with no partition gate at all. A failing event is pushed two and a half seconds
 * > into the future by the backoff, so event N+1 in the SAME channel is claimed on the very next
 * > 250ms tick and overtakes it - and a parked row is skipped forever, so its whole partition
 * > sails past it. The index the schema declares for this claim, `outbox_unprocessed` on
 * > `(partition_key, id)`, was never used by the query that named it.
 *
 * The second half is about a failure the retry column could not see. The batch ran inside ONE
 * transaction while every handler's own writes went through a different pool connection and
 * committed immediately, and `attempts` was incremented only in the catch. A handler that KILLS
 * the process - an out-of-memory in variant derivation, say - therefore never counted an attempt,
 * looped forever, and never reached the floor that fires the park alarm.
 *
 * These assert on the two properties that must hold for that not to happen again: nothing in a
 * partition runs ahead of an unresolved earlier event, and the attempt is durable before the
 * handler is entered.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drainOnce, MAX_ATTEMPTS } from '../worker/drain.ts';
import type { EffectDeps } from '../worker/effects.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;

const silent = () => undefined;

/**
 * Deliberately no `media` store, which is what makes `media.uploaded` a handler that SUCCEEDS
 * cheaply: it logs that there is no store configured and returns. Every other cheap event type
 * either fails or needs a club, a channel and a roster behind it.
 */
function deps(overrides: Partial<EffectDeps> = {}): EffectDeps {
  return {
    db: h.db,
    redis: { publish: async () => 1 } as never,
    push: new RecordingPushSender(),
    log: silent,
    ...overrides,
  };
}

beforeAll(async () => {
  h = await startTestDb();
}, 120_000);
afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE outbox RESTART IDENTITY CASCADE`);
});

/** An event nothing handles, so it fails every time it is dispatched. */
async function enqueueFailing(partitionKey: string): Promise<number> {
  const rows = await h.db.execute<{ id: number }>(sql`
    INSERT INTO outbox (partition_key, event_type, payload)
    VALUES (${partitionKey}, 'unhandled.type', '{}'::jsonb)
    RETURNING id
  `);
  return Number(rows.rows[0]!.id);
}

/** An event that succeeds without any domain rows behind it. See `deps`. */
async function enqueueSucceeding(partitionKey: string): Promise<number> {
  const rows = await h.db.execute<{ id: number }>(sql`
    INSERT INTO outbox (partition_key, event_type, payload)
    VALUES (${partitionKey}, 'media.uploaded', ${JSON.stringify({ mediaId: crypto.randomUUID() })}::jsonb)
    RETURNING id
  `);
  return Number(rows.rows[0]!.id);
}

async function rowState(id: number) {
  const rows = await h.db.execute<{
    attempts: number;
    processed_at: string | null;
    last_error: string | null;
  }>(sql`SELECT attempts, processed_at, last_error FROM outbox WHERE id = ${id}`);
  const row = rows.rows[0]!;
  return {
    attempts: Number(row.attempts),
    processedAt: row.processed_at,
    lastError: row.last_error,
  };
}

/** Read `attempts` on its own connection, which is the only way to see a COMMITTED value. */
async function committedAttempts(id: number): Promise<number> {
  const rows = await h.db.execute<{ attempts: number }>(
    sql`SELECT attempts FROM outbox WHERE id = ${id}`,
  );
  return Number(rows.rows[0]!.attempts);
}

/** Make a backing-off row claimable again, standing in for the passage of time. */
async function timeTravel(id: number): Promise<void> {
  await h.db.execute(
    sql`UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE id = ${id}`,
  );
}

// ===========================================================================
// Ordering within a partition
// ===========================================================================

describe('an event never overtakes an unresolved earlier event in its partition', () => {
  it('holds inside one batch, where both events are claimed together', async () => {
    /*
     * Both rows are ready and both are claimed by the same 50-row batch. The first fails; the
     * second must not be dispatched behind it in the same pass, because "X was added to the
     * club" arriving before the event that caused it is exactly the symptom TECH/03 forbids.
     */
    const first = await enqueueFailing('channel-a');
    const second = await enqueueFailing('channel-a');

    const result = await drainOnce(h.db, deps());

    expect(result.failed, 'more than one event in the partition was dispatched').toBe(1);
    expect((await rowState(first)).attempts).toBe(1);

    const later = await rowState(second);
    expect(later.attempts, 'the later event was dispatched while the earlier one was failing').toBe(
      0,
    );
    expect(later.lastError, 'the later event was dispatched out of order').toBeNull();
  });

  it('holds across ticks, where the earlier event is backing off', async () => {
    /*
     * The reported defect, exactly. The backoff pushes the failing row 2.5 to 5 seconds into the
     * future; the next 250ms tick then finds the newer row perfectly claimable and runs it.
     */
    const first = await enqueueFailing('channel-a');
    await drainOnce(h.db, deps());
    expect((await rowState(first)).attempts).toBe(1);

    const second = await enqueueFailing('channel-a');
    const result = await drainOnce(h.db, deps());

    expect(result.failed, 'the newer event overtook the one backing off').toBe(0);
    expect((await rowState(second)).attempts, 'the newer event was claimed').toBe(0);
  });

  it('holds when the later event would otherwise have succeeded', async () => {
    // The dangerous shape: the blocked event is one that WORKS, so nothing downstream reports
    // that it ran early. Only the order is wrong, and only for that channel.
    const first = await enqueueFailing('channel-a');
    const second = await enqueueSucceeding('channel-a');

    await drainOnce(h.db, deps());

    expect((await rowState(second)).processedAt, 'the effect ran ahead of the event before it').toBe(
      null,
    );
  });

  it('is scoped to the partition, so one bad channel does not stall the rest', async () => {
    // The gate must be per partition and nothing wider, or a single failing provider would
    // freeze every club in the system behind it.
    await enqueueFailing('channel-a');
    const elsewhere = await enqueueSucceeding('channel-b');

    const result = await drainOnce(h.db, deps());

    expect(result.failed).toBe(1);
    expect(result.processed, 'an unrelated partition was held behind a failure').toBe(1);
    expect((await rowState(elsewhere)).processedAt).not.toBeNull();
  });
});

// ===========================================================================
// A parked head must not block its partition forever
// ===========================================================================

describe('a parked event releases its partition', () => {
  it('lets the rest of the partition through once the head has parked', async () => {
    /*
     * The starvation the ordering gate would otherwise create. A parked event will NEVER run -
     * that is what parking means - so holding its partition behind it stops the channel's
     * notifications permanently rather than losing one of them. ADR-0006 already chose the other
     * answer for the Kafka era ("a poisoned event goes to the DLQ rather than blocking its
     * partition forever"); this is the same choice, one layer down.
     */
    const head = await enqueueFailing('channel-a');
    const behind = await enqueueSucceeding('channel-a');

    for (let n = 0; n < MAX_ATTEMPTS; n += 1) {
      await timeTravel(head);
      await drainOnce(h.db, deps());
    }

    expect((await rowState(head)).attempts, 'the head did not park').toBe(MAX_ATTEMPTS);
    expect(
      (await rowState(behind)).processedAt,
      'the event behind the head ran while the head was still being retried',
    ).toBeNull();

    const after = await drainOnce(h.db, deps());
    expect(after.processed, 'the partition stayed blocked behind a parked event').toBe(1);
    expect((await rowState(behind)).processedAt).not.toBeNull();
  });
});

// ===========================================================================
// The attempt is counted before the handler runs
// ===========================================================================

describe('an attempt is durable before its handler is entered', () => {
  it('commits the increment at claim time, so a handler that kills the process still counts', async () => {
    /*
     * The failure this closes: `attempts` was incremented only in the catch, so a handler that
     * takes the whole process down with it - an out-of-memory deriving variants for a large image
     * - is retried forever. It never counts towards MAX_ATTEMPTS, so it never parks, so the alarm
     * that exists for exactly this never fires. The batch's own transaction rolled the increment
     * back on the way out; the handler's writes, on a different pool connection, did not.
     *
     * Observed from INSIDE the handler, on another connection, because that is the only vantage
     * point that distinguishes "committed before dispatch" from "committed afterwards". A
     * transaction's own uncommitted increment is invisible there by construction.
     */
    const id = await enqueueSucceeding('channel-a');

    let probe: Promise<number> | null = null;
    const result = await drainOnce(
      h.db,
      deps({
        log: (_level, message) => {
          if (message.includes('no store configured')) probe = committedAttempts(id);
        },
      }),
    );

    expect(result.processed, 'the handler never ran, so the probe proves nothing').toBe(1);
    expect(probe, 'the handler never ran, so the probe proves nothing').not.toBeNull();
    expect(
      await probe!,
      'the attempt was not durable when the handler ran, so a crash inside it costs nothing',
    ).toBe(1);
    expect((await rowState(id)).processedAt).not.toBeNull();
  });
});
