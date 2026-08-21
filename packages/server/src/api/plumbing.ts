/**
 * What every route group needs, defined once.
 *
 * The router was one file until Phase 3.75a, which roughly doubles the number of routes.
 * Splitting it then rather than later was the cheaper order: the alternative was a
 * two-thousand-line module where the only way to find a route is to search for its path.
 *
 * Route groups are grouped by **path**, not by domain module. `/channels/:id/reports` lives
 * with the moderation queue rather than with the rest of the channel routes, because a
 * reader asking "where do reports go" should find both answers in one place. Two domain
 * modules serving one path group is normal; one path group split across two files is the
 * thing this avoids.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { Auth } from '../auth.ts';
import type { Tracer } from '../dev/trace.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { getChannelRefs } from '../domain/reads.ts';
import type { MediaConfig } from '../media/pipeline.ts';
import type { MediaStore } from '../media/store.ts';
import type { Monitor } from '../monitoring.ts';
import type { KeyedRateLimiter } from '../bus/redis.ts';
import type { AccessContext } from '../policy/context.ts';
import { isChannelMember, type ChannelRef } from '../policy/predicates.ts';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    access?: AccessContext;
  }
}

export type AppDeps = {
  db: Db;
  auth: Auth;
  config: Config;
  /** Injected so tests can use the in-memory fake and production uses S3. */
  mediaStore: MediaStore;
  /**
   * Where a 5xx goes. Injected like `mediaStore` and for the same reason: tests pass
   * `silentMonitor()` and assert behaviour, production passes the real one.
   */
  monitor: Monitor;
  /**
   * How often one caller may hit the API.
   *
   * Injected like `mediaStore`: production passes a Redis-backed limiter, tests pass one that
   * always allows so a suite is never throttled by its own speed.
   */
  limiter: KeyedRateLimiter;
  /**
   * The entrypoint's logger, when there is one.
   *
   * Shared with the monitor so a captured error and the request that caused it print in the same
   * shape. Optional because a test does not need to care - Fastify builds its own from
   * `LOG_LEVEL` when this is absent.
   */
  logger?: FastifyBaseLogger;
  /**
   * The development trace, when one is attached.
   *
   * Optional in the strong sense: absent is the default and the only state that exists in a
   * test or in production. The entrypoint constructs one only when `devTraceEnabled()`, so
   * "is the observer running" is answered by whether this field has a value rather than by a
   * flag read at each call site.
   */
  tracer?: Tracer | undefined;
  /**
   * A Redis connection dedicated to reading the trace back, for the dashboard's fan-out.
   *
   * Separate from the limiter's connection because ioredis puts a client into subscriber mode
   * exclusively - the same constraint the gateway documents around its own `subscriber`. Its
   * presence is what mounts `/dev/trace`.
   */
  devSubscriber?: Redis | undefined;
  /**
   * The Redis this process uses, so `/ready` can say whether it is reachable.
   *
   * Optional in the same sense as `tracer` and `devSubscriber`: absent is a state that exists,
   * and every route test builds without one. What absent means here is that readiness FAILS
   * CLOSED - nothing can be said about a dependency that was not supplied, and "ready" is the
   * wrong answer to a question that was not asked. The entrypoint always passes it.
   *
   * The same connection the limiter uses, not one of readiness's own. A separate client would
   * report "Redis is up" while the one the application actually holds was broken, which is the
   * class of lie this whole check exists to remove.
   */
  redis?: Redis | undefined;
  /**
   * How long one readiness probe may take, when the default is not wanted.
   *
   * Overridable for the same reason the gateway's `authTimeoutMs` is: a test asserting that a
   * hung dependency is answered rather than waited on should not have to wait the real budget to
   * find out. Production takes `READINESS_TIMEOUT_MS`.
   */
  readinessTimeoutMs?: number | undefined;
};

/**
 * A group of routes, registered inside the authenticated scope.
 *
 * Every group receives the scoped instance rather than the root one, so no group can
 * accidentally register a route that skips the session check - the hook is on the scope,
 * and a group never sees the instance without it.
 */
export type RouteGroup = (app: FastifyInstance, deps: AppDeps) => void;

/** Media settings, derived once from config rather than rebuilt per request. */
export function mediaConfigOf(config: Config): MediaConfig {
  return {
    publicBucket: config.S3_BUCKET_PUBLIC,
    privateBucket: config.S3_BUCKET_PRIVATE,
    signingSecret: config.MEDIA_SIGNING_SECRET,
    cdnBaseUrl: config.MEDIA_CDN_BASE_URL,
    urlMode: config.MEDIA_URL_MODE,
  };
}

/**
 * Is this a UUID?
 *
 * Used by one hook covering every route rather than per route - see the hook in `app.ts` for
 * why. Accepts any version, because the question being asked is "will Postgres parse this into
 * a `uuid`", not "which generator made it".
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * A type predicate rather than a plain boolean, so a caller that has checked can then USE the
 * value as a string. The uuid hook in `app.ts` normalizes case after validating, and without the
 * narrowing that is a cast.
 */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value);

/** How many ids one batch read may name. Well under any URL length anybody enforces. */
export const MAX_BATCH_IDS = 100;

export type IdList = { ok: true; ids: string[] } | { ok: false; error: string };

/**
 * Parse `?ids=a,b,c` for a batch read.
 *
 * > **Batch reads exist because a screen full of cards was a screen full of requests.** A chat
 * > with 26 poll cards and 10 event cards issued 36 requests to draw itself, one per card, and
 * > the client had no way to say "these ones" - the same shape as `/sync` before it took a list.
 *
 * Three rules, and each is the one `/sync` settled on for the same reasons:
 *
 *  1. **A malformed id is a 400, not a skip.** Skipping it answers `200` with a response that
 *     simply does not mention that id, which is indistinguishable from an id the caller may not
 *     read - so a client bug hides behind a success. That cost this project months on iOS once
 *     already; see the `channels[]` note in `routes/inbox.ts`.
 *  2. **An id the caller may not read is OMITTED**, by the route rather than here. That is
 *     deliberate and is not the same as (1): a card in old chat history can name a poll that has
 *     since been deleted or a race the reader has left, and one stale card must not fail the
 *     other 25. Omission also keeps `forbidden` and `not_found` indistinguishable, which is the
 *     property `refusalStatus` exists to hold.
 *  3. **Duplicates collapse and order is preserved**, so a caller that asks twice for the same id
 *     is charged once and can still match results back positionally if it wants to.
 *
 * The id list is never percent-encoded by the client. A uuid and a comma need no escaping, and
 * whatever a platform escapes on its own the server decodes back - the rule from `syncEntry`,
 * which is the one place this project has been bitten by encoding twice.
 */
export function parseIdList(raw: unknown, max: number = MAX_BATCH_IDS): IdList {
  if (typeof raw !== 'string' || raw === '') return { ok: false, error: 'no_ids' };

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(',')) {
    /*
     * Lower cased as well as trimmed, and that is a correctness fix rather than tidiness.
     *
     * `isUuid` accepts either case and so does Postgres, which compares these as `uuid` values.
     * But every batch read below keys a `Map` by `row.id`, which Postgres renders lower case
     * whatever was sent, and then looks the caller's own spelling up in it - so an upper case id
     * was fetched, authorized, and then silently dropped from the answer. See the matching note
     * on the uuid hook in `app.ts`, which does the same for route params. Found 2026-08-21.
     *
     * Case-folding also has to happen BEFORE the duplicate check, or the same id in two spellings
     * is charged twice and answered twice.
     */
    const id = part.trim().toLowerCase();
    if (!isUuid(id)) return { ok: false, error: 'bad_id' };
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  if (ids.length === 0) return { ok: false, error: 'no_ids' };
  if (ids.length > max) return { ok: false, error: 'too_many_ids' };
  return { ok: true, ids };
}

/** Map a domain refusal onto a status code, in one place. */
export const refusalStatus = (code: string): number =>
  code === 'forbidden' || code === 'not_found'
    ? // 404 for both: a member who has no business with this club must not learn
      // whether it exists, and "forbidden" would tell them.
      404
    : 409;

export type ChannelGuard =
  | { ok: true; channel: ChannelRef }
  | { ok: false; code: number };

/**
 * Guard a channel-scoped route.
 *
 * Scope access is decided ONCE, here at the boundary, and never re-derived per route
 * below it - SPEC/PRD/15 rule 7, restated on the server. Returns the channel so the
 * caller does not load it twice.
 */
export async function authorizeChannel(
  deps: AppDeps,
  request: FastifyRequest,
  channelId: string,
): Promise<ChannelGuard> {
  const allowed = await authorizeChannels(deps, request, [channelId]);
  const channel = allowed.get(channelId);
  if (!channel) return { ok: false, code: 404 };
  return { ok: true, channel };
}

/**
 * The same check, for many channels, in one round trip.
 *
 * > **`GET /sync` admits up to 200 `channels[]` entries and called `authorizeChannel` per entry**,
 * > so authorizing a sync cost one statement per channel before a single message was read.
 * > Measured on 2026-08-21 as half of `/sync`'s `5 + 2n`.
 *
 * Returns only the channels this caller may read, keyed by id. **Absent covers both "no such
 * channel" and "not yours", exactly as the single guard's 404 does**, and that conflation is the
 * point rather than a shortcut: distinguishing them would confirm to a stranger that a channel
 * exists.
 *
 * The predicate is applied per id in a loop, over refs fetched in one query - never folded into a
 * `WHERE` clause. `isChannelMember` is defined once in `policy/predicates.ts` and a second copy of
 * it expressed as SQL is failure mode 9, which is how the race scope once went missing from four
 * separate reads at the same time without a single test failing.
 */
export async function authorizeChannels(
  deps: AppDeps,
  request: FastifyRequest,
  channelIds: readonly string[],
): Promise<Map<string, ChannelRef>> {
  const refs = await getChannelRefs(deps.db, channelIds);
  const allowed = new Map<string, ChannelRef>();
  for (const [channelId, channel] of refs) {
    if (!isChannelMember(request.access!, channel)) continue;
    allowed.set(channelId, channel);
  }
  return allowed;
}
