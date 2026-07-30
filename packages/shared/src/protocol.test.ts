import { describe, expect, it } from 'vitest';
import { decideGap } from './protocol.ts';
import { unreadCount } from './domain.ts';

describe('decideGap', () => {
  it('appends in-order messages without syncing', () => {
    expect(decideGap(4, 3)).toEqual({ action: 'append', syncAfter: false });
  });

  it('ignores a seq already held', () => {
    expect(decideGap(3, 3)).toEqual({ action: 'ignore', syncAfter: false });
    expect(decideGap(1, 3)).toEqual({ action: 'ignore', syncAfter: false });
  });

  it('appends AND syncs when a hole exists behind the arriving message', () => {
    // The asymmetry that matters: the message is not dropped. A send that
    // succeeded must not vanish from the UI, so it is appended and the sync
    // backfills the hole behind it.
    expect(decideGap(6, 3)).toEqual({ action: 'append', syncAfter: true });
  });

  it('treats the first message in an empty channel as in order', () => {
    expect(decideGap(1, 0)).toEqual({ action: 'append', syncAfter: false });
  });

  // The scenario SPEC/TECH/08-client-architecture.md exists to make impossible.
  // Reproduced as a test because the failure is permanent and silent: without the
  // gap check on the ack path, every later message satisfies local_max + 1 and the
  // client never discovers the hole.
  it('does not leave a permanent hole when the gap arrives on the client own ack', () => {
    let localMax = 3;
    const holes: number[] = [];

    const apply = (seq: number) => {
      const decision = decideGap(seq, localMax);
      if (decision.action === 'append') {
        if (seq > localMax + 1) {
          for (let missing = localMax + 1; missing < seq; missing += 1) holes.push(missing);
        }
        localMax = seq;
      }
      return decision;
    };

    // seq 4 was missed while the socket flapped. The client's own send acks at 5.
    const ack = apply(5);
    expect(ack).toEqual({ action: 'append', syncAfter: true });
    expect(holes).toEqual([4]);

    // Sync backfills 4. The client is genuinely caught up, not merely convinced of it.
    holes.length = 0;

    // A later live message at 6 is now in order and requires no further sync.
    expect(apply(6)).toEqual({ action: 'append', syncAfter: false });
    expect(holes).toEqual([]);
  });
});

describe('unreadCount', () => {
  it('is the difference between the channel head and the read cursor', () => {
    expect(unreadCount({ lastSeq: 10, lastReadSeq: 7 })).toBe(3);
  });

  it('is zero when caught up', () => {
    expect(unreadCount({ lastSeq: 10, lastReadSeq: 10 })).toBe(0);
  });

  it('never goes negative if a cursor somehow runs ahead of the head', () => {
    expect(unreadCount({ lastSeq: 10, lastReadSeq: 12 })).toBe(0);
  });
});
