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
 * A race's `raceDate` and a workout's `workoutDate` are date-only; a message's `createdAt` and an
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

/** "Tue, Mar 2" for a date-only value. Never parses the string as an instant. */
export function formatDateOnly(dateKey: string): string {
  return fromDateKey(dateKey).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
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
 */
export function bibParts(iso: string): { day: number; month: string } {
  const date = fromDateKey(iso.slice(0, 10));
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
