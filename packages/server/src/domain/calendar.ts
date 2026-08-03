/**
 * The merged calendar feed.
 *
 * Two views over ONE merged read: a month grid for "what is happening when", and a list for
 * "what is coming up". There is deliberately no separate calendar table that everything
 * writes into - a second copy would drift, whereas a merged read cannot go stale.
 *
 * Four rules are enforced here rather than in the client, because each is a correctness
 * property rather than a display choice:
 *
 *  1. **Every read respects the viewer's own access.** An Eboard meeting appears only for
 *     Eboard members; a race poll only for race members.
 *  2. **Every race is visible to every club member**, whether or not they have race access -
 *     members need to know a race exists in order to ask to join it.
 *  3. **Polls are excluded from the month grid** but included in the list. A poll has a
 *     closing deadline, not a day it happens on.
 *  4. **A poll is "upcoming" while it is still open**, never by comparing its date. An
 *     open-ended poll must never fall into Past.
 *
 * This is also the least scalable read in the product: one read per feature per club the
 * viewer belongs to. It is expressed as a single query per call for that reason.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import type { AccessContext } from '../policy/context.ts';

export type FeedItemKind = 'event' | 'race' | 'meeting' | 'poll';

export type FeedItem = {
  kind: FeedItemKind;
  id: string;
  clubId: string;
  /** Tagged with its club, which the merged cross-club view renders. */
  clubName: string;
  title: string;
  /**
   * When it happens. For a poll this is its deadline, which is why polls are off the grid.
   *
   * **Two shapes, told apart by `allDay`**: an ISO instant for something that happens at a time,
   * and a date-only `YYYY-MM-DD` for something that happens on a day. They are NOT interchangeable
   * and flattening one into the other is a dated bug - see `allDay`.
   */
  at: string | null;
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
  /** Only meaningful for a poll. */
  open?: boolean;
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

  // One query, four sources. Note each branch's access predicate is in SQL rather than
  // applied afterwards in JS: filtering after the fact would mean loading rows the viewer
  // may not read, and one forgotten filter downstream would leak them.
  const rows = await db.execute<{
    kind: string;
    id: string;
    club_id: string;
    club_name: string;
    title: string;
    at: string | null;
    all_day: boolean;
    open: boolean | null;
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
           e.title, e.starts_at::text AS at, false AS all_day, NULL::boolean AS open,
           true AS accessible
      FROM calendar_events e
      JOIN clubs cl ON cl.id = e.club_id
     WHERE e.club_id IN (SELECT club_id FROM my_clubs)
       AND (${clubFilter}::uuid IS NULL OR e.club_id = ${clubFilter}::uuid)

    UNION ALL

    -- Races. Visible to EVERY club member, accessible only with a roster row. Hiding races
    -- the viewer cannot enter was rejected: they need to know one exists to ask to join.
    -- race_date is a DATE, so this is the one branch that is a day rather than a moment.
    SELECT 'race'::text, r.id::text, r.club_id::text, cl.name,
           r.name, r.race_date::text, true, NULL::boolean,
           (r.id IN (SELECT race_id FROM my_races)) AS accessible
      FROM races r
      JOIN clubs cl ON cl.id = r.club_id
     WHERE r.club_id IN (SELECT club_id FROM my_clubs)
       AND (${clubFilter}::uuid IS NULL OR r.club_id = ${clubFilter}::uuid)

    UNION ALL

    -- Eboard meetings. Members of that space ONLY.
    SELECT 'meeting'::text, m.id::text, ec.club_id::text, cl.name,
           m.title, m.starts_at::text, false, NULL::boolean, true
      FROM meetings m
      JOIN eboard_channels ec ON ec.id = m.eboard_id
      JOIN clubs cl ON cl.id = ec.club_id
     WHERE m.eboard_id IN (SELECT eboard_id FROM my_eboards)
       AND (${clubFilter}::uuid IS NULL OR ec.club_id = ${clubFilter}::uuid)

    UNION ALL

    -- Polls, scoped three ways. A race poll reaches roster members only - never roster
    -- union club admins, which would notify people about a poll they cannot open.
    SELECT 'poll'::text, p.id::text, p.club_id::text, cl.name,
           p.question, p.closes_at::text, false,
           NOT (p.closed_at IS NOT NULL OR (p.closes_at IS NOT NULL AND p.closes_at < now())) AS open,
           true
      FROM polls p
      JOIN clubs cl ON cl.id = p.club_id
     WHERE (${clubFilter}::uuid IS NULL OR p.club_id = ${clubFilter}::uuid)
       AND (
             (p.scope = 'club'   AND p.club_id  IN (SELECT club_id  FROM my_clubs))
          OR (p.scope = 'eboard' AND p.scope_id IN (SELECT eboard_id FROM my_eboards))
          OR (p.scope = 'race'   AND p.scope_id IN (SELECT race_id  FROM my_races))
           )
  `);

  const now = Date.now();

  return rows.rows.map((row) => {
    const kind = row.kind as FeedItemKind;
    // An all-day value is passed through as the date it already is. Normalising it the way an
    // instant is normalised is what produced the UTC-midnight race - see `FeedItem.allDay`.
    const at =
      row.at === null ? null : row.all_day ? row.at.slice(0, 10) : new Date(row.at).toISOString();

    // A poll is upcoming while it is OPEN, never by comparing its date. Comparing dates
    // would drop an open-ended poll into Past, where nobody would ever vote in it.
    const upcoming =
      kind === 'poll' ? row.open === true : at !== null && new Date(at).getTime() >= now;

    return {
      kind,
      id: row.id,
      clubId: row.club_id,
      clubName: row.club_name,
      title: row.title,
      at,
      allDay: row.all_day,
      upcoming,
      ...(kind === 'poll' ? { open: row.open === true } : {}),
      accessible: row.accessible,
    };
  });
}

/**
 * The days of a month that carry something.
 *
 * **Polls are excluded** - a poll has a deadline, not a day it happens on, and putting them
 * on the grid cluttered it. **Filler days from adjacent months are never marked**, so a
 * marker always belongs to the month on screen; that is the caller's rendering concern, but
 * this returns only dates inside the requested month so a filler day cannot be marked by
 * accident.
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
    if (item.kind === 'poll') continue;
    if (!item.at) continue;
    const day = item.at.slice(0, 10);
    // Inside the requested month only.
    if (day.startsWith(prefix)) days.add(day);
  }
  return [...days].sort();
}
