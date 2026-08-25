/**
 * A 500 raised on purpose, through the real error handler, with no production route to raise it.
 *
 * > **The question this exists to answer is not "does the code capture errors".** That is proved
 * > by `test/error-reporting.test.ts` on every run. It is "does a captured error reach a human",
 * > and every link in that chain - the DSN, egress from the machine, the Sentry project, its
 * > alert rule, the inbox filter it lands in - has never been exercised once. Nobody would learn
 * > about breakage from a tool today; they would learn about it from a member.
 *
 * **What this deliberately is not: a route.** The obvious way to force a 500 in production is an
 * endpoint that throws, guarded by a token or a header. That is a permanent piece of attack
 * surface, live for ever, bought for a drill that runs twice a year - and a guard on it is one
 * more secret to rotate and one more thing to get wrong. So the throwing route is registered on
 * an app instance built HERE, in a process the operator started, and exists for the length of one
 * `inject`. The shape is `error-reporting.test.ts`'s, for the same reason it uses it.
 *
 * **What makes it a real drill rather than a `capture` call with a plausible label:** the app is
 * the real `buildApp`, so the failure travels the real `setErrorHandler` - which is where the
 * decision to report 5xx and stay quiet about 4xx lives, where the route PATTERN is chosen over
 * the URL, and where the opaque `{ error: 'internal' }` body is written. A drill that called
 * `monitor.capture(error, 'api.request')` directly would prove a path that does not exist.
 *
 * **No database, no Redis, no object storage.** The deps below are stubs, and that is the whole
 * reason this can be run from a laptop against the production Sentry project: requiring the
 * production `DATABASE_URL` in order to find out whether an alert reaches somebody's phone would
 * be a far worse trade than a stub `db` that no code path in this file touches. The route throws
 * before any handler that would use one.
 *
 * The operator entrypoint is `scripts/drills/forced-5xx.mjs`, which owns the refusal to run
 * against an unnamed target. This module owns the mechanism and nothing else.
 */

import { buildApp } from '../api/app.ts';
import type { Config } from '../config.ts';
import { FakeMediaStore } from '../media/store.ts';
import type { Monitor } from '../monitoring.ts';

/**
 * The path the drill's throwing route is registered at.
 *
 * It reaches Sentry as the `route` in the report's context, so it is written to be recognised at
 * 3am by somebody who did not run the drill: the issue says `/__drill/forced-5xx` rather than
 * something that could be mistaken for a real endpoint members reach.
 */
export const DRILL_ROUTE = '/__drill/forced-5xx';

export type ForcedFiveHundred = {
  /** What the caller got. 500, or the drill proved nothing. */
  status: number;
  /** The response body, which must say nothing about the failure. */
  body: string;
  route: string;
};

/**
 * Only the fields `buildApp` reads while building and answering this one route.
 *
 * Cast the way every handler test casts, and for the same reason: the alternative is `loadConfig`,
 * which requires ten values this drill never uses and would put the production database URL on a
 * laptop as the price of testing an alert rule.
 */
const drillConfig = {
  LOG_LEVEL: 'silent',
  CLIENT_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_URL: 'http://localhost:3000',
  S3_BUCKET_PUBLIC: 'identity',
  S3_BUCKET_PRIVATE: 'content',
  MEDIA_SIGNING_SECRET: 'drill-signing-secret-not-a-real-one',
  MEDIA_CDN_BASE_URL: 'http://cdn.invalid/content',
  MEDIA_URL_MODE: 'cdn',
  TRUST_PROXY: 'false',
} as unknown as Config;

/**
 * Raise one deliberate 500 and let the given monitor report it.
 *
 * The monitor is passed in rather than constructed here so the same mechanism serves both callers:
 * the script hands it the real one built from a production DSN, and `test/drills.test.ts` hands it
 * a recorder and asserts the report's shape without sending anything anywhere.
 */
export async function forceFiveHundred(monitor: Monitor): Promise<ForcedFiveHundred> {
  const app = buildApp({
    // Never touched: the route below throws, and nothing in the request's path before it reads a
    // dependency. Typed away rather than faked, because a convincing fake would invite somebody
    // to extend this drill into something that needs a real one.
    db: {} as never,
    auth: {} as never,
    config: drillConfig,
    mediaStore: new FakeMediaStore(),
    monitor,
    limiter: { async tryConsume() { return true; } },
  });

  // Registered on the built instance, exactly as `error-reporting.test.ts` does, so `app.ts` has
  // no route that throws on purpose and the production surface gains nothing from this file.
  app.get(DRILL_ROUTE, async () => {
    throw new Error('deliberate 5xx: ClubChat monitoring drill');
  });

  await app.ready();
  /*
   * `inject` rather than a real socket. It runs the whole Fastify lifecycle - hooks, the error
   * handler, serialization - without binding a port, which matters here for a reason beyond
   * convenience: a drill that listened would be a second server briefly answering on a machine
   * that already has one, and AGENTS.md failure mode 15 is about exactly the confusion that
   * causes.
   */
  const response = await app.inject({ method: 'GET', url: DRILL_ROUTE });
  await app.close();

  return { status: response.statusCode, body: response.body, route: DRILL_ROUTE };
}
