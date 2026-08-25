/**
 * What a stranger holding an invite link may be told about the club on the other end of it.
 *
 * Every other read in this directory takes an `AccessContext` and answers a member. This one
 * deliberately takes neither a context nor a user id, because the caller has no account: the
 * person standing in front of a QR code taped to a table has never heard of ClubChat, and the web
 * join page greeting them has no session to borrow (ADR-0045, ADR-0046).
 *
 * **The token is what authorizes the read, and it authorizes strictly more than this.** Anybody
 * holding it can redeem it and be inside the club a second later, roster and chat history
 * included, so naming the club to that same holder discloses less than they already have. That is
 * the whole safety argument, and it is why this function is a public read rather than a hole in
 * the one in `membership.ts`.
 *
 * Two properties follow, and both are enforced here rather than left to the route:
 *
 *  1. **The projection is the contract, in SQL.** The statement selects the name and a count and
 *     nothing else, so the row that comes back does not carry the club id, the description, the
 *     join policy or either token. A handler that spread this row would still disclose nothing,
 *     which is the difference between a rule and a rule somebody has to remember.
 *  2. **There is one refusal.** Unknown, revoked, deleted and malformed all return `null` from
 *     this one function, so the route has a single branch and cannot grow a second answer that
 *     tells them apart. Distinguishing them would confirm to a stranger that a club with that
 *     token once existed, which is a fact about somebody else's club that they did not hold.
 *
 * A revoked token is not merely refused, it is unrecoverable: rotation OVERWRITES both columns
 * in place (`rotateInviteToken`), so there is no row anywhere recording that the old string was
 * ever a token. The indistinguishability above is therefore a property of the data and not only
 * of this code.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';

/**
 * Everything the join page is given, and the whole of it.
 *
 * `expiresAt` is in the shape and is always `null`, because a ClubChat invite token does not
 * expire: it is a bearer string that stays valid until an admin rotates it (ADR-0010, ADR-0025,
 * and `clubs` in `db/schema.ts`, which has no expiry column). It is answered rather than omitted
 * so the page reads one shape whatever happens, and it is typed as `null` rather than as
 * `string | null` so that adding an expiry later is a change this type forces somebody to make
 * deliberately instead of a field that quietly starts carrying a date.
 */
export type InvitePreview = {
  club: { name: string; memberCount: number };
  expiresAt: null;
};

/**
 * The token charset and bounds, matched exactly and case-sensitively.
 *
 * `mintInviteToken` is 32 bytes of CSPRNG as base64url, so 43 characters of `[A-Za-z0-9_-]`.
 * ADR-0010 records that it must not be shortened and must not be made case-insensitive - a
 * case-insensitive match here would throw away a quarter of its entropy on the one surface in
 * this api anybody can reach without an account.
 *
 * Checked before the database is touched, which is the point: this is the only route an
 * unauthenticated caller can aim at a table, and a bound on what reaches the query is a bound on
 * what a stranger can spend. 16 to 128 rather than exactly 43, so a change to the one constant in
 * `create-club.ts` does not silently start refusing every new link, while a pasted paragraph
 * still never becomes a query parameter.
 */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The club an invite token opens, or null.
 *
 * Null for a token that is unknown, revoked, malformed, or whose club has been deleted. The
 * caller cannot tell those apart because this function does not.
 */
export async function readInvitePreview(db: Db, token: string): Promise<InvitePreview | null> {
  if (!INVITE_TOKEN.test(token)) return null;

  /*
   * One statement, one indexed probe per column, and a count only for the row that matched.
   *
   * Both token columns are `unique`, so this is two index lookups rather than a scan - which
   * matters here more than it does on an authenticated route, because the caller is anonymous and
   * the work is spent before anything is known about them.
   *
   * The timing difference that remains is the one inherent in answering at all: a token that
   * matches costs a count that a token that does not never reaches. It is not an oracle worth
   * closing, because reaching it means already holding a valid token - guessing one is guessing 32
   * bytes of CSPRNG. What must not differ, and does not, is unknown against revoked against
   * deleted: all three are the same two probes returning no row.
   */
  const rows = await db.execute<{ name: string; member_count: string }>(sql`
    SELECT c.name AS name,
           (SELECT count(*) FROM club_memberships m WHERE m.club_id = c.id) AS member_count
      FROM clubs c
     WHERE c.invite_token = ${token} OR c.member_invite_token = ${token}
     LIMIT 1
  `);

  const row = rows.rows[0];
  if (!row) return null;

  /*
   * Which of the two tokens matched is deliberately not asked and deliberately not answered.
   * It decides what redeeming the link DOES (ADR-0025), and it is not a stranger's to learn from
   * a page that has not asked them to sign in - a preview that differed would also hand anybody
   * with a member link a way to test whether a second string is the admin one.
   */
  return {
    club: {
      name: row.name,
      // `count(*)` arrives from the driver as a string, exactly as it does in `readClub`.
      memberCount: Number(row.member_count),
    },
    expiresAt: null,
  };
}
