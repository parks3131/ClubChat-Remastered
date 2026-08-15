/**
 * SQL fragments shared by the raw-`execute` reads.
 */

import { sql, type SQL } from 'drizzle-orm';

/**
 * A `timestamptz` as an ISO-8601 UTC string.
 *
 * > **`::text` is the wrong cast and looks like the right one.** It renders Postgres's own
 * > format - `2026-07-30 08:42:41.123+00`, with a space and a two-digit offset - which is not
 * > ISO 8601. `new Date()` in a browser happens to parse it, so the mistake survives a casual
 * > look at a response; `Date.parse` is not required to, and a strict validator refuses it
 * > outright. Found when a paging cursor this API emitted was rejected by the same API's own
 * > `before` parameter.
 *
 * Every other timestamp the server returns comes from `.toISOString()`, so this is what a
 * `db.execute` read has to do to match. Not a concern for a `date` column: `::text` on a DATE
 * is already `YYYY-MM-DD`, which is exactly what a date-only value should be, and turning one
 * into a timestamp is the negative-offset bug from AGENTS.md section 4.
 */
export const isoUtc = (column: SQL | string): SQL =>
  sql`to_char(${typeof column === 'string' ? sql.raw(column) : column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * A mute that is still in force. **A lapsed `muted_until` is not a mute.**
 *
 * > **Extracted on 2026-08-15, at the sixth copy.** `muted_until IS NULL OR muted_until > now()`
 * > had been hand-written in the DM thread list, the channel meta read, the push audience, the
 * > race list and the chat list, and a seventh was about to be added for the member card. Every
 * > copy was individually correct, which is precisely the shape failure mode 9 describes: nothing
 * > diverges loudly, no type error appears, and the day one of them forgets the `IS NULL` half,
 * > indefinite mutes silently stop counting in exactly one screen.
 *
 * The NULL half is the one worth naming: **NULL means muted indefinitely, not "not muted"** - the
 * row's existence is the mute, and the column is only an expiry. Written as `NOT (... <= now())`
 * would have been wrong for the same reason.
 *
 * @param alias the table alias the `muted_until` column is reached through, e.g. `mute`. Pass
 *   nothing where the query selects from `channel_mutes` unaliased.
 */
export const muteInForce = (alias?: string): SQL => {
  const column = alias === undefined ? sql.raw('muted_until') : sql.raw(`${alias}.muted_until`);
  return sql`(${column} IS NULL OR ${column} > now())`;
};
