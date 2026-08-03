/**
 * How often one caller may hit the HTTP API.
 *
 * > **Only message sends were throttled.** `SEND_RATE_*` covers the gateway, which is one path;
 * > the other 123 are the whole rest of the product, and every one of them was unlimited. `PRD/17`
 * > debt 12 records it as "rate limiting beyond messages - reports, reactions, and join requests
 * > are still unthrottled", and the honest version of that sentence was "and everything else".
 *
 * The shape is **one default plus named overrides**, which is the choice that matters here. The
 * alternative - name every route that needs limiting - means a route added next month is
 * unthrottled until somebody remembers, and forgetting is exactly how this gap opened. A default
 * covers the routes nobody thought about, including the ones that do not exist yet.
 *
 * ---
 *
 * **The numbers are deliberately generous.** This is abuse protection, not quota enforcement: a
 * member scrolling fast, a screen that loads six lists at once, and a reconnect that refetches
 * everything are all normal and must never see a 429. The limits below are set where a human
 * cannot reach them and a script trivially can.
 */

/** A token bucket: `burst` tokens, refilled at `refillPerSec`, one token per request. */
export type Bucket = { burst: number; refillPerSec: number };

/**
 * Every authenticated route, per user.
 *
 * 300 in reserve refilling at 10/sec. Opening the app cold fires a double-digit number of reads
 * and a fast scroll pages more, so the burst has to absorb a screenful of activity without
 * thinking about it.
 */
export const DEFAULT_BUCKET: Bucket = { burst: 300, refillPerSec: 10 };

/**
 * Sign-in and sign-up, per IP, since there is no user yet.
 *
 * The one bucket here that is a security control rather than an abuse limit: it is what stands
 * between an attacker and unlimited credential guessing. Ten in reserve refilling at one every
 * five seconds - forgetting your password twice is fine, working through a word list is not.
 *
 * **Per IP is a real trade-off and not a free one.** A university dorm behind one NAT shares this
 * bucket, which is the reason it is not tighter.
 */
export const AUTH_BUCKET: Bucket = { burst: 10, refillPerSec: 0.2 };

/**
 * Routes that cost more than a read, keyed by `METHOD /route/pattern`.
 *
 * The pattern is Fastify's registered URL, not the request's - `/clubs/:id/polls`, never
 * `/clubs/<uuid>/polls` - so one entry covers every club.
 *
 * Each entry answers "what does abusing this actually do to us?", which is why they differ:
 *
 *  - **Media** mints presigned S3 URLs and then verifies real objects. It is the only route group
 *    that spends money per call and the only one that can be turned into someone else's storage
 *    bill.
 *  - **Anything that notifies somebody** is a harassment vector before it is a load problem. A
 *    join request, a report and a new DM thread each put a row in another person's inbox, and the
 *    limit is about the human on the other end rather than the database.
 *  - **A new DM thread specifically**: `PRD/17` debt 12 names this shape - "one sender opening
 *    many threads stays under any per-sender bucket" - because the per-conversation limits that
 *    would catch a flood do not exist until the conversation does.
 */
export const ROUTE_BUCKETS: Readonly<Record<string, Bucket>> = {
  // Media: the only routes that cost real money per call.
  'POST /media/upload-intent': { burst: 30, refillPerSec: 0.5 },
  'POST /media/:id/complete': { burst: 30, refillPerSec: 0.5 },

  // Opening a conversation with somebody who has not asked for one.
  'POST /dm/threads': { burst: 10, refillPerSec: 0.05 },

  // Asking to join, and deciding. The request side is the one that reaches a stranger.
  'POST /clubs/:id/join': { burst: 20, refillPerSec: 0.2 },
  'POST /eboards/:id/join-requests': { burst: 20, refillPerSec: 0.2 },
  'POST /races/:id/join-requests': { burst: 20, refillPerSec: 0.2 },
  'POST /invites/:token/redeem': { burst: 20, refillPerSec: 0.2 },

  // Reports land in a moderator's queue. A flood of them IS the abuse.
  'POST /channels/:id/messages/:seq/report': { burst: 15, refillPerSec: 0.1 },

  // Blocking is cheap and reversible, but a block/unblock loop republishes state each time.
  'POST /blocks': { burst: 30, refillPerSec: 0.5 },

  // Reactions are the highest-frequency legitimate write, so this is loose on purpose - it is
  // here to stop a script, not a person having fun.
  'POST /news/:id/reactions': { burst: 60, refillPerSec: 2 },
};

/**
 * The bucket for a request, and the key it counts against.
 *
 * Pure, so the policy can be asserted without a Redis or an HTTP server - which matters more than
 * usual here, because the failure mode of a wrong answer is either "the product feels broken" or
 * "the limit does nothing", and neither shows up in an ordinary test.
 */
export function bucketFor(method: string, routePattern: string | undefined): Bucket {
  if (routePattern === undefined) return DEFAULT_BUCKET;
  return ROUTE_BUCKETS[`${method.toUpperCase()} ${routePattern}`] ?? DEFAULT_BUCKET;
}

/**
 * The Redis key a request counts against.
 *
 * Namespaced per route for an override and shared for the default, which is the behaviour the
 * two are for: the default is "how much is this person doing overall", an override is "how much
 * of THIS is this person doing". Sharing one bucket across both would let ordinary reading
 * exhaust the allowance for reporting, and separating every route would mean no overall ceiling.
 */
export function limitKey(
  identity: string,
  method: string,
  routePattern: string | undefined,
): string {
  const named = routePattern !== undefined && `${method.toUpperCase()} ${routePattern}` in ROUTE_BUCKETS;
  return named ? `rate:http:${method.toUpperCase()}:${routePattern}:${identity}` : `rate:http:all:${identity}`;
}
