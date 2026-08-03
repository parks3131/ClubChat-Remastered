/**
 * The calendar's two list rules, both of which were invisible inside the screen.
 *
 * The one that shipped broken is the default: the grid marked today and then showed nothing under
 * it, so the screen looked like it had lost the events it was drawing a marker for. The assertions
 * that matter are the ones about *not* applying the default - reopening a day the reader has
 * closed is the failure mode a naive fix produces.
 */

import { describe, expect, it } from 'vitest';
import { bucketByDay, dayInView } from './calendar-days.ts';
import { toDateKey } from './dates.ts';
import type { FeedItem } from './api-types.ts';

/** An instant, given as a LOCAL wall-clock time - the way a reader would have entered it. */
const at = (year: number, month: number, day: number, hour: number, minute = 0): string =>
  new Date(year, month - 1, day, hour, minute).toISOString();

const item = (
  kind: FeedItem['kind'],
  id: string,
  when: string | null,
  allDay = false,
): FeedItem => ({
  kind,
  id,
  clubId: 'club-1',
  clubName: 'Track Club',
  title: id,
  at: when,
  allDay,
  upcoming: true,
  accessible: true,
});

describe('bucketing a feed into days', () => {
  it('groups a day’s items together and keeps the order they arrived in', () => {
    const byDay = bucketByDay([
      item('event', 'morning', at(2026, 8, 8, 8, 30)),
      item('race', 'invitational', '2026-09-23', true),
      item('event', 'afternoon', at(2026, 8, 8, 15)),
    ]);

    expect([...byDay.keys()]).toEqual(['2026-08-08', '2026-09-23']);
    expect(byDay.get('2026-08-08')?.map((each) => each.id)).toEqual(['morning', 'afternoon']);
  });

  it('files a late-evening event on the day it is actually on', () => {
    // The bug this module was rewritten for. West of Greenwich a 9pm event has TOMORROW's UTC
    // date, so keying on the raw string put it on the next square while the grid's cells stayed
    // local. Asserted through toDateKey so it holds in whatever zone the suite runs in.
    const byDay = bucketByDay([item('event', 'social', at(2026, 8, 3, 21))]);

    expect([...byDay.keys()]).toEqual([toDateKey(new Date(2026, 7, 3))]);
    expect(byDay.has('2026-08-03')).toBe(true);
  });

  it('never parses an all-day date, which would move it a day earlier', () => {
    // `new Date('2026-09-23')` is UTC midnight, so a reader in the Americas would see the 22nd.
    const byDay = bucketByDay([item('race', 'invitational', '2026-09-23', true)]);

    expect([...byDay.keys()]).toEqual(['2026-09-23']);
  });

  it('keeps polls and undated items off the grid', () => {
    const byDay = bucketByDay([
      item('poll', 'closes-today', at(2026, 8, 3, 12)),
      item('event', 'undated', null),
      item('event', 'real', at(2026, 8, 3, 12)),
    ]);

    expect(byDay.get('2026-08-03')?.map((each) => each.id)).toEqual(['real']);
  });
});

describe('which day the calendar opens on', () => {
  const today = '2026-08-03';
  const carrying = new Map([[today, [item('event', 'today', at(2026, 8, 3, 12))]]]);

  it('opens today when today carries something, with no tap', () => {
    expect(dayInView(null, carrying, today)).toBe(today);
  });

  it('opens nothing when today is empty, so no undismissable heading appears', () => {
    expect(dayInView(null, new Map(), today)).toBe(null);
    expect(dayInView(null, new Map([['2026-08-14', []]]), today)).toBe(null);
  });

  it('is null before the feed lands, then today once it has', () => {
    // The same choice, either side of the load. A default computed once on mount would be stuck
    // on the first answer, which is the empty one.
    expect(dayInView(null, new Map(), today)).toBe(null);
    expect(dayInView(null, carrying, today)).toBe(today);
  });

  it('lets a tapped day win over today', () => {
    expect(dayInView({ day: '2026-08-14' }, carrying, today)).toBe('2026-08-14');
  });

  it('leaves today closed once the reader has closed it', () => {
    // The regression a "select today whenever nothing is selected" fix reintroduces: today would
    // reopen on the very next render and the day could never be collapsed.
    expect(dayInView({ day: null }, carrying, today)).toBe(null);
  });
});
