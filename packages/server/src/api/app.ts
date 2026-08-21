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
import fastifyHelmet from '@fastify/helmet';
import { fromNodeHeaders } from 'better-auth/node';
import { trustProxyOption } from '../config.ts';
import { loadAccessContext } from '../policy/context.ts';
import { isSessionUsable } from '../policy/predicates.ts';
import { isUuid, type AppDeps } from './plumbing.ts';
import {
  AUTH_BUCKET,
  PASSWORD_RESET_BUCKET,
  bucketFor,
  limitKey,
  passwordResetLimitKey,
} from './rate-limit.ts';
import { readIdentity } from '../domain/account.ts';
import { registerDevDashboard, type RouteEntry } from '../dev/dashboard.ts';
import { beginQueryCount, type QueryCount } from '../dev/queries.ts';
import { readBody } from '../dev/trace.ts';
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

/**
 * Is this the request that sends password-reset mail?
 *
 * Matched on the path alone, ignoring any query string, and against the ONE endpoint better-auth
 * registers for it - the `/forget-password` spelling belongs to the email-OTP plugin, which this
 * app does not load. Getting this wrong fails open rather than closed, so it is written to be
 * checked rather than trusted: the test asserts the limit actually engages on the real route.
 */
function isPasswordResetRequest(url: string): boolean {
  return (url.split('?')[0] ?? '') === '/api/auth/request-password-reset';
}

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
    {
      ...(deps.logger === undefined
        ? { logger: { level: deps.config.LOG_LEVEL } }
        : { loggerInstance: deps.logger }),
      /*
       * Whether `X-Forwarded-For` may be believed.
       *
       * This decides what `request.ip` is, and `request.ip` is what keys the per-IP sign-in
       * bucket - the only limit in this API that is a security control rather than an abuse
       * ceiling. Unset behind a proxy, every caller shares the proxy's address and one bucket
       * covers the whole internet. See `TRUST_PROXY` in config.ts for why it is not simply
       * `true`.
       */
      trustProxy: trustProxyOption(deps.config.TRUST_PROXY),
    },
  );

  /*
   * The development trace, and the route table it is measured against.
   *
   * Both are inert without `deps.tracer`, which no test and no production boot constructs. The
   * hooks are registered HERE, before any route, because a Fastify hook only applies to routes
   * added after it - registering them lower down would silently miss `/api/auth/*` and every
   * group below, which is the same "a route that forgets" failure the session hook and the
   * limiter are placed on a scope to avoid.
   */
  const devRoutes: RouteEntry[] = [];
  if (deps.tracer) {
    const tracer = deps.tracer;

    // `onRoute` fires once per registration and propagates into encapsulated children, so this
    // sees the whole protected scope even though those routes are added inside `app.register`.
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) devRoutes.push({ method, url: route.url });
    });

    /*
     * The response body is only readable here.
     *
     * `onSend` is the one hook handed the serialized payload; by `onResponse` it has been
     * written to the socket and is gone. Stored on the side rather than on the request object,
     * so the shared `FastifyRequest` type does not grow a field that exists in development
     * only.
     */
    const payloads = new WeakMap<FastifyRequest, unknown>();

    /*
     * The query counter, established as early as a hook can run.
     *
     * `onRequest` is the first hook in Fastify's lifecycle, so everything a handler does below
     * it - including the session lookup and the rate limiter, which are themselves reads - is
     * inside the count. That is deliberate: "what did this request cost" has to include the
     * plumbing, or the number flatters every route equally.
     *
     * Stored on the side like `payloads` above, so the shared `FastifyRequest` type does not
     * grow a field that exists in development only.
     */
    const counters = new WeakMap<FastifyRequest, QueryCount>();

    app.addHook('onRequest', async (request) => {
      counters.set(request, beginQueryCount());
    });

    app.addHook('onSend', async (request, _reply, payload) => {
      payloads.set(request, payload);
      return payload;
    });

    /*
     * Emitted on the way out, once, with everything the page needs to draw one row.
     *
     * `reply.elapsedTime` is Fastify's own measurement from the moment the request arrived, so
     * `startedAt` below is a real arrival time rather than this hook's own. That matters for
     * ordering: a slow request must sort above the effects it caused, not below them.
     */
    app.addHook('onResponse', async (request, reply) => {
      /*
       * The observer does not observe itself.
       *
       * Without this the dashboard's own catalogue fetch is traced, complete with a response
       * body holding every route note in the spec - so opening the page fills its own replay
       * buffer with itself, and the SSE stream posts a row every time a browser disconnects.
       * `/dev` is not part of the app, so nothing is lost by leaving it out.
       */
      if (request.url.startsWith('/dev/')) return;

      const ms = Math.round(reply.elapsedTime);
      // Spread rather than assigned: `exactOptionalPropertyTypes` is on, so an absent counter
      // has to mean an absent field rather than a present `undefined`.
      const counted = counters.get(request);
      tracer.emit({
        kind: 'http',
        id: request.id,
        method: request.method,
        url: request.url,
        route: request.routeOptions?.url ?? null,
        status: reply.statusCode,
        ms,
        startedAt: Date.now() - ms,
        userId: request.userId ?? null,
        reqBody: readBody(request.body),
        resBody: readBody(payloads.get(request)),
        ...(counted ? { queries: counted.queries, dbMs: counted.dbMs } : {}),
      });
    });
  }

  /*
   * Security headers, on every response, from one plugin.
   *
   * > **There were none at all until 2026-08-08** - no HSTS, no frame options, no
   * > content-type-options, no CSP, zero occurrences anywhere in the codebase. Registered here
   * > rather than per route for the same structural reason the session hook and the rate limiter
   * > are on the scope: a header set route by route is a header the next route forgets.
   *
   * Three defaults are overridden, and each would otherwise break something real:
   *
   *  1. **CSP is `default-src 'none'`** rather than helmet's `'self'`. This process serves JSON
   *     and one 302, never a document, so nothing legitimate needs a source - and the tightest
   *     possible policy costs nothing while covering the case where a response is coaxed into
   *     being rendered as one. `frame-ancestors 'none'` is the half that does real work, beside
   *     the frame-options header.
   *  2. **`crossOriginResourcePolicy` is `cross-origin`.** The default is `same-origin`, and this
   *     API is deliberately consumed from another origin - the Expo web client on a different
   *     port in development, and a different host in production. Leaving the default would refuse
   *     the browser client while native carried on working, which is the failure shape this
   *     project has hit twice.
   *  3. **COEP stays off.** It governs what a *document* may embed and this serves none, so
   *     enabling it buys nothing and would complicate the media redirect for no benefit.
   */
  app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      /*
       * `useDefaults: false`, so the policy says exactly what is meant.
       *
       * Left on, helmet merges its document-shaped defaults underneath - `script-src 'self'`,
       * `style-src ... 'unsafe-inline'`, `font-src`, `img-src`. None of them is wrong, and all of
       * them are noise on a process that serves no documents: a reader of the response would
       * reasonably conclude scripts and styles are expected here. `default-src 'none'` already
       * covers every fetch directive, and the three below are the ones it does not.
       */
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        // Not covered by default-src, and the one that does real work here.
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    // DENY, not helmet's SAMEORIGIN default, so this agrees with `frame-ancestors 'none'` above.
    // Two headers answering the same question differently is the kind of thing that gets
    // resolved later by whichever one somebody reads first.
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    /*
     * Two years, with subdomains, and preload-eligible.
     *
     * Ignored by browsers over plain HTTP, so development is unaffected and this is inert until
     * there is a certificate in front of it - which is the point of setting it now rather than
     * remembering to at deploy time.
     */
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
  });

  app.register(fastifyCors, {
    origin: deps.config.CLIENT_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    /*
     * How long a browser may remember that a request shape is allowed.
     *
     * > **Unset, this doubled the request count of the entire web client.** Every call carries
     * > an `Authorization` header, which makes it non-simple, so the browser sends a preflight
     * > `OPTIONS` first and will only skip the next one if the answer said how long to cache it.
     * > With no `Access-Control-Max-Age` the browser falls back to its own default - five
     * > seconds in Chromium - and effectively re-asks before everything. Measured on a signed-in
     * > session: 92 preflights against 104 real requests.
     *
     * Two hours is the ceiling Chromium honours; Firefox caps at 24. Asking for more is not an
     * error, it is just silently reduced, so this is the largest value that means what it says.
     *
     * Safe to cache because what is being cached is the SHAPE of the permission - this origin
     * may send these methods with these headers - and not any authorization decision. Every
     * request is still authenticated and access-checked on arrival. Native clients are
     * unaffected either way: preflight is a browser rule, and the phone never sent one.
     */
    maxAge: 7200,
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

      /**
       * Password reset is limited a **second** time, per address.
       *
       * The bucket above protects us from a caller. This one protects a third party from the
       * caller: every reset request puts mail in somebody else's inbox, and the sender needs to
       * know nothing but the address. Ten per IP is a fair allowance for a forgotten password and
       * ten unwanted emails for whoever owns the address that was typed.
       *
       * Deliberately consumed BEFORE better-auth sees the request, and regardless of whether the
       * address belongs to an account. Charging only for addresses that exist would make the
       * limit itself the account-existence oracle that `PRD/03` rule 14 exists to close.
       */
      if (request.method === 'POST' && isPasswordResetRequest(request.url)) {
        const email = (request.body as { email?: unknown } | undefined)?.email;
        if (typeof email === 'string' && email.trim() !== '') {
          const key = passwordResetLimitKey(email);
          if (!(await deps.limiter.tryConsume(key, PASSWORD_RESET_BUCKET))) {
            return refuseTooMany(reply, PASSWORD_RESET_BUCKET);
          }
        }
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
      for (const key of ['id', 'uid'] as const) {
        const value = params?.[key];
        if (value === undefined) continue;
        if (!isUuid(value)) return reply.code(404).send({ error: 'not_found' });
        /*
         * **Normalized as well as validated, because a uuid has more than one spelling and the
         * code below keys `Map`s by it.**
         *
         * `UUID_PATTERN` carries `/i`, so `ABCDEF01-...` is accepted - and Postgres accepts it
         * too, comparing it as a `uuid` rather than as text. But a batch read fetches its rows in
         * one statement, builds a `Map` keyed by `row.id` - which Postgres renders **lower case**
         * whatever was sent - and then looks each caller id up in it. The row was therefore
         * fetched, authorized, and silently dropped from the answer, which is the worst available
         * shape: a `200` listing fewer things than were asked for, indistinguishable from an id
         * the caller may not read.
         *
         * Fixed here rather than at each read for the reason this hook exists at all: there are
         * more than sixty of these routes and the ones that forgot would be indistinguishable
         * from the ones that cannot happen. Found on 2026-08-21, latent in `/polls` and
         * `/media/urls` since they were written.
         */
        (params as Record<string, unknown>)[key] = value.toLowerCase();
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

  /*
   * The dashboard, last, and only when a connection to read the trace back was supplied.
   *
   * Registered on the root instance rather than inside the protected scope, deliberately: it
   * must be openable in a browser that holds no app session, because the traffic worth watching
   * belongs to somebody else. That is only safe because it cannot be constructed outside
   * development - see `dev/trace.ts` for the three independent gates.
   */
  if (deps.devSubscriber) {
    registerDevDashboard(app, {
      subscriber: deps.devSubscriber,
      routes: devRoutes,
      log: (message) => app.log.info(message),
    });
  }

  return app;
}
