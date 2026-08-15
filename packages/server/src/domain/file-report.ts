/**
 * Filing a report, with no opinion at all about who may file one.
 *
 * > **Extracted so there is exactly one answer to "what happens when a message is reported".**
 * > There are two callers now - a member pressing Report (`reportMessage`) and the content
 * > filter flagging a term it will not judge (`sendMessage`) - and a second hand-written copy
 * > of the body would be failure mode 9 with the row, the conflict absorption and the outbox
 * > event as the three things that silently drift apart.
 *
 * The same shape as `applySoftDelete`, and for the same reason: the mechanism lives in one
 * place, the authorization lives at each entry point, and a caller with extra work that must
 * land atomically supplies the transaction.
 *
 * It lives in its own module rather than beside `reportMessage` because `moderation.ts` already
 * imports from `send-message.ts`, and putting it there would make the two import each other.
 */

import { outbox, messageReports } from '../db/schema.ts';
import type { DbTx } from './send-message.ts';

/**
 * Write the report row and the event that tells somebody about it, in the caller's transaction.
 *
 * **Idempotent by the primary key**, which is what makes PRD/05 rule 10 - "reporting twice is a
 * no-op" - a property of the data rather than a check a caller could forget.
 *
 * **Only a report that was actually created emits an event.** A repeat by the same reporter is
 * absorbed by the primary key and must not buzz anybody a second time, which for the automatic
 * caller also means a retried send cannot re-notify a room.
 *
 * @returns whether a new report row was created.
 */
export async function fileReport(
  tx: DbTx,
  args: { messageId: string; reporterId: string; channelId: string; seq: number },
): Promise<boolean> {
  const rows = await tx
    .insert(messageReports)
    .values({ messageId: args.messageId, reporterId: args.reporterId })
    // Named, not bare. The table happens to carry one unique constraint today, so an untargeted
    // clause behaves identically - and that is exactly the state the car-group defect was in
    // before somebody added the second one. Naming it is the difference between "ignore a repeat
    // report" and "ignore whatever this table starts enforcing next".
    .onConflictDoNothing({ target: [messageReports.messageId, messageReports.reporterId] })
    .returning({ messageId: messageReports.messageId });

  if (rows.length === 0) return false;

  await tx.insert(outbox).values({
    partitionKey: args.channelId,
    eventType: 'message.reported',
    payload: {
      channelId: args.channelId,
      messageId: args.messageId,
      seq: args.seq,
      reporterId: args.reporterId,
    },
  });

  return true;
}
