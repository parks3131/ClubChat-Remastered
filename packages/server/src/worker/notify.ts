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
