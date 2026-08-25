/**
 * Writing down what happened to a message after we sent it.
 *
 * One concern, one round trip, and no opinion at all about who is allowed to tell us - the
 * signature check in `api/mail-webhook.ts` is what decides that, before this is reached.
 *
 * The whole of the idempotency lives here, in `ON CONFLICT DO NOTHING` against
 * `mail_events_delivery`. Resend documents at-least-once delivery and retries on a fixed
 * schedule, so the same event WILL arrive twice - a slow acknowledgement of ours is enough to
 * cause it - and "the same bounce recorded twice" would mean the same alarm raised twice at 3am.
 */

import { mailEvents } from '../db/schema.ts';
import type { Db } from '../db/client.ts';
import type { MailEvent } from '../mail-webhook.ts';

/**
 * Record one delivery's events, skipping any that were recorded before.
 *
 * @returns the addresses a row was actually written for. **Not a count**, because the caller has
 * to know WHICH ones were new: a hard bounce or a complaint raises an alarm, and raising it again
 * on every redelivery would turn Resend's ten-hour retry schedule into six copies of the same
 * incident. Returning the set makes "report only what is new" a fact the caller reads rather than
 * a rule it has to remember.
 */
export async function recordMailEvents(
  db: Db,
  input: { providerEventId: string; events: readonly MailEvent[] },
): Promise<Set<string>> {
  if (input.events.length === 0) return new Set();

  const inserted = await db
    .insert(mailEvents)
    .values(
      input.events.map((event) => ({
        providerEventId: input.providerEventId,
        kind: event.kind,
        email: event.email,
        bounceType: event.bounceType,
        detail: event.detail,
        providerMessageId: event.providerMessageId,
        occurredAt: event.occurredAt,
      })),
    )
    /*
     * Named, not bare. The table carries one unique index today, so an untargeted
     * `onConflictDoNothing` behaves identically - and would go on silently swallowing a
     * constraint added later, which is the shape of a write that appears to succeed and records
     * nothing. Same reasoning as `fileReport`.
     */
    .onConflictDoNothing({ target: [mailEvents.providerEventId, mailEvents.email] })
    .returning({ email: mailEvents.email });

  return new Set(inserted.map((row) => row.email));
}
