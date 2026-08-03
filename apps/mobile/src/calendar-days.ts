/**
 * What sits under each day of the calendar grid, and which day is open.
 *
 * Extracted from the screen for the reason `chat-rows.ts` was: it is arithmetic over a list, and
 * inside a component the only way to exercise it is to open the app and look at it. That is how
 * the bug this module was written for survived.
 *
 * ---
 *
 * **Arriving at the calendar opens today, without a tap.**
 *
 * > The grid drew today's ring and today's filled marker, announcing "there is something here",
 * > and then showed nothing underneath until the day was tapped. The screen was answering a
 * > question the reader had not asked yet and staying silent on the one they had.
 *
 * The rule has to survive two things that a plain "select today on mount" does not:
 *
 *  1. **The reader can close it.** Tapping the open day collapses it, and it must stay collapsed.
 *     An effect that re-selects today whenever nothing is selected reopens it on the next render,
 *     so the day becomes untappable rather than merely open.
 *  2. **The feed arrives after the first render.** Whether today carries anything is not knowable
 *     on mount, so a default computed once at mount is computed from an empty map and is always
 *     null.
 *
 * Both are handled by deriving rather than storing: `null` means the reader has not chosen yet,
 * which is a different state from having chosen nothing, and only the first one falls back to
 * today. The default therefore re-evaluates for free when the data lands, and stops applying the
 * moment the reader expresses a preference.
 */

import type { FeedItem } from './api-types.ts';
import { toDateKey } from './dates.ts';

/**
 * What the reader has chosen.
 *
 * `null` is "has not chosen yet" and `{ day: null }` is "has chosen nothing" - deliberately not
 * the same value, because only the first defaults to today. Collapsing the open day and paging to
 * another month both produce the second.
 */
export type DayChoice = { day: string | null } | null;

/**
 * The day a feed item belongs on, in the same terms the grid's cells are in.
 *
 * > **The grid's cells are LOCAL days and an instant's day is not.** Keyed on `at.slice(0, 10)`,
 * > every item was filed under its UTC date while every cell was labelled with a local one, so a
 * > 9pm event in New York was marked and listed on TOMORROW - correct time, wrong square. It only
 * > looked right because nothing on the calendar had yet been created after 8pm.
 *
 * An all-day value is already a local day and must NOT be parsed: `new Date('2027-01-01')` is UTC
 * midnight, which is the previous day for every reader in the Americas. That is the same rule
 * `dates.ts` opens with, and the reason the two shapes are told apart rather than normalised.
 */
export function dayKeyOf(item: FeedItem & { at: string }): string {
  return item.allDay ? item.at.slice(0, 10) : toDateKey(new Date(item.at));
}

/**
 * Group a feed into the days the grid marks.
 *
 * **Polls are excluded**, matching the server's markers query: a poll has a closing deadline
 * rather than a day it happens on. They stay in the events list, which is where `PRD/07` puts
 * them. An item with no date is excluded for the same reason.
 */
export function bucketByDay(items: readonly FeedItem[]): Map<string, FeedItem[]> {
  const byDay = new Map<string, FeedItem[]>();
  for (const item of items) {
    if (item.kind === 'poll' || item.at === null) continue;
    const day = dayKeyOf({ ...item, at: item.at });
    const bucket = byDay.get(day);
    if (bucket) bucket.push(item);
    else byDay.set(day, [item]);
  }
  return byDay;
}

/**
 * The day whose items are open, which is today until the reader says otherwise.
 *
 * Today only opens when it actually carries something, which is the same rule the grid applies to
 * the gesture: a day with nothing on it is not tappable, so it must not be openable by arriving
 * either. Without that, a calendar with nothing on today greets the reader with a heading over
 * "Nothing on this day" that no tap can dismiss.
 */
export function dayInView(
  choice: DayChoice,
  byDay: ReadonlyMap<string, unknown>,
  todayKey: string,
): string | null {
  if (choice !== null) return choice.day;
  return byDay.has(todayKey) ? todayKey : null;
}
