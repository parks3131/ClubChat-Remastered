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
  ServerFrame,
  type ChannelState,
  type MessageEnvelope,
  type MessageReaction,
  type MessageReplyRef,
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
  /**
   * A fresh UUID, for the `clientMsgId` that makes a send idempotent.
   *
   * > **Injected, and deliberately not defaulted to `crypto.randomUUID()`.** This module used to
   * > call that global directly, which works in every browser and in Node and **does not exist in
   * > Hermes** - so on iOS the call threw, `start()` rejected, and the app sat on its loading
   * > spinner forever. Web was green throughout, which is exactly why the bug survived: the one
   * > runtime without the global was the one nothing ran on.
   *
   * Required rather than optional for the same reason `createSocket` is. A default reaching for
   * the global would keep working on web and keep failing on native, silently, which is the bug
   * rather than the fix; making every construction site name its source means a platform that
   * cannot supply one cannot compile.
   *
   * Must be collision-free in practice - it is an idempotency key, and a repeat would make the
   * server treat a new message as a retry of an old one and drop it.
   */
  randomUuid: () => string;
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

  /**
   * Their own avatar's media id, learned at auth beside the name.
   *
   * Same trip and the same purpose: without it, the one bubble whose avatar the client could
   * always have drawn - its own - is the only letter placeholder in the conversation, until a
   * sync replaces the locally built envelope.
   */
  displayImage: string | null = null;

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

  /**
   * Decode one frame from the socket, or say why not.
   *
   * > **Parsed against the shared contract, never cast to it.** Every field in here used to be
   * > read with `frame.d['x'] as T` - an assertion that the server sent what this switch believes
   * > it sent, which nothing checked. That is failure mode 16 on the hot path, and it has already
   * > cost one bug: an envelope published by a process older than the `mentions` field reached
   * > SQLite with the field absent, bound NULL into a NOT NULL column, and silently lost the
   * > message. Parsing applies the schema's own defaults, so the same envelope now arrives
   * > repaired instead of malformed.
   *
   * A rejection carries the frame's claimed `t` where one can be read, because what a bad frame
   * costs depends entirely on which frame it was - see `onFrame`.
   */
  private decodeFrame(raw: string): { ok: true; frame: ServerFrame } | { ok: false; type: string | null } {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.log('undecodable frame');
      return { ok: false, type: null };
    }

    const parsed = ServerFrame.safeParse(json);
    if (parsed.success) return { ok: true, frame: parsed.data };

    // The whole frame, not just the type: a frame that fails validation is one nobody has seen
    // before, and the type alone rarely says which field was wrong.
    this.log('frame failed validation', { raw, issues: parsed.error.issues });
    const type = (json as { t?: unknown } | null)?.t;
    return { ok: false, type: typeof type === 'string' ? type : null };
  }

  private async onFrame(raw: string): Promise<void> {
    const decoded = this.decodeFrame(raw);
    if (!decoded.ok) {
      /*
       * > **An unreadable auth reply must FAIL, not be dropped.** Everything else on this socket
       * > can be recovered by asking again; the handshake cannot, because nothing else will ever
       * > arrive to prompt a retry. Dropping it silently leaves `connect()` awaiting a promise
       * > that no longer has a resolver - the app sits on its loading spinner forever, which
       * > PRD/03 names as the one outcome never acceptable. That failure has shipped here once
       * > already, from `crypto.randomUUID` throwing during sign-in.
       */
      if (decoded.type === 'auth.ok' || decoded.type === 'auth.err') {
        this.authRejected?.(new Error('auth reply could not be understood'));
        return;
      }

      /*
       * Everything else is dropped and paid for with one sync.
       *
       * A frame we cannot read might have been a message, and a missed message is the one
       * failure this client is built to make impossible. Rather than guess at the payload, ask
       * the authoritative read path: `syncAll` pulls every channel above its local max, so a
       * dropped `msg.new` costs a round trip and nothing else. `msg.update` and `msg.ack` are
       * idempotent or repeated, so re-syncing is harmless for those too.
       *
       * Deliberately fire-and-forget: this runs inside the socket's message handler, and an
       * awaited sync there would stall every frame queued behind it.
       */
      void this.syncAll().catch((error) => this.log('sync after bad frame failed', { error }));
      return;
    }
    const frame = decoded.frame;

    switch (frame.t) {
      case 'auth.ok': {
        this.userId = frame.d.userId;
        this.displayName = frame.d.displayName;
        this.displayImage = frame.d.displayImage;
        this.channels = frame.d.channels;
        this.authResolved?.();
        // The socket is only usable once the server has accepted the token, so this is the
        // earliest honest moment to flush anything held while it was down.
        this.flushReads();
        this.opts.onChange?.();
        break;
      }
      case 'auth.err': {
        this.authRejected?.(new Error(`auth failed: ${frame.d.code}`));
        break;
      }
      case 'msg.ack': {
        const { seq, clientMsgId, channelId } = frame.d;

        // THE ASYMMETRY THAT MATTERS. The ack is gap-checked exactly like msg.new.
        //
        // If local max is 3, seq 4 was missed while the socket flapped, and our own
        // send acks at 5: appending without the check sets local max to 5 and leaves a
        // PERMANENT hole at 4, because every later msg.new at 6 then satisfies
        // local_max + 1 and never triggers a sync. The client would believe it is
        // caught up and be wrong, forever, with no error anywhere.
        await this.applyIncoming(
          {
            id: frame.d.messageId,
            channelId,
            seq,
            senderId: this.userId ?? '',
            // The name learned at auth, not one carried on the ack. The ack repeats per message
            // and the name cannot change mid-connection, so putting it there would be paying for
            // the same string on every send. Null only before auth completes, which cannot happen
            // here: an ack arrives on an authenticated socket.
            senderName: this.displayName,
            senderImage: this.displayImage,
            // The outbox knows what was sent. Hardcoding 'text' here stored a photo as a
            // text message locally until the next sync overwrote it.
            type: this.outbox.get(clientMsgId)?.type ?? 'text',
            body: this.outbox.get(clientMsgId)?.body ?? null,
            clientMsgId,
            pinned: false,
            pinnedAt: null,
            // A message we have only just sent cannot have been reacted to. Any reaction
            // that lands afterwards arrives as its own msg.update.
            reactions: [],
            // The sender's own optimistic bubble. It knows who it named, but the highlight can
            // wait for the read that follows: an unhighlighted name for a moment is invisible
            // next to the bubble appearing at all.
            mentions: [],
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
            // From the outbox entry, like the attachment fields above. The ack carries only ids
            // and the seq, and the quote is the sender's own copy of a message they were looking
            // at when they replied - so their bubble draws it now rather than when it re-syncs.
            replyTo: this.outbox.get(clientMsgId)?.replyTo ?? null,
            deletedAt: null,
            createdAt: frame.d.createdAt,
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
        const { clientMsgId, code } = frame.d;
        this.waiters.get(clientMsgId)?.reject(new Error(code));
        this.waiters.delete(clientMsgId);
        break;
      }
      case 'msg.new': {
        // Already validated, and already carrying the schema's defaults for anything a producer
        // older than a field left out. This used to be a bare cast, which is how an envelope
        // with no `mentions` reached SQLite and lost the message it belonged to.
        const envelope = frame.d;
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
       * A lost update is self-healing **while the socket is up**, because the frame carries the
       * full reaction set rather than a delta - the next update on that message brings the
       * truth. That is the property that lets this path skip the ceremony `msg.new` needs.
       *
       * > **It is NOT self-healing across a disconnect, and this comment used to claim it was.**
       * > `syncChannel` pulls strictly ABOVE the local max, so a row already cached is never
       * > fetched again - an update missed while offline is missed permanently. A client that
       * > was disconnected when a message was deleted keeps showing that message and its text.
       * > Recorded as item 14 of SPEC/PRD/17; the fix is a changed-since watermark in sync,
       * > which is a change to the sync contract rather than something to patch here.
       */
      case 'msg.update': {
        const { channelId, seq } = frame.d;
        const patch: MessagePatch = {};
        /*
         * Only fields actually present. `deletedAt: null` means "not deleted" and must stay
         * distinguishable from "this frame says nothing about deletion" - which is why each is
         * an `undefined` check rather than a truthiness one, and why the schema declares them
         * `.optional()` rather than `.nullable()` with a default.
         */
        if (frame.d.pinned !== undefined) patch.pinned = frame.d.pinned;
        if (frame.d.reactions !== undefined) patch.reactions = frame.d.reactions;
        if (frame.d.deletedAt !== undefined) patch.deletedAt = frame.d.deletedAt;

        // Serialized per channel like message application, so an update and an arriving
        // message cannot interleave a read-then-write on the same row.
        await this.serialize(channelId, () => this.store.patch(channelId, seq, patch));
        this.opts.onChange?.();
        break;
      }
      case 'subscribed':
      case 'pong':
        break;
      default: {
        /*
         * Unreachable, and the compiler proves it.
         *
         * `ServerFrame` is a discriminated union and every member is now handled above, so
         * `frame` narrows to `never` here - which means **adding a frame type to the protocol
         * without handling it is a type error in this file** rather than a log line nobody
         * reads. That is the whole return on parsing instead of casting: the old switch took a
         * bare `string` and could silently ignore anything.
         *
         * The log stays for the runtime case that cannot happen through this path anyway: an
         * unknown `t` fails the union and is dropped by `decodeFrame` before reaching here.
         */
        const unhandled: never = frame;
        this.log('unhandled frame type', unhandled);
      }
    }
  }

  /**
   * Apply one arriving message under the gap rule.
   *
   * On a gap the message is still appended - a send that succeeded must not vanish
   * from the UI - and a sync backfills the hole behind it.
   */
  private async applyIncoming(envelope: MessageEnvelope, channelId: string): Promise<void> {
    /*
     * The gap decision and the write happen under the channel's lock. The BACKFILL does not.
     *
     * > **Syncing inside the lock is what produced `cannot start a transaction within a
     * > transaction`.** `syncChannel` writes to the same store, and holding the lock across it
     * > meant the only safe way to serialize those writes - taking the same lock - would have
     * > deadlocked against the operation waiting for them. Moving the network round trip out
     * > from under the lock lets both paths queue behind it properly.
     *
     * It is also the right shape regardless: a gap sync is a network round trip, and holding a
     * per-channel lock across one stalls every other frame for that channel until it returns.
     */
    const gap = await this.serialize(channelId, async () => {
      const localMax = await this.store.localMaxSeq(channelId);
      const decision = decideGap(envelope.seq, localMax);

      if (decision.action === 'ignore') return null;

      await this.store.upsert([envelope]);
      // On a gap the message is still appended - a send that succeeded must not vanish from the
      // UI - and the backfill below fills the hole behind it.
      return decision.syncAfter ? localMax : null;
    });

    if (gap === null) return;
    this.log('gap detected, syncing', { channelId, arriving: envelope.seq, localMax: gap });
    await this.syncChannel(channelId, gap);
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

    /*
     * Advance this client's own view of the cursor, not just the server's.
     *
     * `channels` is only ever replaced wholesale at `auth.ok`, so without this it keeps
     * reporting the cursor as it stood when the socket connected - for the whole session. A
     * screen that asks "what had I read when I opened this?" to decide where to place the
     * reader would then get the same stale answer on every re-entry and drop them back into
     * history they had already read. Monotonic, like the server's own `GREATEST`.
     */
    const channel = this.channels.find((entry) => entry.id === channelId);
    const advanced = channel !== undefined && upToSeq > channel.lastReadSeq;
    if (advanced && channel) channel.lastReadSeq = upToSeq;

    this.flushReads();

    /*
     * **Tell whoever is drawing a count that one just changed.**
     *
     * This was missing, and it is the whole reason unread counts appeared not to clear: reading
     * a chat advanced the cursor on the server and updated the line above, and then nothing
     * announced it. Every screen showing a number watches `onChange` - the chat list, the club
     * hub, the tab badge - so all three kept whatever they had loaded, which for a session that
     * had been open a while meant the count as it stood at sign-in.
     *
     * The failure is worth naming precisely because it looked like a server bug and was not: the
     * cursor was correct in Postgres the whole time. Only the client never asked again.
     *
     * Fired only when the mark actually moved. Opening an already-read chat changes nothing, and
     * a notification per open would refetch every list on every navigation.
     */
    if (advanced) this.opts.onChange?.();
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
      /** User ids the composer named. See `PendingSend.mentions`. */
      mentions?: readonly string[];
      /** The message being answered, and the quote to draw meanwhile. See `PendingSend`. */
      replyToSeq?: number;
      replyTo?: MessageReplyRef;
    } = {},
  ): string {
    const clientMsgId = opts.clientMsgId ?? this.opts.randomUuid();
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
      ...(opts.mentions && opts.mentions.length > 0 ? { mentions: opts.mentions } : {}),
      ...(opts.replyToSeq !== undefined ? { replyToSeq: opts.replyToSeq } : {}),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
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
        // From the outbox entry, so a retry after a reconnect names the same people the
        // first attempt did.
        ...(pending.mentions && pending.mentions.length > 0
          ? { mentions: [...pending.mentions] }
          : {}),
        // The seq only. The quote itself is joined by the server on every read, so what the
        // client believes it is quoting never becomes what anybody else sees.
        ...(pending.replyToSeq !== undefined ? { replyToSeq: pending.replyToSeq } : {}),
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
      mentions?: readonly string[];
      replyToSeq?: number;
      replyTo?: MessageReplyRef;
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

  /**
   * Drop this device's cached copy of a conversation, after the server has raised the floor.
   *
   * > **The client half of "Delete chat", and it is not optional.** The server hides those
   * > messages from every future read; this device is already holding them and renders from
   * > SQLite before any network call resolves. Without this the conversation clears on the
   * > server and stays fully visible on the phone until the cache happens to be rebuilt - a rule
   * > enforced at one end and ignored at the other, which is the shape of bug this codebase has
   * > shipped more than once.
   *
   * Safe to call before or after the server, because sync will never bring the messages back:
   * it now pulls only what is above the floor.
   */
  async forgetChannel(channelId: string): Promise<void> {
    await this.store.forgetChannel(channelId);
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

      /*
       * Through the SAME per-channel queue a live frame uses.
       *
       * This write used to bypass it entirely, so a sync and an arriving message could open two
       * SQLite transactions at once - "cannot start a transaction within a transaction", which
       * kills the insert and loses whichever message was in flight. Failure mode 3 said "apply
       * frames one at a time per channel"; the sync path was never counted as a frame, and it
       * writes to the same table.
       */
      await this.serialize(channelId, () => this.store.upsert(result.messages));
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
    // Serialized for the same reason as the sync write above: one writer per channel at a time.
    await this.serialize(channelId, () => this.store.upsert(body.messages));
    return body.messages;
  }
}
