/**
 * `GET /invites/:token/preview` - the one route in this API that is unauthenticated on purpose and
 * answers a question about a club.
 *
 * > **A QR code taped to a table is scanned by a stranger, and `clubchat://join/<token>` does
 * > nothing at all for a phone without the app.** ADR-0045 puts a web page at
 * > `https://clubchatapp.com/join/<token>` to catch that person. This is how that page learns which
 * > club it is talking about, and it has no session to ask with, because the person has no account.
 *
 * Registered from `app.ts` on the ROOT instance, beside `/health`, `/ready`, `/__parity` and the
 * Resend webhook, for the reason that file's docblock gives: an unauthenticated route cannot be
 * added by forgetting something, only by editing `app.ts`. It lives in its own module rather than
 * under `routes/` because every module there is handed the SCOPED instance and is documented as
 * being inside the session hook, and this one is deliberately not - the same placement, and the
 * same reasoning, as `api/mail-webhook.ts`.
 *
 * ---
 *
 * **Why an unauthenticated read of a club is safe here, stated once so it is not re-derived.**
 * The token is already a bearer credential: whoever holds it can redeem it and be inside the club
 * a second later, with the roster and the chat history. Naming the club to that same holder
 * discloses strictly less than they already have. The endpoint is therefore not a widening of what
 * a token grants; it is a narrower use of it.
 *
 * Everything else follows from that, and each half is a way to get it wrong:
 *
 *  1. **Nothing beyond the contract.** `{ club: { name, memberCount }, expiresAt }` and no other
 *     field, ever - not the club id, not the description, not the join policy, not either token,
 *     and nothing whatsoever about a member. The projection is enforced in the SQL, in
 *     `domain/invite-preview.ts`, so this handler has nothing to be careful with.
 *  2. **Not an oracle.** Unknown, revoked, expired and deleted are one answer, and this route has
 *     exactly one refusal branch because the read has exactly one `null`.
 *  3. **Its own bucket.** The per-user limiter keys on `request.userId`, which a public caller does
 *     not have, so an unlimited route is what this would be by default. See
 *     `INVITE_PREVIEW_BUCKET`.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { readInvitePreview } from '../domain/invite-preview.ts';
import type { AppDeps } from './plumbing.ts';
import { INVITE_PREVIEW_BUCKET, invitePreviewLimitKey, type Bucket } from './rate-limit.ts';

/**
 * Where the route answers. Fixed by the interface contract and consumed by
 * `packages/site-worker/src/invite.ts`; changing it means changing it there in the same breath.
 */
export const INVITE_PREVIEW_PATH = '/invites/:token/preview';

/**
 * Register the preview, on whichever instance the caller hands over.
 *
 * `refuseTooMany` is passed in rather than rebuilt, exactly as `registerMailWebhook` takes it: it
 * is a closure inside `buildApp` carrying the one refusal shape every limited route in this API
 * uses, `Retry-After` included.
 */
export function registerInvitePreview(
  app: FastifyInstance,
  options: {
    deps: AppDeps;
    refuseTooMany: (reply: FastifyReply, bucket: Bucket) => unknown;
  },
): void {
  const { deps, refuseTooMany } = options;

  app.get<{ Params: { token: string } }>(
    INVITE_PREVIEW_PATH,
    {
      /**
       * The route's own log level, so the token does not go into the log.
       *
       * Fastify logs `req.url` at info on every request, and on this route the url IS a bearer
       * credential - the one that lets whoever reads it walk into the club. Every other route
       * carrying a token is behind a session; this is the one an unauthenticated caller drives, so
       * it is the one where a log line is a credential written down for anybody with log access.
       *
       * `warn` rather than `silent`, deliberately: the rate-limit warning below still prints, and
       * it names the route pattern rather than the url, so an operator can still see the endpoint
       * being abused without the tokens coming with it. Traffic in the ordinary case is visible on
       * the Worker's side, which is where the join page is served from anyway.
       */
      logLevel: 'warn',
    },
    async (request, reply) => {
      /*
       * Spent BEFORE the lookup, which is the opposite of the mail webhook and right for the
       * opposite reason. That route can prove who its caller is and so charges only a caller who
       * has proved it; this one never can, so the bucket has to bound the work rather than reward
       * it. A malformed token is charged too, because a caller sending junk is exactly the caller
       * this ceiling is for.
       */
      const key = invitePreviewLimitKey(request.ip);
      if (!(await deps.limiter.tryConsume(key, INVITE_PREVIEW_BUCKET))) {
        // The route PATTERN, never `request.url`, for the same reason as `logLevel` above.
        request.log.warn({ route: INVITE_PREVIEW_PATH }, 'rate limited');
        return refuseTooMany(reply, INVITE_PREVIEW_BUCKET);
      }

      const preview = await readInvitePreview(deps.db, request.params.token);

      /*
       * `no-store` on BOTH answers, and the same body shape as the redeem route's refusal.
       *
       * The header is on the 404 as well as the 200 so that the header itself is not the thing
       * that tells a live token from a dead one - and on the 200 because a token in a shared cache
       * key is a bearer credential handed to whoever can read that cache. The member count would
       * also go stale, but that is the smaller of the two reasons.
       */
      if (preview === null) {
        return reply.code(404).header('cache-control', 'no-store').send({ error: 'invite_invalid' });
      }

      return reply.code(200).header('cache-control', 'no-store').send(preview);
    },
  );
}
