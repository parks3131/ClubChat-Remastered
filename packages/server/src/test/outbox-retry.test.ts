/**
 * The retry policy: when a failed event is tried again, and when it stops being tried.
 *
 * > **This exists because five attempts spanned about 1.25 seconds.** The drain polls every
 * > 250ms and re-claimed a failing row on every tick, so the entire budget was spent before
 * > any real outage had begun to recover. `TECH/04` said "failures retry with backoff" and
 * > there was no backoff of any kind - the doc described a policy the code did not have, which
 * > is the worst way to be wrong about one, because nobody rereads the code to check.
 *
 * The assertions here are about **time**, not about counts. A count without a schedule says
 * nothing: eight attempts over two hours and eight attempts over one second are the same
 * number and completely different systems.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  backoffDelayMs,
  drainOnce,
  MAX_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_MAX_DELAY_MS,
  type DrainResult,
} from '../worker/drain.ts';
import { PermanentEffectError, type EffectDeps } from '../worker/effects.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;

const silent = () => undefined;

/**
 * A handler that fails on demand.
 *
 * The drain dispatches by event type, so a test controls the outcome by choosing the type it
 * writes. `unhandled.type` reaches `dispatch`'s no-handler branch, which is a plain `Error` and
 * therefore retryable - exactly the shape of a transient fault, without needing a real one.
 */
function deps(): EffectDeps {
  return {
    db: h.db,
    redis: { publish: async () => 1 } as never,
    push: new RecordingPushSender(),
    log: silent,
    // The retry ledger is the subject here, not the push. Without `pushDeferralMs` a deferred
    // push row is not claimable for eight seconds, so nothing it enqueues joins the counts.
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
async function failingEvent(partitionKey = 'p1'): Promise<number> {
  const rows = await h.db.execute<{ id: number }>(sql`
    INSERT INTO outbox (partition_key, event_type, payload)
    VALUES (${partitionKey}, 'unhandled.type', '{}'::jsonb)
    RETURNING id
  `);
  return Number(rows.rows[0]!.id);
}

async function rowState(id: number) {
  const rows = await h.db.execute<{
    attempts: number;
    processed_at: string | null;
    next_in_seconds: string;
    last_error: string | null;
  }>(sql`
    SELECT attempts,
           processed_at,
           extract(epoch from (next_attempt_at - now()))::text AS next_in_seconds,
           last_error
      FROM outbox WHERE id = ${id}
  `);
  const row = rows.rows[0]!;
  return {
    attempts: Number(row.attempts),
    processedAt: row.processed_at,
    nextInSeconds: Number(row.next_in_seconds),
    lastError: row.last_error,
  };
}

/** Make a backing-off row claimable again, standing in for the passage of time. */
async function timeTravel(id: number): Promise<void> {
  await h.db.execute(sql`UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE id = ${id}`);
}

// ===========================================================================
// The schedule
// ===========================================================================

describe('backoffDelayMs', () => {
  it('grows the wait with each attempt', () => {
    // Fixed random, so this is about the growth rather than the jitter.
    const half = () => 0.5;
    const delays = [1, 2, 3, 4, 5].map((n) => backoffDelayMs(n, half));
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!, `attempt ${i + 1} did not wait longer than ${i}`).toBeGreaterThan(
        delays[i - 1]!,
      );
    }
  });

  it('jitters, so a recovering service is not hit by the whole herd at once', () => {
    /*
     * The failure this prevents: ten thousand events fail against one dead provider, every
     * one waits the identical interval, and all ten thousand retry in the same millisecond -
     * knocking the service straight back over the moment it recovers.
     */
    const lowest = backoffDelayMs(3, () => 0);
    const highest = backoffDelayMs(3, () => 1);
    expect(highest, 'the delay is fixed, so every row retries in lockstep').toBeGreaterThan(lowest);
    // Equal jitter: never less than half the interval, so a retry cannot land almost
    // immediately and waste an attempt on an outage that has not moved.
    expect(lowest).toBe(Math.round(highest / 2));
  });

  it('never waits longer than the cap, however many attempts have passed', () => {
    expect(backoffDelayMs(50, () => 1)).toBe(RETRY_MAX_DELAY_MS);
  });

  it('retries the first failure quickly, because the common case is a blip already over', () => {
    expect(backoffDelayMs(1, () => 1)).toBe(RETRY_BASE_MS);
  });

  it('covers more than an hour across the whole budget', () => {
    /*
     * The number that matters, and the reason MAX_ATTEMPTS alone is not a policy. A provider
     * having a bad hour must be survived without a human replaying anything.
     */
    let total = 0;
    for (let n = 1; n < MAX_ATTEMPTS; n += 1) total += backoffDelayMs(n, () => 0);
    expect(total, 'the retry budget does not outlast a one-hour outage').toBeGreaterThan(
      60 * 60 * 1000,
    );
  });
});

// ===========================================================================
// The drain honours it
// ===========================================================================

describe('a failed event backs off instead of burning its budget', () => {
  it('does not re-claim a row that failed a moment ago', async () => {
    /*
     * The whole bug in one assertion. Before backoff, this second drain - and the 250ms tick
     * behind it - consumed another attempt, and five ticks later the row was parked.
     */
    const id = await failingEvent();

    const first = await drainOnce(h.db, deps());
    expect(first.failed).toBe(1);
    const after = await rowState(id);
    expect(after.attempts).toBe(1);
    expect(after.nextInSeconds, 'a failed row was immediately claimable again').toBeGreaterThan(0);

    const second = await drainOnce(h.db, deps());
    expect(second.failed, 'the row was retried before its delay elapsed').toBe(0);
    expect((await rowState(id)).attempts, 'a second attempt was spent instantly').toBe(1);
  });

  it('retries once the delay has elapsed', async () => {
    const id = await failingEvent();
    await drainOnce(h.db, deps());
    await timeTravel(id);

    const again = await drainOnce(h.db, deps());
    expect(again.failed).toBe(1);
    expect((await rowState(id)).attempts).toBe(2);
  });

  it('parks only after the full budget, and each attempt needs its own wait', async () => {
    const id = await failingEvent();
    let last: DrainResult | null = null;

    for (let n = 0; n < MAX_ATTEMPTS; n += 1) {
      await timeTravel(id);
      last = await drainOnce(h.db, deps());
    }

    expect((await rowState(id)).attempts).toBe(MAX_ATTEMPTS);
    expect(last!.parked).toBe(1);
  });

  it('leaves an unrelated event free to run while another is backing off', async () => {
    // Backoff delays the failing row. It must not delay anything else, or one bad provider
    // would stall the whole outbox.
    const failing = await failingEvent('p1');
    await drainOnce(h.db, deps());

    const other = await failingEvent('p2');
    const result = await drainOnce(h.db, deps());

    // Exactly one row was claimed: the new one. The first was dispatched while the second
    // was still waiting out its delay, rather than the delay stalling the whole outbox.
    expect(result.failed).toBe(1);
    expect((await rowState(other)).attempts, 'the unrelated event was not claimed').toBe(1);
    expect((await rowState(failing)).attempts, 'the backing-off row was claimed early').toBe(1);
  });
});

// ===========================================================================
// Permanent failures skip the wait entirely
// ===========================================================================

describe('a permanent failure parks immediately', () => {
  it('goes straight to the floor rather than counting up to it', async () => {
    /*
     * Without this, backoff makes a known-hopeless event *worse*: it would take over an hour
     * to reach a conclusion available on the first attempt, and report nothing in the meantime.
     *
     * `club.created` with an empty payload throws `PermanentEffectError` - the payload is
     * frozen at write time, so a field missing now is missing forever.
     */
    const rows = await h.db.execute<{ id: number }>(sql`
      INSERT INTO outbox (partition_key, event_type, payload)
      VALUES ('p1', 'club.created', '{}'::jsonb)
      RETURNING id
    `);
    const id = Number(rows.rows[0]!.id);

    const result = await drainOnce(h.db, deps());

    expect(result.parked, 'a permanent failure was retried').toBe(1);
    expect(result.failed).toBe(0);
    const after = await rowState(id);
    expect(after.attempts).toBe(MAX_ATTEMPTS);
    expect(after.lastError).toContain('missing mainChannelId');
  });

  it('is the error type that decides it, not the message', () => {
    // Guards the classification itself: a plain Error must stay retryable, or every transient
    // fault would park on its first bad second.
    expect(new PermanentEffectError('x')).toBeInstanceOf(Error);
    expect(new Error('x')).not.toBeInstanceOf(PermanentEffectError);
  });

  it('keeps an unknown event type RETRYABLE, so a rolling deploy is not an incident', async () => {
    /*
     * The tempting misclassification. An unknown event type looks permanent, but the commonest
     * way to reach it is an old worker briefly seeing an event only the new code handles. That
     * heals when the deploy finishes, and the schedule covers well over an hour.
     */
    const id = await failingEvent();
    const result = await drainOnce(h.db, deps());

    expect(result.parked, 'a rolling deploy would page somebody').toBe(0);
    expect(result.failed).toBe(1);
    expect((await rowState(id)).attempts).toBe(1);
  });
});
