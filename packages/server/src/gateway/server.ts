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
import {
  channelTopic,
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

type SocketState = {
  socket: WebSocket;
  userId: string | null;
  sessionId: string | null;
  deviceId: string | null;
  subscribed: Set<string>;
  lastSeenAt: number;
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

export function createGateway(deps: GatewayDeps, opts: { port: number }): Gateway {
  const wss = new WebSocketServer({ port: opts.port });
  const registry = createConnectionRegistry(deps.redis, deps.gatewayId);

  const states = new Map<WebSocket, SocketState>();
  /** channelId -> sockets subscribed to it, for in-process fan-out. */
  const byChannel = new Map<string, Set<WebSocket>>();

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

  const attach = async (socket: WebSocket, channelId: string) => {
    let sockets = byChannel.get(channelId);
    if (!sockets) {
      sockets = new Set();
      byChannel.set(channelId, sockets);
      // First local subscriber for this channel: start listening. A gateway holding no
      // member of a channel receives nothing at all, which is the point of
      // per-channel topics.
      await deps.subscriber.subscribe(channelTopic(channelId));
    }
    sockets.add(socket);
  };

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
        detach(socket, channelId);
        state.subscribed.delete(channelId);
        dropped += 1;
      }
    }
    if (dropped > 0) deps.log('info', 'revoked subscriptions', { userId, dropped });
  }

  const detach = (socket: WebSocket, channelId: string) => {
    const sockets = byChannel.get(channelId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
      byChannel.delete(channelId);
      void deps.subscriber.unsubscribe(channelTopic(channelId)).catch(() => undefined);
    }
  };

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

    const sockets = byChannel.get(published.channelId);
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
      send(state.socket, { t: 'auth.err', d: { code: 'invalid_token' } }, correlationId);
      state.socket.close();
      return;
    }

    // Blocking a user does not invalidate an already-issued token, so the check has to
    // happen here too rather than only at sign-in. Through the access context and the
    // policy module, because the version that read `session.user.signinBlockedAt` directly
    // was asking for a property better-auth does not return, and never fired.
    const access = await loadAccessContext(deps.db, session.user.id);
    if (!isSessionUsable(access)) {
      send(state.socket, { t: 'auth.err', d: { code: 'signin_blocked' } }, correlationId);
      state.socket.close();
      return;
    }

    state.userId = session.user.id;
    state.sessionId = session.session.id;
    state.deviceId = payload.deviceId;
    state.lastSeenAt = Date.now();

    await registry.register(state.userId, state.sessionId, {
      deviceId: payload.deviceId,
      platform: payload.platform,
    });

    // Hand over every channel's head and this user's cursor. The client now knows
    // exactly which channels have a gap BEFORE fetching a single message.
    const channels = await listAccessibleChannels(deps.db, state.userId);

    send(
      state.socket,
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
      await attach(state.socket, channelId);
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

      // Only then publish. A deduplicated retry must not republish: the original was
      // already delivered, and a second publish would push a duplicate to every open
      // client.
      if (!result.deduplicated) {
        await publishToChannel(deps.redis, payload.channelId, result.message);
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
    const state: SocketState = {
      socket,
      userId: null,
      sessionId: null,
      deviceId: null,
      subscribed: new Set(),
      lastSeenAt: Date.now(),
    };
    states.set(socket, state);

    const authTimer = setTimeout(() => {
      if (state.userId === null) {
        send(socket, { t: 'auth.err', d: { code: 'timeout' } });
        socket.close();
      }
    }, AUTH_TIMEOUT_MS);

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
            clearTimeout(authTimer);
            await handleAuth(state, frame.d, frame.id);
            break;
          case 'subscribe':
            await handleSubscribe(state, frame.d.channelIds, frame.id);
            break;
          case 'unsubscribe':
            for (const channelId of frame.d.channelIds) {
              detach(socket, channelId);
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
            if (state.userId) void registry.heartbeat(state.userId);
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
      clearTimeout(authTimer);
      for (const channelId of state.subscribed) detach(socket, channelId);
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
   * The reaper. Closes any socket silent for longer than the timeout.
   *
   * A gateway that dies without closing its sockets leaves stale Redis entries, which
   * expire by TTL. A publish to a stale entry is a harmless no-op, because the message
   * is already durable in the channel log and the client will sync on reconnect.
   */
  const reaper = setInterval(() => {
    const cutoff = Date.now() - REAPER_TIMEOUT_MS;
    for (const [socket, state] of states) {
      if (state.lastSeenAt < cutoff) {
        deps.log('info', 'reaping silent socket', { userId: state.userId });
        socket.terminate();
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
