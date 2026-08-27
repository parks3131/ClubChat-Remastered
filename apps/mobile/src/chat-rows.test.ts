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
import { SYSTEM_ACTOR_ID } from '@clubchat/shared';
import {
  buildChatRows,
  decideLastReadAnchor,
  decideRunStarts,
  LAST_READ_ROW,
  rowKey,
  type Row,
} from './chat-rows.ts';

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

/**
 * Runs: the face and the name are drawn once for a spell of messages, not once per message.
 *
 * **The rule came off a photograph.** The founder circled a second "Parks RPK" and avatar in a
 * DIRECT MESSAGE - a conversation with two people in it, naming both of them on every line - and
 * the two messages under it were **19 minutes apart**. That single fact settles the shape of this:
 * the 5-minute break most chat apps use would have repeated the header exactly where he circled
 * it, so the gap here is an hour.
 *
 * The other three answers he gave are all "no special cases": the same rule in a DM as in a group
 * chat, and the same rule for his own messages as for everybody else's. There is one rule in this
 * file and no branches on who is reading.
 */
describe('runs of consecutive messages', () => {
  const ALICE = '11111111-1111-4111-8111-111111111111';
  const BOB = '22222222-2222-4222-8222-222222222222';
  const NOON = Date.UTC(2026, 7, 1, 12, 0, 0);

  /** A message `minutes` after noon, from `senderId`. UTC noon so no local day boundary is near. */
  function from(
    seq: number,
    senderId: string,
    minutes = 0,
    extra: Partial<MessageEnvelope> = {},
  ): Row {
    return {
      kind: 'message',
      message: {
        seq,
        senderId,
        createdAt: new Date(NOON + minutes * 60_000).toISOString(),
        type: 'text',
        deletedAt: null,
        linkedPollId: null,
        linkedEventId: null,
        linkedMeetingId: null,
        ...extra,
      } as MessageEnvelope,
    };
  }

  const pending = (clientMsgId: string): Row => ({
    kind: 'pending',
    clientMsgId,
    body: 'hi',
    failed: false,
    type: 'text',
  });

  /** What the reader actually sees: which rows draw a face and a name. */
  const starters = (rows: readonly Row[], viewerId: string | null = ALICE) => {
    const built = buildChatRows(rows, { lastReadAnchor: null, now: new Date(NOON) });
    const set = decideRunStarts(built, { viewerId, now: new Date(NOON) });
    return built
      .filter((row) => row.kind === 'message' || row.kind === 'pending')
      .filter((row) => set.has(rowKey(row)))
      .map((row) => rowKey(row))
      .sort();
  };

  it('draws the header once for a spell from one person', () => {
    expect(starters([from(1, BOB, 0), from(2, BOB, 2), from(3, BOB, 4)])).toEqual(['m-1']);
  });

  /*
   * The five minutes are measured from the run's FIRST message, not from the previous one.
   *
   * Measured from the previous one, a chain of four-minute messages would run for an hour under a
   * header still claiming the hour's first minute - which is precisely the staleness that moving
   * the clock into the header was supposed to end. Every bubble under a header is within five
   * minutes of what that header says, and this is the test that keeps it true.
   */
  it('measures the five minutes from the start of the run, not from the last message', () => {
    expect(starters([from(1, BOB, 0), from(2, BOB, 4), from(3, BOB, 8)])).toEqual(['m-1', 'm-3']);
  });

  it('keeps four minutes inside one run', () => {
    expect(starters([from(1, BOB, 0), from(2, BOB, 4)])).toEqual(['m-1']);
  });

  it('starts a new run after five minutes of silence', () => {
    expect(starters([from(1, BOB, 0), from(2, BOB, 6)])).toEqual(['m-1', 'm-2']);
  });

  /*
   * **The pair from the photograph, and it SPLITS.** 12:12 and 12:31 are 19 minutes apart, and the
   * second header is the one he circled in yellow as the thing to remove.
   *
   * It is asserted here rather than left implicit because it is the one case where the shipped
   * behaviour disagrees with the report that started the work, and that disagreement is a decision
   * rather than a regression: the founder moved the clock into the run header on 2026-08-27, was
   * told in as many words that five minutes puts a header back exactly where he circled one, and
   * chose it. A header that repeats is a smaller price than a header whose time is not true.
   *
   * So if this test ever fails, the question to ask is not "did grouping break" but "did somebody
   * lengthen `RUN_GAP_MS` without moving the clock back into the bubbles".
   */
  it('splits the nineteen minutes from the photograph, which is deliberate', () => {
    expect(starters([from(1, BOB, 12), from(2, BOB, 31)])).toEqual(['m-1', 'm-2']);
  });

  it('starts a new run whenever the speaker changes', () => {
    expect(starters([from(1, BOB, 0), from(2, ALICE, 1), from(3, BOB, 2)])).toEqual([
      'm-1',
      'm-2',
      'm-3',
    ]);
  });

  /*
   * No branch on who is reading. He was offered the option of dropping his own name and face
   * entirely and chose to keep them, once per run, exactly like everybody else's.
   */
  it('treats the reader own messages the same as anybody else', () => {
    expect(starters([from(1, ALICE, 0), from(2, ALICE, 3)])).toEqual(['m-1']);
  });

  it('starts a new run under a date heading', () => {
    // A day apart, so `buildChatRows` puts a heading between them. Something full width sat in
    // the gap, so the next bubble has to say who is speaking again.
    expect(starters([from(1, BOB, 0), from(2, BOB, 24 * 60)])).toEqual(['m-1', 'm-2']);
  });

  it('starts a new run under the Last read rule', () => {
    const rows = [from(1, BOB, 0), from(2, BOB, 1)];
    const built = buildChatRows(rows, { lastReadAnchor: 2, now: new Date(NOON) });
    const set = decideRunStarts(built, { viewerId: ALICE, now: new Date(NOON) });
    expect(set.has('m-2')).toBe(true);
  });

  it('starts a new run under a system message', () => {
    const joined = from(2, SYSTEM_ACTOR_ID, 1, { body: 'Casey joined the club' });
    expect(starters([from(1, BOB, 0), joined, from(3, BOB, 2)])).toEqual(['m-1', 'm-3']);
  });

  it('starts a new run under an announcement, which draws its own sender line', () => {
    const shout = from(2, BOB, 1, { type: 'announcement' });
    expect(starters([from(1, BOB, 0), shout, from(3, BOB, 2)])).toEqual(['m-1', 'm-3']);
  });

  it('starts a new run under a tombstone', () => {
    const gone = from(2, BOB, 1, { deletedAt: new Date(NOON).toISOString() });
    expect(starters([from(1, BOB, 0), gone, from(3, BOB, 2)])).toEqual(['m-1', 'm-3']);
  });

  /*
   * A card is full width and carries its own attribution, so it always heads its own run AND the
   * next message starts one - there is a whole card between them.
   */
  it('gives a card its own run, on both sides of it', () => {
    const poll = from(2, BOB, 1, { linkedPollId: 'p1' });
    expect(starters([from(1, BOB, 0), poll, from(3, BOB, 2)])).toEqual(['m-1', 'm-2', 'm-3']);
  });

  /*
   * A DELETED card renders nothing at all - not even a tombstone, because a card has no replies
   * to leave dangling. Nothing is drawn, so nothing should break: two messages either side of it
   * are visually adjacent, and giving the second one a header would put a face in the middle of a
   * run for a row the reader cannot see.
   */
  it('is not broken by a deleted card, which draws nothing', () => {
    const goneCard = from(2, BOB, 1, {
      linkedPollId: 'p1',
      deletedAt: new Date(NOON).toISOString(),
    });
    expect(starters([from(1, BOB, 0), goneCard, from(3, BOB, 2)])).toEqual(['m-1']);
  });

  it('groups a message being sent with the reader own previous one', () => {
    expect(starters([from(1, ALICE, 0), pending('c1')])).toEqual(['m-1']);
  });

  it('starts a run for a message being sent after somebody else spoke', () => {
    expect(starters([from(1, BOB, 0), pending('c1')])).toEqual(['m-1', 'p-c1']);
  });

  it('groups consecutive messages being sent', () => {
    expect(starters([from(1, ALICE, 0), pending('c1'), pending('c2')])).toEqual(['m-1']);
  });

  /*
   * A send is happening NOW, so it is compared against the clock rather than against a timestamp
   * it does not have yet. An hour-old message of your own does not adopt it.
   */
  it('does not group a send with a message of the reader own from ten minutes ago', () => {
    const rows = [from(1, ALICE, 0), pending('c1')];
    const built = buildChatRows(rows, { lastReadAnchor: null, now: new Date(NOON + 10 * 60_000) });
    const set = decideRunStarts(built, {
      viewerId: ALICE,
      now: new Date(NOON + 10 * 60_000),
    });
    expect(set.has('p-c1')).toBe(true);
  });

  it('names rows the way the list already keys them', () => {
    expect(rowKey(from(7, BOB))).toBe('m-7');
    expect(rowKey(pending('abc'))).toBe('p-abc');
    expect(rowKey({ kind: 'day', dateKey: '2026-08-01' })).toBe('d-2026-08-01');
    expect(rowKey(LAST_READ_ROW)).toBe('last-read');
  });
});
