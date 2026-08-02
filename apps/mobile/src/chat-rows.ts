/**
 * What the chat list actually renders, and where the markers go in it.
 *
 * Extracted from the chat screen because this is the part that keeps being wrong. It is pure
 * arithmetic over a list - no hooks, no rendering - and inside a 3,400 line component it had no
 * way to be tested, so both of its bugs shipped and were found by eye on a phone.
 *
 * ---
 *
 * **"Last read" marks what was unread WHEN THE SCREEN OPENED, and nothing else, ever.**
 *
 * > The first version compared every message against the entry cursor as the list changed, which
 * > is a different rule wearing the same clothes: the cursor is frozen at arrival, so a message
 * > sent one minute later has a higher `seq` and counts as unread against it. Open a chat you are
 * > caught up on, type anything, and the rule appeared above your own message - announcing that
 * > you had not read the thing you had just written.
 *
 * So the anchor is a **decision**, taken once on arrival and passed in here, rather than a
 * comparison this function re-runs. Once it is null it stays null for the visit: nothing that
 * arrives afterwards can make a rule appear, because nothing that arrives afterwards was unread
 * when you got here. A message from somebody else lands below the rule where it belongs, and the
 * "N new messages" control is what announces it.
 */

import type { MessageEnvelope, MessageReplyRef } from '@clubchat/shared';
import { toDateKey } from './dates.ts';

export type Row =
  | { kind: 'message'; message: MessageEnvelope }
  /** An optimistic row from the send outbox, not yet acked. */
  | {
      kind: 'pending';
      clientMsgId: string;
      body: string;
      failed: boolean;
      /** Mirrors the outbox entry, announcements included - see `store.ts`. */
      type: 'text' | 'photo' | 'document' | 'announcement';
      /** Renders the photo the sender just picked, before any round trip. */
      localUri?: string | undefined;
      documentName?: string | undefined;
      documentSize?: number | undefined;
      /** The quote to draw before the ack lands. Local only - see `PendingSend.replyTo`. */
      replyTo?: MessageReplyRef | undefined;
    }
  /**
   * The "Last read" rule, drawn above the first message that was unread on arrival.
   *
   * Carries nothing: where it sits is the entire content, so there is nothing to put on it.
   */
  | { kind: 'lastRead' }
  /** A day's heading, above the first message sent on that local date. */
  | { kind: 'day'; dateKey: string };

/**
 * The one and only "Last read" row.
 *
 * **A module constant, so its identity survives every rebuild of the list**, which is what makes
 * it safe to hold. The arrival remembers its target row and re-applies it as cards and photos
 * finish measuring, and it finds that row by `indexOf` - so a target rebuilt into a fresh object
 * on the next render silently stops being found and the placement quietly gives up. A message row
 * has that hazard by nature; this one does not have to.
 */
export const LAST_READ_ROW: Row = { kind: 'lastRead' };

/**
 * Which message the "Last read" rule belongs above, decided once from the cursor at arrival.
 *
 * Returns null for "draw no rule at all this visit", which covers three cases that are one case:
 * the reader was caught up, the cursor is not known yet, or every message in hand is unread
 * because they have never opened this conversation - and a rule at the very top of history claims
 * "everything below is new" about a chat that has simply never been read.
 */
export function decideLastReadAnchor(
  rows: readonly Row[],
  entryLastReadSeq: number | null,
): number | null {
  if (entryLastReadSeq === null) return null;

  const messages = rows.filter((row) => row.kind === 'message');
  const firstUnread = messages.find((row) => row.message.seq > entryLastReadSeq);
  if (!firstUnread || firstUnread.kind !== 'message') return null;

  // Nothing above it means nothing was read: see the note above.
  if (messages[0]?.kind === 'message' && messages[0].message.seq === firstUnread.message.seq) {
    return null;
  }
  return firstUnread.message.seq;
}

/**
 * The rows the inverted list wants: newest first, with the day headings and the rule in place.
 *
 * **Built in chronological order and reversed at the end.** Doing it the other way means
 * reasoning about a list that reads bottom-upwards, which is where an off-by-one hides in plain
 * sight. Neither marker is written back into the caller's own array: that is what history is, and
 * the pinned strip, the jump lookup and the unread arithmetic all read it without needing to know
 * a marker might be sitting in the middle.
 */
export function buildChatRows(
  rows: readonly Row[],
  options: { lastReadAnchor: number | null; now?: Date },
): Row[] {
  const today = toDateKey(options.now ?? new Date());
  const out: Row[] = [];
  let previousDay: string | null = null;

  for (const row of rows) {
    // A pending row has no timestamp yet - it is being sent right now, so it belongs to today.
    const dayKey =
      row.kind === 'message' ? toDateKey(new Date(row.message.createdAt)) : today;

    if (dayKey !== previousDay) {
      out.push({ kind: 'day', dateKey: dayKey });
      previousDay = dayKey;
    }

    /*
     * The day heading comes FIRST where both land on the same message, which is the order the
     * two facts are true in: the reader crossed into a new day, and then into what they had not
     * read. Reversed, that draws the date above the rule above the message.
     */
    if (
      options.lastReadAnchor !== null &&
      row.kind === 'message' &&
      row.message.seq === options.lastReadAnchor
    ) {
      out.push(LAST_READ_ROW);
    }

    out.push(row);
  }

  return out.reverse();
}
