/**
 * Reading a scanned code.
 *
 * The interesting half of this function is what it REFUSES. A scanner points at the world, and
 * the world is mostly not our join links - so the tests that matter are the ones asserting that a
 * wifi code, a payment link and a plain URL all come back null rather than being handed to the
 * router as a token.
 */

import { describe, expect, it } from 'vitest';
import { tokenFromScan } from './invite-link.ts';

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
