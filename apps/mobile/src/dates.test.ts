/**
 * The day boundary, which is the one piece of date handling a chat gets wrong quietly.
 *
 * This module's own thesis is that a date-only value parsed as an ISO string is UTC midnight and
 * renders a day early west of Greenwich. A chat's day separator is where that bites hardest: it
 * compares two timestamps and decides whether a heading goes between them, so being wrong by one
 * boundary means a "Today" over yesterday's messages, every day, for half the world.
 *
 * `formatDaySeparator` takes `now` as a parameter precisely so the boundary can be asserted
 * rather than waited for.
 */

import { describe, expect, it } from 'vitest';
import { formatDaySeparator, toDateKey } from './dates.ts';

/** A local date, built from components - never parsed, for the reason at the top of `dates.ts`. */
const localDate = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour);

describe('the chat day separator', () => {
  const now = localDate(2026, 8, 1, 23);

  it('says Today and Yesterday rather than a date', () => {
    expect(formatDaySeparator(toDateKey(now), now)).toBe('Today');
    expect(formatDaySeparator(toDateKey(localDate(2026, 7, 31)), now)).toBe('Yesterday');
  });

  it('crosses the boundary at local midnight, not at UTC midnight', () => {
    /*
     * 23:00 local on the 1st. A message sent one hour later is tomorrow to the reader, and the
     * two are inside the same UTC day for a positive offset and different ones for a negative -
     * which is exactly why this compares keys instead of subtracting milliseconds.
     */
    const justBeforeMidnight = localDate(2026, 8, 1, 23);
    const justAfterMidnight = localDate(2026, 8, 2, 0);
    expect(toDateKey(justBeforeMidnight)).not.toBe(toDateKey(justAfterMidnight));
    expect(formatDaySeparator(toDateKey(justBeforeMidnight), justBeforeMidnight)).toBe('Today');
    expect(formatDaySeparator(toDateKey(justBeforeMidnight), justAfterMidnight)).toBe('Yesterday');
  });

  it('names the day for anything older, and the year only when it is a different one', () => {
    const thisYear = formatDaySeparator(toDateKey(localDate(2026, 3, 2)), now);
    expect(thisYear).toContain('Mar');
    expect(thisYear).not.toContain('2026');

    // A conversation is read in the present, so "Mar 2" means this March until it does not.
    const lastYear = formatDaySeparator(toDateKey(localDate(2025, 3, 2)), now);
    expect(lastYear).toContain('2025');
  });

  it('is not fooled by a 20-hour gap that stays inside one day', () => {
    // Two timestamps 20 hours apart on the SAME local date. Subtracting milliseconds and
    // dividing by a day would call this a day apart; the calendar does not.
    const morning = localDate(2026, 8, 1, 2);
    const night = localDate(2026, 8, 1, 22);
    expect(toDateKey(morning)).toBe(toDateKey(night));
    expect(formatDaySeparator(toDateKey(morning), night)).toBe('Today');
  });
});
