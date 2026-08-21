/**
 * A connection may not buffer without limit, in either direction.
 *
 * > **The defect this file exists for: nothing bounded what the gateway held for a client that
 * > had stopped reading.** `send` wrote on the sole condition that the socket was OPEN, the
 * > Redis fan-out did the same for every subscriber, and `ws` buffers in process memory once the
 * > kernel socket is full. The only thing bounding it was the reaper, which is an accident
 * > rather than a design: it fires on silence, and a client whose UPLINK is healthy is never
 * > silent. A phone on one bar answers its keepalives on a link that works while the link that
 * > does not carries an ever growing backlog it will never read.
 *
 * The 2026-08-19 review predicted the heartbeat fix would make this worse, and it was right for
 * a slightly different reason than it gave. It named the server's ping and the `pong` that
 * answers it, but a `pong` cannot come back down a pipe that is not draining, because the ping
 * never went out. What actually keeps a drowning socket unreaped is the client's own 30s `ping`
 * frame, arriving on the uplink that still works and refreshing `lastSeenAt` on the way in. That
 * frame also makes the leak feed itself: the gateway answers each one with a `pong` that joins
 * the backlog it can never leave.
 *
 * The other direction was never bounded either. `new WebSocketServer({ port })` passes no
 * `maxPayload`, so `ws` 8's default of 100 MiB applies, and it applies to a socket that has not
 * authenticated: the 8,000 character body cap lives in a Zod schema that runs after the whole
 * frame has been buffered and parsed.
 *
 * These tests need no database and no Redis. They stand a real gateway on an ephemeral port and
 * drive it with a real socket, and the one quantity they fake is `bufferedAmount` - which is the
 * one quantity a test cannot produce honestly, because producing it means a real peer that has
 * really stopped reading for real seconds. Everything else is the shipping path.
 */

import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import type { Auth } from '../auth.ts';
import type { Db } from '../db/client.ts';
import type { RateLimiter } from '../bus/redis.ts';
import {
  createGateway,
  MAX_FRAME_BYTES,
  WRITE_BUFFER_CEILING_BYTES,
  type Gateway,
} from './server.ts';

/**
 * Long enough that the handshake timer never fires inside a case.
 *
 * Every test here drives a socket that deliberately never authenticates, so the timer is pure
 * noise: it would answer `auth.err timeout` and close, which is another frame and another close
 * to disambiguate from the one under test.
 */
const AUTH_TIMEOUT_MS = 5_000;

/** ioredis in subscriber mode, reduced to the three members the gateway touches. */
const stubSubscriber = () =>
  ({
    subscribe: async () => 1,
    unsubscribe: async () => 0,
    on: () => undefined,
  }) as unknown as Redis;

const stubRateLimiter: RateLimiter = { tryConsume: async () => true };
const stubAuth = { api: { getSession: async () => null } } as unknown as Auth;

type Harness = {
  gateway: Gateway;
  url: string;
  /** Warnings the gateway logged, so a silent drop is distinguishable from a reported one. */
  warnings: Array<{ message: string; extra?: unknown }>;
};

const open: Harness[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.gateway.close();
});

async function standGateway(opts: { heartbeatIntervalMs?: number } = {}): Promise<Harness> {
  const warnings: Harness['warnings'] = [];
  const gateway = createGateway(
    {
      db: {} as Db,
      auth: stubAuth,
      redis: {} as unknown as Redis,
      subscriber: stubSubscriber(),
      rateLimiter: stubRateLimiter,
      gatewayId: 'write-ceiling-test',
      log: (level, message, extra) => {
        if (level === 'warn') warnings.push({ message, extra });
      },
    },
    {
      port: 0,
      authTimeoutMs: AUTH_TIMEOUT_MS,
      handshakeTimeoutMs: AUTH_TIMEOUT_MS,
      ...(opts.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: opts.heartbeatIntervalMs }),
    },
  );

  await new Promise<void>((resolve) => gateway.wss.once('listening', () => resolve()));
  const { port } = gateway.wss.address() as AddressInfo;
  const harness = { gateway, url: `ws://127.0.0.1:${port}`, warnings };
  open.push(harness);
  return harness;
}

type Peer = {
  socket: WebSocket;
  frames: Array<{ t: string; d?: Record<string, unknown> }>;
  /** The close code the client actually saw, which is a different fact from "it closed". */
  closeCode: number | null;
  /** Resolves when the socket closes, or after `ms` of quiet if it is still open. */
  settle: (ms?: number) => Promise<void>;
};

/** Connect, and collect everything the gateway says and does to this socket. */
async function connect(url: string): Promise<Peer> {
  const socket = new WebSocket(url);
  const peer: Peer = {
    socket,
    frames: [],
    closeCode: null,
    settle: async () => undefined,
  };

  socket.on('message', (raw: Buffer) => {
    peer.frames.push(JSON.parse(raw.toString()) as { t: string });
  });
  socket.on('error', () => undefined);

  let closed = false;
  let onClosed: (() => void) | null = null;
  socket.on('close', (code: number) => {
    peer.closeCode = code;
    closed = true;
    onClosed?.();
  });

  peer.settle = (ms = 300) =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      const timer = setTimeout(resolve, ms);
      onClosed = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return peer;
}

/**
 * The gateway's own end of the connection this client just opened.
 *
 * `wss.clients` is a `Set` in insertion order, so the socket accepted for the newest peer is the
 * last one. Reaching for it is the point: `bufferedAmount` is a property of the SERVER's end,
 * and no client can move it from the outside.
 */
function serverEnd(harness: Harness): WebSocket {
  const sockets = [...harness.gateway.wss.clients];
  return sockets[sockets.length - 1]!;
}

/**
 * Pin `bufferedAmount` at a value.
 *
 * It is a getter on `WebSocket.prototype` returning
 * `_socket._writableState.length + _sender._bufferedBytes`, so an own property on the instance
 * shadows it for exactly this socket and nothing else about the connection changes.
 */
function pinBufferedAmount(socket: WebSocket, bytes: number): void {
  Object.defineProperty(socket, 'bufferedAmount', {
    get: () => bytes,
    configurable: true,
  });
}

/** A frame the gateway parses successfully and answers, so the answer is the thing observed. */
const malformedFrame = JSON.stringify({ t: 'not-a-frame-type', d: {} });

describe('the per-connection write buffer ceiling', () => {
  /**
   * THE ONE THAT MATTERS.
   *
   * A backlog past the ceiling is a client that is not reading, and the correct response is to
   * stop holding its mail. The client reconnects with backoff, re-authenticates, resubscribes
   * and runs `/sync`, which is exactly what the channel log exists to make correct - so every
   * byte dropped here is a byte that is still durable and still reachable.
   */
  it('closes a socket whose backlog is over the ceiling rather than writing more to it', async () => {
    const harness = await standGateway();
    const peer = await connect(harness.url);

    pinBufferedAmount(serverEnd(harness), WRITE_BUFFER_CEILING_BYTES + 1);
    peer.socket.send(malformedFrame);
    await peer.settle();

    expect(peer.frames, 'nothing may be added to a backlog already past the ceiling').toEqual([]);
    expect(peer.closeCode, 'a drowning socket is dropped, not merely left alone').not.toBeNull();
    expect(
      harness.warnings.map((w) => w.message),
      'a connection dropped for its backlog must say so, or the ceiling is invisible in production',
    ).toContain('write buffer past the ceiling, dropping the socket');
  });

  /**
   * The control, and it is not a formality: a ceiling that fires on a healthy socket is worse
   * than no ceiling, because it turns a slow link into a reconnect loop.
   */
  it('writes normally to a socket whose backlog is under the ceiling', async () => {
    const harness = await standGateway();
    const peer = await connect(harness.url);

    pinBufferedAmount(serverEnd(harness), WRITE_BUFFER_CEILING_BYTES - 1);
    peer.socket.send(malformedFrame);
    await peer.settle();

    expect(peer.frames.map((f) => f.t)).toEqual(['auth.err']);
    expect(peer.frames[0]?.d).toEqual({ code: 'malformed' });
    expect(peer.closeCode, 'a socket under the ceiling is untouched by it').toBeNull();
  });

  /**
   * The largest single frame the wire contract can produce is 135,014 bytes: an 8,000 character
   * body in its most expensive JSON encoding, 200 mentions and a 300 member channel's reactions.
   * The ceiling has to sit far enough above that for a legitimate burst never to reach it,
   * because being closed for receiving real messages is the failure that would matter.
   */
  it('sits clear of the largest frame the contract can produce', () => {
    const largestFrameBytes = 135_014;
    expect(WRITE_BUFFER_CEILING_BYTES).toBeGreaterThan(largestFrameBytes * 5);
  });

  /**
   * The sweep, which is what makes the bound independent of the client still talking.
   *
   * Every write goes through one gate, so a socket that crosses the ceiling is normally caught
   * by the next thing sent to it - and for a client that pings, that is within thirty seconds,
   * because the gateway answers each ping with a `pong` that goes through the same gate. This
   * covers the case where nothing is sent at all: a socket that fell behind and whose channels
   * then went quiet would otherwise hold its backlog until the reaper's ninety second silence
   * window, or forever if the client keeps pinging.
   */
  it('drops a drowning socket on the heartbeat tick, with no write to prompt it', async () => {
    const harness = await standGateway({ heartbeatIntervalMs: 30 });
    const peer = await connect(harness.url);

    pinBufferedAmount(serverEnd(harness), WRITE_BUFFER_CEILING_BYTES + 1);
    await peer.settle(500);

    expect(peer.closeCode, 'the sweep must not need a message to notice').not.toBeNull();
    expect(peer.frames).toEqual([]);
  });
});

describe('the inbound frame ceiling', () => {
  /**
   * `maxPayload` is checked against the frame header before the payload is read, and against the
   * running total across a fragmented message, so an oversized frame is refused rather than
   * accumulated. Without it the default is 100 MiB, per socket, before authentication.
   */
  it('refuses a frame larger than the ceiling instead of buffering it', async () => {
    const harness = await standGateway();
    const peer = await connect(harness.url);

    peer.socket.send('x'.repeat(MAX_FRAME_BYTES + 1));
    await peer.settle(1_000);

    expect(peer.closeCode, 'ws answers an oversized frame with 1009, Message Too Big').toBe(1009);
  });

  /**
   * And the other half, which is the half that would hurt if the number were wrong: the largest
   * `msg.send` the contract admits is 56,075 bytes, and it must arrive.
   *
   * It is sent before `auth`, so the gateway refuses it with `not_authenticated` - and that
   * refusal is the proof, because it can only be produced by a frame that was received whole,
   * parsed against `ClientFrame`, and reached the handler.
   */
  it('accepts the largest frame the contract admits', async () => {
    const harness = await standGateway();
    const peer = await connect(harness.url);

    const uuid = '3f6b1c2e-8a4d-4f19-9b7c-2e5a1d0f8c33';
    const frame = JSON.stringify({
      t: 'msg.send',
      id: 'c1f0a2b3-4d5e-6f70-8192-a3b4c5d6e7f8',
      d: {
        clientMsgId: uuid,
        channelId: uuid,
        type: 'text',
        // The most expensive encoding of the longest body the schema admits: a control
        // character costs six bytes as an escape where an ascii letter costs one.
        body: String.fromCharCode(1).repeat(8_000),
        mediaId: uuid,
        mentions: Array.from({ length: 200 }, () => uuid),
        replyToSeq: 41_270,
      },
    });
    expect(Buffer.byteLength(frame, 'utf8')).toBeLessThan(MAX_FRAME_BYTES);

    peer.socket.send(frame);
    await peer.settle(1_000);

    expect(peer.frames.map((f) => f.t)).toEqual(['auth.err']);
    expect(peer.frames[0]?.d).toEqual({ code: 'not_authenticated' });
  });
});
