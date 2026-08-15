/**
 * Following a short map link, and the fences around doing so.
 *
 * The parsing is tested in `@clubchat/shared`. What is tested here is the part that touches the
 * network: that a shortener is followed to the point it hides, and that following one cannot be
 * turned into a way to make this server fetch an arbitrary address.
 *
 * `fetch` is injected rather than mocked globally - the function takes it as a parameter for
 * exactly this reason, so the test is about the walk rather than about a stub.
 */

import { describe, expect, it } from 'vitest';
import { resolveMapPoint } from './maps.ts';

/** A fetch that redirects along a script, then stops. */
function redirector(chain: Record<string, string>): typeof fetch {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const next = chain[url];
    return {
      url,
      headers: new Headers(next === undefined ? {} : { location: next }),
    } as Response;
  }) as unknown as typeof fetch;
  (impl as unknown as { calls: string[] }).calls = calls;
  return impl;
}

const callsOf = (impl: typeof fetch): string[] => (impl as unknown as { calls: string[] }).calls;

describe('a link that already says where it is', () => {
  it('never touches the network', async () => {
    const impl = redirector({});
    expect(await resolveMapPoint('https://maps.apple.com/?ll=42.0887,-75.9698', impl)).toEqual({
      lat: 42.0887,
      lng: -75.9698,
    });
    expect(callsOf(impl)).toEqual([]);
  });

  it('does not fetch a long Google link that simply has no point in it', async () => {
    // Fetching would be a round trip that cannot produce an answer: the page it returns is the
    // same page, and the URL is the one already read.
    const impl = redirector({});
    expect(await resolveMapPoint('https://www.google.com/maps/place/Nature+Preserve', impl)).toBeNull();
    expect(callsOf(impl)).toEqual([]);
  });
});

describe('a short link, which is what the Google Maps app actually shares', () => {
  it('follows it to the point it hides', async () => {
    const impl = redirector({
      'https://maps.app.goo.gl/aB3xY': 'https://www.google.com/maps/place/Track/@42.0887,-75.9698,17z',
    });

    expect(await resolveMapPoint('https://maps.app.goo.gl/aB3xY', impl)).toEqual({
      lat: 42.0887,
      lng: -75.9698,
    });
  });

  it('follows a chain of them', async () => {
    const impl = redirector({
      'https://maps.app.goo.gl/aB3xY': 'https://goo.gl/maps/second',
      'https://goo.gl/maps/second': 'https://maps.google.com/?q=42.1,-75.9',
    });

    expect(await resolveMapPoint('https://maps.app.goo.gl/aB3xY', impl)).toEqual({
      lat: 42.1,
      lng: -75.9,
    });
  });

  it('gives up on a loop rather than hanging', async () => {
    const impl = redirector({
      'https://maps.app.goo.gl/a': 'https://maps.app.goo.gl/b',
      'https://maps.app.goo.gl/b': 'https://maps.app.goo.gl/a',
    });

    expect(await resolveMapPoint('https://maps.app.goo.gl/a', impl)).toBeNull();
    // Bounded, and the bound is the hop limit rather than the loop noticing itself.
    expect(callsOf(impl).length).toBeLessThanOrEqual(5);
  });

  it('saves without a map when the network refuses', async () => {
    const failing = (async () => {
      throw new Error('ETIMEDOUT');
    }) as unknown as typeof fetch;

    // Not a throw. A meetup with an unresolvable link is a meetup without a map picture, and the
    // link is still stored and still opens in Maps.
    expect(await resolveMapPoint('https://maps.app.goo.gl/aB3xY', failing)).toBeNull();
  });
});

describe('the allowlist, which is why this is safe to point at a URL somebody typed', () => {
  it('never fetches a host that is not a map', async () => {
    const impl = redirector({});
    for (const url of [
      'http://localhost:3000/admin',
      'https://169.254.169.254/latest/meta-data/iam/security-credentials',
      'https://maps.google.com.evil.test/?q=1,1',
      'file:///etc/passwd',
    ]) {
      expect([url, await resolveMapPoint(url, impl)]).toEqual([url, null]);
    }
    expect(callsOf(impl), 'the server was talked into fetching something').toEqual([]);
  });

  /*
   * The one that matters, and the reason `redirect: 'manual'` is used rather than `follow`.
   *
   * A shortener's entire purpose is to point somewhere else, so checking only the URL that was
   * pasted checks the one hop that was never in doubt. With automatic following, this link would
   * have the server issue a GET to the metadata address and hand back whatever came out.
   */
  it('stops when a redirect leaves the allowlist', async () => {
    const impl = redirector({
      'https://maps.app.goo.gl/aB3xY': 'https://169.254.169.254/latest/meta-data',
    });

    expect(await resolveMapPoint('https://maps.app.goo.gl/aB3xY', impl)).toBeNull();
    // It followed the first, and refused to fetch the second.
    expect(callsOf(impl)).toEqual(['https://maps.app.goo.gl/aB3xY']);
  });
});
