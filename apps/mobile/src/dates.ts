/**
 * Date formatting and date math, in one place.
 *
 * Every screen was formatting timestamps inline with `iso.slice(0, 16).replace('T', ' ')`, which
 * is the same duplication the policy module exists to prevent one layer down: eight copies, each
 * individually plausible, and the ninth is where the bug goes. It also renders UTC to a reader in
 * a local timezone, which is wrong everywhere west of Greenwich.
 *
 * **The rule that governs this whole module** is AGENTS.md's failure mode: *a date-only value
 * parsed as an ISO string is UTC midnight, and renders a day early in a negative-offset timezone.*
 * A race's `raceDate` and a meetup's `meetupDate` are date-only; a message's `createdAt` and an
 * event's `startsAt` are instants. The two are formatted by different functions on purpose, and
 * the date-only ones build a `Date` from split components rather than parsing.
 */

/** A local `YYYY-MM-DD` key. Local, not UTC: "today" is a question about where the reader is. */
export function toDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A `Date` at local midnight on a date-only `YYYY-MM-DD`.
 *
 * The whole reason this exists rather than `new Date(str)`: that parses as UTC midnight, which is
 * the previous day for every reader in the Americas. Built from components, it cannot be.
 */
export function fromDateKey(key: string): Date {
  const [year, month, day] = key.slice(0, 10).split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/**
 * Step a month, from the first of it.
 *
 * The day is set to 1 before stepping, so January 31 plus one month is February rather than
 * March 3 - which is what `setMonth` alone does, because "February 31" normalises forward. Month
 * navigation only ever cares which month is on screen, so pinning the day loses nothing.
 */
export function addMonths(date: Date, delta: number): Date {
  const next = new Date(date);
  next.setDate(1);
  next.setMonth(next.getMonth() + delta);
  return next;
}

/** "March 2027", for a month grid's header. */
export function formatMonthTitle(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

/** "Tuesday, March 2", for the header over one day's items. Takes a date-only key. */
export function formatDayTitle(dateKey: string): string {
  return fromDateKey(dateKey).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/** "Tue, Mar 2, 5:00 PM" for an instant. */
export function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * "Tuesday, 15 September 2026" - the same date-only value, spelled out in full.
 *
 * For a screen where the date IS the subject rather than a detail beside a title: a race profile
 * has one date on it and room to say it properly, where a list row does not. Goes through
 * `fromDateKey` like every other reader here, so it can never become a UTC instant.
 */
export function formatDateLong(dateKey: string): string {
  return fromDateKey(dateKey).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** "Tue, Mar 2" for a date-only value. Never parses the string as an instant. */
/**
 * "6:30 PM" from a wall-clock `HH:MM`.
 *
 * Deliberately not `formatClock`, which takes an instant. A meetup's time is the club's own
 * wall-clock and has no timezone to convert from - Tuesday 6pm is Tuesday 6pm for everybody on
 * the roster. The throwaway Date exists only to reach the locale's 12-or-24-hour preference;
 * its day is never read and must never be.
 */
export function formatWallClock(hhmm: string): string {
  const [hour, minute] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, hour ?? 0, minute ?? 0).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDateOnly(dateKey: string): string {
  return fromDateKey(dateKey).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * The label on a chat's day separator: "Today", "Yesterday", or the date.
 *
 * **Compared as local date KEYS, never as instants.** "Was this today?" is a question about the
 * reader's calendar, and subtracting milliseconds answers a different one - two timestamps 20
 * hours apart can be either the same day or two days apart depending on where the boundary falls.
 * Keys make that impossible to get wrong: same string, same day, in the reader's own timezone.
 *
 * The year appears only when it is not this one. A chat is read in the present, so "Mar 2" means
 * this March until it does not, and spelling out a year on every older message is noise.
 *
 * `now` is a parameter so the boundary can be tested rather than waited for.
 */
export function formatDaySeparator(dateKey: string, now: Date = new Date()): string {
  const today = toDateKey(now);
  if (dateKey === today) return 'Today';

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dateKey === toDateKey(yesterday)) return 'Yesterday';

  const date = fromDateKey(dateKey);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/**
 * The timestamp on a conversation row: a time today, a weekday this week, a date before that.
 *
 * The shape every chat list uses, and the reason it is here rather than in the screen is
 * AGENTS.md pitfall 34 - **list arithmetic belongs outside the component**. Both bugs in chat's
 * marker placement shipped because the logic lived in a memo inside a 3,400 line screen, where
 * the only way to exercise it was to open a chat on a phone and look at it.
 *
 * Like `formatDaySeparator`, the day comparisons go through local date KEYS rather than
 * subtracting milliseconds. "Was this today?" is a question about the reader's calendar, and two
 * timestamps twenty hours apart can be the same day or two days apart depending on where the
 * boundary falls.
 *
 * The week window is six days back, not seven: at exactly seven days the weekday name would be
 * today's, so "Sat" would mean either yesterday-week or a moment ago. A date is unambiguous.
 *
 * `now` is a parameter so every boundary can be tested rather than waited for.
 */
export function formatConversationTimestamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const key = toDateKey(date);
  if (key === toDateKey(now)) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === toDateKey(yesterday)) return 'Yesterday';

  const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  if (date >= weekAgo) return date.toLocaleDateString(undefined, { weekday: 'short' });

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    // The year only when it is not this one, the same rule the day separator uses. A chat list
    // is read in the present, so "Jul 17" means this July until it does not.
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** "5:00 PM". The time of day alone, for an item already filed under its date. */
export function formatTimeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "17:04", for a chat or highlight row where the date is carried by its grouping. */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The day-and-month pair a calendar "bib" chip shows.
 *
 * Split rather than formatted into one string because the two render at different sizes, and
 * building it here keeps the date-only parsing rule in one place.
 *
 * **`allDay` is required, and it is the entire correctness of this function.** The two inputs need
 * opposite handling and look identical at the call site:
 *
 * - A **date-only** `YYYY-MM-DD` is a day, and `new Date()` would read it as UTC midnight - which
 *   is the day before, anywhere west of Greenwich. It is built from split components instead.
 * - An **instant** already carries a zone, so its day is whatever the reader's clock says. Slicing
 *   the first ten characters off it takes the UTC day, which is the *next* one for anything after
 *   early evening in a negative offset.
 *
 * > It shipped as the second of those. `EventRow` passed `FeedItem.at` - a field whose own
 * > docstring says never to parse it without checking the flag beside it - straight in, so a 9pm
 * > event was chipped with tomorrow's date on the calendar feed. The parameter is required rather
 * > than defaulted so that a caller has to say which of the two it holds.
 */
export function bibParts(iso: string, allDay: boolean): { day: number; month: string } {
  const date = allDay ? fromDateKey(iso.slice(0, 10)) : new Date(iso);
  return {
    day: date.getDate(),
    month: date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(),
  };
}

/** Coarse relative time, backwards. For a notification or a join request. */
export function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Coarse relative time, forwards. For a poll's deadline badge.
 *
 * **Display only.** Whether a poll is actually closed is the server's answer, evaluated per read -
 * this string must never be what a screen decides voting on. See `PollView.closed`.
 */
export function formatCountdown(iso: string): string {
  const remaining = new Date(iso).getTime() - Date.now();
  if (remaining <= 0) return 'ENDED';
  const hours = Math.floor(remaining / 3_600_000);
  if (hours < 1) return 'ENDING SOON';
  if (hours < 24) return `${hours} HOUR${hours === 1 ? '' : 'S'} LEFT`;
  const days = Math.floor(hours / 24);
  return `${days} DAY${days === 1 ? '' : 'S'} LEFT`;
}

/**
 * "20 August 2004", for a date of birth.
 *
 * Built from split components like every other date-only value here: parsing it would land on UTC
 * midnight and show the day before for anybody west of Greenwich - which on a birthday is the kind
 * of wrong that gets noticed.
 */
export function formatDateOfBirth(dateKey: string | null | undefined): string {
  if (dateKey === null || dateKey === undefined || dateKey.length === 0) return 'Not set';
  return fromDateKey(dateKey).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * `M`, `T`, `W`, `Th`, `F`, `S`, `Su` - the day badge on the weekly meetups screen.
 *
 * **Hand-written rather than sliced off a locale name**, and the reason is Tuesday and Thursday.
 * A single initial gives `T` for both and `S` for both weekend days, so the week reads as
 * M T W T F S S and two pairs of days become indistinguishable at exactly the glance this badge
 * exists to serve. Two letters where one is ambiguous is the whole trick.
 *
 * The consequence of writing them out is that these are English, where the rest of this module
 * formats in the reader's locale. That is a real limitation and it is deliberate for now: the
 * product ships in one language, and a locale-derived version has to solve the collision above
 * per language rather than once.
 */
const WEEKDAY_INITIALS = ['Su', 'M', 'T', 'W', 'Th', 'F', 'S'] as const;

export function weekdayInitial(dateKey: string): string {
  return WEEKDAY_INITIALS[fromDateKey(dateKey).getDay()] ?? '';
}

/** Whether a date-only key is the reader's today. Local, like `toDateKey`. */
export function isToday(dateKey: string, now: Date = new Date()): boolean {
  return dateKey === toDateKey(now);
}

/**
 * `Aug 17 - 23`, or `Aug 31 - Sep 6` when the week crosses a month.
 *
 * Carries the dates the per-day headers used to, now that the week is seven rows marked by a
 * letter rather than seven headed sections - so "which 17th" is still answerable without giving
 * every row a number.
 */
export function formatWeekRange(mondayKey: string): string {
  const start = fromDateKey(mondayKey);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const month = (date: Date) => date.toLocaleDateString(undefined, { month: 'short' });
  return start.getMonth() === end.getMonth()
    ? `${month(start)} ${start.getDate()} - ${end.getDate()}`
    : `${month(start)} ${start.getDate()} - ${month(end)} ${end.getDate()}`;
}
