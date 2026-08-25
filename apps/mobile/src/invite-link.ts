/**
 * The invite link, in both directions: the string the app hands out, and the token it reads back.
 *
 * Both live here rather than on the screens that use them, for failure mode 34's reason: the
 * scanner screen needs a camera to mount and the share screen needs a loaded club, so a parser or
 * a builder living in either could only be exercised by pointing a phone at something. These are
 * the halves that can be wrong in interesting ways, and they are the halves a test can reach.
 *
 * **A QR code is arbitrary text from a stranger.** Almost everything anybody points the scanner at
 * will be a wifi password, a menu, a parcel label or a payment link, so the reading job is mostly
 * refusal: recognise our own join links and return null for the entire rest of the world.
 */

/**
 * Where an invite link points.
 *
 * **The apex site, not the app's own scheme, and that is the whole point of the change.** Until
 * 2026-08-25 the link was `Linking.createURL('/join/<token>')`, which is `clubchat://join/<token>`
 * in a store build. That string is nothing whatsoever to a phone that does not have ClubChat
 * installed: no page, no prompt, no error, not even a failed navigation - which is precisely the
 * person an invite is for. It was recorded as the cost of link-only invites in ADR-0010 and became
 * much worse when the club QR code shipped, because a code taped to a table is scanned by somebody
 * who has never heard of the app.
 *
 * One https string now does both jobs. `packages/site-worker` serves `/join/:token` with the
 * club's name and a store link, and the app claims that exact path as a universal link, so the
 * same link opens the app for somebody who has it and a page for somebody who does not. The two
 * halves of that claim are `apps/mobile/app.json` and the association files the Worker serves; see
 * ADR-0045 and `src/app-config.test.ts`, which pins them to this constant.
 *
 * > **This is not `config.ts`.** The api and websocket origins there are per-build, because a
 * > development build talks to a laptop. This one is not: the association files are served from
 * > one domain and signed for one bundle id, so a build pointed at a different apex would claim a
 * > domain that has never heard of it. There is nothing to configure.
 */
export const INVITE_LINK_ORIGIN = 'https://clubchatapp.com';

/**
 * The link to hand somebody, for a club's invite token.
 *
 * The token is interpolated raw and deliberately not encoded: `mintInviteToken` produces 32 bytes
 * of CSPRNG as base64url, so it is `A-Za-z0-9_-` and every one of those characters is already
 * path-safe. Encoding it would be a no-op that looked like a guarantee, and the guarantee that
 * matters is `tokenFromScan` refusing anything outside that charset on the way back in.
 */
export function inviteLink(token: string): string {
  return `${INVITE_LINK_ORIGIN}/join/${token}`;
}

/**
 * The invite token in a scanned string, or `null` if it is not one of our join links.
 *
 * > **Matched on the PATH, never on the scheme.** A join link has four spellings in the wild:
 * > `https://clubchatapp.com/join/x` from `inviteLink` above, `clubchat://join/x` from every link
 * > shared or printed before 2026-08-25, and `exp://192.168.1.176:8081/--/join/x` from a
 * > development build. The path is the only part that is ours in every one of them, which is why
 * > anchoring on the scheme would have worked on the founder's phone and failed in development -
 * > the direction that wastes an afternoon.
 *
 * The token charset is the one `mintInviteToken` produces: 32 bytes of CSPRNG as base64url, so
 * `A-Za-z0-9_-` and nothing else. Anchoring the end means a link with something appended is
 * refused rather than silently yielding a token with the extra glued on.
 */
export function tokenFromScan(raw: string): string | null {
  const match = /\/(?:--\/)?join\/([A-Za-z0-9_-]+)\/?$/.exec(raw.trim());
  return match?.[1] ?? null;
}
