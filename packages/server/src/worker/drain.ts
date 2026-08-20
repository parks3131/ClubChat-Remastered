/**
 * The outbox drain.
 *
 * Phase 0 reads the outbox DIRECTLY with `FOR UPDATE SKIP LOCKED`. There is no relay
 * and no Kafka yet, and that is the plan rather than a shortcut: ADR-0006 slots Kafka
 * at Phase 1.5 specifically because the effects pipeline must be *correct* before it is
 * *distributed* - debugging an ordering bug and a consumer rebalance at the same time
 * is how a learning goal turns into a week lost.
 *
 * The shape here is also exactly what ADR-0006's exit ramp describes as the fallback if
 * Kafka is ever dropped, which is the property that keeps that decision cheap to
 * reverse: **the outbox already works without Kafka.**
 *
 * Polling, never LISTEN/NOTIFY. LISTEN needs a session pinned for the listener's
 * lifetime, which is incompatible with transaction-mode connection pooling and would
 * rule out serverless Postgres. At 250ms a tick is one trivially-indexed query and
 * effect latency stays well inside anything a human perceives.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { redact } from '../dev/trace.ts';
import { dispatch, PermanentEffectError, type EffectDeps, type OutboxEvent } from './effects.ts';

export const POLL_INTERVAL_MS = 250;
export const BATCH_SIZE = 50;

/**
 * Attempts before a row is parked.
 *
 * A parked row stops being retried but is NOT deleted, and it must be alerted on: a
 * stuck event means system messages and notifications have silently stopped for that
 * partition, which is the kind of failure nobody notices until someone complains that
 * a club chat "went quiet".
 *
 * Eight rather than five, because a count is only meaningful together with the delays
 * between the attempts - see `backoffDelayMs`. Five attempts with no delay at all, which
 * is what this was, spans about a second.
 */
export const MAX_ATTEMPTS = 8;

/**
 * How long a claimed row stays invisible while its handler runs.
 *
 * **The claim is a lease, not a read.** A row is stamped `attempts + 1` and pushed this far
 * into the future in the claiming statement itself, before any handler is entered, and that
 * stamp is committed on its own. Two things depend on it:
 *
 * 1. **A handler that kills the process still costs an attempt.** Until 2026-08-19 the whole
 *    batch ran inside one transaction and `attempts` was incremented only in the catch, so a
 *    handler that took the process down with it - an out-of-memory deriving variants for a
 *    large image is the case that exists - rolled the increment back on the way out while its
 *    own writes, on a different pool connection, had already committed. The row was retried
 *    forever, never reached `MAX_ATTEMPTS`, and never fired the park alarm that exists for
 *    exactly this. See `TECH/04`.
 * 2. **It is what holds the rest of the partition back** while the row is in flight. See the
 *    claim query below: a later event is claimable only when nothing earlier in its partition
 *    is unresolved, and "unresolved" means exactly "still leased or still backing off".
 *
 * A minute rather than a few seconds, because the cost of guessing short is two workers running
 * the same slow handler at once, while the cost of guessing long is a crashed worker's row
 * waiting a minute. Effects are idempotent either way, so this only trades duplicate work
 * against latency after a crash.
 */
export const CLAIM_LEASE_MS = 60_000;

/**
 * The retry schedule.
 *
 * > **Attempts without delays are not retries.** This drain polls every 250ms and used to
 * > re-claim a failing row on every tick, so the entire budget was spent in roughly 1.25
 * > seconds. Any outage lasting longer than that - which is every real outage - parked the
 * > row permanently and required a human to replay it.
 *
 * The first retry is deliberately quick, because the common case is a blip that is already
 * over. The growth is steep after that, so a genuine outage is absorbed rather than raced:
 *
 * | attempt | delay before it (jittered) |
 * |---|---|
 * | 1 | 2.5s to 5s |
 * | 2 | 10s to 20s |
 * | 3 | 40s to 80s |
 * | 4 | 2.5m to 5m |
 * | 5 | 11m to 21m |
 * | 6 | 30m to 60m (capped) |
 * | 7 | 30m to 60m (capped) |
 *
 * Roughly 75 minutes of coverage at worst and two and a half hours at best, so a provider
 * having an hour is survived without anybody being told.
 */
export const RETRY_BASE_MS = 5_000;
export const RETRY_FACTOR = 4;
/** No single wait longer than an hour, however many attempts remain. */
export const RETRY_MAX_DELAY_MS = 60 * 60 * 1000;

/**
 * How long to wait before the next attempt.
 *
 * **Jittered, and that is not decoration.** Without it, a provider that fails ten thousand
 * events at once retries all ten thousand in the same millisecond, and the recovering
 * service is knocked straight back over by the herd it just released.
 *
 * Equal jitter - half the delay fixed, half random - rather than full jitter, which can
 * schedule a retry almost immediately and waste an attempt on an outage that has not moved.
 *
 * `random` is injectable so a test can assert the bounds rather than approximate them.
 */
export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
  const exponential = Math.min(
    RETRY_BASE_MS * RETRY_FACTOR ** Math.max(0, attempts - 1),
    RETRY_MAX_DELAY_MS,
  );
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

type ClaimedRow = {
  id: string;
  partition_key: string;
  event_type: string;
  payload: Record<string, unknown>;
  /** Already incremented: the number of the attempt this claim is about to make. */
  attempts: number;
};

export type DrainResult = {
  processed: number;
  failed: number;
  parked: number;
  /**
   * Claimed, then handed back unrun because something earlier in the same partition failed
   * during this batch. Not an error - it is the ordering guarantee doing its job - but worth
   * counting, because a partition that defers on every tick is one whose head is stuck.
   */
  deferred: number;
};

/**
 * Claim a batch, stamping the attempt before anything is dispatched.
 *
 * One statement, and it has to be one: the sub-select takes the row locks and the UPDATE
 * consumes them in the same snapshot, so a second worker either sees the row locked and skips
 * it, or sees the committed lease and is held behind it. Two statements would leave a window
 * in which a second worker sees a row that is locked but still looks claimable-soon, and its
 * successors in the partition would look claimable too.
 *
 * The ordering gate is the `NOT EXISTS`. A row is claimable only when nothing earlier in its
 * partition is still live and unresolved, where "unresolved" is `next_attempt_at > now()`:
 * either leased by a worker that has it in hand, or backing off after a failure. That single
 * predicate closes both halves of the defect this replaced:
 *
 * - **within a batch**, because the loser of a partition race is never claimed alongside its
 *   predecessor once that predecessor fails (and if it was claimed while its predecessor still
 *   looked fine, `drainOnce` hands it back rather than running it);
 * - **across ticks**, because a row pushed 2.5 seconds into the future by the backoff now
 *   blocks its successors for those 2.5 seconds instead of being quietly overtaken by them.
 *
 * **A PARKED row is deliberately not a blocker** - `earlier.attempts < MAX_ATTEMPTS`. A parked
 * event will never run, so holding its partition behind it stops that channel's notifications
 * permanently rather than losing one of them. ADR-0006 already made this call for the Kafka
 * era ("a poisoned event goes to the DLQ rather than blocking its partition forever"); this is
 * the same choice one layer down, and it is why parking is alerted on.
 *
 * The `NOT EXISTS` is what finally uses `outbox_unprocessed` - the partial index on
 * `(partition_key, id) WHERE processed_at IS NULL` that the schema has declared since the
 * table was written, for a claim query that never referenced `partition_key` at all.
 */
async function claimBatch(db: Db): Promise<ClaimedRow[]> {
  const claimed = await db.execute<ClaimedRow>(sql`
    WITH claimed AS (
      SELECT o.id
        FROM outbox o
       WHERE o.processed_at IS NULL
         AND o.attempts < ${MAX_ATTEMPTS}
         -- The backoff gate. A row that failed recently is not claimable yet, which is
         -- what stops the 250ms tick from spending the whole budget in a second.
         AND o.next_attempt_at <= now()
         -- The ordering gate. See above.
         AND NOT EXISTS (
           SELECT 1
             FROM outbox earlier
            WHERE earlier.partition_key = o.partition_key
              AND earlier.processed_at IS NULL
              AND earlier.id < o.id
              AND earlier.attempts < ${MAX_ATTEMPTS}
              AND earlier.next_attempt_at > now()
         )
       ORDER BY o.id
         FOR UPDATE SKIP LOCKED
       LIMIT ${BATCH_SIZE}
    )
    UPDATE outbox
       SET attempts = outbox.attempts + 1,
           next_attempt_at = now() + (${CLAIM_LEASE_MS} * interval '1 millisecond')
      FROM claimed
     WHERE outbox.id = claimed.id
    RETURNING outbox.id,
              outbox.partition_key,
              outbox.event_type,
              outbox.payload,
              outbox.attempts
  `);

  // RETURNING follows the update plan, not the sub-select's ORDER BY, and the whole point of
  // this function is order. Sort once here rather than trusting the planner.
  return [...claimed.rows].sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * Drain one batch.
 *
 * **No transaction wraps the loop, deliberately.** It used to, and the transaction was a lie:
 * every handler's own writes go through `deps.db`, a different pool connection, and commit as
 * they happen. A process death at row 40 left rows 1 to 39 with their effects performed and
 * their `processed_at` rolled back. Redelivery is fine - delivery is at-least-once and every
 * effect is idempotent - but the rolled-back `attempts` was not, because it is the only thing
 * that ever reaches `MAX_ATTEMPTS` and fires the park alarm. The attempt is now stamped by the
 * claim (see `claimBatch`) and each row's outcome is written on its own, so the batch's blast
 * radius is one row rather than fifty.
 *
 * Rows are dispatched in `id` order, and a partition stops for the rest of the batch the
 * moment one of its events fails: "X was added to the club" must not overtake the event that
 * caused it, and within a batch that is a loop concern rather than a query one.
 */
export async function drainOnce(db: Db, deps: EffectDeps): Promise<DrainResult> {
  const result: DrainResult = { processed: 0, failed: 0, parked: 0, deferred: 0 };

  const claimed = await claimBatch(db);
  /** Partitions whose head failed in THIS batch. Everything behind them waits for a later tick. */
  const stalled = new Set<string>();
  const deferred: string[] = [];

  for (const row of claimed) {
    if (stalled.has(row.partition_key)) {
      deferred.push(row.id);
      result.deferred += 1;
      continue;
    }

    const event: OutboxEvent = {
      // bigserial arrives as a string from the driver; the derived idempotency key
      // must be stable, so normalise once here rather than at each use.
      id: Number(row.id),
      partitionKey: row.partition_key,
      eventType: row.event_type,
      payload: row.payload ?? {},
    };

    /*
     * The development trace's clock, started before the handler rather than around the whole
     * loop. What a reader of the dashboard wants to know is how long THIS effect took, which
     * is the number that answers "why was that push slow" - a per-batch figure would hide a
     * single slow handler behind forty fast ones.
     */
    const startedAt = Date.now();
    const trace = (outcome: 'ok' | 'retry' | 'parked', error: string | null) =>
      deps.tracer?.emit({
        kind: 'effect',
        outboxId: event.id,
        eventType: event.eventType,
        partitionKey: event.partitionKey,
        payload: redact(event.payload),
        ms: Date.now() - startedAt,
        outcome,
        error,
      });

    try {
      await dispatch(event, deps);
      /*
       * `next_attempt_at` goes back to `now()` alongside the stamp, so the claim's lease is
       * not left lying in the future on a row that is finished with. It is dead weight on a
       * processed row - nothing claims one - right up until somebody replays the event by
       * hand with `UPDATE outbox SET processed_at = NULL`, which is a documented operational
       * move and must not silently wait out a lease nobody knew was there.
       */
      await db.execute(sql`
        UPDATE outbox SET processed_at = now(), next_attempt_at = now() WHERE id = ${row.id}
      `);
      result.processed += 1;
      trace('ok', null);
    } catch (error) {
      // Nothing else in this partition runs until this row resolves, in this batch or any
      // later one. The claim query enforces the second half; this enforces the first.
      stalled.add(row.partition_key);

      const message = error instanceof Error ? error.message : String(error);
      /*
       * A permanent failure goes straight to the floor rather than counting up to it.
       *
       * Retrying it cannot change the outcome, and with the delays above it would take
       * over an hour to reach the same conclusion - an hour in which nothing is reported
       * and the row looks, from outside, like an effect that is merely slow.
       */
      const permanent = error instanceof PermanentEffectError;
      // `row.attempts` is already the number of the attempt just made: the claim incremented it.
      const nextAttempts = permanent ? MAX_ATTEMPTS : row.attempts;
      const delayMs = permanent ? 0 : backoffDelayMs(nextAttempts);

      await db.execute(sql`
        UPDATE outbox
           SET attempts = ${nextAttempts},
               last_error = ${message},
               next_attempt_at = now() + (${delayMs} * interval '1 millisecond')
         WHERE id = ${row.id}
      `);

      trace(nextAttempts >= MAX_ATTEMPTS ? 'parked' : 'retry', message);

      if (nextAttempts >= MAX_ATTEMPTS) {
        result.parked += 1;
        deps.log('error', 'outbox event PARKED after repeated failures', {
          eventId: event.id,
          eventType: event.eventType,
          partitionKey: event.partitionKey,
          attempts: nextAttempts,
          // So the log distinguishes "we tried for two hours" from "this could never work",
          // which are the same outcome reached for opposite reasons.
          permanent,
          lastError: message,
        });
        /*
         * A parked event is the worst failure this system has and was the quietest.
         *
         * > It means an effect will now NEVER run: a notification nobody receives, a card that
         * > never appears. `effect-coverage.test.ts` exists because three event types were
         * > parked for the entire life of the Eboard space and nothing said so - the retry
         * > path absorbs a handler failure into a column, which is right for a transient fault
         * > and indistinguishable from a permanent one once the budget runs out.
         *
         * `PermanentEffectError` narrows that: a failure known to be about the data arrives
         * here on its first attempt rather than its eighth. What cannot be classified still
         * takes the long road, which is the safe default.
         *
         * Captured only at the park, not on each retry: a flaky push that succeeds on attempt
         * two is not an incident, and reporting every attempt would bury the one that matters.
         */
        deps.monitor?.capture(error, 'worker.outbox.parked', {
          eventId: event.id,
          eventType: event.eventType,
          partitionKey: event.partitionKey,
          attempts: nextAttempts,
          permanent,
        });
      } else {
        result.failed += 1;
        deps.log('warn', 'outbox event failed, will retry', {
          eventId: event.id,
          eventType: event.eventType,
          attempts: nextAttempts,
          // The wait is the useful half of this line. "Failed, will retry" with no interval
          // reads as "any moment now", which was true before and is not any more.
          retryInMs: delayMs,
          error: message,
        });
      }
    }
  }

  if (deferred.length > 0) await releaseUnrun(db, deferred);

  return result;
}

/**
 * Hand back rows that were claimed and never dispatched.
 *
 * The claim stamps the attempt on every row it takes, which is right for the row it is about
 * to run and wrong for one it turns out to be holding behind a failure. `attempts` counts
 * dispatches begun, so a row that was never entered must give its increment back or a partition
 * whose head fails eight times would park everything queued behind it without ever running any
 * of it. `next_attempt_at` goes back to `now()`: these rows are ready, and it is the ordering
 * gate rather than a delay that decides when they are claimable again.
 */
async function releaseUnrun(db: Db, ids: string[]): Promise<void> {
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  await db.execute(sql`
    UPDATE outbox
       SET attempts = attempts - 1,
           next_attempt_at = now()
     WHERE id IN (${list})
  `);
}

/**
 * Run the drain until stopped.
 *
 * Sequential ticks with no overlap: a slow batch delays the next tick rather than
 * running two drains concurrently over the same partition, which would defeat the
 * ordering guarantee the `id` ordering exists to provide.
 */
export function startDrainLoop(
  db: Db,
  deps: EffectDeps,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;

  return (async () => {
    while (!opts.signal?.aborted) {
      try {
        const result = await drainOnce(db, deps);
        if (result.processed > 0 || result.failed > 0 || result.parked > 0) {
          deps.log('info', 'drained outbox batch', result);
        }
      } catch (error) {
        // A failure of the drain itself (a lost connection, say) must not kill the
        // loop. Nothing is lost: unprocessed rows stay unprocessed and the next tick
        // picks them up.
        deps.log('error', 'drain tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Surviving the tick is not the same as the tick being fine. A drain that fails every
        // time delivers nothing and looks, from outside, exactly like an empty outbox.
        deps.monitor?.capture(error, 'worker.drain.tick');
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  })();
}
