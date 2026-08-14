/**
 * Where the tab bar appears.
 *
 * Both directions, and the second matters more: the old rule was "everywhere except chat", so a
 * test that only checks the five screens that keep it would pass against the behaviour this change
 * exists to remove. The bulk of the cases below are screens that must NOT have it.
 *
 * The forms under `/clubs/` are the sharp ones. `/clubs/add`, `/clubs/create` and `/clubs/join`
 * are the same shape as a club hub if you count segments, and a form is exactly where the bar does
 * not belong.
 */

import { describe, expect, it } from 'vitest';
import { showsTabBar } from './tab-bar-routes.ts';

const CLUB = 'a52be46b-e847-4474-8ca2-52d9d59635c1';
const RACE = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b';
const CHANNEL = 'b1498131-1310-472e-980e-763b7f437f1f';

describe('the five screens that keep the tab bar', () => {
  it.each(['/clubs', '/calendar', '/notifications', '/profile'])('shows it on %s', (path) => {
    expect(showsTabBar(path)).toBe(true);
  });

  it("shows it on a club's front door", () => {
    expect(showsTabBar(`/clubs/${CLUB}`)).toBe(true);
  });

  it('ignores a query string, which the Clubs tab adds on its own jump', () => {
    expect(showsTabBar(`/clubs/${CLUB}?from=clubsTab`)).toBe(true);
    expect(showsTabBar('/clubs?arrived=forward')).toBe(true);
  });

  it('ignores a trailing slash, which is a web spelling of the same route', () => {
    expect(showsTabBar('/clubs/')).toBe(true);
    expect(showsTabBar(`/clubs/${CLUB}/`)).toBe(true);
  });
});

describe('the screens that must not have it', () => {
  /**
   * Two segments and not a club hub. Counting segments would have let all three through, which is
   * why the id is matched by shape.
   */
  it.each(['/clubs/add', '/clubs/create', '/clubs/join'])('hides it on the form %s', (path) => {
    expect(showsTabBar(path)).toBe(false);
  });

  it.each([
    `/clubs/${CLUB}/members`,
    `/clubs/${CLUB}/weekly-meetups`,
    `/clubs/${CLUB}/polls`,
    `/clubs/${CLUB}/news`,
    `/clubs/${CLUB}/events`,
    `/clubs/${CLUB}/calendar`,
    `/clubs/${CLUB}/edit`,
    `/clubs/${CLUB}/share`,
    `/clubs/${CLUB}/qr`,
    `/clubs/${CLUB}/profile`,
    `/clubs/${CLUB}/races/create`,
  ])('hides it inside a club, on %s', (path) => {
    expect(showsTabBar(path)).toBe(false);
  });

  /** A race and the Eboard space are a level below the front door, so they follow the general rule. */
  it.each([
    `/races/${RACE}`,
    `/races/${RACE}/roster`,
    `/races/${RACE}/car-groups`,
    `/races/${RACE}/meet`,
    `/eboard/${CLUB}`,
    `/eboard/${CLUB}/meetings`,
  ])('hides it on %s', (path) => {
    expect(showsTabBar(path)).toBe(false);
  });

  it.each([
    `/chat/${CHANNEL}`,
    `/channels/${CHANNEL}/gallery`,
    `/channels/${CHANNEL}/highlights`,
    `/polls/${CLUB}`,
    `/events/${CLUB}`,
    `/meetings/${CLUB}`,
    `/news/${CLUB}`,
    `/users/${CLUB}`,
    '/moderation',
    `/moderation/${CLUB}`,
    '/dm/new',
    '/profile/edit',
    '/legal/terms',
    '/legal/privacy',
    '/sign-in',
    '/join/some-token',
  ])('hides it on %s', (path) => {
    expect(showsTabBar(path)).toBe(false);
  });

  /**
   * The safe default. A screen nobody has classified gets no bar, so it inherits no clearance
   * obligation - the opposite default would ship a sliced last row and fail nothing.
   */
  it('hides it on an unknown route', () => {
    expect(showsTabBar('/something-nobody-has-built-yet')).toBe(false);
    expect(showsTabBar('/')).toBe(false);
    expect(showsTabBar('')).toBe(false);
  });

  it('does not mistake a non-id for a club hub', () => {
    expect(showsTabBar('/clubs/not-a-uuid')).toBe(false);
    expect(showsTabBar('/clubs/undefined')).toBe(false);
  });
});
