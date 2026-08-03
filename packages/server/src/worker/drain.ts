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
import { dispatch, type EffectDeps, type OutboxEvent } from './effects.ts';

export const POLL_INTERVAL_MS = 250;
export const BATCH_SIZE = 50;

/**
 * Attempts before a row is parked.
 *
 * A parked row stops being retried but is NOT deleted, and it must be alerted on: a
 * stuck event means system messages and notifications have silently stopped for that
 * partition, which is the kind of failure nobody notices until someone complains that
 * a club chat "went quiet".
 */
export const MAX_ATTEMPTS = 5;

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
        const nextAttempts = row.attempts + 1;

        await tx.execute(sql`
          UPDATE outbox
             SET attempts = ${nextAttempts},
                 last_error = ${message}
           WHERE id = ${row.id}
        `);

        if (nextAttempts >= MAX_ATTEMPTS) {
          result.parked += 1;
          deps.log('error', 'outbox event PARKED after repeated failures', {
            eventId: event.id,
            eventType: event.eventType,
            partitionKey: event.partitionKey,
            attempts: nextAttempts,
            lastError: message,
          });
          /*
           * A parked event is the worst failure this system has and was the quietest.
           *
           * > It means an effect will now NEVER run: a notification nobody receives, a card that
           * > never appears. `effect-coverage.test.ts` exists because three event types were
           * > parked for the entire life of the Eboard space and nothing said so - the retry
           * > path absorbs a handler failure into a column, which is right for a transient fault
           * > and indistinguishable from a permanent one after five attempts.
           *
           * Captured only at the park, not on each retry: a flaky push that succeeds on attempt
           * two is not an incident, and reporting every attempt would bury the one that matters.
           */
          deps.monitor?.capture(error, 'worker.outbox.parked', {
            eventId: event.id,
            eventType: event.eventType,
            partitionKey: event.partitionKey,
            attempts: nextAttempts,
          });
        } else {
          result.failed += 1;
          deps.log('warn', 'outbox event failed, will retry', {
            eventId: event.id,
            eventType: event.eventType,
            attempts: nextAttempts,
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
