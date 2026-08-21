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

import { createServer, type Server, type ServerResponse } from 'node:http';
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
import { createReadinessCheck } from '../health.ts';
import { redact, type Tracer } from '../dev/trace.ts';
import type { Auth } from '../auth.ts';
import { resolveSessionFromToken } from '../auth.ts';
import { ChannelGoneError } from '../domain/append-message.ts';
import { sendMessage } from '../domain/send-message.ts';
import { getChannelRef, getChannelRefs, listAccessibleChannels } from '../domain/reads.ts';
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
 * The largest frame this gateway will read from a client.
 *
 * > **There was no limit, so `ws` 8's default of 100 MiB applied - to every socket, including
 * > one that had not authenticated.** The 8,000 character body cap lives in `MsgSendFrame`,
 * > which is a Zod schema: it runs after the whole frame has been buffered and `JSON.parse`d, so
 * > it bounds what is STORED and says nothing about what is READ. The 5s auth window is no help
 * > either, because five seconds is a long time in which to be handed a hundred megabytes.
 *
 * 128 KiB, measured rather than picked. The largest frame the wire contract can produce is a
 * `msg.send` at 56,075 bytes: 8,000 body characters in their most expensive JSON encoding, a
 * `mediaId`, a `replyToSeq` and the full 200 mentions. The next largest is a `subscribe`
 * carrying its 200 channel ids, at 7,882. This sits a little over twice above the worst
 * legitimate frame, which is the headroom that keeps a real message from ever being refused,
 * and roughly eight hundred times below the default it replaces.
 *
 * > **That sentence was false when it was first written, and `MAX_CORRELATION_ID_CHARS` is what
 * > made it true.** The envelope's `id` was `z.string().optional()` with no maximum, so "the
 * > largest frame the contract can produce" was actually this whole 128 KiB - the arithmetic
 * > above described a bound the schema did not enforce. Capping the correlation id at 128
 * > characters on 2026-08-21 closed the gap, and the pair should move together: raising one
 * > without re-reading the other puts this comment back into fiction.
 *
 * `ws` checks it against the frame header before reading the payload, and against the running
 * total across a fragmented message, so an oversized frame is refused rather than accumulated
 * and fragmentation cannot walk past it. The socket is closed with 1009, Message Too Big.
 */
export const MAX_FRAME_BYTES = 131_072;

/**
 * The most one connection's unwritten backlog may reach before the connection is dropped.
 *
 * > **Nothing bounded the outbound side, and what looked like a bound was an accident.** `send`
 * > wrote on the sole condition that the socket was OPEN and the Redis fan-out did the same for
 * > every subscriber, so once the kernel socket filled, `ws` queued the rest in process memory
 * > with no limit. The only thing that ever collected such a socket was the reaper, which fires
 * > on silence - and silence is a fact about the UPLINK. A phone on one bar has a link that
 * > works and a link that does not, and it answers its keepalives on the one that works.
 *
 * The 2026-08-19 review predicted the heartbeat fix would make this worse and was right, though
 * for a slightly different reason than it gave. It named the server's ping and the `pong` that
 * answers it; but a `pong` cannot come back down a pipe that is not draining, because the ping
 * never went out. What actually keeps a drowning socket unreaped is the client's own 30s `ping`
 * frame arriving on the uplink that still works, refreshing `lastSeenAt` as it is received. That
 * frame also makes the leak feed itself: each one is answered with a `pong` that joins the
 * backlog it can never leave.
 *
 * **1 MiB, and the three numbers that choose it.** The largest single frame this gateway can
 * send is 135,014 bytes - a maximum length body, 200 mentions and a 300 member channel's
 * reactions - so the ceiling is 7.7 times the worst case and no legitimate message, or short
 * burst of them, can reach it. A typical envelope measures 1,047 bytes, so it is around a
 * thousand messages of backlog, far more than a club chat produces inside the ninety seconds of
 * silence the reaper already tolerates. And at the design peak of 3,000 concurrent connections
 * ([`SPEC/TECH/00`](../../../../SPEC/TECH/00-overview.md)) the worst case is 3 GB, which needs
 * every socket in the cluster stalled at once; the number worth comparing it against is the one
 * it replaces, which was no number at all.
 *
 * **Nothing is lost by dropping the socket, which is what makes the trade cheap.** Everything
 * buffered here is a duplicate of what is already durable in the channel log, and the client
 * reconnects with backoff, re-authenticates, resubscribes and runs `/sync`. Buffering is an
 * optimisation to save a member a sync, never a delivery guarantee, so the only question a
 * ceiling asks is how much memory that optimisation may cost.
 */
export const WRITE_BUFFER_CEILING_BYTES = 1_048_576;

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
  /**
   * The HTTP server underneath the WebSocket server, which is ours rather than `ws`'s.
   *
   * `ws` stands up its own when it is given a `port`, and that one answers `426 Upgrade Required`
   * to every ordinary request - so there was nothing a platform health check could point at.
   * Given a `server` instead, `ws` attaches its `upgrade` listener to ours and leaves ordinary
   * requests to us. Exposed because closing it is `close()`'s job, not `ws`'s: see there.
   */
  server: Server;
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
    /** Same reason: the ping and the buffer sweep both ride this tick, thirty seconds apart. */
    heartbeatIntervalMs?: number;
  },
): Gateway {
  /**
   * The gateway's HTTP surface: liveness, readiness, and 404 for everything else.
   *
   * > **There was none, so Fly had nothing to check.** `ws` creates its own HTTP server when it is
   * > handed a `port`, and that server answers `426 Upgrade Required` to any request that is not an
   * > upgrade. Handed a `server` we made instead, `ws` attaches its own `upgrade` listener to it
   * > and re-emits `listening` and `error`, so `wss.address()`, `wss.clients` and
   * > `wss.once('listening')` all keep working and every existing test is untouched.
   *
   * Deliberately NOT `noServer`: that mode makes `address()` throw and would mean writing the
   * upgrade handler by hand, for no gain. And deliberately no `path` option, because today any
   * path upgrades and the mobile client connects at `/` - narrowing that here would be a silent
   * protocol change wearing a health check's clothes.
   *
   * No CORS and no cookies. Nothing here is read by a browser, and neither endpoint reads anything
   * about the caller - which is also why `trustProxy` has no equivalent here. The gateway sits
   * behind an L4 handler by design (see `main.ts`), and no code on these two paths asks who is
   * calling.
   */
  const readiness = createReadinessCheck({
    db: deps.db,
    redis: deps.redis,
    monitor: deps.monitor,
    where: 'gateway.ready',
    log: (level, message, detail) => deps.log(level, message, detail),
  });

  const respond = (response: ServerResponse, status: number, body: unknown): void => {
    /*
     * The peer may be gone, and on shutdown it usually is.
     *
     * `closeAllConnections()` destroys in-flight connections rather than waiting for them, so a
     * readiness probe still running when SIGTERM arrived settles seconds later against a socket
     * that no longer exists. That much is real: at write time `response.destroyed` is genuinely
     * true on that path.
     *
     * > **This comment used to claim the unguarded write is a process-ending unhandled rejection.
     * > It is not, and the correction is kept because the false version is the more plausible
     * > one.** Measured on the pinned runtime, `node:24-trixie-slim` / v24.19.0, inside the
     * > deployment image: `writeHead` plus `end` against a destroyed response returns normally,
     * > throws nothing, emits no `error` event, and produces no `uncaughtException` and no
     * > `unhandledRejection`. Node discards the write.
     *
     * So this guard is cheap insurance and a statement of intent rather than a crash fix, and
     * nothing observable changes if it is removed. It stays because "answer only a live response"
     * is the property we want to hold regardless of which Node version is underneath, and because
     * a future runtime is free to make that write loud. Do not delete it on the grounds that the
     * tests still pass without it; they do.
     */
    if (response.destroyed || response.writableEnded) return;
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
  };

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];

    // Liveness. Process memory only, so a database blip cannot restart every gateway at once.
    if (path === '/health') {
      respond(response, 200, { ok: true });
      return;
    }

    /*
     * Readiness, and the body is `{ok:true}` or `{error:'not_ready'}` and nothing else - no
     * dependency name, no driver text, no host. Which one failed goes to the log and the monitor.
     *
     * The rejection branch cannot be reached today (`createReadinessCheck` swallows everything a
     * probe throws), and it is here because the alternative to answering is an HTTP request that
     * is never ended - a prober held open until its own timeout, which reads as a hang rather
     * than as a refusal.
     */
    if (path === '/ready') {
      void readiness()
        .then(
          (ready) =>
            respond(response, ready ? 200 : 503, ready ? { ok: true } : { error: 'not_ready' }),
          () => respond(response, 503, { error: 'not_ready' }),
        )
        // Belt and braces beside the guard in `respond`: nothing on this path may become an
        // unhandled rejection, because an unhandled rejection ends the process.
        .catch(() => undefined);
      return;
    }

    response.writeHead(404, { 'content-length': 0 }).end();
  });

  const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });
  const authTimeoutMs = opts.authTimeoutMs ?? AUTH_TIMEOUT_MS;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
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

  /**
   * Drop a connection whose backlog has passed the ceiling. Answers whether it did.
   *
   * > **`terminate()`, not `close()`, and the reason is the whole shape of the problem.**
   * > `close()` is the graceful path: it queues a close frame, which on a socket that is not
   * > draining means queueing it BEHIND the megabyte that is the reason we are here. The frame
   * > does not go out, the memory the ceiling exists to release stays held for `ws`'s own 30s
   * > close timer, and the client is told nothing anyway. `terminate()` destroys the socket now.
   *
   * So the client sees an abnormal closure, 1006, rather than a code that says why - and it does
   * not need one. `chat-client.ts` reads no close code at all: any close it did not ask for
   * schedules a reconnect with backoff, and the reconnect re-authenticates, resubscribes and
   * runs `/sync`. A code would be nice to have and cannot be delivered, because a code that
   * cannot be delivered is precisely the condition being reported.
   *
   * Logged rather than captured to the monitor on purpose. A client that stops reading is a bad
   * network, which is an expected event on phones and not a fault in this system; routing it to
   * the error monitor would teach whoever reads that monitor to ignore it. The log line carries
   * both numbers, so how close production runs to this ceiling is a question the logs answer.
   */
  const dropIfDrowning = (socket: WebSocket): boolean => {
    if (socket.bufferedAmount <= WRITE_BUFFER_CEILING_BYTES) return false;
    deps.log('warn', 'write buffer past the ceiling, dropping the socket', {
      userId: states.get(socket)?.userId ?? null,
      bufferedAmount: socket.bufferedAmount,
      ceiling: WRITE_BUFFER_CEILING_BYTES,
    });
    socket.terminate();
    return true;
  };

  /**
   * Write one already encoded frame to one socket. The only path bytes take to a client.
   *
   * Both write sites go through here rather than each testing the socket themselves, for the
   * reason AGENTS.md failure mode 31 records: an effect that must always accompany another
   * belongs in one function, because a convention is a thing a later call site forgets. There
   * were two sites and both checked only `readyState`; the third one somebody adds should not
   * have to know that a ceiling exists.
   *
   * Answers whether the frame was written, so a caller that counts recipients counts the ones
   * that actually received it.
   */
  const deliver = (socket: WebSocket, encoded: string): boolean => {
    if (socket.readyState !== socket.OPEN) return false;
    if (dropIfDrowning(socket)) return false;
    socket.send(encoded);
    return true;
  };

  const send = (socket: WebSocket, frame: ServerFrame, correlationId?: string) => {
    const withId = correlationId === undefined ? frame : { ...frame, id: correlationId };
    if (!deliver(socket, JSON.stringify(withId))) return;

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
    /*
     * Iterated over the live Set while `deliver` may drop a socket out of it, which is safe in
     * both directions: `terminate()` destroys the socket and Node emits its `close` on a later
     * tick, so the detach that empties this Set happens after the loop - and a `Set` iterator
     * tolerates deletion mid-iteration regardless. What must not happen is one drowning
     * subscriber costing its neighbours their message, and it does not: each is written
     * independently and only the one over the ceiling is dropped.
     */
    for (const socket of sockets) {
      if (deliver(socket, encoded)) delivered += 1;
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

    /*
     * Every channel's ref in ONE round trip, before the loop rather than inside it.
     *
     * > **This awaited `getChannelRef` per id, sequentially, and `SubscribeFrame` admits 200 of
     * > them.** So a client resubscribing after a reconnect - which is every client, on every
     * > reconnect, and a gateway restart means all of them at once - serialized up to two hundred
     * > database round trips inside a single frame, while that socket's frame queue held
     * > everything behind it. `SPEC/TECH/20` milestone 2 names this as "the connect path's
     * > per-channel round trips, the same shape TECH/18 already removed from /sync".
     *
     * The refusal stays exactly where it was: `isChannelMember` applied per id, in the loop,
     * against refs fetched together. An id naming no channel is simply absent from the map, which
     * is the same answer `getChannelRef` gave by returning null.
     */
    const refs = await getChannelRefs(deps.db, channelIds);

    for (const channelId of channelIds) {
      // Lower cased because the map is keyed by the canonical id. `Uuid` is `z.string().uuid()`,
      // which accepts either spelling, so a client sending an upper case channel id was granted
      // before this batching and must still be.
      const channel = refs.get(channelId.toLowerCase());
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
      /*
       * The write buffer sweep, which is what makes that ceiling independent of the client
       * still talking.
       *
       * Every write goes through `deliver`, so a socket that crosses the ceiling is normally
       * collected by the next thing sent to it - and for a client that pings, that is inside
       * thirty seconds, because each `ping` is answered with a `pong` through the same gate.
       * This covers the case where nothing is sent at all: a socket that fell behind and whose
       * channels then went quiet would otherwise hold its backlog until the reaper's ninety
       * second silence window, or forever if the client keeps pinging into it.
       *
       * Before the ping rather than after, so a drowning socket is not handed one more frame to
       * queue on the way out.
       */
      if (dropIfDrowning(socket)) continue;
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
  }, heartbeatIntervalMs);

  /**
   * Listening starts HERE, after the `WebSocketServer` has been constructed.
   *
   * `ws` attaches its `listening` re-emitter inside its own constructor, so a server that was
   * already listening would have fired the event before anything was there to forward it - and
   * every test that waits on `wss.once('listening')` would wait forever.
   */
  server.listen(opts.port, '0.0.0.0');

  return {
    wss,
    server,
    /**
     * Shut down inside a SIGTERM's budget, which is the part the external server changed.
     *
     * > **`wss.close()` deliberately does NOT close a server it did not create.** It detaches its
     * > listeners and returns, and the HTTP server carries on listening. Closing it is now this
     * > function's job, and doing that safely is not `server.close()` on its own.
     *
     * The order is the whole of it:
     *
     *  1. `clearInterval` - the reaper must not ping sockets that are being taken down.
     *  2. Terminate the WebSocket connections. `terminate()` rather than `close()` because a
     *     socket that is not draining would queue the close frame behind whatever is already
     *     stuck there, and this path has a deadline. Nothing is lost: every client reconnects,
     *     resubscribes and syncs, which is the property the top of this file is built on.
     *  3. `wss.close()` - stops new upgrades, synchronously.
     *  4. `closeAllConnections()` - the HTTP connections, and the one that earns its place.
     *  5. `server.close()` - now it can actually finish.
     *
     * **Step 4 is about a request in flight, not about an idle keep-alive socket**, and the
     * difference is worth writing down because the shape of the bug is not the obvious one.
     * `server.close()` has closed IDLE connections by itself since Node 19, so the state a health
     * prober is in between polls costs nothing. What it still waits for is a connection currently
     * being served - which is exactly what SIGTERM lands on during a rolling deploy, and what a
     * readiness probe makes slow, because a readiness probe waits on a database. Measured at
     * 4.9 seconds without this line against 5 milliseconds with it. Multiply that by a machine
     * whose database is the thing that is broken and shutdown outlives the grace period: SIGTERM
     * never reaches `pool.end()` in `main.ts` and Fly SIGKILLs the machine mid-deploy.
     *
     * The probe those destroyed requests were waiting on still settles afterwards and still tries
     * to answer, which is why `respond` checks the response is alive before writing to it.
     */
    async close() {
      clearInterval(reaper);
      for (const socket of states.keys()) socket.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    revokeSubscriptions: revoke,
  };
}
