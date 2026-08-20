/**
 * Writing notification rows.
 *
 * Two properties, both structural rather than careful:
 *
 *  - **Idempotent.** `UNIQUE (outbox_event_id, recipient_id)` plus `ON CONFLICT DO
 *    NOTHING`, so at-least-once redelivery is a no-op instead of a second inbox row.
 *  - **Validated.** Params are parsed against their per-type schema before the insert, so
 *    a malformed param fails here rather than surfacing as broken text in somebody's
 *    inbox months later, by which time the row is history. That is the compensating
 *    control ADR-0013 owes for having dropped the rendered body column.
 */

import { sql } from 'drizzle-orm';
import {
  parseNotificationParams,
  type NotificationParams,
  type NotificationType,
} from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { notifications } from '../db/schema.ts';

/**
 * How many notification kinds one outbox event may produce.
 *
 * > **Every idempotency key is `eventId * NOTIFICATION_SLOTS + slot`, and that is not a
 * > formality - the previous scheme collided with itself.**
 * >
 * > Most handlers produce exactly one notification and keyed on the raw `event.id`. The
 * > message handler produces up to three, and keyed the second one as `event.id * 2 + 1`.
 * > Those sequences overlap in both directions: a mention on event 3 keys as 7, and so does an
 * > announcement on event 7; and once any handler multiplies, its keys land on other handlers'
 * > raw ids too. Both `notifications_idempotency` and the `push_deliveries` ledger are on
 * > `(outbox_event_id, recipient/device)`, so a collision reads as "already handled" and
 * > silently drops a real notification and a real push, with nothing reporting it.
 * >
 * > Banding every event into its own block of slots makes the mapping injective by
 * > construction, which is the only version of this that cannot be got wrong by adding a
 * > fourth kind later. Found while adding the third one.
 *
 * Synthetic keys - the poll closing-soon reminder and the chat-caught-up row - stay **negative**
 * and are deliberately not banded: real outbox ids are a positive bigserial, so the two spaces
 * cannot meet whatever the multiplier is.
 */
export const NOTIFICATION_SLOTS = 4;

/**
 * The idempotency key for one kind of notification from one event.
 *
 * Slot 0 is the only or primary notification of an event, 1 is a mention, 2 is a direct
 * message. Slot 3 is spare, so the next kind is a constant rather than another re-keying.
 */
export const notificationKey = (outboxEventId: number, slot: 0 | 1 | 2 | 3 = 0): number =>
  outboxEventId * NOTIFICATION_SLOTS + slot;

export type WriteNotificationsInput<K extends NotificationType = NotificationType> = {
  /** Always through `notificationKey`, never a raw outbox id. See above. */
  outboxEventId: number;
  type: K;
  params: NotificationParams[K];
  recipients: readonly string[];
  actorId: string | null;
  clubId: string | null;
};

/**
 * Write one notification per recipient.
 *
 * Returns how many rows were newly created, which is what distinguishes "first delivery"
 * from "redelivery" for the caller - the push path uses it to decide whether the buzz has
 * already happened.
 */
export async function writeNotifications<K extends NotificationType>(
  db: Db,
  input: WriteNotificationsInput<K>,
): Promise<{ created: number }> {
  if (input.recipients.length === 0) return { created: 0 };

  // Throws on a malformed param. Deliberately not caught: a bad param is a producer bug,
  // and letting it fail routes the event through the outbox retry and parking path where
  // it is visible, rather than writing 300 rows of nonsense.
  const params = parseNotificationParams(input.type, input.params);

  const rows = await db
    .insert(notifications)
    .values(
      [...new Set(input.recipients)].map((recipientId) => ({
        recipientId,
        actorId: input.actorId,
        clubId: input.clubId,
        type: input.type,
        params: params as object,
        outboxEventId: input.outboxEventId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: notifications.id });

  return { created: rows.length };
}

/**
 * Which scope key a request type carries its target under.
 *
 * Exported because the index that keeps `resolvePendingRequests` off a full scan is PARTIAL on
 * exactly these three type strings, and a fourth entry added here without a matching migration
 * would silently put that one type back on a sequential scan of an unbounded table. The plan
 * test iterates this map, so the divergence is a red suite rather than nothing at all.
 */
export const REQUEST_SCOPE_KEY = {
  club_join_request: 'clubId',
  race_join_request: 'raceId',
  eboard_join_request: 'eboardId',
} as const;

export type ResolvePendingInput = {
  type: keyof typeof REQUEST_SCOPE_KEY;
  /** The club, race or Eboard the request was filed against. */
  scopeId: string;
  /** Whose request this was. Two people can have requests open on one roster at once. */
  requesterId: string;
  decision: 'approved' | 'denied';
  decidedByName: string;
};

/**
 * Settle every admin's copy of a request that has just been decided.
 *
 * **A request notification goes to everyone who could act on it, and exactly one of them
 * does.** Every other copy is then describing work that no longer exists: it still says "X
 * asked to join", still deep-links to a roster with nothing pending on it, and - because
 * `markInboxRead` deliberately refuses to clear the three request types - still sits unread
 * against the badge until that particular admin happens to open that particular roster. An
 * admin who was away for the whole thing meets a job that was done hours ago.
 *
 * So the decision resolves them in place. `PRD/12` rule 5 already asked for this ("a decided
 * join request stays in the feed, tagged Approved or Denied"); the row keeps its history and
 * stops claiming to be work.
 *
 * Three details carry the weight:
 *
 *  - **`params ->> 'decision' IS NULL`** is what makes this safe to run against a scope where
 *    the same person has asked before. A denied request can be re-filed (`races.ts`), so
 *    `(scope, requester)` is not unique over time - without this guard a second decision would
 *    reach back and rewrite the record of the first one.
 *  - **`COALESCE(read_at, now())`** keeps an existing read timestamp. An admin who opened the
 *    roster an hour ago read it then, and moving that forward would be inventing a moment.
 *  - **The decider's own copy is resolved too**, and reads "Sarah approved Mike's request"
 *    rather than "you approved". The renderer works from the row, not from who is looking at
 *    it, and a row that says who acted is right for every reader including the actor.
 *
 * Not idempotency-keyed, because it does not need to be: it is an update whose predicate stops
 * matching once it has run, so a redelivered decision event finds nothing left to stamp.
 */
export async function resolvePendingRequests(
  db: Db,
  input: ResolvePendingInput,
): Promise<{ resolved: number }> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE notifications
       SET params = params || ${JSON.stringify({
         decision: input.decision,
         decidedByName: input.decidedByName,
       })}::jsonb,
           read_at = COALESCE(read_at, now())
     WHERE type = ${input.type}
       AND params ->> ${REQUEST_SCOPE_KEY[input.type]} = ${input.scopeId}
       AND params ->> 'requesterId' = ${input.requesterId}
       AND params ->> 'decision' IS NULL
    RETURNING id
  `);
  return { resolved: result.rows.length };
}
