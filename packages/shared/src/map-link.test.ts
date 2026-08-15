/**
 * Reading a point out of a pasted map link.
 *
 * These exist because the failure is silent. A link parsed wrongly does not throw and does not
 * render an error - it renders a convincing map of the wrong place, and the only person who finds
 * out is the member who drove there. So the cases below are the real strings the two share sheets
 * actually produce, and the refusals matter as much as the successes.
 */

import { describe, expect, it } from 'vitest';
import { isMapLink, isShortMapLink, parseMapLink } from './map-link.ts';

describe('a link that carries its point', () => {
  it('reads the camera position out of a Google place URL', () => {
    // What the address bar holds after searching a place on desktop Google Maps.
    expect(
      parseMapLink(
        'https://www.google.com/maps/place/Binghamton+University/@42.0887,-75.9698,17z/data=!3m1',
      ),
    ).toEqual({ lat: 42.0887, lng: -75.9698 });
  });

  it('prefers the coordinate in the path over a place name in the query', () => {
    /*
     * The ordering rule, and the reason it is a rule. A Google URL often carries both: `@lat,lng`
     * is where the camera is, and `?q=` is a name. Reading the query first finds "Nature+Preserve"
     * and gives up, so the map would be blank for exactly the links that carry a point.
     */
    expect(
      parseMapLink('https://www.google.com/maps/place/Nature+Preserve/@42.1,-75.9,15z?q=Nature+Preserve'),
    ).toEqual({ lat: 42.1, lng: -75.9 });
  });

  it('reads Apple Maps, which puts it in a query parameter', () => {
    expect(parseMapLink('https://maps.apple.com/?ll=42.0887,-75.9698&q=Track')).toEqual({
      lat: 42.0887,
      lng: -75.9698,
    });
  });

  it('reads the plain query forms both apps still emit', () => {
    expect(parseMapLink('https://maps.google.com/?q=42.0887,-75.9698')).toEqual({
      lat: 42.0887,
      lng: -75.9698,
    });
    expect(
      parseMapLink('https://www.google.com/maps/search/?api=1&query=42.0887,-75.9698'),
    ).toEqual({ lat: 42.0887, lng: -75.9698 });
  });

  it('reads a bare pair somebody copied from somewhere else', () => {
    expect(parseMapLink('42.0887, -75.9698')).toEqual({ lat: 42.0887, lng: -75.9698 });
  });

  it('keeps the sign, which is the difference between two hemispheres', () => {
    expect(parseMapLink('https://maps.apple.com/?ll=-33.8688,151.2093')).toEqual({
      lat: -33.8688,
      lng: 151.2093,
    });
  });
});

describe('a link that carries no point', () => {
  it('gives up on a short link rather than inventing one', () => {
    // The Google Maps APP shares this, so it is the common case rather than an edge one. There is
    // genuinely nothing in it - only a redirect knows where it goes.
    expect(parseMapLink('https://maps.app.goo.gl/aB3xY7kQm2')).toBeNull();
    expect(isShortMapLink('https://maps.app.goo.gl/aB3xY7kQm2')).toBe(true);
  });

  it('gives up on a place named without coordinates', () => {
    expect(parseMapLink('https://www.google.com/maps/place/Nature+Preserve+Entrance')).toBeNull();
  });

  it('refuses text that is not a link at all', () => {
    for (const junk of ['', '   ', 'Bimini', 'the wooden archway entrance', 'not a url']) {
      expect([junk, parseMapLink(junk)]).toEqual([junk, null]);
    }
  });
});

describe('a point that is not on the earth', () => {
  /*
   * The shapes above are deliberately loose - loose enough to match a zoom level or an id if a URL
   * is unusual - so something has to be the backstop. A refused parse means "no map", which the
   * screen already draws. An accepted wrong point means a confident map of the wrong place, which
   * nothing anywhere would report.
   */
  it('refuses an out-of-range pair', () => {
    expect(parseMapLink('https://maps.apple.com/?ll=200,-999')).toBeNull();
    expect(parseMapLink('https://maps.apple.com/?ll=91,0')).toBeNull();
    expect(parseMapLink('https://maps.apple.com/?ll=0,181')).toBeNull();
  });

  it('refuses null island, which is a failed substitution far more often than a destination', () => {
    expect(parseMapLink('https://maps.apple.com/?ll=0,0')).toBeNull();
  });

  it('accepts the edges of the range, which are real places', () => {
    expect(parseMapLink('https://maps.apple.com/?ll=90,180')).toEqual({ lat: 90, lng: 180 });
    expect(parseMapLink('https://maps.apple.com/?ll=-90,-180')).toEqual({ lat: -90, lng: -180 });
  });
});

describe('which hosts are a map at all', () => {
  /*
   * This list is also the server's outbound allowlist: it decides what the server is willing to
   * send a request to when it follows a short link. So a link to anywhere else has to be false
   * here, or a pasted URL becomes a way to make the server call an arbitrary address.
   */
  it('accepts the hosts the two apps actually share from', () => {
    for (const url of [
      'https://maps.app.goo.gl/aB3xY',
      'https://goo.gl/maps/aB3xY',
      'https://maps.google.com/?q=1,1',
      'https://www.google.com/maps/@42,-75,15z',
      'https://maps.apple.com/?ll=42,-75',
    ]) {
      expect([url, isMapLink(url)]).toEqual([url, true]);
    }
  });

  it('refuses everything else, including a lookalike host', () => {
    for (const url of [
      'https://maps.google.com.evil.test/?q=1,1',
      'https://evil.test/maps.apple.com',
      'http://localhost:3000/admin',
      'https://169.254.169.254/latest/meta-data',
      'not a url',
    ]) {
      expect([url, isMapLink(url)]).toEqual([url, false]);
    }
  });

  it('knows which of them still needs following', () => {
    expect(isShortMapLink('https://maps.app.goo.gl/aB3xY')).toBe(true);
    expect(isShortMapLink('https://goo.gl/maps/aB3xY')).toBe(true);
    // A long link already says where it is, so following it would be a round trip for nothing.
    expect(isShortMapLink('https://www.google.com/maps/@42,-75,15z')).toBe(false);
    expect(isShortMapLink('https://maps.apple.com/?ll=42,-75')).toBe(false);
  });
});
