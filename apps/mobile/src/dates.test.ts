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
import {
  bibParts,
  formatConversationTimestamp,
  formatDaySeparator,
  formatWeekRange,
  isToday,
  toDateKey,
  weekdayInitial,
} from './dates.ts';

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

/**
 * The timestamp on a conversation row.
 *
 * Same boundary rules as the separator above, different vocabulary: a chat list says a time for
 * today and a weekday for this week, because the column is narrow and the reader is scanning it
 * rather than reading it.
 */
describe('the conversation row timestamp', () => {
  // A Saturday, so the weekday assertions below name real days rather than assumed ones.
  const now = localDate(2026, 8, 1, 15);

  it('shows a clock time for today', () => {
    const earlier = localDate(2026, 8, 1, 9);
    const shown = formatConversationTimestamp(earlier.toISOString(), now);
    // Locale decides 9:00 AM versus 09:00, so assert the minutes rather than the whole string.
    expect(shown).toMatch(/9[:.]00/);
    expect(shown).not.toBe('Yesterday');
  });

  it('says Yesterday, then names the weekday for the rest of the week', () => {
    expect(formatConversationTimestamp(localDate(2026, 7, 31, 9).toISOString(), now)).toBe(
      'Yesterday',
    );
    // Four days back is Tuesday 28 July 2026.
    expect(formatConversationTimestamp(localDate(2026, 7, 28, 9).toISOString(), now)).toBe('Tue');
  });

  it('falls back to a date once the weekday would be ambiguous', () => {
    /*
     * Seven days back is another Saturday, and "Sat" would then mean either a week ago or
     * today. The window is six days for exactly that reason, so this reads as a date.
     */
    const weekAgo = formatConversationTimestamp(localDate(2026, 7, 25, 9).toISOString(), now);
    expect(weekAgo).not.toBe('Sat');
    expect(weekAgo).toContain('Jul');
  });

  it('adds the year only when it is not this one', () => {
    const thisYear = formatConversationTimestamp(localDate(2026, 3, 2, 9).toISOString(), now);
    expect(thisYear).toContain('Mar');
    expect(thisYear).not.toContain('2026');

    const lastYear = formatConversationTimestamp(localDate(2025, 3, 2, 9).toISOString(), now);
    expect(lastYear).toContain('2025');
  });

  it('renders nothing rather than "Invalid Date" for a timestamp it cannot read', () => {
    // A row whose last message somehow arrived without a usable date must not print garbage
    // across the list. Empty is honest; "Invalid Date" is a bug report shown to a member.
    expect(formatConversationTimestamp('', now)).toBe('');
    expect(formatConversationTimestamp('not-a-date', now)).toBe('');
  });
});

/**
 * The chip on a calendar row and on an event's chat card.
 *
 * **Both cases are asserted with an hour that puts UTC on a different DAY**, in each direction, so
 * the pair discriminates in every zone rather than only in the tester's. The one machine these
 * cannot fail on is a machine actually running UTC, where there is no boundary to get wrong.
 */
describe('the calendar bib', () => {
  it('reads an instant in the zone the reader is in, never in UTC', () => {
    // Half past eleven at night: the UTC day is already the 13th anywhere west of Greenwich.
    expect(bibParts(new Date(2026, 7, 12, 23, 30).toISOString(), false).day).toBe(12);
    // Half past midnight: the UTC day is still the 11th anywhere east of it.
    expect(bibParts(new Date(2026, 7, 12, 0, 30).toISOString(), false).day).toBe(12);
  });

  it('reads a date-only value as a day, not as UTC midnight', () => {
    // The opposite handling, and the reason the flag is a required parameter: this string has no
    // zone to honour, so parsing it as an instant would chip the 11th west of Greenwich.
    expect(bibParts('2026-08-12', true).day).toBe(12);
  });
});

describe('the weekly meetups week', () => {
  it('gives every day a distinguishable badge', () => {
    // 2026-08-17 is a Monday. Seven consecutive days, seven distinct labels.
    const week = [
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
    ].map(weekdayInitial);

    expect(week).toEqual(['M', 'T', 'W', 'Th', 'F', 'S', 'Su']);
    /*
      The point of the two-letter forms, asserted rather than described: a single initial gives
      T for Tuesday and Thursday and S for Saturday and Sunday, and a badge that cannot tell
      Tuesday from Thursday is worse than no badge at all.
    */
    expect(new Set(week).size).toBe(7);
  });

  it('reads the weekday locally, not as UTC midnight', () => {
    // The failure this whole module is shaped around: parsed as an instant, a date-only key is
    // UTC midnight and lands on the previous day west of Greenwich - so Monday would badge as Su.
    expect(weekdayInitial('2026-08-17')).toBe('M');
    expect(weekdayInitial('2026-01-01')).toBe('Th');
  });

  it('names the week by its span, and says both months when it crosses one', () => {
    expect(formatWeekRange('2026-08-17')).toBe('Aug 17 - 23');
    // 2026-08-31 is a Monday, so this week ends in September.
    expect(formatWeekRange('2026-08-31')).toBe('Aug 31 - Sep 6');
  });

  it('knows today from a date-only key, in the reader own zone', () => {
    const now = new Date(2026, 7, 17, 9, 30);
    expect(isToday('2026-08-17', now)).toBe(true);
    expect(isToday('2026-08-18', now)).toBe(false);

    // Late evening, when the UTC date has already rolled over west of Greenwich.
    expect(isToday('2026-08-17', new Date(2026, 7, 17, 23, 45))).toBe(true);
  });
});
