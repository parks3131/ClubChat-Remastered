/**
 * The API. Composition only - every route lives in a group under `routes/`.
 *
 * The guarantee, unchanged from v1 and the reason the application server exists:
 *
 * > Every read and every write is access-checked on the server, not in the UI.
 * > Client-side gates are UX, never enforcement. A member who types a URL for a race
 * > chat, an Eboard poll, or another club's roster gets NOTHING back.
 *
 * What changed is where it is enforced: a policy module of pure functions over a
 * loaded access context, rather than row-level predicates evaluated inside queries.
 *
 * Structurally, what this file guarantees is narrower and worth stating: **no route group
 * is ever handed an instance without the session hook**. Groups are registered inside the
 * `protectedRoutes` scope and receive that instance, so an unauthenticated route cannot be
 * added by forgetting something - it can only be added by editing this file.
 */

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import fastifyCors from '@fastify/cors';
import { fromNodeHeaders } from 'better-auth/node';
import { loadAccessContext } from '../policy/context.ts';
import { isSessionUsable } from '../policy/predicates.ts';
import { isUuid, type AppDeps } from './plumbing.ts';
import { AUTH_BUCKET, bucketFor, limitKey } from './rate-limit.ts';
import { readIdentity } from '../domain/account.ts';
import { registerAccountRoutes } from './routes/account.ts';
import { registerCalendarRoutes } from './routes/calendar.ts';
import { registerChatRoutes } from './routes/chat.ts';
import { registerClubRoutes } from './routes/clubs.ts';
import { registerContentRoutes } from './routes/content.ts';
import { registerDmRoutes } from './routes/dm.ts';
import { registerEboardRoutes } from './routes/eboard.ts';
import { registerInboxRoutes } from './routes/inbox.ts';
import { registerMediaRoutes } from './routes/media.ts';
import { registerModerationRoutes } from './routes/moderation.ts';
import { registerPollRoutes } from './routes/polls.ts';
import { registerRaceRoutes } from './routes/races.ts';

export type { AppDeps };

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify(
    /*
     * The entrypoint's logger when it has one, so captured errors and request logs share a
     * stream. Tests build without it and get their own at the configured level.
     *
     * **`loggerInstance` and `logger` are different options and not interchangeable.** Fastify 5
     * split them: `logger` takes CONFIGURATION, and passing a built pino instance to it fails at
     * construction with `FST_ERR_LOG_INVALID_LOGGER_CONFIG`. Worth the comment because the type
     * error is not obvious and every test builds down the other branch, so the suite stays green
     * while the server refuses to start.
     */
    deps.logger === undefined
      ? { logger: { level: deps.config.LOG_LEVEL } }
      : { loggerInstance: deps.logger },
  );

  app.register(fastifyCors, {
    origin: deps.config.CLIENT_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  /**
   * Refuse, in the one shape every limited route uses.
   *
   * `Retry-After` is not decoration: without it a client's only strategy is to try again
   * immediately, which is what turns a limit into a hot loop against the thing it protects.
   */
  const refuseTooMany = (reply: FastifyReply, bucket: { refillPerSec: number }) =>
    reply
      .code(429)
      .header('Retry-After', String(Math.max(1, Math.ceil(1 / bucket.refillPerSec))))
      .send({ error: 'rate_limited' });

  // Mounted AFTER cors, which the better-auth Fastify integration requires for
  // header handling to work.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    /**
     * Sign-in and sign-up, limited **per IP**.
     *
     * The only limit in the API that is a security control rather than an abuse ceiling: there is
     * no session yet, so there is no user to key on, and unlimited attempts here is unlimited
     * credential guessing. `request.ip` honours `trustProxy` when that is configured; behind a
     * proxy without it, every caller shares one bucket, which fails safe (too strict) rather than
     * open.
     */
    async preHandler(request, reply) {
      if (!(await deps.limiter.tryConsume(`rate:http:auth:${request.ip}`, AUTH_BUCKET))) {
        return refuseTooMany(reply, AUTH_BUCKET);
      }
    },
    async handler(request, reply) {
      const url = new URL(request.url, deps.config.BETTER_AUTH_URL);
      const req = new Request(url.toString(), {
        method: request.method,
        headers: fromNodeHeaders(request.raw.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await deps.auth.handler(req);
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? await response.text() : null);
    },
  });

  app.get('/health', async () => ({ ok: true }));

  /**
   * Every unhandled failure in a route, in one place.
   *
   * > **There was no error handler at all.** Fastify's default logged through pino and answered
   * > 500, which is correct behaviour and reaches nobody: the failure existed only in a log file
   * > on a machine no one reads. This is the hook `SPEC/TECH/15` was describing.
   *
   * Two rules it holds:
   *
   *  1. **A 4xx is not an incident.** A validation failure or a refusal is the API working. Only
   *     5xx is captured, or the signal drowns in ordinary client mistakes.
   *  2. **The caller learns nothing new.** The response is the same opaque 500 it always was -
   *     the detail goes to the monitor, not over the wire.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    if (status >= 500) {
      deps.monitor.capture(error, 'api.request', {
        method: request.method,
        // The route PATTERN, not the URL: `/clubs/:id/polls` groups, `/clubs/<uuid>/polls`
        // makes a distinct issue per club and buries the fact that one route is failing.
        route: request.routeOptions?.url ?? request.url,
        userId: request.userId ?? null,
      });
    } else {
      request.log.info({ err: error, status }, 'request refused');
    }

    return reply.code(status).send(status >= 500 ? { error: 'internal' } : { error: error.message });
  });

  /**
   * Resolve the caller, then load their access context once for the request.
   *
   * The revocation check is here rather than only at sign-in because blocking a user does
   * NOT invalidate an already-issued token. Without it, a deleted or blocked account keeps
   * working until its session expires.
   *
   * It runs AFTER the context load rather than before, which is the fix for the version that
   * shipped: the answer lives in our own `users` row, and asking the session object for it
   * read a property better-auth does not return. One extra query for a request that was
   * going to make it anyway, in exchange for a check that actually fires.
   */
  async function authenticate(request: FastifyRequest): Promise<boolean> {
    const session = await deps.auth.api.getSession({
      headers: fromNodeHeaders(request.raw.headers),
    });
    if (!session?.user) return false;

    const access = await loadAccessContext(deps.db, session.user.id);
    if (!isSessionUsable(access)) return false;

    request.userId = session.user.id;
    request.access = access;
    return true;
  }

  // Everything below /api that is not the auth handler requires a session.
  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook('preHandler', async (request, reply) => {
      if (!(await authenticate(request))) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }
    });

    /**
     * Every authenticated route, limited per user.
     *
     * > **On the scope, so a route cannot opt out by being forgotten.** That is the same structural
     * > argument the session hook above is built on, and it is the whole reason the default exists:
     * > naming the routes that need limiting means the next route added is unlimited until somebody
     * > remembers, which is precisely how the API came to have 123 unthrottled routes.
     *
     * AFTER authentication, because the key is the user id. That ordering also means an
     * unauthenticated caller is refused by the 401 rather than spending somebody's tokens - a
     * limiter in front of the session check would let an attacker exhaust a stranger's bucket by
     * guessing their id.
     */
    protectedRoutes.addHook('preHandler', async (request, reply) => {
      const pattern = request.routeOptions?.url;
      const bucket = bucketFor(request.method, pattern);

      if (!(await deps.limiter.tryConsume(limitKey(request.userId!, request.method, pattern), bucket))) {
        request.log.warn(
          { userId: request.userId, route: pattern, method: request.method },
          'rate limited',
        );
        return refuseTooMany(reply, bucket);
      }
    });

    /**
     * Every `:id` and `:uid` in this API is a UUID. Anything else is not found.
     *
     * > **Without this, a malformed id is a 500.** The value goes straight into a `uuid`
     * > column, Postgres refuses to parse it, and the driver error surfaces as an unhandled
     * > failure - one route logged a whole stack trace for `/channels/undefined/messages/9999`,
     * > which is both the wrong status and more than a caller should learn. Found by a test
     * > that fetched a path built from an undefined variable, which is exactly how a client
     * > will hit it.
     *
     * Here rather than in each route because there are more than sixty of them and the ones
     * that forget would be indistinguishable from the ones that cannot happen. `seq` and
     * `token` are deliberately not covered: they are not uuids, and their routes parse them
     * explicitly.
     *
     * 404 rather than 400, to match every other id refusal in the API - a caller learns
     * "nothing here", not which of the several reasons applied.
     */
    protectedRoutes.addHook('preHandler', async (request, reply) => {
      const params = request.params as { id?: unknown; uid?: unknown } | undefined;
      for (const value of [params?.id, params?.uid]) {
        if (value !== undefined && !isUuid(value)) {
          return reply.code(404).send({ error: 'not_found' });
        }
      }
    });

    /**
     * Who the caller is.
     *
     * The email lives HERE and never on a profile read, which
     * `phase3-75-account-and-eboard-routes` asserts for both the public and the own shape. It is a
     * login identifier rather than a profile field: a roster that carried one would hand every
     * club member a mailing list, and "own profile only" is a rule somebody would eventually
     * relax by accident. Keeping it on the authenticated identity read means there is no profile
     * shape it could leak from.
     */
    protectedRoutes.get('/me', async (request) => readIdentity(deps.db, request.access!));

    registerAccountRoutes(protectedRoutes, deps);
    registerClubRoutes(protectedRoutes, deps);
    registerChatRoutes(protectedRoutes, deps);
    registerMediaRoutes(protectedRoutes, deps);
    registerDmRoutes(protectedRoutes, deps);
    registerModerationRoutes(protectedRoutes, deps);
    registerInboxRoutes(protectedRoutes, deps);
    registerRaceRoutes(protectedRoutes, deps);
    registerPollRoutes(protectedRoutes, deps);
    registerContentRoutes(protectedRoutes, deps);
    registerCalendarRoutes(protectedRoutes, deps);
    registerEboardRoutes(protectedRoutes, deps);
  });

  return app;
}
