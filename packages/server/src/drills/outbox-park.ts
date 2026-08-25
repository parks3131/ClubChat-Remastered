/**
 * A parked outbox event, created on purpose, in a partition that belongs to nobody.
 *
 * A parked event is the worst failure this system has: an effect that will now never run - a
 * notification nobody receives, a system message that never appears - and `drain.ts` reports it
 * exactly once, at the moment it parks, through `worker.outbox.parked`. That alarm has never
 * fired in production. This makes it fire.
 *
 * **The one thing this must never do is park a real event.** Two properties hold that, and both
 * are structural rather than careful:
 *
 *  1. **It creates its own event in its own partition.** Real `partition_key` values are bare
 *     uuids - a club id, a channel id, a user id - written by `domain/`. This writes
 *     `drill:monitoring:<uuid>`, which nothing else in the codebase can produce, so the drill's
 *     event shares an ordering queue with nothing.
 *  2. **The revert deletes by that partition, never by "parked".** Deleting parked rows would
 *     destroy the durable evidence that a real effect never ran, which is precisely what
 *     `retention.ts` refuses to do on a timer (`processed_at IS NOT NULL` is its whole delete
 *     condition). The revert here is narrower than retention, not wider.
 *
 * **Why `club.created` with an empty payload.** `onClubCreated` throws `PermanentEffectError`
 * when the payload carries no `mainChannelId` - before it reads the database, before it writes
 * anything - and a permanent failure parks on its FIRST attempt rather than counting to eight.
 * So the drill parks within one 250ms tick. The alternative, an event type with no handler at
 * all, is deliberately NOT permanent (a rolling deploy is the commonest way to hit one), which
 * would mean sitting through the full retry budget of 75 minutes to two and a half hours.
 *
 * The operator entrypoint is `scripts/drills/outbox-park.mjs`, which owns the refusal to run
 * against an unnamed target, the waiting and the reporting. This module owns the two statements.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { MAX_ATTEMPTS } from '../worker/drain.ts';

/**
 * The partition every drill event is written into.
 *
 * A prefix rather than a fixed key, so two drills run minutes apart cannot queue behind each
 * other, and so `LIKE 'drill:monitoring:%'` is an exact statement of "everything this drill has
 * ever written and nothing else".
 */
export const DRILL_PARTITION_PREFIX = 'drill:monitoring:';

/**
 * The event type the drill writes.
 *
 * A real type with a real handler, chosen because that handler refuses this payload permanently.
 * See the module docblock: an unknown type would take hours to reach the same place.
 */
export const DRILL_EVENT_TYPE = 'club.created';

export type DrillEvent = {
  /** `bigserial`, so a string from the driver. */
  id: string;
  partitionKey: string;
};

export type DrillEventState = {
  attempts: number;
  processedAt: string | null;
  lastError: string | null;
  /** The parked predicate, stated the same way `retention.ts` states it. */
  parked: boolean;
};

/**
 * Write one synthetic event for the running worker to fail on.
 *
 * Nothing here parks it: the worker does, on its next tick, which is the point. A drill that
 * marked the row parked itself would prove that this file can write an eight into a column.
 */
export async function insertDrillEvent(db: Db): Promise<DrillEvent> {
  const partitionKey = `${DRILL_PARTITION_PREFIX}${crypto.randomUUID()}`;
  const rows = await db.execute<{ id: string; partition_key: string }>(sql`
    INSERT INTO outbox (partition_key, event_type, payload)
    VALUES (${partitionKey}, ${DRILL_EVENT_TYPE}, '{}'::jsonb)
    RETURNING id, partition_key
  `);
  const row = rows.rows[0];
  if (row === undefined) throw new Error('the drill event was not written');
  return { id: row.id, partitionKey: row.partition_key };
}

/** What the worker has done with the drill event so far, or undefined once it has been removed. */
export async function readDrillEvent(db: Db, id: string): Promise<DrillEventState | undefined> {
  const rows = await db.execute<{
    attempts: number;
    // `db.execute` does no column coercion, so a timestamptz arrives as a string. AGENTS.md 5.3
    // entry 7: a row type over a raw read is an assertion, and this is the shape it must assert.
    processed_at: string | null;
    last_error: string | null;
  }>(sql`
    SELECT attempts, processed_at, last_error
      FROM outbox
     WHERE id = ${id}
       AND partition_key LIKE ${`${DRILL_PARTITION_PREFIX}%`}
  `);
  const row = rows.rows[0];
  if (row === undefined) return undefined;
  return {
    attempts: Number(row.attempts),
    processedAt: row.processed_at,
    lastError: row.last_error,
    parked: row.processed_at === null && Number(row.attempts) >= MAX_ATTEMPTS,
  };
}

/**
 * Remove every event this drill has ever written, and nothing else.
 *
 * This is the un-park step, and deleting is the right shape of it. Resetting `attempts` to zero
 * would hand the row back to the worker, which would fail it again and park it again - a drill
 * that cannot be ended. The row is synthetic, so nothing is lost by removing it, and the parked
 * COUNT returns to whatever it was before the drill, which is what the hourly
 * "outbox events are PARKED" line and any alarm built on it actually read.
 */
export async function removeDrillEvents(db: Db): Promise<number> {
  const removed = await db.execute<{ id: string }>(sql`
    DELETE FROM outbox
     WHERE partition_key LIKE ${`${DRILL_PARTITION_PREFIX}%`}
    RETURNING id
  `);
  return removed.rows.length;
}
