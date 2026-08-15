/**
 * The merged calendar feed.
 *
 * Two views over ONE merged read: a month grid for "what is happening when", and a list for
 * "what is coming up". There is deliberately no separate calendar table that everything
 * writes into - a second copy would drift, whereas a merged read cannot go stale.
 *
 * Three rules are enforced here rather than in the client, because each is a correctness
 * property rather than a display choice:
 *
 *  1. **Every read respects the viewer's own access.** An Eboard meeting appears only for
 *     Eboard members.
 *  2. **Every race is visible to every club member**, whether or not they have race access -
 *     members need to know a race exists in order to ask to join it.
 *  3. **Only a race that HAS a date is a calendar item.** The nullable `race_date` is what
 *     separates a dated race from an ordinary side group, and this query's predicate is the
 *     only thing enforcing it.
 *
 * > **Polls left this feed on 2026-08-15, at the founder's request.** They had never been on
 * > the grid - a poll has a closing deadline rather than a day it happens on - so they lived
 * > only in the Upcoming/Past list, and paid for the difference at every stop: a nullable
 * > `at`, an `open` flag nothing else needed, an "upcoming" rule that read open/closed instead
 * > of comparing a date, no date chip on the row, and a skip in both the markers query and the
 * > client's day bucketing. This feed answers "what is happening when", and a deadline is not
 * > a thing that happens. Removing the branch removed all six exceptions with it, and made a
 * > null `at` unrepresentable. Polls are reached from their own screen in each scope. See
 * > `PRD/07`.
 *
 * This is also the least scalable read in the product: one read per feature per club the
 * viewer belongs to. It is expressed as a single query per call for that reason.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import type { AccessContext } from '../policy/context.ts';

export type FeedItemKind = 'event' | 'race' | 'meeting';

export type FeedItem = {
  kind: FeedItemKind;
  id: string;
  clubId: string;
  /** Tagged with its club, which the merged cross-club view renders. */
  clubName: string;
  title: string;
  /**
   * When it happens.
   *
   * **Never null.** Every source on this feed is dated: `calendar_events.starts_at` and
   * `meetings.starts_at` are both NOT NULL, and the race branch selects only rows whose
   * `race_date` is set. That was not true while polls were here, and the nullability cost
   * every consumer a branch it no longer needs.
   *
   * **Two shapes, told apart by `allDay`**: an ISO instant for something that happens at a time,
   * and a date-only `YYYY-MM-DD` for something that happens on a day. They are NOT interchangeable
   * and flattening one into the other is a dated bug - see `allDay`.
   */
  at: string;
  /**
   * True when `at` is a day rather than a moment, which today means a race.
   *
   * > **A race has a date; it does not have a time.** This field used to not exist, and every
   * > race's `race_date` was pushed through `new Date(...).toISOString()` to match the others -
   * > turning "2027-01-01" into "2027-01-01T00:00:00.000Z", an instant at UTC midnight. That is
   * > the failure this codebase's date rule is about, and it cost the client twice: the calendar
   * > printed a time of day under every race ("7:00 PM", being UTC midnight read in New York),
   * > and the day a race belonged to could not be computed in the reader's own timezone without
   * > moving the race a day earlier.
   *
   * With the two kept apart, the reader's local day is the right question for an instant and the
   * wrong one for a date - which is exactly what the client now asks.
   */
  allDay: boolean;
  /** Whether this belongs in Upcoming or Past. */
  upcoming: boolean;
  /** True when the viewer can enter it. A race they cannot enter still appears. */
  accessible: boolean;
};

/**
 * Read the feed.
 *
 * Omit `clubId` for the merged cross-club view, which tags each row with its club and offers
 * no create action. Passing a club scopes it to that club.
 */
export async function readCalendarFeed(
  db: Db,
  ctx: AccessContext,
  opts: { clubId?: string | undefined } = {},
): Promise<FeedItem[]> {
  const clubFilter = opts.clubId ?? null;

  // One query, three sources. Note each branch's access predicate is in SQL rather than
  // applied afterwards in JS: filtering after the fact would mean loading rows the viewer
  // may not read, and one forgotten filter downstream would leak them.
  const rows = await db.execute<{
    kind: string;
    id: string;
    club_id: string;
    club_name: string;
    title: string;
    at: string;
    all_day: boolean;
    accessible: boolean;
  }>(sql`
    WITH my_clubs AS (
      SELECT club_id FROM club_memberships WHERE user_id = ${ctx.userId}
    ),
    my_eboards AS (
      SELECT eboard_id FROM eboard_memberships WHERE user_id = ${ctx.userId}
    ),
    my_races AS (
      SELECT race_id FROM race_memberships WHERE user_id = ${ctx.userId}
    )

    -- Club events. Every club member.
    -- all_day is carried per branch rather than inferred from the kind downstream, so a future
    -- date-only source has to answer the question rather than silently defaulting to an instant.
    SELECT 'event'::text AS kind, e.id::text, e.club_id::text, cl.name AS club_name,
           e.title, e.starts_at::text AS at, false AS all_day, true AS accessible
      FROM calendar_events e
      JOIN clubs cl ON cl.id = e.club_id
     WHERE e.club_id IN (SELECT club_id FROM my_clubs)
       AND (${clubFilter}::uuid IS NULL OR e.club_id = ${clubFilter}::uuid)

    UNION ALL

    -- Races. Visible to EVERY club member, accessible only with a roster row. Hiding races
    -- the viewer cannot enter was rejected: they need to know one exists to ask to join.
    -- race_date is a DATE, so this is the one branch that is a day rather than a moment.
    --
    -- **Only the races that HAVE a date.** The column went nullable on 2026-08-12 because the
    -- same object serves an actual race and an ordinary side group, and a group has no day.
    -- The null is what keeps it off the calendar, and this predicate is the only thing
    -- enforcing that - without it an undated race lands on the feed with a NULL "at" column,
    -- which every consumer would then have to defend against. It is also, since polls left on
    -- 2026-08-15, the only thing keeping FeedItem.at non-null.
    -- (No backticks in this comment: one of those ends the surrounding template literal.)
    SELECT 'race'::text, r.id::text, r.club_id::text, cl.name,
           r.name, r.race_date::text, true,
           (r.id IN (SELECT race_id FROM my_races)) AS accessible
      FROM races r
      JOIN clubs cl ON cl.id = r.club_id
     WHERE r.club_id IN (SELECT club_id FROM my_clubs)
       AND r.race_date IS NOT NULL
       AND (${clubFilter}::uuid IS NULL OR r.club_id = ${clubFilter}::uuid)

    UNION ALL

    -- Eboard meetings. Members of that space ONLY.
    SELECT 'meeting'::text, m.id::text, ec.club_id::text, cl.name,
           m.title, m.starts_at::text, false, true
      FROM meetings m
      JOIN eboard_channels ec ON ec.id = m.eboard_id
      JOIN clubs cl ON cl.id = ec.club_id
     WHERE m.eboard_id IN (SELECT eboard_id FROM my_eboards)
       AND (${clubFilter}::uuid IS NULL OR ec.club_id = ${clubFilter}::uuid)
  `);

  const now = Date.now();

  return rows.rows.map((row) => {
    // An all-day value is passed through as the date it already is. Normalising it the way an
    // instant is normalised is what produced the UTC-midnight race - see `FeedItem.allDay`.
    const at = row.all_day ? row.at.slice(0, 10) : new Date(row.at).toISOString();

    return {
      kind: row.kind as FeedItemKind,
      id: row.id,
      clubId: row.club_id,
      clubName: row.club_name,
      title: row.title,
      at,
      allDay: row.all_day,
      upcoming: new Date(at).getTime() >= now,
      accessible: row.accessible,
    };
  });
}

/**
 * The days of a month that carry something.
 *
 * **Filler days from adjacent months are never marked**, so a marker always belongs to the
 * month on screen; that is the caller's rendering concern, but this returns only dates inside
 * the requested month so a filler day cannot be marked by accident.
 *
 * Every row on the feed is now a day this can mark. It used to skip polls, which is the one
 * thing it did beyond the month filter - see `readCalendarFeed` on why they are gone.
 */
export async function readMonthMarkers(
  db: Db,
  ctx: AccessContext,
  opts: { clubId?: string | undefined; year: number; month: number },
): Promise<string[]> {
  const feed = await readCalendarFeed(db, ctx, { clubId: opts.clubId });
  const prefix = `${opts.year}-${String(opts.month).padStart(2, '0')}`;

  const days = new Set<string>();
  for (const item of feed) {
    const day = item.at.slice(0, 10);
    // Inside the requested month only.
    if (day.startsWith(prefix)) days.add(day);
  }
  return [...days].sort();
}
