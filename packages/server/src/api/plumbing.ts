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
import { getChannelRef } from '../domain/reads.ts';
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

export const isUuid = (value: unknown): boolean =>
  typeof value === 'string' && UUID_PATTERN.test(value);

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
  const channel = await getChannelRef(deps.db, channelId);
  if (!channel) return { ok: false, code: 404 };
  if (!isChannelMember(request.access!, channel)) {
    // 404 rather than 403: a member who types a URL for a channel they cannot access
    // gets nothing back, and "nothing back" includes not confirming the channel exists.
    return { ok: false, code: 404 };
  }
  return { ok: true, channel };
}
