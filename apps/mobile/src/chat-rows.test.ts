/**
 * Where the markers go, and - mostly - where they must not.
 *
 * The rule this file exists for: **"Last read" marks what was unread when the screen opened, and
 * nothing else, ever.** The first implementation compared every message against the entry cursor
 * as the list changed, so sending a message into a chat you were caught up on drew the rule above
 * your own message. It was found by eye on a phone, because this arithmetic lived inside a 3,400
 * line component and could not be tested.
 */

import { describe, expect, it } from 'vitest';
import type { MessageEnvelope } from '@clubchat/shared';
import { buildChatRows, decideLastReadAnchor, type Row } from './chat-rows.ts';

/** A message row, with only the fields this module reads. */
function message(seq: number, createdAt = '2026-08-01T12:00:00.000Z'): Row {
  return { kind: 'message', message: { seq, createdAt } as MessageEnvelope };
}

const kinds = (rows: readonly Row[]) => rows.map((row) => row.kind);
/** The rows as the reader sees them top-to-bottom, which is the reverse of an inverted list. */
const asDisplayed = (rows: readonly Row[]) => [...rows].reverse();

describe('deciding where the rule goes', () => {
  it('puts it above the first message that was unread on arrival', () => {
    const rows = [message(1), message(2), message(3)];
    expect(decideLastReadAnchor(rows, 1)).toBe(2);
  });

  it('draws nothing when the reader was already caught up', () => {
    const rows = [message(1), message(2)];
    expect(decideLastReadAnchor(rows, 2)).toBeNull();
  });

  it('draws nothing when the cursor is not known yet', () => {
    // A cold open reaches the screen before the channel list has synced. "Cannot prove otherwise"
    // has to mean no rule, not a rule in the wrong place.
    expect(decideLastReadAnchor([message(1), message(2)], null)).toBeNull();
  });

  it('draws nothing above the very first message in history', () => {
    // Never opened this conversation: a rule at the top says "everything below is new" about a
    // chat that has simply never been read, which is not what it means.
    expect(decideLastReadAnchor([message(1), message(2)], 0)).toBeNull();
  });
});

describe('the rule does not follow the conversation', () => {
  /*
   * THE BUG, as reported: open a chat you are caught up on, type something, and the rule appeared
   * above the message you had just written - announcing that you had not read your own message.
   *
   * The anchor is a decision taken once on arrival. Once it is null it stays null, so nothing
   * that arrives afterwards can make a rule appear.
   */
  it('never appears because the reader sent a message', () => {
    const onArrival = [message(1), message(2)];
    const anchor = decideLastReadAnchor(onArrival, 2);
    expect(anchor).toBeNull();

    const afterTyping: Row[] = [
      ...onArrival,
      { kind: 'pending', clientMsgId: 'c1', body: 'hi', failed: false, type: 'text' },
      message(3),
    ];
    expect(kinds(buildChatRows(afterTyping, { lastReadAnchor: anchor }))).not.toContain('lastRead');
  });

  it('never appears because somebody else sent one while the screen was open', () => {
    const anchor = decideLastReadAnchor([message(1), message(2)], 2);
    const later = [message(1), message(2), message(3), message(4)];
    expect(kinds(buildChatRows(later, { lastReadAnchor: anchor }))).not.toContain('lastRead');
  });

  it('stays put when messages arrive under it', () => {
    // It marked seq 2 on arrival and it goes on marking seq 2, however much lands afterwards.
    const anchor = decideLastReadAnchor([message(1), message(2)], 1);
    expect(anchor).toBe(2);

    const displayed = asDisplayed(
      buildChatRows([message(1), message(2), message(3)], { lastReadAnchor: anchor }),
    );
    const ruleAt = displayed.findIndex((row) => row.kind === 'lastRead');
    const seqAfterRule = displayed[ruleAt + 1];
    expect(seqAfterRule?.kind === 'message' && seqAfterRule.message.seq).toBe(2);
  });
});

describe('day headings', () => {
  const now = new Date(2026, 7, 1, 12);

  it('opens each local date once, and only once', () => {
    const rows = [
      message(1, new Date(2026, 6, 31, 9).toISOString()),
      message(2, new Date(2026, 6, 31, 18).toISOString()),
      message(3, new Date(2026, 7, 1, 9).toISOString()),
    ];
    const displayed = asDisplayed(buildChatRows(rows, { lastReadAnchor: null, now }));
    expect(kinds(displayed)).toEqual(['day', 'message', 'message', 'day', 'message']);
  });

  it('puts the date above the rule where both land on the same message', () => {
    // The order the two facts are true in: crossed into a new day, then into what was unread.
    const rows = [
      message(1, new Date(2026, 6, 31, 9).toISOString()),
      message(2, new Date(2026, 7, 1, 9).toISOString()),
    ];
    const anchor = decideLastReadAnchor(rows, 1);
    expect(anchor).toBe(2);

    const displayed = asDisplayed(buildChatRows(rows, { lastReadAnchor: anchor, now }));
    expect(kinds(displayed)).toEqual(['day', 'message', 'day', 'lastRead', 'message']);
  });

  it('files a pending send under today, since it is being sent right now', () => {
    const rows: Row[] = [
      message(1, new Date(2026, 6, 31, 9).toISOString()),
      { kind: 'pending', clientMsgId: 'c1', body: 'hi', failed: false, type: 'text' },
    ];
    const displayed = asDisplayed(buildChatRows(rows, { lastReadAnchor: null, now }));
    expect(kinds(displayed)).toEqual(['day', 'message', 'day', 'pending']);
  });
});
