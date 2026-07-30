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

export type WriteNotificationsInput<K extends NotificationType = NotificationType> = {
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
