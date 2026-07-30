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
