/**
 * The development trace bus: every client/server interaction, on one wire, for one page.
 *
 * ## Why this exists
 *
 * The system talks to its clients over TWO transports and a browser's network panel only
 * understands one of them properly. REST on the API port carries every read and every
 * command that is not a chat send; the WebSocket on the gateway port carries the sends, the
 * acks and the live fan-out. Watching only the first makes chat look like it does nothing at
 * all. Worse, the interesting half of a tap happens AFTER the response: a command writes a
 * domain row and an outbox row in one transaction, and the outbox is what eventually becomes
 * a system message, a notification and a push. None of that is visible from the client side
 * at any point.
 *
 * So the trace is emitted by the server, from all three roles, and joined in one place.
 *
 * ## Why Redis
 *
 * API, gateway and worker are three PROCESSES. An in-process event emitter would produce
 * three disconnected feeds, which is the problem restated rather than solved. Redis pub/sub
 * is already a dependency of all three for exactly this shape of problem, so the trace rides
 * it: every role publishes, the API's dashboard subscribes and fans out to browsers over SSE.
 *
 * Publishing is fire-and-forget and every failure is swallowed. A dev tool that can break the
 * thing it is observing is worse than no dev tool.
 *
 * ## Why it cannot reach production
 *
 * Three gates, deliberately independent:
 *
 *  1. The entrypoints only construct a tracer when `NODE_ENV !== 'production'`.
 *  2. `devTraceEnabled()` says the same thing, and the dashboard route checks it again.
 *  3. Every consumer takes the tracer as an OPTIONAL dependency, so the default in any code
 *     path that did not deliberately opt in - every test, every production boot - is a
 *     tracer that does not exist rather than one that is switched off.
 *
 * The payloads carry real message bodies and real user ids, so the redaction below is not
 * decoration: the API binds `0.0.0.0` in development so the phone can reach it, which means
 * this page is reachable from the LAN. Credentials never enter the stream in the first place.
 */

import type { Redis } from 'ioredis';

/** The pub/sub topic. `dev:` prefixed so it is obvious in `redis-cli monitor` what it is. */
export const DEV_TRACE_TOPIC = 'dev:trace';

/** Which process saw the thing. */
export type TraceSource = 'api' | 'gateway' | 'worker';

/**
 * One REST request, emitted once it has an answer.
 *
 * Emitted on the way OUT rather than the way in, because a request with no status is half a
 * fact, and the dashboard would have to join two events to draw one row. `startedAt` is
 * carried so the page can still order by when the request arrived: a slow request must not
 * sort after the effects it caused.
 */
export type HttpTrace = {
  kind: 'http';
  id: string;
  method: string;
  url: string;
  /** The route PATTERN (`/clubs/:id/polls`), which is what groups meaningfully. */
  route: string | null;
  status: number;
  ms: number;
  startedAt: number;
  userId: string | null;
  reqBody: unknown;
  resBody: unknown;
  /**
   * Database round trips this request cost, and the time spent on them.
   *
   * > **The layer below `ms`.** Everything else here is what the client asked for; this is what
   * > answering it cost. A tidy 15ms request that ran twenty statements is the defect this
   * > exists to make visible, and no amount of watching the wire could ever have shown it.
   *
   * Optional because it is wired in one process: the API establishes a counter per request, and
   * a gateway or worker event has none. `dbMs` sums each statement's own wait, so a handler
   * running queries in parallel can report more of it than the request's whole `ms`.
   */
  queries?: number;
  dbMs?: number;
};

/**
 * One WebSocket frame, in either direction.
 *
 * `dir` is written from the SERVER's point of view: `in` is a frame the client sent us.
 */
export type WsTrace = {
  kind: 'ws';
  dir: 'in' | 'out';
  /** The frame's `t` field: `msg.send`, `msg.ack`, `auth.ok`, and so on. */
  type: string;
  userId: string | null;
  /** The frame's correlation id, where it has one. */
  correlationId: string | null;
  payload: unknown;
};

/**
 * One outbox event, once the worker has finished with it.
 *
 * This is the half of a tap that no client-side tool can see. The `outboxId` is the join key
 * back to the row the command wrote, and `ms` is how long the effect actually took - which is
 * where "why did that push take three seconds" is answered.
 */
export type EffectTrace = {
  kind: 'effect';
  outboxId: number;
  eventType: string;
  partitionKey: string;
  payload: unknown;
  ms: number;
  outcome: 'ok' | 'retry' | 'parked';
  error: string | null;
};

export type TraceEvent = (HttpTrace | WsTrace | EffectTrace) & {
  /** Stamped by `emit`, so a caller cannot forget it. */
  at: number;
  source: TraceSource;
};

/** What a caller passes to `emit`: everything except the fields the tracer stamps itself. */
export type TraceInput = HttpTrace | WsTrace | EffectTrace;

export type Tracer = {
  emit: (event: TraceInput) => void;
};

/**
 * Is the trace allowed to run at all?
 *
 * Two conditions, and the second exists so the answer can be "no" without editing code: set
 * `DEV_TRACE=off` to run a normal development stack with no observer attached.
 */
export function devTraceEnabled(): boolean {
  return process.env['NODE_ENV'] !== 'production' && process.env['DEV_TRACE'] !== 'off';
}

/**
 * Keys whose VALUES never enter the stream.
 *
 * Matched case-insensitively against the key name anywhere in a payload, at any depth. The
 * list is about credentials rather than privacy: `/api/auth/sign-in` posts a password in
 * plain JSON, and a trace of it would put that password on a page served over plain HTTP on
 * a home network. `token` covers both the bearer token on the socket handshake and the
 * invite tokens that are the only thing standing between a stranger and a club.
 */
const SECRET_KEY = /pass|secret|token|authorization|credential|otp|signature/i;

/** Longer than this and a string is cut. Message bodies are interesting; base64 is not. */
const MAX_STRING = 600;
/** More than this and an array is cut. A 200-member roster proves its shape in 20. */
const MAX_ITEMS = 25;
/** Deeper than this and a payload is not being read by a human anyway. */
const MAX_DEPTH = 6;
/** The whole event, serialized, must fit comfortably in one SSE frame. */
const MAX_BYTES = 24_000;

/**
 * Copy a payload into something safe and small enough to broadcast.
 *
 * Returns a NEW value rather than mutating: the argument is a live request body or a frame
 * about to be written to a socket, and a tracer that edits what it observes is a bug that
 * will be found much later and blamed on something else.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > MAX_DEPTH) return '[deep]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}... +${value.length - MAX_STRING} chars` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ITEMS).map((item) => redact(item, depth + 1));
    return value.length > MAX_ITEMS ? [...head, `... +${value.length - MAX_ITEMS} more`] : head;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
  }

  // Functions, symbols: nothing a payload should contain, and nothing worth showing.
  return `[${typeof value}]`;
}

/**
 * Parse a body that may already be an object, may be JSON text, and may be neither.
 *
 * Fastify hands `onSend` a serialized string, hands `request.body` a parsed object, and hands
 * either of them something that is not JSON at all when a route replies with a redirect or a
 * binary. All three arrive here and none of them may throw.
 */
export function readBody(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return redact(value);
  if (value === '') return null;
  try {
    return redact(JSON.parse(value));
  } catch {
    return redact(value);
  }
}

/**
 * A tracer that publishes to Redis, or one that does nothing.
 *
 * `null` is an accepted argument rather than an error so a caller can write
 * `createTracer(enabled ? redis : null, 'api')` without branching around the whole wiring.
 */
export function createTracer(redis: Redis | null, source: TraceSource): Tracer {
  if (redis === null || !devTraceEnabled()) return { emit: () => undefined };

  return {
    emit(event: TraceInput) {
      try {
        const full: TraceEvent = { ...event, at: Date.now(), source };
        let encoded = JSON.stringify(full);

        // An oversized event is dropped down to its shape rather than dropped entirely: knowing
        // that a 2MB gallery response happened is the interesting part, and the body is not.
        if (encoded.length > MAX_BYTES) {
          const trimmed: TraceEvent =
            full.kind === 'http'
              ? { ...full, reqBody: '[too large]', resBody: '[too large]' }
              : { ...full, payload: '[too large]' };
          encoded = JSON.stringify(trimmed);
        }

        // Deliberately not awaited. A trace that adds latency to the request it is tracing is
        // measuring itself, and a Redis blip must not surface as a failed API call.
        void redis.publish(DEV_TRACE_TOPIC, encoded).catch(() => undefined);
      } catch {
        // A payload that will not serialize (a cycle, a BigInt in an unexpected place) costs
        // one missing line on a dev page. It must never cost the request.
      }
    },
  };
}

/**
 * Listen for trace events.
 *
 * Takes a connection of its own because ioredis puts a client into subscriber mode
 * exclusively - the same constraint the gateway documents around its own `subscriber`.
 */
export function subscribeToTrace(
  subscriber: Redis,
  onEvent: (event: TraceEvent) => void,
): void {
  void subscriber.subscribe(DEV_TRACE_TOPIC).catch(() => undefined);
  subscriber.on('message', (topic: string, raw: string) => {
    if (topic !== DEV_TRACE_TOPIC) return;
    try {
      onEvent(JSON.parse(raw) as TraceEvent);
    } catch {
      // A frame that will not parse is one line lost on a dev page.
    }
  });
}
