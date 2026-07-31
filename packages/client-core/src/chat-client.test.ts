/**
 * Client tests for the gap rule as APPLIED, not merely as defined.
 *
 * `decideGap` has its own unit tests in @clubchat/shared. What those cannot prove is
 * that ChatClient actually routes the `msg.ack` path through it - and that is where the
 * bug SPEC/TECH/08-client-architecture.md warns about lives. The scenario is
 * constructed deterministically here rather than hoped for in an integration test,
 * because the failure is silent and permanent: a client that skips the check believes
 * it is caught up forever after, with no error anywhere.
 */

import { describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '@clubchat/shared';
import { ChatClient, type SocketLike } from './chat-client.ts';
import { findGaps } from './store.ts';

const CHANNEL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = '11111111-1111-4111-8111-111111111111';

/** A socket whose inbound frames the test controls exactly. */
class FakeSocket implements SocketLike {
  readyState = 1;
  onopen: ((this: unknown, ev: unknown) => void) | null = null;
  onmessage: ((this: unknown, ev: { data: unknown }) => void) | null = null;
  onclose: ((this: unknown, ev: unknown) => void) | null = null;
  onerror: ((this: unknown, ev: unknown) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.call(this, {});
  }

  /** Push a frame from the "server". */
  deliver(frame: unknown): void {
    this.onmessage?.call(this, { data: JSON.stringify(frame) });
  }

  open(): void {
    this.onopen?.call(this, {});
  }
}

function envelope(seq: number, overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: crypto.randomUUID(),
    channelId: CHANNEL,
    seq,
    senderName: null,
  senderId: 'someone-else',
    type: 'text',
    body: `message ${seq}`,
    clientMsgId: crypto.randomUUID(),
    pinned: false,
    reactions: [],
    mediaId: null,
    linkedPollId: null,
    documentName: null,
    documentSize: null,
    deletedAt: null,
    createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    ...overrides,
  };
}

type Fixture = {
  client: ChatClient;
  socket: FakeSocket;
  syncCalls: string[];
  /** Messages the fake /sync endpoint will hand back. */
  backlog: MessageEnvelope[];
};

async function setup(): Promise<Fixture> {
  const socket = new FakeSocket();
  const syncCalls: string[] = [];
  const backlog: MessageEnvelope[] = [];

  const fetchImpl = vi.fn(async (input: unknown) => {
    const url = String(input);
    syncCalls.push(url);
    const since = Number(url.split('%3A').pop() ?? url.split(':').pop());
    const toSend = backlog.filter((message) => message.seq > since);
    return new Response(
      JSON.stringify({
        channels: [{ channelId: CHANNEL, messages: toSend, hasMore: false }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  const client = new ChatClient({
    wsUrl: 'ws://test',
    apiUrl: 'http://test',
    token: 'token',
    deviceId: '22222222-2222-4222-8222-222222222222',
    platform: 'ios',
    createSocket: () => socket,
    fetchImpl,
  });

  const connected = client.connect();
  socket.open();
  socket.deliver({
    t: 'auth.ok',
    d: {
      sessionId: 'sess',
      userId: USER,
      serverTime: new Date(2026, 0, 1).toISOString(),
      channels: [{ id: CHANNEL, scope: 'club', clubId: 'club', lastSeq: 0, lastReadSeq: 0 }],
    },
  });
  await connected;

  return { client, socket, syncCalls, backlog };
}

describe('ChatClient applies the gap rule', () => {
  it('appends in-order live messages without syncing', async () => {
    const { client, socket, syncCalls } = await setup();

    socket.deliver({ t: 'msg.new', d: envelope(1) });
    socket.deliver({ t: 'msg.new', d: envelope(2) });
    await vi.waitFor(async () =>
      expect(await client.store.seqs(CHANNEL)).toEqual([1, 2]),
    );

    expect(syncCalls, 'no sync should be needed for in-order delivery').toHaveLength(0);
  });

  it('syncs when a live message arrives past a hole', async () => {
    const { client, socket, syncCalls, backlog } = await setup();

    socket.deliver({ t: 'msg.new', d: envelope(1) });
    // 2 is withheld, so 3 arrives past a hole.
    backlog.push(envelope(2));
    socket.deliver({ t: 'msg.new', d: envelope(3) });

    await vi.waitFor(() => expect(syncCalls.length).toBeGreaterThan(0));
    await vi.waitFor(async () =>
      expect(await client.store.seqs(CHANNEL)).toEqual([1, 2, 3]),
    );
    expect(findGaps(await client.store.seqs(CHANNEL))).toEqual([]);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * Local max is 1. Seq 2 is missed while the socket flaps. The client then sends its
   * OWN message, which acks at seq 3. If the ack path skips the gap check, the client
   * appends at 3, sets local max to 3, and holds a permanent hole at 2 - permanent
   * because every later msg.new at 4 satisfies local_max + 1 and never triggers a sync.
   */
  it('syncs when the gap arrives on its own msg.ack, not just on msg.new', async () => {
    const { client, socket, syncCalls, backlog } = await setup();

    socket.deliver({ t: 'msg.new', d: envelope(1) });
    await vi.waitFor(async () => expect(await client.store.localMaxSeq(CHANNEL)).toBe(1));

    // Seq 2 exists on the server but never reached this client.
    backlog.push(envelope(2));

    // Our own send, acked at 3.
    const clientMsgId = client.enqueue(CHANNEL, 'my own message');
    const acked = client.flushOne(clientMsgId);
    socket.deliver({
      t: 'msg.ack',
      d: {
        clientMsgId,
        messageId: crypto.randomUUID(),
        channelId: CHANNEL,
        seq: 3,
        createdAt: new Date(2026, 0, 1, 0, 0, 3).toISOString(),
      },
    });
    await expect(acked).resolves.toBe(3);

    // The ack must have triggered reconciliation.
    await vi.waitFor(() =>
      expect(syncCalls.length, 'the ack path did not gap-check').toBeGreaterThan(0),
    );

    const seqs = await client.store.seqs(CHANNEL);
    // Our own message is still here - a send that succeeded must not vanish from the UI.
    expect(seqs).toContain(3);
    // And the hole behind it was backfilled.
    expect(seqs).toEqual([1, 2, 3]);
    expect(findGaps(seqs), 'a permanent hole survived the ack').toEqual([]);

    // A later in-order message needs no further sync, which is what makes the hole
    // permanent if it was never caught.
    const before = syncCalls.length;
    socket.deliver({ t: 'msg.new', d: envelope(4) });
    await vi.waitFor(async () =>
      expect(await client.store.localMaxSeq(CHANNEL)).toBe(4),
    );
    expect(syncCalls.length).toBe(before);
  });

  it('ignores a duplicate seq, so a sender own msg.new after its ack is a no-op', async () => {
    // The sender is subscribed to the same channel, so it receives its own message back
    // over the fan-out after already applying the ack. The spec wants no server-side
    // special casing for this: the gap rule drops it.
    const { client, socket } = await setup();

    const clientMsgId = client.enqueue(CHANNEL, 'mine');
    const acked = client.flushOne(clientMsgId);
    socket.deliver({
      t: 'msg.ack',
      d: {
        clientMsgId,
        messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        channelId: CHANNEL,
        seq: 1,
        createdAt: new Date(2026, 0, 1).toISOString(),
      },
    });
    await acked;

    socket.deliver({
      t: 'msg.new',
      d: envelope(1, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', clientMsgId }),
    });

    await vi.waitFor(async () => expect(await client.store.seqs(CHANNEL)).toEqual([1]));
  });
});

describe('the send outbox', () => {
  it('generates client_msg_id once and reuses it across retries', async () => {
    const { client, socket } = await setup();

    const clientMsgId = client.enqueue(CHANNEL, 'retry me');
    void client.flushOne(clientMsgId).catch(() => undefined);
    void client.flushOne(clientMsgId).catch(() => undefined);

    const sends = socket.sent.filter((frame) => frame['t'] === 'msg.send');
    expect(sends).toHaveLength(2);
    // Both attempts carry the SAME key, which is what makes the server's unique index
    // collapse them into one message instead of double-posting.
    const ids = sends.map((frame) => (frame['d'] as { clientMsgId: string }).clientMsgId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(clientMsgId);
  });

  it('keeps a message queued until it is acked', async () => {
    const { client, socket } = await setup();

    const clientMsgId = client.enqueue(CHANNEL, 'unacked');
    expect(client.outbox.has(clientMsgId)).toBe(true);

    const acked = client.flushOne(clientMsgId);
    socket.deliver({
      t: 'msg.ack',
      d: {
        clientMsgId,
        messageId: crypto.randomUUID(),
        channelId: CHANNEL,
        seq: 1,
        createdAt: new Date(2026, 0, 1).toISOString(),
      },
    });
    await acked;

    expect(client.outbox.has(clientMsgId)).toBe(false);
  });

  it('surfaces a rejected send rather than dropping it silently', async () => {
    const { client, socket } = await setup();

    const clientMsgId = client.enqueue(CHANNEL, 'too fast');
    const attempt = client.flushOne(clientMsgId);
    socket.deliver({ t: 'msg.err', d: { clientMsgId, code: 'rate_limited' } });

    await expect(attempt).rejects.toThrow('rate_limited');
    // Still queued, so the UI can offer a retry. A send must fail VISIBLY.
    expect(client.outbox.get(clientMsgId)?.clientMsgId).toBe(clientMsgId);
  });
});

describe('msg.update, the frame that had no producer until reactions', () => {
  it('applies reactions to a message already held', async () => {
    const { client, socket } = await setup();
    socket.deliver({ t: 'msg.new', d: envelope(1) });
    await vi.waitFor(async () => expect(await client.store.seqs(CHANNEL)).toEqual([1]));

    socket.deliver({
      t: 'msg.update',
      d: { channelId: CHANNEL, seq: 1, reactions: [{ emoji: '\u{1F525}', userIds: ['u-1', 'u-2'] }] },
    });

    await vi.waitFor(async () => {
      const held = await client.store.list(CHANNEL);
      expect(held[0]?.reactions).toEqual([{ emoji: '\u{1F525}', userIds: ['u-1', 'u-2'] }]);
    });
  });

  it('leaves fields the frame does not mention alone', async () => {
    const { client, socket } = await setup();
    socket.deliver({ t: 'msg.new', d: envelope(1, { pinned: true, body: 'keep me' }) });
    await vi.waitFor(async () => expect(await client.store.seqs(CHANNEL)).toEqual([1]));

    // Only reactions. A patch that assigned every field would silently unpin this message and
    // blank its body, which is why the handler builds the patch from keys actually present.
    socket.deliver({
      t: 'msg.update',
      d: { channelId: CHANNEL, seq: 1, reactions: [{ emoji: '\u{1F44D}', userIds: ['u-1'] }] },
    });

    await vi.waitFor(async () => {
      const held = (await client.store.list(CHANNEL))[0];
      expect(held?.reactions).toHaveLength(1);
      expect(held?.pinned, 'pinned must survive a reactions-only update').toBe(true);
      expect(held?.body).toBe('keep me');
      expect(held?.deletedAt).toBeNull();
    });
  });

  it('applies a tombstone, distinguishing an absent field from an explicit null', async () => {
    const { client, socket } = await setup();
    socket.deliver({ t: 'msg.new', d: envelope(1, { pinned: true }) });
    await vi.waitFor(async () => expect(await client.store.seqs(CHANNEL)).toEqual([1]));

    const deletedAt = new Date(2026, 5, 1).toISOString();
    socket.deliver({
      t: 'msg.update',
      d: { channelId: CHANNEL, seq: 1, deletedAt, pinned: false, reactions: [] },
    });

    await vi.waitFor(async () => {
      const held = (await client.store.list(CHANNEL))[0];
      expect(held?.deletedAt).toBe(deletedAt);
      expect(held?.pinned).toBe(false);
    });
  });

  it('is a no-op for a seq this client has never seen, rather than inventing a row', async () => {
    const { client, socket, syncCalls } = await setup();

    // A reaction on a message we have not paged back to. Inventing a row would put a blank
    // bubble in the conversation; running it through the gap rule would spuriously sync.
    socket.deliver({
      t: 'msg.update',
      d: { channelId: CHANNEL, seq: 99, reactions: [{ emoji: '\u{1F525}', userIds: ['u-1'] }] },
    });

    await vi.waitFor(() => expect(true).toBe(true));
    expect(await client.store.seqs(CHANNEL)).toEqual([]);
    expect(syncCalls, 'an update must not trigger gap detection').toHaveLength(0);
  });

  it('does not let an update masquerade as a new message and extend the log', async () => {
    const { client, socket } = await setup();
    socket.deliver({ t: 'msg.new', d: envelope(1) });
    await vi.waitFor(async () => expect(await client.store.seqs(CHANNEL)).toEqual([1]));

    socket.deliver({ t: 'msg.update', d: { channelId: CHANNEL, seq: 1, pinned: true } });
    await vi.waitFor(async () => {
      expect((await client.store.list(CHANNEL))[0]?.pinned).toBe(true);
    });

    // Still exactly one message. An update names an existing seq; it never adds one.
    expect(await client.store.seqs(CHANNEL)).toEqual([1]);
    expect(await client.store.localMaxSeq(CHANNEL)).toBe(1);
  });
});

describe('findGaps', () => {
  it('finds nothing in a contiguous run', () => {
    expect(findGaps([1, 2, 3, 4])).toEqual([]);
  });

  it('finds a single hole', () => {
    expect(findGaps([1, 2, 4])).toEqual([3]);
  });

  it('finds a multi-seq hole', () => {
    expect(findGaps([1, 5])).toEqual([2, 3, 4]);
  });

  it('does not treat un-paged history as a gap', () => {
    // A client that has only paged back to seq 10 is not missing 1 through 9.
    expect(findGaps([10, 11, 12])).toEqual([]);
  });

  it('handles empty and single-element sets', () => {
    expect(findGaps([])).toEqual([]);
    expect(findGaps([7])).toEqual([]);
  });
});
