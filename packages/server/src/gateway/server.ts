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
  type MessageEnvelope,
  type ServerFrame,
} from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import type { Auth } from '../auth.ts';
import { resolveSessionFromToken } from '../auth.ts';
import { appendMessage, ChannelGoneError } from '../domain/append-message.ts';
import { advanceReadCursor, getChannelRef, listAccessibleChannels } from '../domain/reads.ts';
import { loadAccessContext } from '../policy/context.ts';
import { isChannelMember } from '../policy/predicates.ts';
import {
  channelTopic,
  createConnectionRegistry,
  publishToChannel,
  type Published,
  type RateLimiter,
  HEARTBEAT_INTERVAL_MS,
  REAPER_TIMEOUT_MS,
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
};

export type Gateway = {
  wss: WebSocketServer;
  close: () => Promise<void>;
  /**
   * Drop a user's subscriptions to specific channels, immediately.
   *
   * Because access is checked at subscribe time and NOT rechecked per message, a live
   * subscription outlives the membership that justified it. Removing someone from a
   * club, a race roster or the Eboard - or blocking them in a DM - must therefore
   * force-unsubscribe their sockets, not merely delete the row. This is the one cost
   * per-channel fan-out carries that per-user fan-out does not, and the failure is
   * silent: a removed member keeps reading a channel they no longer belong to and
   * nothing reports it.
   *
   * Phase 2 wires the membership cascade to call this. It exists now so that wiring is
   * a call rather than a redesign.
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

  const detach = (socket: WebSocket, channelId: string) => {
    const sockets = byChannel.get(channelId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
      byChannel.delete(channelId);
      void deps.subscriber.unsubscribe(channelTopic(channelId)).catch(() => undefined);
    }
  };

  deps.subscriber.on('message', (topic: string, raw: string) => {
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
    const frame: ServerFrame = { t: 'msg.new', d: published.envelope };
    const encoded = JSON.stringify(frame);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(encoded);
    }
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
    // happen here too rather than only at sign-in.
    if ((session.user as { signinBlockedAt?: unknown }).signinBlockedAt) {
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
          serverTime: new Date().toISOString(),
          channels,
        },
      },
      correlationId,
    );
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
    payload: {
      clientMsgId: string;
      channelId: string;
      type: MessageEnvelope['type'];
      body?: string | null | undefined;
    },
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
    if (!isChannelMember(access, channel)) {
      send(
        state.socket,
        { t: 'msg.err', d: { clientMsgId: payload.clientMsgId, code: 'forbidden' } },
        correlationId,
      );
      return;
    }

    try {
      const result = await appendMessage(deps.db, {
        channelId: payload.channelId,
        senderId: state.userId!,
        clientMsgId: payload.clientMsgId,
        type: payload.type,
        body: payload.body ?? null,
      });

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

    socket.on('message', (raw: Buffer) => {
      void (async () => {
        state.lastSeenAt = Date.now();

        let frame: ClientFrame;
        try {
          frame = ClientFrame.parse(JSON.parse(raw.toString()));
        } catch {
          send(socket, { t: 'auth.err', d: { code: 'malformed' } });
          return;
        }

        // Everything except `auth` requires an authenticated socket.
        if (frame.t !== 'auth' && state.userId === null) {
          send(socket, { t: 'auth.err', d: { code: 'invalid_token' } });
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
              await advanceReadCursor(
                deps.db,
                state.userId!,
                frame.d.channelId,
                frame.d.upToSeq,
              );
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
        }
      })();
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
    revokeSubscriptions(userId, channelIds) {
      for (const [socket, state] of states) {
        if (state.userId !== userId) continue;
        for (const channelId of channelIds) {
          if (!state.subscribed.has(channelId)) continue;
          detach(socket, channelId);
          state.subscribed.delete(channelId);
        }
      }
    },
  };
}
