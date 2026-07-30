/**
 * The one scheduled job.
 *
 * `TECH/12` is emphatic that poll closing-soon is the **only** effect with no data change to
 * hang on: nothing changes when a deadline gets within ten minutes, so there is nothing for
 * the outbox to carry and this has to be timer-driven. Everything else in the system reacts
 * to a write.
 *
 * Two properties it must have, both structural:
 *
 *  - **Fires at most once per poll, ever.** The stamp is written in the SAME transaction as
 *     the fan-out, so a crash between them cannot produce a second reminder.
 *  - **Includes the creator**, which is the single exception to "creation notifications
 *     exclude the actor". They are exactly who needs to know their own poll is closing.
 *
 * And the thing it must NOT do: **there is no job that closes polls.** Closed-ness is
 * evaluated at read time. A job that flipped a boolean would be a second source of truth for
 * something a comparison already answers.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { resolveAudience } from './audience.ts';
import { writeNotifications } from './notify.ts';
import { dispatchPush } from '../push/dispatch.ts';
import type { EffectDeps } from './effects.ts';

/**
 * How often to look.
 *
 * 30 seconds, which is the cadence `TECH/04` specifies. `PRD/16` requires deadline reminders
 * to fire within a minute of their window, so this leaves headroom rather than sitting exactly
 * on the requirement.
 */
export const SCHEDULED_TICK_MS = 30_000;

/** How far ahead of the deadline the reminder fires. */
export const CLOSING_SOON_MINUTES = 10;

export type TickResult = { remindersSent: number; gc?: { orphanedRemoved: number; stalePendingRemoved: number } };

/**
 * How often housekeeping runs.
 *
 * Nightly in production. The interval is separate from the poll tick because the two have
 * completely different urgencies: a deadline reminder that is a minute late is a bug, and a
 * storage sweep that is an hour late is nothing.
 */
export const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;

/**
 * One tick.
 *
 * `FOR UPDATE SKIP LOCKED` means a second worker process takes the polls this one has not
 * claimed rather than blocking on them - and, more importantly, cannot claim the same poll and
 * send a duplicate reminder.
 */
export async function runScheduledTick(db: Db, deps: EffectDeps): Promise<TickResult> {
  let remindersSent = 0;

  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      club_id: string;
      scope: string;
      scope_id: string;
      creator_id: string;
      question: string;
    }>(sql`
      SELECT id, club_id, scope, scope_id, creator_id, question
        FROM polls
       WHERE closed_at IS NULL
         AND closing_soon_notified_at IS NULL
         AND closes_at IS NOT NULL
         AND closes_at BETWEEN now() AND now() + (${CLOSING_SOON_MINUTES} * interval '1 minute')
         FOR UPDATE SKIP LOCKED
    `);

    if (rows.rows.length > 0) {
      // Stamped in the same transaction as the claim. A crash after this commit but before
      // the fan-out below loses a reminder rather than sending two - the correct direction to
      // fail for something that cannot be un-sent.
      await tx.execute(sql`
        UPDATE polls SET closing_soon_notified_at = now()
         WHERE id = ANY(${sql.param(rows.rows.map((r) => r.id))}::uuid[])
      `);
    }

    return rows.rows;
  });

  for (const poll of claimed) {
    const recipients = await resolveAudience(db, {
      // The ONE type that includes the actor. `resolveAudience` knows that from the type
      // rather than from a flag passed here, so the exception lives in one place.
      type: 'poll_closing_soon',
      actorId: poll.creator_id,
      clubId: poll.club_id,
    });

    // Phase 2 note: the audience for a poll depends on its scope, and resolveAudience returns
    // an empty list for poll types until the scope branches are wired. Resolve directly here
    // so the reminder is correct today, and the branch below is the one place that knows how.
    const scoped = recipients.length > 0 ? recipients : await pollAudience(db, poll);

    if (scoped.length === 0) continue;

    const params = {
      clubId: poll.club_id,
      clubName: await clubName(db, poll.club_id),
      pollId: poll.id,
      question: poll.question,
    };

    // A synthetic negative event id, derived from the poll, so the notification's idempotency
    // index still applies and a replay cannot double-write. Negative keeps it clear of the
    // positive space real outbox ids occupy.
    const eventId = -Math.abs(hash(`poll-closing:${poll.id}`)) - 1;

    await writeNotifications(db, {
      outboxEventId: eventId,
      type: 'poll_closing_soon',
      params,
      recipients: scoped,
      actorId: null,
      clubId: poll.club_id,
    });

    await dispatchPush(db, deps.push, {
      outboxEventId: eventId,
      type: 'poll_closing_soon',
      params,
      recipients: scoped,
    });

    remindersSent += 1;
    deps.log('info', 'poll closing-soon reminder sent', {
      pollId: poll.id,
      recipients: scoped.length,
    });
  }

  return { remindersSent };
}

/**
 * Everyone who can access a poll, by scope.
 *
 * The race branch is roster members ONLY - never roster union club admins, which would remind
 * people about a poll they cannot open.
 */
async function pollAudience(
  db: Db,
  poll: { scope: string; scope_id: string; club_id: string },
): Promise<string[]> {
  const rows = await db.execute<{ user_id: string }>(sql`
    SELECT user_id FROM club_memberships
     WHERE ${poll.scope} = 'club' AND club_id = ${poll.club_id}
    UNION
    SELECT user_id FROM race_memberships
     WHERE ${poll.scope} = 'race' AND race_id = ${poll.scope_id}::uuid
    UNION
    SELECT user_id FROM eboard_memberships
     WHERE ${poll.scope} = 'eboard' AND eboard_id = ${poll.scope_id}::uuid
  `);
  return rows.rows.map((r) => r.user_id);
}

async function clubName(db: Db, clubId: string): Promise<string> {
  const rows = await db.execute<{ name: string }>(
    sql`SELECT name FROM clubs WHERE id = ${clubId}`,
  );
  return rows.rows[0]?.name ?? 'Your club';
}

function hash(key: string): number {
  let value = 0;
  for (let i = 0; i < key.length; i += 1) value = (value * 31 + key.charCodeAt(i)) | 0;
  return value;
}

/** Run the tick on a timer until stopped. */
export function startScheduler(
  db: Db,
  deps: EffectDeps,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const interval = opts.intervalMs ?? SCHEDULED_TICK_MS;
  let lastHousekeeping = 0;

  return (async () => {
    while (!opts.signal?.aborted) {
      try {
        const result = await runScheduledTick(db, deps);
        if (result.remindersSent > 0) deps.log('info', 'scheduled tick', result);

        // Housekeeping on its own, much slower cadence, inside the same loop so there is one
        // timer to reason about rather than two racing.
        if (deps.media && Date.now() - lastHousekeeping > HOUSEKEEPING_INTERVAL_MS) {
          lastHousekeeping = Date.now();
          const { runMediaGc } = await import('../media/derive.ts');
          await runMediaGc(db, deps.media, (message, extra) => deps.log('info', message, extra));
        }
      } catch (error) {
        // A failed tick must not kill the loop: the next one re-claims whatever was missed,
        // because the stamp is only written on a successful claim.
        deps.log('error', 'scheduled tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  })();
}
