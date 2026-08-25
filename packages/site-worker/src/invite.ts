/**
 * Reading an invite token off the path, and asking the api what it is worth.
 *
 * The api's endpoint is `GET /invites/:token/preview`. It is public: no session, no cookie, no
 * header. It answers 200 with `{ club: { name, memberCount }, expiresAt }` for a live token and 404
 * for one that is unknown, expired or revoked, and it says nothing else about the club and nothing
 * at all about its members. That contract is fixed elsewhere; this file consumes it and treats
 * every field of the 200 as hostile, because `club.name` is a string a member typed.
 *
 * ## Three outcomes, not two
 *
 * `live`, `invalid`, and `unreachable`, and the third one is the whole reason this file exists.
 * A join page that turned an api timeout into a 500, or into the "this link is not valid any more"
 * page, would be actively wrong: the link is probably fine, the person holding it is standing next
 * to a QR code on a table, and telling them their invite is dead is worse than telling them
 * nothing. So a timeout, a connection failure, a 500 from the api and a 200 whose body does not
 * parse all collapse into `unreachable`, which renders a page that still carries both ways into
 * the app and says plainly that the club could not be named.
 */

import { apiOrigin, type Env } from './env.ts';

/**
 * The token charset, matched exactly and case-sensitively.
 *
 * `mintInviteToken` in `packages/server/src/domain/create-club.ts` is 32 bytes of CSPRNG as
 * base64url, so 43 characters of `[A-Za-z0-9_-]`. ADR-0010 records that it must not be shortened
 * and must not be made case-insensitive.
 *
 * **Matched here rather than passed through**, for two reasons that both matter. It keeps anything
 * that is not a token out of the URL this Worker builds against the api - the token is the only
 * caller-controlled part of that URL, and a `/` or a `?` in it would be a request for a different
 * endpoint. And it keeps a token out of an `href` without having been checked, which is what makes
 * the `clubchat://join/<token>` link on the page inert by construction rather than by escaping.
 *
 * The bound is 16 to 128 rather than exactly 43: a token format that changes length is a change to
 * one constant in the server, and a bound wide enough to survive it but narrow enough to reject a
 * pasted paragraph is the useful shape. The same regex shape is in `apps/mobile/src/invite-link.ts`.
 */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The api's own limit on a club name, from `packages/server/src/api/routes/clubs.ts`:
 * `name: z.string().min(1).max(120)`.
 *
 * Re-applied here because this Worker is downstream of a system it does not control and a page
 * that renders whatever length of string arrives is a page that can be made enormous by a name.
 * A name longer than the api itself accepts is truncated rather than refused: the invite is real
 * and the visitor should still be able to join.
 */
const MAX_CLUB_NAME = 120;

/**
 * How long the join page will wait for the api before giving up and rendering degraded.
 *
 * Two and a half seconds. The number is a judgement, and the judgement is that a person who has
 * just scanned a QR code will wait about that long before deciding the link is broken, and that a
 * page which arrives without the club's name beats a spinner that never resolves. The api answers
 * this endpoint from one indexed row.
 */
const PREVIEW_TIMEOUT_MS = 2_500;

export type InvitePreview =
  | { readonly state: 'live'; readonly clubName: string; readonly memberCount: number | null }
  | { readonly state: 'invalid' }
  | { readonly state: 'unreachable' };

/**
 * The token in `/join/:token`, or null.
 *
 * Null for every other shape, including `/join`, `/join/`, `/join/a/b` and a token with a character
 * outside the charset. The caller turns null into the same page an expired token gets, because from
 * the visitor's side those are the same event: the link they were given does not work.
 */
export function inviteTokenFromPath(pathname: string): string | null {
  const match = /^\/join\/([^/]+)$/.exec(pathname);
  const token = match?.[1];
  if (token === undefined) return null;
  return INVITE_TOKEN.test(token) ? token : null;
}

/** A club name that is really a string, trimmed, bounded, or null. */
function readClubName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_CLUB_NAME);
}

/**
 * A member count that is really a count, or null.
 *
 * `null` rather than a fallback of zero, because the page omits the line entirely when the count is
 * missing. Printing "0 members" for a club the api did not report a count for would be a false
 * statement on a page whose whole job is to be trustworthy about what is on the other side of it.
 */
function readMemberCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/**
 * Ask the api about a token.
 *
 * `fetch` is read off the global at call time rather than captured at module load, which is what
 * lets a test replace it with `vi.stubGlobal`. That is not a seam invented for testing - it is the
 * ordinary way to call `fetch` - but it is load-bearing here, because `fetchMock` was removed from
 * `cloudflare:test` in pool 0.22 and a global stub is the mechanism that replaced it.
 */
export async function readInvitePreview(env: Env, token: string): Promise<InvitePreview> {
  const origin = apiOrigin(env);
  // An unset API_ORIGIN is a misconfiguration, not a dead invite. `GET /__parity` prints the value
  // it is actually holding, which is the one request that separates the two.
  if (origin === null) return { state: 'unreachable' };

  let response: Response;
  try {
    response = await fetch(`${origin}/invites/${token}/preview`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
    });
  } catch {
    // A timeout is an `AbortError`, a refused connection is a `TypeError`, and a DNS failure is
    // something else again. All three mean the same thing to the visitor, and catching the class
    // rather than enumerating them is what stops a fourth kind becoming an unreported 500.
    return { state: 'unreachable' };
  }

  // 404 is the api saying it looked and there is nothing there: unknown, expired or revoked, told
  // apart from each other deliberately nowhere. Any OTHER non-200 is the api having a problem,
  // which is not evidence about the invite.
  if (response.status === 404) return { state: 'invalid' };
  if (!response.ok) return { state: 'unreachable' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { state: 'unreachable' };
  }

  const club = (body as { club?: unknown } | null)?.club;
  const clubName = readClubName((club as { name?: unknown } | null | undefined)?.name);
  // A 200 with no usable name is the api answering a shape this page does not understand, which is
  // a deploy skew rather than a dead invite. Degraded, so the two buttons still work.
  if (clubName === null) return { state: 'unreachable' };

  return {
    state: 'live',
    clubName,
    memberCount: readMemberCount((club as { memberCount?: unknown }).memberCount),
  };
}
