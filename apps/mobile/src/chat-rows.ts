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

import { SYSTEM_ACTOR_ID, type MessageEnvelope, type MessageReplyRef } from '@clubchat/shared';
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

/**
 * How long a silence has to be before the same person is introduced again.
 *
 * **An hour, and the number came off a photograph rather than off a convention.** The founder
 * circled a repeated face and name in a direct message on 2026-08-27; the two messages under it
 * were 19 minutes apart. Five minutes is what GroupMe, WhatsApp and iMessage roughly use, and it
 * would have drawn the header exactly where he circled it. An hour groups his case and still
 * re-introduces somebody who wrote in the morning and again after lunch, which is a different
 * moment and should read as one.
 */
export const RUN_GAP_MS = 60 * 60 * 1000;

/**
 * What the list calls this row.
 *
 * **Here rather than in the screen, because two things now need the same answer.** The `FlatList`
 * keys rows by it and `decideRunStarts` reports by it, and the second time a rule is written out
 * is when to extract it - `AGENTS.md` failure mode 10 is a `WHERE` clause that was written four
 * times and stayed individually correct in each copy.
 */
export function rowKey(row: Row): string {
  switch (row.kind) {
    case 'message':
      return `m-${row.message.seq}`;
    case 'pending':
      return `p-${row.clientMsgId}`;
    case 'day':
      return `d-${row.dateKey}`;
    case 'lastRead':
      return 'last-read';
  }
}

/** What a message row puts on screen, which is what decides whether it can be part of a run. */
type Draw =
  /** A bubble or a card with a face and a name over it. Only these can start or continue a run. */
  | 'attributed'
  /** Something full width and unsided: a system line, a tombstone, an announcement. Breaks a run. */
  | 'interrupting'
  /** Nothing at all. A deleted CARD draws no tombstone, so it must not break what it sits inside. */
  | 'invisible';

function isCard(message: MessageEnvelope): boolean {
  return (
    (message.linkedPollId ?? null) !== null ||
    (message.linkedEventId ?? null) !== null ||
    (message.linkedMeetingId ?? null) !== null
  );
}

/**
 * Mirrors the branches at the top of `MessageRow`, and has to keep mirroring them.
 *
 * Every case here is a shape that screen already renders differently: a system message is centred
 * and unattributed, a deleted message leaves a tombstone, a deleted card leaves nothing, an
 * announcement is v1's full-width card with its own sender line inside it. If a new branch is
 * added there without one here, the grouping will draw a face over something that is not a bubble
 * or omit one from something that is.
 */
function drawOf(message: MessageEnvelope): Draw {
  if ((message.deletedAt ?? null) !== null) return isCard(message) ? 'invisible' : 'interrupting';
  if (message.senderId === SYSTEM_ACTOR_ID) return 'interrupting';
  if (message.type === 'announcement') return 'interrupting';
  return 'attributed';
}

/**
 * Which rows draw a face and a name, given that a spell from one person only needs one.
 *
 * > **The rule came off a photograph of a DIRECT MESSAGE** - a conversation with two people in it,
 * > naming both of them on every single line, the second "Parks RPK" circled in yellow. The face
 * > and name row costs 40pt of avatar plus 8pt of padding on every message in the product,
 * > whoever sent it and however recently they last spoke.
 *
 * **There is one rule and it has no branches.** Not one for a DM and another for a group chat, and
 * not one for the reader and another for everybody else: all three were offered as options on
 * 2026-08-27 and all three were declined in favour of the same treatment everywhere. So this
 * function never asks who is reading except to identify an optimistic row, which has no sender of
 * its own to read.
 *
 * A run ends on any of four things, and each of them is something the reader can see:
 *
 *  1. **A different person speaks.** The obvious one.
 *  2. **Something full width sits between**, because it does: a date heading, the "Last read" rule,
 *     a system line, a tombstone, an announcement, or a poll, event or meeting card. After any of
 *     those the next bubble has to say who is speaking again, and a card additionally heads a run
 *     of its own - it carries its own attribution and is not part of anybody's spell of talking.
 *  3. **An hour passes.** See `RUN_GAP_MS` for why an hour and not five minutes.
 *  4. **Nothing else.** In particular a message that draws nothing - a deleted card - is
 *     transparent: the bubbles either side of it are visually adjacent, so putting a face between
 *     them would introduce somebody in the middle of their own sentence.
 *
 * Takes the built, newest-first list because that is what the screen holds, and walks it
 * **chronologically** anyway, for the reason `buildChatRows` gives: reasoning about a list that
 * reads bottom-upwards is where an off-by-one hides in plain sight.
 */
export function decideRunStarts(
  displayed: readonly Row[],
  options: { viewerId: string | null; now?: Date; gapMs?: number },
): ReadonlySet<string> {
  const gapMs = options.gapMs ?? RUN_GAP_MS;
  const nowMs = (options.now ?? new Date()).getTime();
  const starts = new Set<string>();
  /** The last row that could be spoken over, or null when something has broken the spell. */
  let previous: { sender: string; at: number } | null = null;

  for (const row of [...displayed].reverse()) {
    if (row.kind === 'day' || row.kind === 'lastRead') {
      previous = null;
      continue;
    }

    /*
     * An optimistic row is always the reader's own and carries no sender and no timestamp: it is
     * being sent right now. So it is compared against the CLOCK rather than against a time it does
     * not have, which is what stops it adopting an hour-old message of your own.
     */
    if (row.kind === 'pending') {
      const sender = options.viewerId;
      const continues =
        sender !== null &&
        previous !== null &&
        previous.sender === sender &&
        nowMs - previous.at <= gapMs;
      if (!continues) starts.add(rowKey(row));
      // Nothing to compare the next row against when the session has not resolved yet.
      previous = sender === null ? null : { sender, at: nowMs };
      continue;
    }

    const draw = drawOf(row.message);
    if (draw === 'invisible') continue;
    if (draw === 'interrupting') {
      previous = null;
      continue;
    }

    if (isCard(row.message)) {
      starts.add(rowKey(row));
      previous = null;
      continue;
    }

    const sender = row.message.senderId;
    const at = Date.parse(row.message.createdAt);
    const continues = previous !== null && previous.sender === sender && at - previous.at <= gapMs;
    if (!continues) starts.add(rowKey(row));
    previous = { sender, at };
  }

  return starts;
}
