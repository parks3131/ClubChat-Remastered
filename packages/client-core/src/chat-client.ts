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
  findGaps,
  InMemoryMessageStore,
  type MessagePatch,
  type MessageStore,
  type PendingSend,
} from './store.ts';

/**
 * One `channels[]` entry for `GET /sync`, deliberately **not** percent-encoded.
 *
 * > **`encodeURIComponent` here is what stopped every sync the iPhone ever attempted.** React
 * > Native's `fetch` normalises the URL it is handed, and on iOS that means percent-encoding the
 * > query string *again* - so our `%3A` left the device as `%253A`. Fastify decodes exactly once,
 * > the server saw `<uuid>%3A92` with no colon in it, the entry failed to parse, and the channel
 * > was **omitted from the response**. Every `/sync` answered `200` with an empty list.
 *
 * It was invisible for months because the socket kept the phone current and the failure had no
 * error at either end: 609 of these went out before anybody looked at a URL. What finally showed
 * it was a gap repair that ran on every sync forever, because the one call that could have filled
 * the hole was the call that was being silently dropped.
 *
 * The entry needs no encoding at all: a channel id is a uuid, the cursors are integers, and a
 * colon is legal in a query string. Anything the platform escapes on top of that, the server
 * decodes back. **The rule is not "encode less", it is: never hand `fetch` a URL you have already
 * encoded, because you cannot stop the platform encoding it again.**
 */
export function syncEntry(channelId: string, since: number, rev?: number): string {
  return rev === undefined ? `${channelId}:${since}` : `${channelId}:${since}:${rev}`;
}

/**
 * The gateway answered and refused us, with the reason it gave.
 *
 * > **A distinct type because "the server said no" and "I could not reach the server" are
 * > different facts, and only the first is grounds to sign somebody out.** `session.ts` has drawn
 * > that line since Phase 3 for the HTTP check; the socket path had no way to express it, so a
 * > gateway explicitly reporting `invalid_token` was caught as a generic connect failure and the
 * > app settled into "Offline. Showing saved messages." **permanently**. Nothing ever re-checked,
 * > and the member's only clue that their session was dead rather than the network being quiet was
 * > a thin grey banner. Observed on the web client on 2026-08-08.
 *
 * `code` is the gateway's own `auth.err` code, so a caller can act on `invalid_token` and
 * `signin_blocked` without string-matching a message.
 */
export class AuthRejectedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`auth failed: ${code}`);
    this.name = 'AuthRejectedError';
    this.code = code;
  }
}

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
  /**
   * Whether the server has accepted this socket's `auth`.
   *
   * > **A socket that exists is not a socket that may be used, and treating the two as the same
   * > thing signed members out.** `connect` assigns `this.socket` and only then waits for
   * > `auth.ok`, so between the socket opening and the server answering there is a window where
   * > sending throws nothing and the gateway refuses the frame - which it reported as
   * > `invalid_token`, which the provider reads as a dead session. A chat screen mounting on a
   * > cold open (deep link, notification tap, web refresh) lands in that window reliably.
   *
   * So "can I send" is asked about the handshake, not about the object. The window is small and
   * it is exactly the window a cold open occupies, which is the worst possible place for it.
   */
  private authenticated = false;
  /** Read cursors this client wants advanced, waiting on a socket. Channel -> highest seq. */
  private readonly pendingReads = new Map<string, number>();
  /**
   * Channels this client wants subscribed, waiting on the handshake.
   *
   * The same shape as `pendingReads` and for the same reason: a subscription is a durable thing
   * the client wants, not a frame it happens to be able to deliver this instant. Held rather than
   * dropped, so a chat opened during connect is still subscribed once the socket is usable.
   */
  private readonly pendingSubscribes = new Set<string>();
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
    this.authenticated = false;
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
      this.authenticated = false;
      if (!this.closedByUs) this.authRejected?.(new Error('socket closed before auth'));
    };

    socket.onerror = () => {
      /* surfaced through onclose */
    };

    await authed;
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.authenticated = false;
    this.socket?.close();
    this.socket = null;
  }

  /**
   * Put a frame on the wire, or refuse.
   *
   * Refusing before `auth.ok` is the point rather than caution: the gateway discards a frame it
   * receives from an unauthenticated socket and closes the connection, so sending early does not
   * merely fail, it takes the conversation down. Every caller already treats a throw here as
   * "not now" - the outbox retries, `flushReads` holds, `openChannel` carries on to the HTTP
   * sync it never needed a socket for.
   */
  private send(frame: unknown) {
    if (!this.socket) throw new Error('not connected');
    if (!this.authenticated) throw new Error('not authenticated');
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
        // The socket is only usable once the server has accepted the token. This is the line
        // that makes `send` work, so it comes before anything that flushes.
        this.authenticated = true;
        // Held while the handshake was in flight, in the order a caller asked for them.
        this.flushSubscribes();
        this.flushReads();
        this.authResolved?.();
        this.opts.onChange?.();
        break;
      }
      case 'auth.err': {
        this.authRejected?.(new AuthRejectedError(frame.d.code));
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
        // Its own check rather than being folded into the one above, because the two are
        // separately optional on the wire and a frame that carried only the time would still
        // be a change worth storing.
        if (frame.d.pinnedAt !== undefined) patch.pinnedAt = frame.d.pinnedAt;
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

      /*
       * **Written unconditionally, including when the gap decision is `ignore`.**
       *
       * This used to `return null` before the upsert, on the reasoning that a seq at or below the
       * local high-water mark is one we already hold. That reasoning has a hole in it, and the
       * hole is permanent: `localMaxSeq` is a high-water MARK, not proof that every seq beneath it
       * is present. A frame arriving at or under it was therefore discarded without anybody
       * checking whether the row it carried actually existed - and `syncChannel` pulls strictly
       * ABOVE the local max, so nothing would ever fetch it again. The message was gone for the
       * life of that cache while still counting towards the unread badge, which is the
       * "the chat says there is something here and there is nothing" report.
       *
       * Writing anyway costs one idempotent upsert - the store is keyed `(channel_id, seq)` with
       * `ON CONFLICT DO UPDATE` - and it turns a duplicate frame into a no-op instead of turning a
       * hole into a permanent one. The decision below still governs whether to BACKFILL, which is
       * the expensive part and the only thing worth deciding.
       */
      await this.store.upsert([envelope]);

      // On a gap the message is still appended - a send that succeeded must not vanish from the
      // UI - and the backfill below fills the hole behind it. An `ignore` never backfills: it is
      // at or below the mark, so there is nothing above it to fetch.
      return decision.action !== 'ignore' && decision.syncAfter ? localMax : null;
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

  /**
   * Ask for these channels to be subscribed, now or as soon as the socket can carry it.
   *
   * Recorded before it is sent, so a caller during the handshake - which is every chat screen
   * on a cold open - keeps its subscription instead of losing it to a throw.
   */
  subscribe(channelIds: readonly string[]) {
    for (const channelId of channelIds) this.pendingSubscribes.add(channelId);
    this.flushSubscribes();
  }

  /** Send whatever subscriptions are outstanding, if the socket can carry them. */
  private flushSubscribes() {
    if (this.pendingSubscribes.size === 0) return;
    const channelIds = [...this.pendingSubscribes];
    try {
      this.send({ t: 'subscribe', d: { channelIds } });
      this.pendingSubscribes.clear();
    } catch {
      // Not usable yet. Left pending; `auth.ok` flushes them.
    }
  }

  /**
   * Open a conversation: make sure this client is subscribed to it and has its history.
   *
   * > **A channel you gain access to mid-session was never backfilled.** `channels` is replaced
   * > wholesale at `auth.ok` and never again, and `syncAll` walks exactly that list - so a race
   * > you just joined, were added to, or created was not in it. Nothing fetched its messages,
   * > and joining a race redirects straight into its chat, so the founder met "No messages yet"
   * > in a room the server had already written "PwOwner joined the race" into. A reload fixed
   * > it, which is what made it look like the server had not posted anything.
   *
   * Live frames were unaffected, which is exactly why this hid for so long: anything sent while
   * you sat there appeared, and only the history you arrived too late for was missing. The two
   * halves were each individually correct.
   *
   * Called on entering any chat, not only an unknown one. Syncing a channel already in hand is
   * the cheap case - the server answers from the revision mark with nothing to send - and a
   * method that only ran for unknown channels would be one more rule to get right at the call
   * site.
   */
  async openChannel(channelId: string): Promise<void> {
    if (!this.channels.some((entry) => entry.id === channelId)) {
      /*
       * Subscribe before syncing, so anything posted during the fetch arrives rather than
       * falling into the gap between the two.
       *
       * > **A failure here must not cancel the sync below, and for a long time it did.** `send`
       * > throws `not connected` when the socket is down, which aborted `openChannel` before it
       * > ever reached `syncChannel` - so opening a conversation on a client whose socket was
       * > flapping did **no reconciliation at all**, despite the sync being plain HTTP that needs
       * > no socket. The realtime enhancement was taking the durable path down with it, which is
       * > backwards: PRD/16 rule 4 makes realtime an enhancement and the fetch the requirement.
       *
       * The visible cost was a device that stayed permanently behind - it could not receive
       * messages live, and the one thing that could have caught it up was skipped every time it
       * tried. Missed messages then sat below the local high-water mark, where until `repairGaps`
       * nothing would ever ask for them again.
       *
       * `subscribe` now holds rather than throws, so this cannot abort the sync at all - and the
       * subscription survives the wait instead of being dropped by a caller that carried on.
       */
      this.subscribe([channelId]);
    }
    await this.syncChannel(channelId, await this.store.localMaxSeq(channelId));
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

  /**
   * Reconcile a channel: everything new, and everything CHANGED.
   *
   * > **This used to ask for `seq > local max`, and a row already held was therefore never
   * > fetched again.** Pins, tombstones and reactions all mutate rows below that mark, so a
   * > client that was offline when a message was deleted kept showing it - with its text -
   * > indefinitely. Every automated check passed, because each half was individually correct.
   *
   * The mark is now a channel REVISION, which an append and a mutation both advance, so one
   * question covers both. `sinceSeq` is still sent: it is what a server that predates revisions
   * would use, and it costs nothing to keep the request honest for both.
   */
  async syncChannel(channelId: string, sinceSeq: number): Promise<void> {
    this.syncCount += 1;
    /*
     * **Never allowed to fail the sync it runs in front of.**
     *
     * Repairing a hole is a repair, not a precondition. Letting it throw here would mean a
     * failing repair - an expired token, a 500, one bad page - took ordinary reconciliation down
     * with it, turning "some old messages are missing" into "no new messages arrive at all".
     * That is a strictly worse failure than the one this exists to fix.
     */
    try {
      await this.repairGaps(channelId);
    } catch (error) {
      this.log('gap repair failed, continuing with the ordinary sync', {
        channelId,
        error: String(error),
      });
    }
    let since = sinceSeq;
    let mark = await this.store.syncMark(channelId);

    // Keep pulling while the server says there is more, so a client that has been away
    // long enough to exceed one page does not stop half way and believe it is caught up.
    for (;;) {
      const url = `${this.opts.apiUrl}/sync?channels[]=${syncEntry(channelId, since, mark)}`;
      const response = await this.fetch(url, {
        headers: { authorization: `Bearer ${this.opts.token}` },
      });
      if (!response.ok) throw new Error(`sync failed: ${response.status}`);

      const body = (await response.json()) as {
        channels: Array<{
          channelId: string;
          messages: MessageEnvelope[];
          hasMore: boolean;
          maxRev?: number;
        }>;
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

      /*
       * Advance BOTH marks, and page on the revision.
       *
       * The pages arrive ordered by `rev`, not by `seq` - a message changed today sorts after one
       * sent an hour ago - so taking the last message's seq as the next cursor would page
       * incoherently. The revision is the cursor; `since` is kept only for the pre-revision
       * server, where the ordering is by seq and this is still the right value.
       */
      if (result.maxRev !== undefined && result.maxRev > mark) {
        mark = result.maxRev;
        await this.store.setSyncMark(channelId, mark);
      }
      since = Math.max(since, ...result.messages.map((message) => message.seq));

      if (!result.hasMore) return;

      /*
       * A server with no revisions returns no `maxRev`, so the mark never moves - and paging on
       * `since` alone would loop forever if it also never moved. Stopping is correct there: the
       * seq cursor did advance if there was anything new, and if it did not there is nothing
       * left to fetch.
       */
      if (result.maxRev === undefined && since === sinceSeq) return;
    }
  }

  /**
   * Refetch anything missing BELOW the high-water mark.
   *
   * > **Neither cursor can reach a hole, and that is why one could last forever.** `since_seq`
   * > asks for `seq > mine`, and a missing message is below that. `since_rev` asks for
   * > `rev > mine`, and a message that arrived before the mark moved has a lower revision - so
   * > the reconciling form cannot see it either. Every sync reported success while the gap sat
   * > there, counted by the unread badge and invisible in the conversation.
   *
   * This is how a poll card posted by another member stayed missing from one device for an
   * afternoon while rendering correctly on another: three cards were missed while the socket was
   * down, a later message pulled the mark past them, and nothing would ever ask for them again.
   *
   * **Deliberately the seq form, with no revision.** The rev cursor is the right one for ordinary
   * reconciliation and the wrong one for a repair, for the reason above. `findGaps` has existed
   * and been tested since the store was written; it had no caller until now.
   */
  private async repairGaps(channelId: string): Promise<void> {
    const gaps = findGaps(await this.store.seqs(channelId));
    if (gaps.length === 0) return;

    // From just below the lowest hole. Re-pulling what we already hold is an idempotent upsert,
    // and paying that once is the price of never leaving a message unrecoverable.
    let since = Math.max(0, gaps[0]! - 1);
    this.log('repairing a gap below the high-water mark', {
      channelId,
      missing: gaps.length,
      from: since,
      // The seqs themselves, not just how many. A repair that runs every sync forever is either
      // a hole the server will not fill or a write that is not landing, and the count cannot
      // tell those apart - the identity of the rows can.
      seqs: gaps.slice(0, 8),
    });

    for (;;) {
      const response = await this.fetch(`${this.opts.apiUrl}/sync?channels[]=${syncEntry(channelId, since)}`, {
        headers: { authorization: `Bearer ${this.opts.token}` },
      });
      if (!response.ok) throw new Error(`gap repair failed: ${response.status}`);

      const body = (await response.json()) as {
        channels: Array<{ channelId: string; messages: MessageEnvelope[]; hasMore: boolean }>;
      };
      const result = body.channels.find((channel) => channel.channelId === channelId);
      if (!result || result.messages.length === 0) return;

      await this.serialize(channelId, () => this.store.upsert(result.messages));

      /*
       * **A repair that does not repair has to say so.** This runs on every sync, so a hole the
       * write never closes is an unbounded loop of fetch-and-discard that no error reports:
       * the request succeeds, the upsert resolves, and the next sync asks for the same page
       * again. Only comparing the hole before and after can tell that apart from a normal repair.
       */
      const remaining = findGaps(await this.store.seqs(channelId)).filter(
        (seq) => seq <= Math.max(...result.messages.map((message) => message.seq)),
      );
      if (remaining.length > 0) {
        this.log('gap repair wrote a page and the hole is still there', {
          channelId,
          wrote: result.messages.length,
          stillMissing: remaining.slice(0, 8),
        });
      }

      const highest = Math.max(...result.messages.map((message) => message.seq));
      // Guard against a server that returns a page without advancing the cursor, which would
      // otherwise spin here forever.
      if (!result.hasMore || highest <= since) return;
      since = highest;
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
