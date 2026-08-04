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
  attempts: number;
};

export type DrainResult = {
  processed: number;
  failed: number;
  parked: number;
};

/**
 * Drain one batch.
 *
 * Rows are claimed and processed in `id` order, which preserves ordering within a
 * partition for free because a single sequential pass preserves global order. That
 * ordering is load-bearing: "X was added to the club" must not overtake the event that
 * caused it.
 */
export async function drainOnce(db: Db, deps: EffectDeps): Promise<DrainResult> {
  const result: DrainResult = { processed: 0, failed: 0, parked: 0 };

  await db.transaction(async (tx) => {
    // SKIP LOCKED is what lets a second worker process run without double-handling a
    // row: it takes the rows this one has not claimed rather than blocking on them.
    const claimed = await tx.execute<ClaimedRow>(sql`
      SELECT id, partition_key, event_type, payload, attempts
        FROM outbox
       WHERE processed_at IS NULL
         AND attempts < ${MAX_ATTEMPTS}
         -- The backoff gate. A row that failed recently is not claimable yet, which is
         -- what stops the 250ms tick from spending the whole budget in a second.
         AND next_attempt_at <= now()
       ORDER BY id
         FOR UPDATE SKIP LOCKED
       LIMIT ${BATCH_SIZE}
    `);

    for (const row of claimed.rows) {
      const event: OutboxEvent = {
        // bigserial arrives as a string from the driver; the derived idempotency key
        // must be stable, so normalise once here rather than at each use.
        id: Number(row.id),
        partitionKey: row.partition_key,
        eventType: row.event_type,
        payload: row.payload ?? {},
      };

      try {
        await dispatch(event, deps);
        await tx.execute(sql`
          UPDATE outbox SET processed_at = now() WHERE id = ${row.id}
        `);
        result.processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        /*
         * A permanent failure goes straight to the floor rather than counting up to it.
         *
         * Retrying it cannot change the outcome, and with the delays above it would take
         * over an hour to reach the same conclusion - an hour in which nothing is reported
         * and the row looks, from outside, like an effect that is merely slow.
         */
        const permanent = error instanceof PermanentEffectError;
        const nextAttempts = permanent ? MAX_ATTEMPTS : row.attempts + 1;
        const delayMs = permanent ? 0 : backoffDelayMs(nextAttempts);

        await tx.execute(sql`
          UPDATE outbox
             SET attempts = ${nextAttempts},
                 last_error = ${message},
                 next_attempt_at = now() + (${delayMs} * interval '1 millisecond')
           WHERE id = ${row.id}
        `);

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
  });

  return result;
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
