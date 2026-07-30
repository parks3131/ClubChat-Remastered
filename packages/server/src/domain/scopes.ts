/**
 * Which club owns this thing?
 *
 * > **Exists so that no route ever accepts a `clubId` alongside a scope id.**
 * >
 * > Several Phase 2 handlers take both, and none of them can tell whether the two arguments
 * > describe the same thing. `canCreatePoll` for a race asks for a roster row on the race
 * > **and** club-admin on the club, so a caller sending both could pair a race they are merely
 * > on the roster of with a club they happen to administer and satisfy a check that was meant
 * > to be one question. `createMeeting` and `deleteMeeting` take a `clubId` used only to route
 * > their effects, where a wrong one sends a notification and a chat card into the wrong club.
 *
 * The pairing is a fact about the data, so the database answers it. Every function here
 * returns null for a scope that does not exist, which callers turn into the same "nothing
 * back" as a scope the caller may not reach - the two must be indistinguishable.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';

async function clubIdBy(db: Db, query: ReturnType<typeof sql>): Promise<string | null> {
  const rows = await db.execute<{ club_id: string }>(query);
  return rows.rows[0]?.club_id ?? null;
}

/** The club a race belongs to. */
export const clubIdOfRace = (db: Db, raceId: string): Promise<string | null> =>
  clubIdBy(db, sql`SELECT club_id::text AS club_id FROM races WHERE id = ${raceId}`);

/** The club an Eboard space belongs to. Every club has exactly one space. */
export const clubIdOfEboard = (db: Db, eboardId: string): Promise<string | null> =>
  clubIdBy(db, sql`SELECT club_id::text AS club_id FROM eboard_channels WHERE id = ${eboardId}`);

/**
 * The club, if it exists at all.
 *
 * Returns the id rather than a boolean so it composes with the two above - a caller resolving
 * "the club that owns this scope" gets the same shape whichever scope it is holding.
 */
export const clubIdOfClub = (db: Db, clubId: string): Promise<string | null> =>
  clubIdBy(db, sql`SELECT id::text AS club_id FROM clubs WHERE id = ${clubId}`);
