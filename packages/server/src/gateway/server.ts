/**
 * The gateway.
 *
 * Owns WebSocket connections and NOTHING durable. It authenticates the socket,
 * authorizes channel subscriptions once at subscribe time, holds
 * `socket -> {user, subscribed channels}` in process memory, mirrors `user -> gateway`
 * into Redis, and forwards published envelopes to the right sockets.
 *
 * > **A gateway can be killed at any instant with zero data loss.**
 * >
 * > That property is load-bearing and must not be traded away. Everything it knows is
 * > reconstructible by a client reconnecting, because nothing is acknowledged before it
 * > is durable and nothing durable is ever only in a gateway's memory. Every change to
 * > this file should be checked against that sentence.
 *
 * It holds no business logic: sends go through the same appendMessage path the API
 * uses.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import {
  ClientFrame,
  MessageEnvelope,
  MsgUpdate,
  type MsgSendFrame,
  type ServerFrame,
} from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import type { Monitor } from '../monitoring.ts';
import { redact, type Tracer } from '../dev/trace.ts';
import type { Auth } from '../auth.ts';
import { resolveSessionFromToken } from '../auth.ts';
import { ChannelGoneError } from '../domain/append-message.ts';
import { sendMessage } from '../domain/send-message.ts';
import { getChannelRef, listAccessibleChannels } from '../domain/reads.ts';
import { openChat } from '../domain/inbox.ts';
import { loadAccessContext } from '../policy/context.ts';
import { isChannelMember, isSessionUsable } from '../policy/predicates.ts';
import { createChannelSubscriptions } from './channel-subscriptions.ts';
import {
  createConnectionRegistry,
  publishToChannel,
  type Published,
  type RateLimiter,
  type RevokeInstruction,
  HEARTBEAT_INTERVAL_MS,
  REAPER_TIMEOUT_MS,
  REVOKE_TOPIC,
} from '../bus/redis.ts';

/** The socket is closed if the first frame is not `auth` within this window. */
const AUTH_TIMEOUT_MS = 5_000;

/**
 * And once `auth` HAS arrived, the handshake has this long to answer it.
 *
 * > **A second window rather than a longer first one, because the two are different
 * > questions.** The first asks whether the client is going to speak at all, and five seconds
 * > is generous for one frame. The second asks whether this server can finish the two database
 * > round trips - and a client that has spoken correctly deserves more room than one that has
 * > not spoken at all, because the cost of being wrong is a member refused on a working token.
 *
 * What must never happen is neither window applying, which is what the code did: the timer was
 * cleared on ENTRY to the handler, so anything that went wrong inside it answered nothing at
 * all and the app sat on a spinner forever.
 *
 * Deliberately SHORTER than the client's own wait for a reply (12s in `chat-client.ts`), so
 * that whenever this process is alive it answers first and the client acts on a reason rather
 * than on a silence. The client's timer is the backstop for a server that is not there at all.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * The two frames that can end a handshake. Exactly one of them leaves every socket.
 *
 * Named as a type so `answerHandshake` cannot be handed an `msg.ack` and so the switch that
 * builds one is checked against the wire contract rather than against a comment.
 */
type AuthReplyFrame = Extract<ServerFrame, { t: 'auth.ok' } | { t: 'auth.err' }>;

type SocketState = {
  socket: WebSocket;
  userId: string | null;
  sessionId: string | null;
  deviceId: string | null;
  subscribed: Set<string>;
  lastSeenAt: number;
  /**
   * End the handshake, exactly once, with the one frame the client is waiting for.
   *
   * Every terminating path of `handleAuth` goes through here, and so does the timer, and so
   * does the catch around the frame switch. That is the whole invariant: **a socket that has
   * been given an `auth` frame is answered with `auth.ok` or `auth.err`, whatever happens.**
   * The client's `connect()` awaits that reply and its only other rejector is the socket
   * closing, so a path that returns without answering hangs the app until it is force-quit.
   *
   * An `auth.err` closes the socket as part of answering; there is nothing further this
   * connection may do. Calls after the first are no-ops, which is what makes the timer safe to
   * leave armed across the handler.
   */
  answerHandshake: (frame: AuthReplyFrame, correlationId?: string) => void;
};

export type GatewayDeps = {
  db: Db;
  auth: Auth;
  /** Command connection: publish, registry, rate limits. */
  redis: Redis;
  /**
   * A SEPARATE connection for subscribe mode. ioredis puts a connection into
   * subscriber mode exclusively, so sharing one with the command client would break
   * every publish and registry write.
   */
  subscriber: Redis;
  rateLimiter: RateLimiter;
  gatewayId: string;
  log: (level: 'info' | 'warn' | 'error', message: string, extra?: unknown) => void;
  /**
   * Where a failed frame goes, beyond the log.
   *
   * Optional so the gateway's tests construct deps unchanged. A socket failure is the one class
   * of server error with no HTTP status to carry it: the client sees a frame that never arrives.
   */
  monitor?: Monitor | undefined;
  /**
   * The development trace.
   *
   * Optional for the same reason `monitor` is: the gateway's tests construct deps unchanged,
   * and absent is the only state that exists in production. See `dev/trace.ts`.
   */
  tracer?: Tracer | undefined;
};

export type Gateway = {
  wss: WebSocketServer;
  close: () => Promise<void>;
  /**
   * Drop a user's subscriptions to specific channels, immediately.
   *
   * Because access is checked at subscribe time and NOT rechecked per message, a live
   * subscription outlives the membership that justified it. Removing someone from a
   * club, a race roster or the Eboard must therefore force-unsubscribe their sockets,
   * not merely delete the row. This is the one cost per-channel fan-out carries that
   * per-user fan-out does not, and the failure is silent: a removed member keeps reading
   * a channel they no longer belong to and nothing reports it.
   *
   * > **Blocking a member in a DM deliberately does NOT revoke anything**, which is the
   * > opposite of what it looks like it should do. A block leaves history readable to both
   * > parties by design (PRD/14 rule 6), so read access has not ended and the subscription is
   * > still justified - and since neither party can now send, there are no new messages for it
   * > to deliver. The same is true when a pair loses their last shared club: read-only, not
   * > gone. Revoking there would break the requirement rather than enforce it.
   */
  revokeSubscriptions: (userId: string, channelIds: readonly string[]) => void;
};

export function createGateway(
  deps: GatewayDeps,
  opts: {
    port: number;
    /** Overridable so a test does not have to wait five seconds to watch a socket be closed. */
    authTimeoutMs?: number;
    handshakeTimeoutMs?: number;
  },
): Gateway {
  const wss = new WebSocketServer({ port: opts.port });
  const authTimeoutMs = opts.authTimeoutMs ?? AUTH_TIMEOUT_MS;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const registry = createConnectionRegistry(deps.redis, deps.gatewayId);

  const states = new Map<WebSocket, SocketState>();
  /**
   * Which sockets this gateway holds for each channel, and the Redis subscription behind them.
   *
   * Its own module because the invariant it keeps is narrow and was broken here for a long
   * time: an entry exists only for a channel this process has an ACCEPTED subscribe for. See
   * `channel-subscriptions.ts`.
   */
  const subscriptions = createChannelSubscriptions<WebSocket>(deps.subscriber, {
    onUnsubscribeFailed: (channelId, error) =>
      deps.log('warn', 'failed to unsubscribe from a channel topic', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      }),
  });

  const send = (socket: WebSocket, frame: ServerFrame, correlationId?: string) => {
    if (socket.readyState !== socket.OPEN) return;
    const withId = correlationId === undefined ? frame : { ...frame, id: correlationId };
    socket.send(JSON.stringify(withId));

    /*
     * Traced AFTER the write, so the page never shows a frame the socket refused.
     *
     * Every directed reply passes through here - handshakes, acks, refusals - so one call is
     * the whole picture rather than a sample. The Redis fan-out is the deliberate exception:
     * it serializes once for many sockets and is traced at its own site, as one event.
     */
    deps.tracer?.emit({
      kind: 'ws',
      dir: 'out',
      type: frame.t,
      userId: states.get(socket)?.userId ?? null,
      correlationId: correlationId ?? null,
      payload: redact((frame as { d?: unknown }).d),
    });
  };

  // ---------------------------------------------------------------------------
  // Redis subscription bookkeeping
  // ---------------------------------------------------------------------------

  /**
   * Drop a user's subscriptions to specific channels, immediately.
   *
   * Called both locally and from the revocation topic. Only affects sockets this gateway
   * holds, which is correct: every gateway receives the instruction and acts on its own.
   */
  function revoke(userId: string, channelIds: readonly string[]) {
    let dropped = 0;
    for (const [socket, state] of states) {
      if (state.userId !== userId) continue;
      for (const channelId of channelIds) {
        if (!state.subscribed.has(channelId)) continue;
        subscriptions.detach(socket, channelId);
        state.subscribed.delete(channelId);
        dropped += 1;
      }
    }
    if (dropped > 0) deps.log('info', 'revoked subscriptions', { userId, dropped });
  }

  // Subscribed for the gateway's whole life, not only while it holds a relevant socket.
  // A gateway that ignored revocations while idle would let a removed member keep reading
  // the channel they were removed from.
  void deps.subscriber.subscribe(REVOKE_TOPIC).catch((error) =>
    deps.log('error', 'failed to subscribe to the revocation topic', {
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  deps.subscriber.on('message', (topic: string, raw: string) => {
    if (topic === REVOKE_TOPIC) {
      try {
        const instruction = JSON.parse(raw) as RevokeInstruction;
        revoke(instruction.userId, instruction.channelIds);
      } catch {
        deps.log('warn', 'undecodable revocation instruction');
      }
      return;
    }

    let published: Published;
    try {
      published = JSON.parse(raw) as Published;
    } catch {
      deps.log('warn', 'undecodable publish payload', { topic });
      return;
    }

    const sockets = subscriptions.socketsFor(published.channelId);
    if (!sockets) return;

    // In-process fan-out to sockets, which is cheap. The expensive part - authorizing
    // the recipient - already happened once, at subscribe time.
    //
    // Two kinds travel on this topic: a new message, and a change to one that already
    // exists (a pin, a tombstone, a reaction). `kind` is absent on anything published by a
    // process that predates updates, which is why the default is 'message' rather than a
    // required tag - a rolling restart must not drop frames.
    //
    /*
     * > **Validated on the way through, not merely typed.** `published` arrives from Redis as a
     * > `JSON.parse` cast, so `ServerFrame` here was a claim about a payload nothing had checked
     * > - and on 2026-08-01 that claim was false: a worker process older than the `mentions`
     * > field published an envelope without it, this relayed it verbatim, and every client's
     * > cache rejected the insert and lost the message.
     * >
     * > Parsing repairs rather than rejects, which is the point of doing it HERE. The schema's
     * > own defaults fill in what an older producer omitted, so a rolling restart stays safe -
     * > the same reason `kind` is defaulted above. Only a payload that cannot be repaired is
     * > dropped, and it is dropped loudly.
     */
    const relayed =
      published.kind === 'update'
        ? MsgUpdate.safeParse(published.update)
        : MessageEnvelope.safeParse(published.envelope);
    if (!relayed.success) {
      deps.log('warn', 'unrelayable publish payload', {
        topic,
        kind: published.kind ?? 'message',
        channelId: published.channelId,
        seq: published.seq,
        issues: relayed.error.issues,
      });
      return;
    }

    const frame: ServerFrame =
      published.kind === 'update'
        ? { t: 'msg.update', d: relayed.data as MsgUpdate }
        : { t: 'msg.new', d: relayed.data as MessageEnvelope };
    const encoded = JSON.stringify(frame);
    let delivered = 0;
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(encoded);
        delivered += 1;
      }
    }

    /*
     * One trace for the whole fan-out, not one per socket.
     *
     * The payload is serialized ONCE above and written to every subscriber, which is the
     * property ADR-0007 exists to buy - so tracing per recipient would both misrepresent the
     * work done and drown the page in a large channel. The recipient count is the interesting
     * number, and it is the one thing a per-socket trace would have made harder to read.
     */
    deps.tracer?.emit({
      kind: 'ws',
      dir: 'out',
      type: `${frame.t} -> ${delivered} socket${delivered === 1 ? '' : 's'}`,
      userId: null,
      correlationId: published.channelId,
      payload: redact(frame.d),
    });
  });

  // ---------------------------------------------------------------------------
  // Frame handling
  // ---------------------------------------------------------------------------

  const handleAuth = async (
    state: SocketState,
    payload: { token: string; deviceId: string; platform: string },
    correlationId?: string,
  ) => {
    const session = await resolveSessionFromToken(deps.auth, payload.token);
    if (!session?.user) {
      state.answerHandshake({ t: 'auth.err', d: { code: 'invalid_token' } }, correlationId);
      return;
    }

    // Blocking a user does not invalidate an already-issued token, so the check has to
    // happen here too rather than only at sign-in. Through the access context and the
    // policy module, because the version that read `session.user.signinBlockedAt` directly
    // was asking for a property better-auth does not return, and never fired.
    const access = await loadAccessContext(deps.db, session.user.id);
    if (!isSessionUsable(access)) {
      state.answerHandshake({ t: 'auth.err', d: { code: 'signin_blocked' } }, correlationId);
      return;
    }

    state.userId = session.user.id;
    state.sessionId = session.session.id;
    state.deviceId = payload.deviceId;
    state.lastSeenAt = Date.now();

    /*
     * The registry write is BEST EFFORT, and is not allowed to fail the handshake.
     *
     * > **It was awaited, and it is the likeliest thing in this function to throw.** It is a
     * > Redis write on `maxRetriesPerRequest: 3`, so a Redis restart makes it reject within a
     * > second or two - and before this it took the whole handshake down with it, silently.
     *
     * Refusing the connection because Redis blinked is the wrong trade twice over.
     * `SPEC/TECH/11-failure-modes.md` requires a wiped Redis to DEGRADE the system rather than
     * break it: realtime stops, push is unaffected, rate limiting fails open. And the registry
     * is a routing hint with no reader at all today - per-channel topics made the lookup
     * unnecessary - so a missing entry costs nothing that the client's own sync does not
     * already repair. A socket that works is worth more than a routing hint that is accurate.
     *
     * Reported rather than swallowed, because "the registry is empty" has no other symptom.
     */
    void registry
      .register(state.userId, state.sessionId, {
        deviceId: payload.deviceId,
        platform: payload.platform,
      })
      .catch((error: unknown) => {
        deps.log('error', 'could not record the connection in the registry', {
          userId: state.userId,
          error: error instanceof Error ? error.message : String(error),
        });
        deps.monitor?.capture(error, 'gateway.registry.register');
      });

    // Hand over every channel's head and this user's cursor. The client now knows
    // exactly which channels have a gap BEFORE fetching a single message.
    const channels = await listAccessibleChannels(deps.db, state.userId);

    state.answerHandshake(
      {
        t: 'auth.ok',
        d: {
          sessionId: state.sessionId,
          userId: state.userId,
          // Handed over once per connection so the client can attribute its own messages the
          // moment they are acked, rather than rendering them anonymously until a sync brings
          // the server's copy back. See AccessContext.displayName.
          displayName: access.displayName,
          /* Same trip, same reason: their own acked bubble draws their face, not a letter. */
          displayImage: access.displayImage,
          serverTime: new Date().toISOString(),
          channels,
        },
      },
      correlationId,
    );
  };

  /**
   * The session was revoked while this socket was open. Drop it.
   *
   * > **Asked on every frame that reloads the context, not only at `auth`.** The HTTP hook
   * > re-asks `isSessionUsable` on every single request; this side asked it once, at connect,
   * > and a socket outlives that answer indefinitely because a client holds it open with
   * > heartbeat pings. Proved on 2026-08-08: with `signin_blocked_at` set, HTTP correctly
   * > answered 401 while the same account's socket kept acking sends into club chat, and the
   * > rows are in the channel log.
   *
   * Note this is the same shape as AGENTS.md failure mode 12 one layer up. There the check read
   * a field better-auth does not return, so it never fired; here the check is correct and simply
   * was not run at the point that mattered. A revocation is only as good as its least frequent
   * question.
   *
   * The socket is closed rather than the frame refused, because there is nothing this connection
   * may still do - and closing is what makes the client sign out rather than retry.
   */
  const dropRevoked = (state: SocketState, correlationId?: string) => {
    send(state.socket, { t: 'auth.err', d: { code: 'signin_blocked' } }, correlationId);
    state.socket.close();
  };

  const handleSubscribe = async (
    state: SocketState,
    channelIds: readonly string[],
    correlationId?: string,
  ) => {
    const granted: string[] = [];
    const rejected: string[] = [];

    // Reloaded per subscribe frame rather than cached from auth: this is the single
    // point at which access is checked for the lifetime of the subscription, so it
    // should read the current state of the world.
    const access = await loadAccessContext(deps.db, state.userId!);
    // Including whether the account may still act at all. Granting a subscription to a revoked
    // session would hand it a live feed of every channel it used to be able to read.
    if (!isSessionUsable(access)) return dropRevoked(state, correlationId);

    for (const channelId of channelIds) {
      const channel = await getChannelRef(deps.db, channelId);
      if (!channel || !isChannelMember(access, channel)) {
        rejected.push(channelId);
        continue;
      }
      /*
       * A subscription that could not be established is REFUSED, not granted.
       *
       * > **The whole frame used to die here, and the socket was told nothing.** `attach`
       * > throws when Redis refuses the SUBSCRIBE, the throw unwound to the generic frame
       * > catch - which deliberately keeps the socket open and says nothing, because one bad
       * > frame must not drop a conversation - and the client was left believing it was
       * > subscribed to channels this gateway had never subscribed to. Every channel after the
       * > failing one in the same frame was skipped too.
       *
       * Reporting it as `rejected` is the honest answer: no live delivery was arranged. It is
       * not a permission refusal and the client treats neither as terminal - it re-subscribes on
       * the next `openChannel` and on every reconnect - so the recoverable case recovers. What
       * must not happen is silence, which is why this is reported as well as logged: a channel
       * whose realtime is off has no other symptom.
       */
      try {
        await subscriptions.attach(state.socket, channelId);
      } catch (error) {
        deps.log('error', 'could not subscribe to a channel topic', {
          channelId,
          error: error instanceof Error ? error.message : String(error),
        });
        deps.monitor?.capture(error, 'gateway.subscribe', { channelId });
        rejected.push(channelId);
        continue;
      }
      state.subscribed.add(channelId);
      granted.push(channelId);
    }

    send(state.socket, { t: 'subscribed', d: { granted, rejected } }, correlationId);
  };

  const handleSend = async (
    state: SocketState,
    // The frame's own type, not a copy of its fields. See `MsgSendFrame`.
    payload: MsgSendFrame,
    correlationId?: string,
  ) => {
    // Rate limited BEFORE the insert, per SPEC/TECH/05-authorization.md.
    if (!(await deps.rateLimiter.tryConsume(state.userId!))) {
      send(
        state.socket,
        { t: 'msg.err', d: { clientMsgId: payload.clientMsgId, code: 'rate_limited' } },
        correlationId,
      );
      return;
    }

    const channel = await getChannelRef(deps.db, payload.channelId);
    if (!channel) {
      send(
        state.socket,
        { t: 'msg.err', d: { clientMsgId: payload.clientMsgId, code: 'channel_gone' } },
        correlationId,
      );
      return;
    }

    // Authorization is re-checked on the send itself and not inherited from the
    // subscription. A subscription proves what was true when it was granted; a write
    // must be checked when it happens.
    const access = await loadAccessContext(deps.db, state.userId!);
    /*
     * And the session itself, which is a different question from "may this user post here".
     *
     * A revoked account normally still holds every membership row it had - an operator shutting
     * somebody off does not remove them from their clubs - so `canPostInChannel` below answers
     * yes and the send commits. Membership is not the check that fails; the session is, and it
     * was never asked.
     *
     * The pending send is settled BEFORE the socket closes, so the client's outbox resolves this
     * attempt rather than holding a promise nobody answers. It stays in the outbox and is retried
     * on reconnect, where `auth` refuses it - which is the correct end state, and safe because
     * `client_msg_id` makes the retry idempotent either way.
     */
    if (!isSessionUsable(access)) {
      send(
        state.socket,
        { t: 'msg.err', d: { clientMsgId: payload.clientMsgId, code: 'forbidden' } },
        correlationId,
      );
      return dropRevoked(state);
    }

    try {
      // Through the authorized command, not straight to appendMessage. That is where the
      // membership check and the announcement gate live, so the gateway cannot become a
      // second path with its own opinion about who may post what.
      const outcome = await sendMessage(deps.db, access, channel, {
        channelId: payload.channelId,
        clientMsgId: payload.clientMsgId,
        type: payload.type,
        body: payload.body ?? null,
        mentions: payload.mentions,
        mediaId: payload.mediaId,
        replyToSeq: payload.replyToSeq,
      });

      if (!outcome.ok) {
        send(
          state.socket,
          {
            t: 'msg.err',
            d: {
              clientMsgId: payload.clientMsgId,
              // `invalid_type` is a client bug rather than a recoverable state, so it maps
              // to malformed. `media_not_ready` passes through unchanged because the client
              // CAN recover from it by completing the upload and retrying, and
              // `content_refused` passes through because the client must NOT retry it and
              // needs to say why - see its note in the protocol.
              code: outcome.code === 'invalid_type' ? 'malformed' : outcome.code,
            },
          },
          correlationId,
        );
        return;
      }

      const result = outcome;

      // The ack goes out the instant the transaction has committed, BEFORE any
      // fan-out. Perceived send latency is one round trip plus one Postgres commit,
      // and ack latency is the number a chat app is judged on.
      send(
        state.socket,
        {
          t: 'msg.ack',
          d: {
            clientMsgId: result.message.clientMsgId,
            messageId: result.message.id,
            channelId: result.message.channelId,
            seq: result.message.seq,
            createdAt: result.message.createdAt,
          },
        },
        correlationId,
      );

      /*
       * Only then publish - and publish for a DEDUPLICATED retry too.
       *
       * > **This used to skip the publish when `appendMessage` reported a retry, on the reasoning
       * > that "the original was already delivered". That reasoning assumes the append and the
       * > publish are atomic, and they are not.** They are a Postgres commit and a Redis publish,
       * > in that order, with nothing spanning them - so a first attempt that committed the row
       * > and then died, or whose publish threw, leaves a message that is durable and was never
       * > fanned out. The client retries with the same `client_msg_id`, this recognises it,
       * > returns the original `seq`, and skips the fan-out **forever**. `deduplicated: true`
       * > proves the row exists. It proves nothing at all about whether anybody was told.
       *
       * The symptom is the one reported as "it did not show up until I backgrounded the app":
       * the message really is in the channel log, so every other member finds it on their next
       * `/sync`. Only realtime was lost, and it was lost silently.
       *
       * **A duplicate publish is strictly cheaper than a lost one**, and three client rules make
       * it a no-op rather than a duplicate message: `decideGap` answers `ignore` for any seq at
       * or below the local maximum, `applyIncoming` upserts and backfills nothing on an `ignore`,
       * and the device's store is `ON CONFLICT (channel_id, seq) DO UPDATE`. Notifications are
       * untouched either way - they ride the outbox event, and `appendMessage` writes no outbox
       * event for a deduplicated retry. The same defect shape was fixed in `worker/effects.ts`
       * `postSystemMessage` on 2026-08-20.
       *
       * The publish has a catch of its own for the same reason it now happens unconditionally.
       * Falling into the handler's catch below would report a committed, acked message as
       * `send failed` and answer `msg.err` after an `msg.ack` has already gone out - which the
       * client drops, because the outbox entry the ack resolved is gone. So the one failure that
       * actually loses a fan-out was the one nothing could see. Realtime is an enhancement and
       * the message is durable, so the send stands; what must not stand is the silence.
       */
      try {
        await publishToChannel(deps.redis, payload.channelId, result.message);
      } catch (error) {
        deps.log('error', 'the message committed but could not be published', {
          channelId: payload.channelId,
          seq: result.message.seq,
          error: error instanceof Error ? error.message : String(error),
        });
        deps.monitor?.capture(error, 'gateway.publish', {
          channelId: payload.channelId,
          seq: result.message.seq,
        });
      }
    } catch (error) {
      if (error instanceof ChannelGoneError) {
        send(
          state.socket,
          { t: 'msg.err', d: { clientMsgId: payload.clientMsgId, code: 'channel_gone' } },
          correlationId,
        );
        return;
      }
      deps.log('error', 'send failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // The client keeps the message in its outbox and retries; `client_msg_id` makes
      // that safe.
      send(
        state.socket,
        { t: 'msg.err', d: { clientMsgId: payload.clientMsgId, code: 'malformed' } },
        correlationId,
      );
    }
  };

  wss.on('connection', (socket: WebSocket) => {
    /**
     * The handshake's one answer, and the timer that guarantees it arrives.
     *
     * > **The timer used to be cleared on ENTRY to the `auth` case**, so from the moment the
     * > frame arrived nothing was watching the handshake at all. A throw inside the handler
     * > unwound into the generic frame catch, which deliberately keeps the socket open and says
     * > nothing - right for one bad `msg.send`, fatal here - and the client sat awaiting a
     * > reply that would never come, with no timeout of its own. Thirty seconds of Redis
     * > restarting was thirty seconds of phones cold-opening onto a permanent spinner.
     *
     * So the timer now OUTLIVES the handler and is cleared by the answer instead. It is
     * re-armed to a longer window when `auth` arrives, because "did you speak" and "can I
     * finish" are different questions deserving different patience.
     */
    let handshakeAnswered = false;
    let authTimer: ReturnType<typeof setTimeout> | undefined;

    const armHandshakeTimer = (ms: number) => {
      if (authTimer !== undefined) clearTimeout(authTimer);
      authTimer = setTimeout(() => {
        answerHandshake({ t: 'auth.err', d: { code: 'timeout' } });
      }, ms);
    };

    /*
     * `timeout` is also what a handshake that FAILED for a server-side reason answers, and that
     * is a compromise worth naming. The protocol's `auth.err` codes are a closed set
     * (`SPEC/TECH/10-protocol.md`), and of the six, `timeout` is the only one that says "this
     * handshake did not complete" without blaming the credential. The two that would be more
     * precise about a server fault do not exist yet, and the two that describe the token -
     * `invalid_token` and `signin_blocked` - are the ones the client acts on by SIGNING THE
     * MEMBER OUT, so reaching for either would turn a Redis blip into a mass sign-out. A
     * distinct `server_error` code is a protocol change and belongs with that document.
     */
    const answerHandshake = (frame: AuthReplyFrame, correlationId?: string) => {
      if (handshakeAnswered) return;
      handshakeAnswered = true;
      if (authTimer !== undefined) clearTimeout(authTimer);
      authTimer = undefined;
      send(socket, frame, correlationId);
      // An `auth.err` ends the connection: there is nothing further it may do, and closing is
      // what lets the client stop waiting and decide between retrying and signing out.
      if (frame.t === 'auth.err') socket.close();
    };

    const state: SocketState = {
      socket,
      userId: null,
      sessionId: null,
      deviceId: null,
      subscribed: new Set(),
      lastSeenAt: Date.now(),
      answerHandshake,
    };
    states.set(socket, state);

    armHandshakeTimer(authTimeoutMs);

    /*
     * A protocol-level PONG is liveness, exactly like an inbound frame.
     *
     * The reaper measures silence, and until the server started pinging, "silent" meant "sent
     * no application frame" - so a member reading a club hub for two minutes without typing was
     * indistinguishable from a phone that had fallen off the network. This is the other half of
     * the ping the reaper sends: a peer that answers is reachable, whatever it has to say.
     */
    socket.on('pong', () => {
      state.lastSeenAt = Date.now();
    });

    const handleFrame = async (raw: Buffer): Promise<void> => {
      let frame: ClientFrame;
      try {
        frame = ClientFrame.parse(JSON.parse(raw.toString()));
      } catch {
        send(socket, { t: 'auth.err', d: { code: 'malformed' } });
        return;
      }

      /*
       * Traced after parsing and before handling.
       *
       * After parsing, because a frame that does not satisfy `ClientFrame` has no `t` to label
       * it with and is already answered above. Before handling, so a frame that goes on to
       * throw still appears - the trace is meant to show what the client sent, and the case
       * worth seeing most is the one that failed.
       */
      deps.tracer?.emit({
        kind: 'ws',
        dir: 'in',
        type: frame.t,
        userId: state.userId,
        correlationId: (frame as { id?: string }).id ?? null,
        payload: redact((frame as { d?: unknown }).d),
      });

      /*
       * Everything except `auth` requires an authenticated socket.
       *
       * > **This is `not_authenticated`, not `invalid_token`, and the distinction is the whole
       * > defect.** They are different facts - "you have not authenticated yet" and "the
       * > credential you presented is no good" - and a client acts on them very differently:
       * > the second is grounds to end the session and sign somebody out, which is exactly what
       * > `chat-provider.tsx` now does. Reporting the first as the second meant a member with a
       * > perfectly good token, whose session the API was answering 200 for, was told their
       * > session was dead.
       *
       * Reachable now only from a client that genuinely sends a frame before its `auth` - the
       * queue below means it can no longer be reached by losing a race.
       */
      if (frame.t !== 'auth' && state.userId === null) {
        send(socket, { t: 'auth.err', d: { code: 'not_authenticated' } });
        socket.close();
        return;
      }

      try {
        switch (frame.t) {
          case 'auth':
            // Re-armed, never cleared. The frame arrived, so the question is no longer whether
            // the client will speak but whether this handshake will ever answer.
            armHandshakeTimer(handshakeTimeoutMs);
            await handleAuth(state, frame.d, frame.id);
            break;
          case 'subscribe':
            await handleSubscribe(state, frame.d.channelIds, frame.id);
            break;
          case 'unsubscribe':
            for (const channelId of frame.d.channelIds) {
              subscriptions.detach(socket, channelId);
              state.subscribed.delete(channelId);
            }
            break;
          case 'msg.send':
            await handleSend(state, frame.d, frame.id);
            break;
          case 'msg.read':
            /*
             * `openChat`, not a bare cursor advance.
             *
             * Both move the cursor, and only this one also writes the "Caught up on N messages"
             * history row - which is the record that replaces a chat-unread row in the inbox
             * once the chat has actually been opened. `PRD/12` rule 7 requires it, and until
             * 2026-07-30 not a single one had ever been written: `openChat` was complete,
             * tested, and reached from nowhere but its own tests, because this handler called
             * the lower-level function underneath it. Failure mode 11.
             *
             * It is idempotent on `(outbox_event_id, recipient_id)`, so the repeated reads a
             * chat screen sends while somebody scrolls cannot produce a row per frame.
             */
            await openChat(deps.db, state.userId!, frame.d.channelId);
            break;
          case 'ping':
            /*
             * `.catch` is not decoration. `void promise` attaches no handler, so a Redis blip
             * here was an unhandled rejection - which Node 24 turns into a process exit, taking
             * every socket on this gateway down over a refreshed TTL nothing reads.
             */
            if (state.userId) {
              void registry.heartbeat(state.userId).catch((error: unknown) => {
                deps.log('warn', 'registry heartbeat failed', {
                  userId: state.userId,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
            }
            send(socket, { t: 'pong', d: {} }, frame.id);
            break;
        }
      } catch (error) {
        deps.log('error', 'frame handling failed', {
          frameType: frame.t,
          error: error instanceof Error ? error.message : String(error),
        });
        // The socket stays open and the client is told nothing, which is deliberate - one bad
        // frame must not drop a conversation. It does mean the failure is invisible from both
        // ends unless it is reported from here.
        deps.monitor?.capture(error, 'gateway.frame', { frameType: frame.t });

        /*
         * **Except for the handshake, where saying nothing is the bug.**
         *
         * Keeping the socket open costs a bad `msg.send` one dropped message and nothing else,
         * because the client will send another frame and get another answer. The handshake has
         * no next frame: `connect()` is awaiting this reply and the socket is not usable until
         * it lands, so a throw swallowed here is an app that never finishes loading. Answering
         * costs a reconnect; not answering costs a force-quit.
         */
        if (frame.t === 'auth') {
          state.answerHandshake({ t: 'auth.err', d: { code: 'timeout' } }, frame.id);
        }
      }
    };

    /**
     * Frames from one socket are handled ONE AT A TIME, in the order they arrived.
     *
     * > **Without this, the ordering a client sends in is not the ordering the server observes.**
     * > `handleAuth` awaits two database round trips, and the old handler started the next frame
     * > immediately rather than behind it - so a client that correctly sent `auth` and then
     * > `subscribe` had its `subscribe` evaluated against `state.userId === null` and refused.
     * > The socket was then closed, on a session the API was answering 200 for, and the member
     * > was signed out. Nothing about the token was ever wrong; the second frame simply overtook
     * > the first.
     *
     * The same rule the client already applies per channel, and for the same reason: a check
     * that reads state written by an earlier frame is only meaningful if that frame has finished.
     * See AGENTS.md failure mode 3.
     *
     * Per socket, so one member's frames never wait behind another's.
     */
    let queue: Promise<void> = Promise.resolve();

    socket.on('message', (raw: Buffer) => {
      /*
       * Liveness is a fact about arrival, not about handling. Told to the reaper here rather
       * than inside the queued work, so a frame waiting its turn is never mistaken for silence.
       */
      state.lastSeenAt = Date.now();

      queue = queue.then(() => handleFrame(raw)).catch((error: unknown) => {
        // The per-frame `catch` above covers handler failures. This is the backstop that keeps
        // the CHAIN alive: a rejection left unhandled here would skip every later frame on this
        // socket, turning one bad frame into a mute conversation.
        deps.log('error', 'frame dispatch failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        deps.monitor?.capture(error, 'gateway.frame');
      });
    });

    socket.on('close', () => {
      if (authTimer !== undefined) clearTimeout(authTimer);
      for (const channelId of state.subscribed) subscriptions.detach(socket, channelId);
      if (state.userId && state.sessionId) {
        void registry.unregister(state.userId, state.sessionId).catch(() => undefined);
      }
      states.delete(socket);
    });

    socket.on('error', (error) => {
      deps.log('warn', 'socket error', { error: error.message });
    });
  });

  /**
   * The reaper, and the ping that makes its question answerable.
   *
   * A gateway that dies without closing its sockets leaves stale Redis entries, which
   * expire by TTL. A publish to a stale entry is a harmless no-op, because the message
   * is already durable in the channel log and the client will sync on reconnect.
   *
   * > **This terminated live connections for two phases, because nothing kept them alive.**
   * > `lastSeenAt` advanced only on an inbound application frame, and no client sent the 30s
   * > `ping` the protocol specifies - so a member reading the clubs tab for ninety seconds
   * > without typing had their socket terminated underneath them. Nothing reconnected either,
   * > so they then received no live message until they sent one or opened a chat.
   *
   * The client's `ping` is the fix and is now sent (`packages/client-core/src/chat-client.ts`).
   * This ping is the SERVER's half, and it is here for a failure the client's cannot cover: a
   * half-open socket, where the peer is gone but no FIN ever arrived. A client in that state
   * believes it is connected, sends its pings into a dead pipe, and reconnects nothing. From
   * here it looks identical to a quiet member until the ping goes unanswered.
   *
   * Note what this changes about the word "silent": it now means "did not answer a ping in
   * ninety seconds" rather than "sent nothing in ninety seconds". That is the property worth
   * measuring. WebSocket peers - browsers, React Native and `ws` alike - answer a ping at the
   * protocol level without the application being involved, so this costs one frame per socket
   * per thirty seconds and needs nothing of the client.
   */
  const reaper = setInterval(() => {
    const cutoff = Date.now() - REAPER_TIMEOUT_MS;
    for (const [socket, state] of states) {
      if (state.lastSeenAt < cutoff) {
        deps.log('info', 'reaping silent socket', { userId: state.userId });
        socket.terminate();
        continue;
      }
      if (socket.readyState !== socket.OPEN) continue;
      try {
        socket.ping();
      } catch (error) {
        // A socket that cannot be pinged is already gone; the close handler cleans it up, and
        // the reaper takes it on a later tick if that never arrives.
        deps.log('warn', 'could not ping a socket', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  return {
    wss,
    async close() {
      clearInterval(reaper);
      for (const socket of states.keys()) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    revokeSubscriptions: revoke,
  };
}
