/**
 * Turning a scanned QR code into an invite token.
 *
 * A pure function, in its own module rather than inside the scanner screen, for failure mode 34's
 * reason: the screen needs a camera to mount, so a parser living in it could only be exercised by
 * pointing a phone at something. This is the half that can be wrong in interesting ways, and it is
 * the half a test can reach.
 *
 * **A QR code is arbitrary text from a stranger.** Almost everything anybody points this at will
 * be a wifi password, a menu, a parcel label or a payment link, so the job here is mostly refusal:
 * recognise our own join links and return null for the entire rest of the world.
 */

/**
 * The invite token in a scanned string, or `null` if it is not one of our join links.
 *
 * > **Matched on the PATH, never on the scheme.** The link is built by
 * > `Linking.createURL('/join/<token>')`, and what that produces differs by platform and by build:
 * > `clubchat://join/x` from the installed app, `exp://192.168.1.176:8081/--/join/x` from a dev
 * > build, and an `https://` form once the web join page exists (ADR-0010's recorded gap). The
 * > path is the only part that is ours in every one of those spellings, which is why anchoring on
 * > the scheme would have worked on the founder's phone and failed in development - the direction
 * > that wastes an afternoon.
 *
 * The token charset is the one `mintInviteToken` produces: 32 bytes of CSPRNG as base64url, so
 * `A-Za-z0-9_-` and nothing else. Anchoring the end means a link with something appended is
 * refused rather than silently yielding a token with the extra glued on.
 */
export function tokenFromScan(raw: string): string | null {
  const match = /\/(?:--\/)?join\/([A-Za-z0-9_-]+)\/?$/.exec(raw.trim());
  return match?.[1] ?? null;
}
