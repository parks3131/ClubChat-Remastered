/**
 * Deleting what nobody will read again.
 *
 * > **Two tables grew without limit and had no archival path at all**: `notifications`, which
 * > gains a row every time anything happens to anybody, and `outbox`, which gains one for every
 * > domain event ever emitted and keeps it after the worker is finished with it. `PRD/17` debt 10.
 *
 * Modelled on `runMediaGc`, deliberately: same shape, same nightly slot in the scheduler, same
 * bounded batches. A sweep that can delete an unbounded number of rows in one statement takes
 * locks proportional to however long nobody ran it, which is the wrong thing to discover on the
 * first night after a busy month.
 *
 * ---
 *
 * **Hard delete, not an archive table.** Archiving moves rows from a table that grows without
 * limit into a different table that grows without limit, and calls it solved. The durable record
 * of what happened is the message log and the domain tables; a notification is a delivery receipt
 * for something that is still there to look at.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { MAX_ATTEMPTS } from './drain.ts';

/**
 * How long a notification survives after it has been read.
 *
 * Ninety days. The inbox is a feed of things that already happened and is read forwards; nobody
 * scrolls a quarter of a year back through it, and the underlying club, race or message it points
 * at is still there for anybody who wants it.
 */
export const READ_NOTIFICATION_DAYS = 90;

/**
 * How long an UNREAD notification survives, which is deliberately longer.
 *
 * > Deleting an unread row silently decrements somebody's badge for something they never saw, so
 * > this window is set where that stops being a real loss rather than where it is convenient.
 * > Six months. A notification nobody has opened by then is not going to be opened, and the
 * > alternative - keeping unread rows forever - leaves an abandoned account accumulating them
 * > with nothing that will ever clear it.
 */
export const UNREAD_NOTIFICATION_DAYS = 180;

/** How long a PROCESSED outbox row is kept. `PRD/17` debt 10 names seven days. */
export const PROCESSED_OUTBOX_DAYS = 7;

/**
 * One statement must not delete more than this.
 *
 * The media GC uses the same bound for the same reason: the first sweep after a long gap would
 * otherwise be arbitrarily large. Housekeeping runs hourly, so a backlog drains over hours rather
 * than in one lock.
 */
export const RETENTION_BATCH = 5_000;

export type RetentionResult = {
  readNotifications: number;
  unreadNotifications: number;
  processedOutbox: number;
  /**
   * Events this sweep deliberately did not touch, and the reason it reports them.
   *
   * > **Nothing else counts these.** A parked event means an effect never ran and never will, and
   * > the failure is silent by construction - the drain absorbs it into a column. Reporting the
   * > figure from the one job that walks this table hourly is close to free, and turns "we would
   * > find out if we looked" into something that arrives on its own.
   */
  parked: number;
};

/**
 * Sweep once.
 *
 * Three bounded deletes rather than one clever statement, because they answer three different
 * questions and each wants its own window. Returns what it removed so the caller can log a sweep
 * that did something and stay quiet about one that did not.
 */
export async function runRetentionSweep(
  db: Db,
  log: (message: string, extra?: unknown) => void,
): Promise<RetentionResult> {
  const result: RetentionResult = {
    readNotifications: 0,
    unreadNotifications: 0,
    processedOutbox: 0,
    parked: 0,
  };

  // --- 1. Notifications that were read, and are old ---
  const read = await db.execute<{ id: string }>(sql`
    DELETE FROM notifications
     WHERE id IN (
       SELECT id FROM notifications
        WHERE read_at IS NOT NULL
          AND read_at < now() - (${READ_NOTIFICATION_DAYS} * interval '1 day')
        LIMIT ${RETENTION_BATCH}
     )
    RETURNING id
  `);
  result.readNotifications = read.rows.length;

  // --- 2. Notifications never read, and older still ---
  //
  // Dated from `created_at` rather than `read_at`, which is null here by definition.
  const unread = await db.execute<{ id: string }>(sql`
    DELETE FROM notifications
     WHERE id IN (
       SELECT id FROM notifications
        WHERE read_at IS NULL
          AND created_at < now() - (${UNREAD_NOTIFICATION_DAYS} * interval '1 day')
        LIMIT ${RETENTION_BATCH}
     )
    RETURNING id
  `);
  result.unreadNotifications = unread.rows.length;

  /*
   * --- 3. Outbox rows the worker has finished with ---
   *
   * > **`processed_at IS NOT NULL` is the whole condition, and a PARKED row is deliberately not
   * > covered by it.** An event that was retried to the limit and never processed is the only
   * > durable evidence that an effect never ran - a notification nobody received, a card that
   * > never appeared. Three of those sat parked for the entire life of the Eboard space and
   * > nothing said so, which is why `effect-coverage.test.ts` exists. Deleting them on a timer
   * > would destroy the evidence of an unfixed bug on a schedule.
   *
   * So parked rows accumulate, on purpose. They are rare by construction - a parked row means a
   * consumer is missing or broken - and if they ever stop being rare, the table growing is the
   * least of it.
   */
  const processed = await db.execute<{ id: string }>(sql`
    DELETE FROM outbox
     WHERE id IN (
       SELECT id FROM outbox
        WHERE processed_at IS NOT NULL
          AND processed_at < now() - (${PROCESSED_OUTBOX_DAYS} * interval '1 day')
        LIMIT ${RETENTION_BATCH}
     )
    RETURNING id
  `);
  result.processedOutbox = processed.rows.length;

  result.parked = await parkedEventCount(db);

  if (result.readNotifications + result.unreadNotifications + result.processedOutbox > 0) {
    log('retention sweep removed rows', result);
  }

  /*
   * Said separately and every sweep, not folded into the line above.
   *
   * A sweep that deleted nothing still needs to report a parked event, and a sweep that deleted
   * thousands must not bury one in the middle of a row count. This is the only recurring place
   * the number is spoken at all.
   */
  if (result.parked > 0) {
    log('outbox events are PARKED - an effect never ran', { parked: result.parked });
  }

  return result;
}

/**
 * How many events are parked right now.
 *
 * Not retention, but it belongs beside it: this is the number the retention sweep refuses to
 * reduce, and it is worth surfacing precisely because nothing else does. A parked count that is
 * growing means effects are being silently dropped.
 */
export async function parkedEventCount(db: Db): Promise<number> {
  const rows = await db.execute<{ parked: string }>(sql`
    SELECT count(*)::text AS parked
      FROM outbox
     WHERE processed_at IS NULL AND attempts >= ${MAX_ATTEMPTS}
  `);
  return Number(rows.rows[0]?.parked ?? 0);
}
