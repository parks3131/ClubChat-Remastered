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

import { createHash } from 'node:crypto';

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
 * Password reset, per **email address** rather than per IP.
 *
 * `AUTH_BUCKET` above already covers the caller, and it is the wrong control here: the person
 * being harmed by a flood of reset mail is not the one making the requests. Ten attempts from one
 * IP is a reasonable allowance for somebody who forgot their password and it is also ten emails
 * into somebody else's inbox, sent by a stranger who only needs to know the address. The two
 * limits stack, and this is the one that protects the third party.
 *
 * Three in reserve refilling at one every five minutes. Asking twice because the first mail was
 * slow is normal; a stream of them is not, and the refusal costs an attacker nothing to discover
 * because the response is identical either way (`PRD/03` rule 14).
 */
export const PASSWORD_RESET_BUCKET: Bucket = { burst: 3, refillPerSec: 1 / 300 };

/**
 * Resend's bounce and complaint webhook, against **one constant key**.
 *
 * Every other bucket in this file keys on somebody - a user id, an IP, an address - because every
 * other route has many callers. This one has exactly one legitimate caller, so there is nothing to
 * key on and a constant is the honest shape.
 *
 * **Consumed only AFTER the signature verifies, which is what makes a constant key safe.** Keyed
 * ahead of verification it would be a denial of the signal rather than a defence: anybody able to
 * reach the port could empty the bucket with unsigned junk, every genuine delivery would be
 * refused, and Resend would give up after ten hours of retries. Behind the check, the only thing
 * that can spend it is Resend.
 *
 * 60 in reserve refilling at one a second, which is far above anything this product can produce -
 * it sends single-digit mails a day - and still bounded, so a bounce storm against a large list
 * cannot write unboundedly fast. A refusal is safe here in a way it is nowhere else: a 429 makes
 * Resend retry on its own schedule, so the event is delayed rather than lost.
 */
export const MAIL_WEBHOOK_BUCKET: Bucket = { burst: 60, refillPerSec: 1 };

/** The one key `MAIL_WEBHOOK_BUCKET` is counted against. There is one caller, so there is one key. */
export const MAIL_WEBHOOK_LIMIT_KEY = 'rate:http:webhook:resend';

/**
 * The public invite preview, per **caller address**, since there is no account to key on.
 *
 * `GET /invites/:token/preview` is read by somebody who has just scanned a QR code and does not
 * have ClubChat, so there is no session, no user id, and nothing about them that is not
 * self-asserted. `request.ip` is the one identity here that a caller cannot choose - a forwarded
 * header would be a fresh bucket per request for anybody who wanted one - and it is meaningful
 * only because `trustProxy` is configured deliberately; see `TRUST_PROXY` in config.ts.
 *
 * **This bucket is a ceiling on database work, and it is not what keeps a token secret.** That is
 * the token's own 32 bytes of CSPRNG: enumerating a 256-bit space is not made infeasible by a
 * limit, it was already infeasible, and a limit tight enough to matter against guessing would
 * refuse real visitors for nothing. So the number is set where a lecture hall cannot reach it and
 * a script pointed at the endpoint still cannot spend the api's afternoon.
 *
 * **Per IP is a coarser control here than it looks, and the reason is worth stating.** The
 * expected caller is the apex Worker (ADR-0045), which calls this endpoint server-side, so every
 * visitor to the join page arrives from one of Cloudflare's shared egress addresses rather than
 * from their own. A whole freshers' fair therefore shares one bucket, which is why 120 in reserve
 * refilling at 5 a second: a club fair is a few hundred scans over an afternoon and this absorbs
 * that in a minute. The refusal is safe when it does come - the join page renders without the
 * club's name rather than claiming the invite is dead - but it is still a worse page, so the
 * generous side is the correct side to err on.
 */
export const INVITE_PREVIEW_BUCKET: Bucket = { burst: 120, refillPerSec: 5 };

/**
 * The key a preview request counts against.
 *
 * Namespaced away from `rate:http:all:` for the reason every override is: the caller here is an
 * address rather than a user, and a shared namespace would put a Cloudflare egress address and a
 * user id in the same keyspace where a collision is somebody else's allowance.
 */
export function invitePreviewLimitKey(ip: string): string {
  return `rate:http:preview:${ip}`;
}

/**
 * The key a reset request counts against: a hash of the address, never the address.
 *
 * Two reasons, and the second is the one that matters. Redis is not the system of record for
 * identity and a `KEYS rate:http:reset:*` would otherwise enumerate every address that has ever
 * asked for a reset - which is a list of real people, sitting in a cache that no part of this
 * product treats as sensitive. And the case fold means `Ada@example.com` and `ada@example.com`
 * share a bucket, because they share an inbox; without it the limit is one `Shift` away from
 * doing nothing.
 */
export function passwordResetLimitKey(email: string): string {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `rate:http:reset:${digest.slice(0, 32)}`;
}

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
