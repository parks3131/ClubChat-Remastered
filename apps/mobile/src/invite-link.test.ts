/**
 * Reading a scanned code.
 *
 * The interesting half of this function is what it REFUSES. A scanner points at the world, and
 * the world is mostly not our join links - so the tests that matter are the ones asserting that a
 * wifi code, a payment link and a plain URL all come back null rather than being handed to the
 * router as a token.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { INVITE_LINK_ORIGIN, inviteLink, tokenFromScan } from './invite-link.ts';

const TOKEN = 'aB3-_xY9zQw1234567890abcdefGHIJKL';

describe('tokenFromScan', () => {
  it('reads every spelling Linking.createURL produces', () => {
    /*
     * The three that exist today plus the one ADR-0010 still owes. Anchoring on the scheme would
     * pass the first and fail the second, which is the combination that works on the founder's
     * phone and breaks in development.
     */
    expect(tokenFromScan(`clubchat://join/${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromScan(`exp://192.168.1.176:8081/--/join/${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromScan(`https://clubchatapp.com/join/${TOKEN}`)).toBe(TOKEN);
    // A trailing slash is a spelling, not a different link.
    expect(tokenFromScan(`clubchat://join/${TOKEN}/`)).toBe(TOKEN);
  });

  it('tolerates the whitespace a scanner or a copy-paste adds', () => {
    expect(tokenFromScan(`  clubchat://join/${TOKEN}\n`)).toBe(TOKEN);
  });

  it('refuses codes that are not ours', () => {
    // What people will actually point this at.
    expect(tokenFromScan('WIFI:S=Binghamton;T=WPA;P=hunter2;;')).toBeNull();
    expect(tokenFromScan('https://example.com/menu')).toBeNull();
    expect(tokenFromScan('https://pay.example.com/r/abc123')).toBeNull();
    expect(tokenFromScan('0123456789012')).toBeNull();
    expect(tokenFromScan('')).toBeNull();
  });

  it('refuses a join link with no token, rather than returning an empty one', () => {
    // An empty token would be handed to /join/ and redeemed as the empty string, which is a
    // request the server has to refuse for us. Refusing it here means it never gets asked.
    expect(tokenFromScan('clubchat://join/')).toBeNull();
    expect(tokenFromScan('clubchat://join')).toBeNull();
  });

  it('refuses a link with something appended, rather than yielding a glued-together token', () => {
    /*
     * The anchored end earning its keep. Without it these would return a token with the extra
     * stuck on - a redeem that fails with "no longer valid", which reads to the person scanning
     * as a rotated link rather than as a code this app should not have accepted.
     */
    expect(tokenFromScan(`clubchat://join/${TOKEN}?utm=qr`)).toBeNull();
    expect(tokenFromScan(`clubchat://join/${TOKEN}/extra`)).toBeNull();
    expect(tokenFromScan(`clubchat://join/${TOKEN}#frag`)).toBeNull();
  });

  it('refuses a token carrying characters the minter never produces', () => {
    // 32 bytes of CSPRNG as base64url is A-Za-z0-9_- and nothing else, so anything with a dot or
    // a slash in it did not come from us.
    expect(tokenFromScan('clubchat://join/tok.en')).toBeNull();
    expect(tokenFromScan('clubchat://join/tok en')).toBeNull();
  });

  it('does not match a path that merely ENDS in join', () => {
    /*
     * `/join/` is required literally, so a segment that happens to finish with those letters is
     * not a join path - `how-to-join/club` offers `-join/` and is refused.
     *
     * Written expecting the opposite: the assertion originally said this returned `club`, and
     * documented it as an accepted false positive. It does not, and the test is kept in the
     * corrected form because the near-miss is worth pinning - a later "simplification" to
     * `join\/` without the leading slash would reintroduce exactly this, and nothing else here
     * would notice.
     */
    expect(tokenFromScan('https://example.com/how-to-join/club')).toBeNull();
    expect(tokenFromScan('https://example.com/rejoin/club')).toBeNull();
  });
});

/**
 * The link the app HANDS OUT, which is the other half of the same module.
 *
 * It used to be `Linking.createURL('/join/<token>')`, which resolves to `clubchat://join/<token>`
 * in a store build. That string is nothing whatsoever to a phone without ClubChat installed: no
 * page, no prompt, no error. Since 2026-08-25 the apex serves `/join/:token`, and the app claims
 * that path as a universal link, so one https string does both jobs - it opens the app for
 * somebody who has it and a page with the club's name for somebody who does not.
 */
describe('inviteLink', () => {
  it('is the https link the apex serves and the app claims', () => {
    expect(inviteLink(TOKEN)).toBe(`https://clubchatapp.com/join/${TOKEN}`);
  });

  it('is built on the origin the two association files are written for', () => {
    expect(inviteLink(TOKEN).startsWith(`${INVITE_LINK_ORIGIN}/join/`)).toBe(true);
  });

  /*
   * Producer and consumer pinned together. The scanner is the one path that never leaves the app -
   * it parses the string itself rather than asking the OS to open it - so a change to the link
   * shape that the scanner stopped recognising would break scanning silently while every tapped
   * link kept working.
   */
  it('round-trips through the scanner', () => {
    expect(tokenFromScan(inviteLink(TOKEN))).toBe(TOKEN);
  });

  it('resolves to the same token as the custom-scheme link it replaces', () => {
    // "Both forms must work": old links in messages and old printed codes still say `clubchat://`.
    expect(tokenFromScan(inviteLink(TOKEN))).toBe(tokenFromScan(`clubchat://join/${TOKEN}`));
  });
});

/*
 * `expo-router` is the app's deep link handler. There is no hand-written one, and adding one would
 * be a second handler racing the first.
 *
 * Reached through `createRequire` rather than an import, so that expo-router moving or renaming
 * this internal fails HERE, with the note below to read, rather than at the top of the file as a
 * bare resolution error in a test that looks unrelated to linking.
 */
const requireFromHere = createRequire(import.meta.url);

/**
 * The path `expo-router` would navigate to, for a URL the OS hands the app.
 *
 * > **If this throws `MODULE_NOT_FOUND`, expo-router moved the function and nothing else here can
 * > tell you whether universal links still work.** The claim being pinned is a property of the
 * > router, not of this app, so re-check it against the upgraded version and then re-point this -
 * > do not delete the test, and do not conclude the feature is fine because everything else is
 * > green. The device-level version of this check is tapping an `https://clubchatapp.com/join/...`
 * > link on a phone with the app installed.
 */
function routerPathFor(url: string): string {
  const fork = requireFromHere('expo-router/build/fork/extractPathFromURL.js') as {
    extractExpoPathFromURL: (prefixes: string[], url: string) => string;
  };
  return fork.extractExpoPathFromURL([], url);
}

/**
 * Where an incoming link actually lands.
 *
 * The app registers no linking listener of its own: `expo-router` takes the URL the OS delivers,
 * strips the origin off an `https://` one and the scheme off a custom one, and navigates to what
 * is left. That is why claiming `https://clubchatapp.com/join/*` in `app.json` was the whole of
 * the client work - there was no handler to extend, only a path to claim. These assertions are the
 * evidence for that sentence.
 */
describe('what expo-router does with an incoming link', () => {
  it('lands the https link and the custom-scheme link on the same route', () => {
    expect(routerPathFor(inviteLink(TOKEN))).toBe(`join/${TOKEN}`);
    expect(routerPathFor(`clubchat://join/${TOKEN}`)).toBe(`join/${TOKEN}`);
    expect(routerPathFor(inviteLink(TOKEN))).toBe(routerPathFor(`clubchat://join/${TOKEN}`));
  });

  it('keeps a query string, so a tagged poster link still reaches the same screen', () => {
    // `join/[token]` reads only `token`, so anything appended is carried and ignored rather than
    // turning the link into a route the app does not have.
    expect(routerPathFor(`${inviteLink(TOKEN)}?src=poster`)).toBe(`join/${TOKEN}?src=poster`);
  });
});
