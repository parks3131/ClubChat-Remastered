/**
 * What the retention sweep deletes, and - more importantly - what it refuses to.
 *
 * A sweep is easy to test in the direction that feels productive: old rows go away. The
 * assertions that earn their place here are the other kind, because **a retention bug deletes
 * something and there is nothing left to notice it with.**
 *
 * The one that matters most is the parked outbox row. It is the only durable evidence that an
 * effect never ran, three of them sat unnoticed for the whole life of the Eboard space, and a
 * sweep that removed them would erase the record of an unfixed bug on a timer.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { users } from '../db/schema.ts';
import { MAX_ATTEMPTS } from '../worker/drain.ts';
import {
  PROCESSED_OUTBOX_DAYS,
  READ_NOTIFICATION_DAYS,
  UNREAD_NOTIFICATION_DAYS,
  parkedEventCount,
  runRetentionSweep,
} from '../worker/retention.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
const silent = () => undefined;

beforeAll(async () => {
  h = await startTestDb();
}, 120_000);
afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE notifications, outbox RESTART IDENTITY CASCADE`);
});

async function makeUser(): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({ id, name: 'Keeper', email: `k-${id.slice(0, 8)}@t.invalid` });
  return id;
}

/** A notification aged by construction, since the sweep dates from real columns. */
async function notification(
  recipientId: string,
  opts: { ageDays: number; read: boolean },
): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.execute(sql`
    INSERT INTO notifications (id, recipient_id, type, params, outbox_event_id, created_at, read_at)
    VALUES (
      ${id}, ${recipientId}, 'test', '{}'::jsonb, ${Math.floor(Math.random() * 1e9)},
      now() - (${opts.ageDays} * interval '1 day'),
      ${opts.read ? sql`now() - (${opts.ageDays} * interval '1 day')` : sql`NULL`}
    )
  `);
  return id;
}

async function outboxRow(opts: {
  ageDays: number;
  processed: boolean;
  attempts?: number;
}): Promise<number> {
  const rows = await h.db.execute<{ id: number }>(sql`
    INSERT INTO outbox (partition_key, event_type, payload, created_at, processed_at, attempts)
    VALUES (
      ${crypto.randomUUID()}, 'test.event', '{}'::jsonb,
      now() - (${opts.ageDays} * interval '1 day'),
      ${opts.processed ? sql`now() - (${opts.ageDays} * interval '1 day')` : sql`NULL`},
      ${opts.attempts ?? 0}
    )
    RETURNING id
  `);
  return rows.rows[0]!.id;
}

const remaining = async (table: 'notifications' | 'outbox'): Promise<number> => {
  const rows = await h.db.execute<{ n: string }>(
    table === 'notifications'
      ? sql`SELECT count(*)::text AS n FROM notifications`
      : sql`SELECT count(*)::text AS n FROM outbox`,
  );
  return Number(rows.rows[0]?.n ?? 0);
};

describe('notifications', () => {
  it('removes read ones past the window and keeps read ones inside it', async () => {
    const userId = await makeUser();
    await notification(userId, { ageDays: READ_NOTIFICATION_DAYS + 1, read: true });
    const recent = await notification(userId, { ageDays: READ_NOTIFICATION_DAYS - 1, read: true });

    const result = await runRetentionSweep(h.db, silent);

    expect(result.readNotifications).toBe(1);
    const left = await h.db.execute<{ id: string }>(sql`SELECT id::text AS id FROM notifications`);
    expect(left.rows.map((r) => r.id)).toEqual([recent]);
  });

  it('keeps an unread one that a read one of the same age would lose', async () => {
    /*
     * The whole reason the two windows differ. Deleting an unread row silently decrements
     * somebody's badge for something they never saw, so unread gets the longer window - and this
     * asserts the branch exists rather than trusting that it does.
     */
    const userId = await makeUser();
    const age = READ_NOTIFICATION_DAYS + 1;
    await notification(userId, { ageDays: age, read: true });
    const unread = await notification(userId, { ageDays: age, read: false });

    await runRetentionSweep(h.db, silent);

    const left = await h.db.execute<{ id: string }>(sql`SELECT id::text AS id FROM notifications`);
    expect(left.rows.map((r) => r.id)).toEqual([unread]);
  });

  it('eventually removes an unread one, so an abandoned account does not leak forever', async () => {
    const userId = await makeUser();
    await notification(userId, { ageDays: UNREAD_NOTIFICATION_DAYS + 1, read: false });

    const result = await runRetentionSweep(h.db, silent);

    expect(result.unreadNotifications).toBe(1);
    expect(await remaining('notifications')).toBe(0);
  });
});

describe('the outbox', () => {
  it('removes processed rows past the window', async () => {
    await outboxRow({ ageDays: PROCESSED_OUTBOX_DAYS + 1, processed: true });
    await outboxRow({ ageDays: PROCESSED_OUTBOX_DAYS - 1, processed: true });

    const result = await runRetentionSweep(h.db, silent);

    expect(result.processedOutbox).toBe(1);
    expect(await remaining('outbox')).toBe(1);
  });

  it('NEVER removes a parked event, however old', async () => {
    /*
     * The assertion this file exists for. A parked row is the only record that an effect never
     * ran; a sweep that removed it would delete the evidence of an unfixed bug on a schedule, and
     * nothing downstream could ever notice it had.
     */
    await outboxRow({ ageDays: 3650, processed: false, attempts: MAX_ATTEMPTS });

    const result = await runRetentionSweep(h.db, silent);

    expect(result.processedOutbox).toBe(0);
    expect(await remaining('outbox')).toBe(1);
    // Reported by the sweep itself, so the number arrives hourly rather than when somebody asks.
    expect(result.parked).toBe(1);
    expect(await parkedEventCount(h.db)).toBe(1);
  });

  it('never removes an unprocessed row that is still being retried', async () => {
    // Not yet parked, not yet processed, and very old because the worker was down. Deleting it
    // would drop an effect that is still going to run.
    await outboxRow({ ageDays: 3650, processed: false, attempts: MAX_ATTEMPTS - 1 });

    await runRetentionSweep(h.db, silent);

    expect(await remaining('outbox')).toBe(1);
    expect(await parkedEventCount(h.db), 'a retryable row was counted as parked').toBe(0);
  });
});

describe('a sweep with nothing to do', () => {
  it('deletes nothing and reports nothing', async () => {
    const userId = await makeUser();
    await notification(userId, { ageDays: 1, read: true });
    await outboxRow({ ageDays: 1, processed: true });

    const result = await runRetentionSweep(h.db, silent);

    expect(result).toEqual({
      readNotifications: 0,
      unreadNotifications: 0,
      processedOutbox: 0,
      parked: 0,
    });
    expect(await remaining('notifications')).toBe(1);
    expect(await remaining('outbox')).toBe(1);
  });
});
