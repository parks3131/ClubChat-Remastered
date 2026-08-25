/**
 * Refusing a pasted link that is not a map.
 *
 * These exist because what they guard is a button every member taps. A stored `map_url` becomes
 * the Directions button on a meetup, so a link that gets through this check is a link the whole
 * club will be sent to. The refusals are the point; the acceptances only prove the gate is not so
 * tight that a real share sheet cannot get through it.
 *
 * The parsing tests that used to sit here went with ADR-0049, which removed the stored
 * coordinates. Nothing reads a point out of a link any more.
 */

import { describe, expect, it } from 'vitest';
import { isMapLink } from './map-link.ts';

describe('which hosts are a map at all', () => {
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

  /*
   * The lookalike is the case worth keeping forever. `maps.google.com.evil.test` reads as Google
   * to a person and to any pattern loose enough to be convenient, and it is not Google. An exact
   * hostname match is what refuses it.
   */
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

  it('reads the host rather than the rest of the string', () => {
    // Surrounding whitespace is what a paste actually carries, and a path that mentions a map host
    // is not a map host.
    expect(isMapLink('  https://maps.apple.com/?ll=42,-75  ')).toBe(true);
    expect(isMapLink('https://evil.test/https://maps.apple.com/')).toBe(false);
  });
});
