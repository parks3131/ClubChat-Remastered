/**
 * The client: socket, send outbox, and sync engine.
 *
 * Written once and shared by the Expo app and the Phase 0 exit drill, so the drill
 * exercises the code that actually ships rather than a convenient stand-in.
 *
 * Two rules from SPEC/TECH/08-client-architecture.md drive the whole design:
 *
 *  1. **Realtime is an enhancement, not a requirement.** The socket is an accelerator.
 *     Every screen can also load its data over REST, so a dropped connection degrades
 *     to stale-until-refresh rather than broken.
 *  2. **The gap rule applies to `msg.ack`, not only to `msg.new`.** Skipping the check
 *     on the ack path leaves a permanent, silent hole. See `decideGap`.
 */

import {
  decideGap,
  type ChannelState,
  type MessageEnvelope,
  type MessageReaction,
} from '@clubchat/shared';
import {
  InMemoryMessageStore,
  type MessagePatch,
  type MessageStore,
  type PendingSend,
} from './store.ts';

/** Minimal socket surface, so Node's `ws` and the RN/browser global both fit. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  readonly readyState: number;
  onopen: ((this: unknown, ev: unknown) => void) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => void) | null;
  onclose: ((this: unknown, ev: unknown) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
}

export type ChatClientOptions = {
  wsUrl: string;
  apiUrl: string;
  token: string;
  deviceId: string;
  platform: 'ios' | 'android' | 'web';
  createSocket: (url: string) => SocketLike;
  fetchImpl?: typeof fetch;
  store?: MessageStore;
  /** Attempts before a queued send is surfaced as failed. */
  maxSendAttempts?: number;
  onChange?: () => void;
  log?: (message: string, extra?: unknown) => void;
};

type AckWaiter = {
  resolve: (seq: number) => void;
  reject: (error: Error) => void;
};

export class ChatClient {
  readonly store: MessageStore;
  /** The send outbox. Distinct from the server's transactional outbox. */
  readonly outbox = new Map<string, PendingSend>();
  channels: ChannelState[] = [];
  userId: string | null = null;
  /**
   * This user's own display name, handed over at auth.
   *
   * Held so an acked message can be attributed immediately. Without it a sender's own bubbles
   * render nameless - and, once the UI draws an avatar from the initial, as a "?" - until a
   * sync replaces the locally built envelope with the server's.
   */
  displayName: string | null = null;

  private socket: SocketLike | null = null;
  /** Read cursors this client wants advanced, waiting on a socket. Channel -> highest seq. */
  private readonly pendingReads = new Map<string, number>();
  private readonly waiters = new Map<string, AckWaiter>();
  private authResolved: ((value: void) => void) | null = null;
  private authRejected: ((error: Error) => void) | null = null;
  private closedByUs = false;
  /**
   * Per-channel serialization for message application.
   *
   * Gap detection is a read-then-write of the local max, so two frames applied
   * concurrently both observe the pre-write value and the second one falsely concludes
   * a hole exists. That produces spurious syncs at best, and it makes the gap signal
   * untrustworthy at worst - a gap has to MEAN a gap. Frames for one channel therefore
   * apply one at a time. Different channels still proceed in parallel.
   */
  private readonly channelQueue = new Map<string, Promise<unknown>>();
  /** Counts syncs, so the drill can assert reconciliation actually ran. */
  syncCount = 0;

  private readonly opts: ChatClientOptions;

  // Explicit assignment, not a parameter property: Node's strip-only type removal does
  // not support those. See AGENTS.md 5.3.
  constructor(opts: ChatClientOptions) {
    this.opts = opts;
    this.store = opts.store ?? new InMemoryMessageStore();
  }

  /**
   * The fetch to use, correctly bound.
   *
   * The `bind` is load-bearing, not defensive. Returning the bare global and then calling
   * it as `this.fetch(...)` invokes it with `this` set to the ChatClient, and a browser
   * rejects that with "Failed to execute 'fetch' on 'Window': Illegal invocation".
   *
   * This shipped broken and was invisible to every automated check: Node's fetch does not
   * care about its receiver, so the whole test suite and the exit drill passed while sync
   * was failing on web - and failing quietly, because the caller logs and continues on the
   * principle that realtime is an enhancement. It took running the real app in a real
   * browser. See AGENTS.md 5.3.
   */
  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private log(message: string, extra?: unknown) {
    this.opts.log?.(message, extra);
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.closedByUs = false;
    const socket = this.opts.createSocket(this.opts.wsUrl);
    this.socket = socket;

    const authed = new Promise<void>((resolve, reject) => {
      this.authResolved = resolve;
      this.authRejected = reject;
    });

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          t: 'auth',
          d: {
            token: this.opts.token,
            deviceId: this.opts.deviceId,
            platform: this.opts.platform,
          },
        }),
      );
    };

    socket.onmessage = (event) => {
      void this.onFrame(String(event.data));
    };

    socket.onclose = () => {
      // Every in-flight send goes back to pending. The message is still in the outbox
      // with its original client_msg_id, so retrying after reconnect cannot double-post.
      for (const waiter of this.waiters.values()) {
        waiter.reject(new Error('socket closed'));
      }
      this.waiters.clear();
      this.socket = null;
      if (!this.closedByUs) this.authRejected?.(new Error('socket closed before auth'));
    };

    socket.onerror = () => {
      /* surfaced through onclose */
    };

    await authed;
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.socket?.close();
    this.socket = null;
  }

  private send(frame: unknown) {
    if (!this.socket) throw new Error('not connected');
    this.socket.send(JSON.stringify(frame));
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  private async onFrame(raw: string): Promise<void> {
    let frame: { t: string; d: Record<string, unknown> };
    try {
      frame = JSON.parse(raw) as { t: string; d: Record<string, unknown> };
    } catch {
      this.log('undecodable frame');
      return;
    }

    switch (frame.t) {
      case 'auth.ok': {
        this.userId = frame.d['userId'] as string;
        this.displayName = (frame.d['displayName'] as string | null | undefined) ?? null;
        this.channels = frame.d['channels'] as ChannelState[];
        this.authResolved?.();
        // The socket is only usable once the server has accepted the token, so this is the
        // earliest honest moment to flush anything held while it was down.
        this.flushReads();
        this.opts.onChange?.();
        break;
      }
      case 'auth.err': {
        this.authRejected?.(new Error(`auth failed: ${String(frame.d['code'])}`));
        break;
      }
      case 'msg.ack': {
        const seq = frame.d['seq'] as number;
        const clientMsgId = frame.d['clientMsgId'] as string;
        const channelId = frame.d['channelId'] as string;

        // THE ASYMMETRY THAT MATTERS. The ack is gap-checked exactly like msg.new.
        //
        // If local max is 3, seq 4 was missed while the socket flapped, and our own
        // send acks at 5: appending without the check sets local max to 5 and leaves a
        // PERMANENT hole at 4, because every later msg.new at 6 then satisfies
        // local_max + 1 and never triggers a sync. The client would believe it is
        // caught up and be wrong, forever, with no error anywhere.
        await this.applyIncoming(
          {
            id: frame.d['messageId'] as string,
            channelId,
            seq,
            senderId: this.userId ?? '',
            // The name learned at auth, not one carried on the ack. The ack repeats per message
            // and the name cannot change mid-connection, so putting it there would be paying for
            // the same string on every send. Null only before auth completes, which cannot happen
            // here: an ack arrives on an authenticated socket.
            senderName: this.displayName,
            // The outbox knows what was sent. Hardcoding 'text' here stored a photo as a
            // text message locally until the next sync overwrote it.
            type: this.outbox.get(clientMsgId)?.type ?? 'text',
            body: this.outbox.get(clientMsgId)?.body ?? null,
            clientMsgId,
            pinned: false,
            // A message we have only just sent cannot have been reacted to. Any reaction
            // that lands afterwards arrives as its own msg.update.
            reactions: [],
            // From the outbox entry rather than the ack, which carries only ids and the seq.
            // Without this a photo would render as an empty bubble until the next sync.
            mediaId: this.outbox.get(clientMsgId)?.mediaId ?? null,
            documentName: this.outbox.get(clientMsgId)?.documentName ?? null,
            documentSize: this.outbox.get(clientMsgId)?.documentSize ?? null,
            // Always null: a card is written by the worker, never sent from a client, so nothing
            // this outbox ever acknowledges is one.
            linkedPollId: null,
            linkedEventId: null,
            linkedMeetingId: null,
            deletedAt: null,
            createdAt: frame.d['createdAt'] as string,
          },
          channelId,
        );

        this.outbox.delete(clientMsgId);
        this.waiters.get(clientMsgId)?.resolve(seq);
        this.waiters.delete(clientMsgId);
        this.opts.onChange?.();
        break;
      }
      case 'msg.err': {
        const clientMsgId = frame.d['clientMsgId'] as string;
        const code = String(frame.d['code']);
        this.waiters.get(clientMsgId)?.reject(new Error(code));
        this.waiters.delete(clientMsgId);
        break;
      }
      case 'msg.new': {
        const envelope = frame.d as unknown as MessageEnvelope;
        await this.applyIncoming(envelope, envelope.channelId);
        this.opts.onChange?.();
        break;
      }
      /**
       * A message that already exists changed: a pin, a tombstone, or a reaction.
       *
       * **Declared in the protocol from Phase 0 and ignored until reactions arrived.** It is
       * deliberately NOT gap-checked: an update names an existing `seq` rather than extending
       * the log, so it cannot create or reveal a hole, and running it through `decideGap`
       * would make every reaction on an older message look like one.
       *
       * A lost update is self-healing because the frame carries the full reaction set rather
       * than a delta - the next update, sync or history page brings the truth. That is the
       * property that lets this path skip the ceremony `msg.new` needs.
       */
      case 'msg.update': {
        const channelId = frame.d['channelId'] as string;
        const seq = frame.d['seq'] as number;
        const patch: MessagePatch = {};
        // Only fields actually present. `deletedAt: null` means "not deleted" and must stay
        // distinguishable from "this frame says nothing about deletion".
        if ('pinned' in frame.d) patch.pinned = frame.d['pinned'] as boolean;
        if ('reactions' in frame.d) patch.reactions = frame.d['reactions'] as MessageReaction[];
        if ('deletedAt' in frame.d) patch.deletedAt = frame.d['deletedAt'] as string | null;

        // Serialized per channel like message application, so an update and an arriving
        // message cannot interleave a read-then-write on the same row.
        await this.serialize(channelId, () => this.store.patch(channelId, seq, patch));
        this.opts.onChange?.();
        break;
      }
      case 'subscribed':
      case 'pong':
        break;
      default:
        this.log('unhandled frame type', frame.t);
    }
  }

  /**
   * Apply one arriving message under the gap rule.
   *
   * On a gap the message is still appended - a send that succeeded must not vanish
   * from the UI - and a sync backfills the hole behind it.
   */
  private async applyIncoming(envelope: MessageEnvelope, channelId: string): Promise<void> {
    return this.serialize(channelId, async () => {
      const localMax = await this.store.localMaxSeq(channelId);
      const decision = decideGap(envelope.seq, localMax);

      if (decision.action === 'ignore') return;

      await this.store.upsert([envelope]);

      if (decision.syncAfter) {
        this.log('gap detected, syncing', { channelId, arriving: envelope.seq, localMax });
        await this.syncChannel(channelId, localMax);
      }
    });
  }

  /** Run `op` after every previously queued op for this channel, pass or fail. */
  private serialize<T>(channelId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.channelQueue.get(channelId) ?? Promise.resolve();
    const next = previous.then(op, op);
    // Swallow on the stored tail only, so one failed application does not reject every
    // frame queued behind it. The caller still sees its own rejection.
    this.channelQueue.set(
      channelId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // -------------------------------------------------------------------------
  // Subscriptions and sending
  // -------------------------------------------------------------------------

  subscribe(channelIds: readonly string[]) {
    this.send({ t: 'subscribe', d: { channelIds } });
  }

  /**
   * Tell the server this channel has been read up to `upToSeq`.
   *
   * > **Held and retried, not fire-and-forget.** `send` throws when the socket is not up, and this
   * > is called from a screen effect the moment a chat mounts - which on a cold open (deep link,
   * > notification tap, refresh) is reliably *before* the socket has finished connecting. The frame
   * > was therefore dropped exactly in the case where clearing the unread matters most, and the
   * > count stayed on the inbox forever because nothing ever tried again.
   *
   * So the intent is recorded first and flushed on connect, the same shape as the send outbox: the
   * cursor is a durable thing the client wants, not a message it happens to be able to deliver.
   * Keyed by channel with the highest seq winning, so repeated reads while scrolling collapse to
   * one frame rather than queueing hundreds.
   */
  markRead(channelId: string, upToSeq: number) {
    const held = this.pendingReads.get(channelId) ?? -1;
    if (upToSeq > held) this.pendingReads.set(channelId, upToSeq);
    this.flushReads();
  }

  /** Send whatever reads are outstanding, if the socket can carry them. Silent when it cannot. */
  private flushReads() {
    if (!this.socket) return;
    for (const [channelId, upToSeq] of this.pendingReads) {
      try {
        this.send({ t: 'msg.read', d: { channelId, upToSeq } });
        this.pendingReads.delete(channelId);
      } catch {
        // Still down. Leave it pending; the next connect flushes it.
        return;
      }
    }
  }

  /**
   * Enqueue a send.
   *
   * `client_msg_id` is generated ONCE here, before the first attempt, and reused by
   * every retry. That is what makes the outbox safe to retry aggressively: a
   * redelivered send hits the server's unique index and returns the original seq
   * instead of posting twice.
   */
  enqueue(
    channelId: string,
    body: string,
    opts: {
      clientMsgId?: string;
      type?: 'text' | 'photo' | 'document' | 'announcement';
      mediaId?: string;
      localUri?: string;
      documentName?: string;
      documentSize?: number;
    } = {},
  ): string {
    const clientMsgId = opts.clientMsgId ?? crypto.randomUUID();
    this.outbox.set(clientMsgId, {
      clientMsgId,
      channelId,
      body,
      attempts: 0,
      status: 'pending',
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.mediaId ? { mediaId: opts.mediaId } : {}),
      ...(opts.localUri ? { localUri: opts.localUri } : {}),
      ...(opts.documentName ? { documentName: opts.documentName } : {}),
      ...(opts.documentSize !== undefined ? { documentSize: opts.documentSize } : {}),
    });
    this.opts.onChange?.();
    return clientMsgId;
  }

  /** Attempt one queued send, returning its committed seq. */
  async flushOne(clientMsgId: string): Promise<number> {
    const pending = this.outbox.get(clientMsgId);
    if (!pending) throw new Error(`nothing queued for ${clientMsgId}`);

    pending.attempts += 1;
    const acked = new Promise<number>((resolve, reject) => {
      this.waiters.set(clientMsgId, { resolve, reject });
    });

    this.send({
      t: 'msg.send',
      d: {
        clientMsgId,
        channelId: pending.channelId,
        type: pending.type ?? 'text',
        // A photo carries no body, and the wire schema rejects an empty string - so send
        // null rather than '' when there is no caption.
        body: pending.body.length > 0 ? pending.body : null,
        ...(pending.mediaId ? { mediaId: pending.mediaId } : {}),
      },
    });

    return acked;
  }

  /**
   * Send with retries across reconnects.
   *
   * A failed send must fail VISIBLY rather than silently dropping the message, so once
   * attempts are exhausted the entry is marked failed and left in the outbox for the UI
   * to offer a retry against.
   */
  async sendWithRetry(
    channelId: string,
    body: string,
    attachment: {
      type?: 'text' | 'photo' | 'document' | 'announcement';
      mediaId?: string;
      localUri?: string;
      documentName?: string;
      documentSize?: number;
    } = {},
  ): Promise<number> {
    const clientMsgId = this.enqueue(channelId, body, attachment);
    const maxAttempts = this.opts.maxSendAttempts ?? 5;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        if (!this.socket) await this.reconnect();
        return await this.flushOne(clientMsgId);
      } catch (error) {
        this.log('send attempt failed', {
          clientMsgId,
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }

    const pending = this.outbox.get(clientMsgId);
    if (pending) pending.status = 'failed';
    this.opts.onChange?.();
    throw new Error(`send failed after ${maxAttempts} attempts`);
  }

  /** Flush everything still queued. Called after a reconnect. */
  async flushOutbox(): Promise<void> {
    for (const clientMsgId of [...this.outbox.keys()]) {
      try {
        await this.flushOne(clientMsgId);
      } catch (error) {
        this.log('outbox flush failed', {
          clientMsgId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  /**
   * Reconnect, resubscribe, reconcile, then retry queued sends.
   *
   * The order is deliberate: reconcile BEFORE flushing the outbox, so a send that acks
   * at a high seq lands on a client that already knows about everything below it.
   */
  async reconnect(opts: { retries?: number } = {}): Promise<void> {
    const retries = opts.retries ?? 10;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        await this.connect();
        const channelIds = this.channels.map((channel) => channel.id);
        if (channelIds.length > 0) this.subscribe(channelIds);
        await this.syncAll();
        return;
      } catch {
        // Backoff with jitter, so a gateway restart does not bring every client back
        // in the same millisecond.
        const backoff = Math.min(1_000, 50 * 2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * 50));
      }
    }
    throw new Error('reconnect failed');
  }

  /**
   * Reconcile every channel with local state.
   *
   * Run on socket connect, app foreground, and network regained - not merely on mount.
   * v1 reconciled only on mount, which is why a phone that backgrounded and resumed
   * could permanently miss messages with no error and no indication.
   */
  async syncAll(): Promise<void> {
    const targets = this.channels.length > 0 ? this.channels.map((c) => c.id) : [];
    for (const channelId of targets) {
      await this.syncChannel(channelId, await this.store.localMaxSeq(channelId));
    }
  }

  async syncChannel(channelId: string, sinceSeq: number): Promise<void> {
    this.syncCount += 1;
    let since = sinceSeq;

    // Keep pulling while the server says there is more, so a client that has been away
    // long enough to exceed one page does not stop half way and believe it is caught up.
    for (;;) {
      const url = `${this.opts.apiUrl}/sync?channels[]=${encodeURIComponent(`${channelId}:${since}`)}`;
      const response = await this.fetch(url, {
        headers: { authorization: `Bearer ${this.opts.token}` },
      });
      if (!response.ok) throw new Error(`sync failed: ${response.status}`);

      const body = (await response.json()) as {
        channels: Array<{ channelId: string; messages: MessageEnvelope[]; hasMore: boolean }>;
      };
      const result = body.channels.find((entry) => entry.channelId === channelId);
      if (!result || result.messages.length === 0) return;

      await this.store.upsert(result.messages);
      since = result.messages[result.messages.length - 1]!.seq;
      if (!result.hasMore) return;
    }
  }

  /** Page backward through history. */
  async loadOlder(channelId: string, before: number, limit = 40): Promise<MessageEnvelope[]> {
    const response = await this.fetch(
      `${this.opts.apiUrl}/channels/${channelId}/messages?before=${before}&limit=${limit}`,
      { headers: { authorization: `Bearer ${this.opts.token}` } },
    );
    if (!response.ok) throw new Error(`history failed: ${response.status}`);
    const body = (await response.json()) as { messages: MessageEnvelope[] };
    await this.store.upsert(body.messages);
    return body.messages;
  }
}
