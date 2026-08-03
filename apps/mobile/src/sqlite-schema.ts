/**
 * The local cache's schema and its migrations, as data.
 *
 * Split out from `sqlite-store.ts` for one reason: **that module imports `expo-sqlite`, which
 * only loads on a device, so nothing in it could ever be tested by the suite.** The schema is
 * the part most worth testing and the part least in need of a device - `ALTER TABLE ... ADD
 * COLUMN` and `PRAGMA table_info` are core SQLite, identical under Node's built-in engine.
 *
 * So this file holds the SQL and knows nothing about how it is executed, and `sqlite-schema.test.ts`
 * runs these exact statements against a real database built to look like an older release's.
 *
 * The rule that makes the split hold: **no import here may reach a native module.** Add one and
 * the test stops being runnable, silently, in the same commit that makes it matter most.
 */

/**
 * A value bound to one of the two NOT NULL json columns, `reactions` and `mentions`.
 *
 * > **`JSON.stringify(undefined)` returns `undefined`, not a string.** So a field missing from an
 * > arriving envelope binds SQL NULL, the insert dies on `NOT NULL constraint failed:
 * > messages.mentions`, and the message is never cached - which shows up as a message that simply
 * > does not appear, plus an unhandled promise rejection with no obvious connection to it.
 * >
 * > Hit on 2026-08-01 by a **card**: those are published by the worker, and the worker process
 * > had been running since before `mentions` was added to the envelope, so its `msg.new` frames
 * > carried no such field. Every other message was fine, because everything else is published by
 * > the gateway. A card that arrived later through `/sync` was fine too, so it looked like a
 * > realtime bug rather than a missing field.
 *
 * An empty list is the right default rather than a guess: `MessageEnvelope` declares exactly that
 * with `.default([])`, so this makes the cache agree with the contract for a producer that
 * predates the field. It is deliberately NOT extended to the identity columns - a payload with no
 * `id` or `sender_id` is broken rather than old, and inventing values for those would turn a loud
 * failure into a corrupt row.
 */
export function jsonListColumn(value: unknown): string {
  return JSON.stringify(value ?? []) ?? '[]';
}

export const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS messages (
  channel_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  id             TEXT NOT NULL,
  sender_id      TEXT NOT NULL,
  sender_name    TEXT,
  sender_image   TEXT,
  type           TEXT NOT NULL,
  body           TEXT,
  client_msg_id  TEXT NOT NULL,
  pinned         INTEGER NOT NULL DEFAULT 0,
  pinned_at      TEXT,
  reactions      TEXT NOT NULL DEFAULT '[]',
  mentions       TEXT NOT NULL DEFAULT '[]',
  media_id       TEXT,
  document_name  TEXT,
  document_size  INTEGER,
  linked_poll_id TEXT,
  linked_event_id TEXT,
  linked_meeting_id TEXT,
  reply_to_seq   INTEGER,
  reply_to       TEXT,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (channel_id, seq)
);
/*
 * How far reconciliation has got, per channel.
 *
 * Its own table rather than a column, because it is a fact about the CHANNEL and not about any
 * message - and because the value cannot be derived from the rows. A revision is deliberately not
 * on the envelope, so the server reports the high-water mark in the sync response and this is
 * where it is kept between runs.
 *
 * A NEW table needs no entry in MIGRATIONS: that list exists for columns added to a table which
 * already exists, where CREATE TABLE IF NOT EXISTS is a no-op. This statement runs on every open,
 * so an existing device gains the table the first time it starts this build - with no rows, which
 * reads as mark zero and costs one full reconciliation.
 */
CREATE TABLE IF NOT EXISTS sync_state (
  channel_id TEXT PRIMARY KEY,
  rev        INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Bring an already-created local database up to the current shape.
 *
 * > **`CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists**, so a device
 * > that has run any earlier build has the old columns and would fail every insert the moment
 * > a new one is referenced. The server has numbered migrations for exactly this; the client
 * > needs the same discipline in miniature.
 *
 * Additive and idempotent: each step is safe to re-run, and a failure on one column does not
 * abort the rest. The cache is disposable - worst case it is rebuilt by a sync - but a store
 * that throws on every write is not a degraded cache, it is a broken app.
 *
 * **Order matters only within a step.** Steps are selected by which column is absent, not by a
 * stored version number, so a database in any prior state converges - including one a failed
 * earlier run left half done.
 */
export const MIGRATIONS: ReadonlyArray<{ column: string; statements: readonly string[] }> = [
  { column: 'reactions', statements: [`ALTER TABLE messages ADD COLUMN reactions TEXT NOT NULL DEFAULT '[]'`] },
  { column: 'media_id', statements: [`ALTER TABLE messages ADD COLUMN media_id TEXT`] },
  { column: 'document_name', statements: [`ALTER TABLE messages ADD COLUMN document_name TEXT`] },
  { column: 'document_size', statements: [`ALTER TABLE messages ADD COLUMN document_size INTEGER`] },
  /*
   * No `DELETE FROM messages` here, unlike `sender_name` below.
   *
   * A null `linked_poll_id` on a cached row is not wrong, it is just incomplete: the card still
   * renders its sentence, and the row gains its link the next time a sync overwrites it. The
   * name column had to wipe because an unattributed bubble is a visible defect on every message;
   * this affects only card messages, and degrades to exactly what shipped before.
   */
  { column: 'linked_poll_id', statements: [`ALTER TABLE messages ADD COLUMN linked_poll_id TEXT`] },
  { column: 'linked_event_id', statements: [`ALTER TABLE messages ADD COLUMN linked_event_id TEXT`] },
  { column: 'linked_meeting_id', statements: [`ALTER TABLE messages ADD COLUMN linked_meeting_id TEXT`] },
  {
    column: 'sender_name',
    statements: [
      `ALTER TABLE messages ADD COLUMN sender_name TEXT`,
      /*
       * And discard what is cached, which is the only way those rows ever get a name.
       *
       * `syncChannel` pulls strictly ABOVE the local max seq, so a message already held is never
       * fetched again - an added column stays null on every existing row for as long as the row
       * survives. Emptying the table drops the local max to zero, which turns the next sync into
       * a full backfill that writes the name in.
       *
       * Safe because this cache is disposable and the server holds the only durable copy. It
       * costs one refetch, once, on the build that adds the column. The pending send outbox is
       * NOT touched: it lives in memory, not here, so nothing unsent is at risk.
       */
      `DELETE FROM messages`,
    ],
  },
  /*
   * No wipe, unlike `sender_name` above - this one follows the `linked_poll_id` reasoning.
   *
   * A null `sender_image` on a cached row degrades to the letter placeholder, which is exactly
   * what every bubble drew before this column existed and is a correct rendering for anybody
   * with no picture set. That is incomplete, not wrong, and the row gains the id the next time
   * a sync overwrites it. Emptying the table to fill it in would cost every user a full
   * backfill to replace a placeholder that already looks right.
   */
  { column: 'sender_image', statements: [`ALTER TABLE messages ADD COLUMN sender_image TEXT`] },
  /*
   * No wipe, following `sender_image` rather than `sender_name`.
   *
   * An empty mention list on a cached row renders the body as plain text, which is exactly what
   * shipped before mentions existed and is correct for the great majority of messages, which name
   * nobody. The row gains its mentions the next time a sync overwrites it.
   */
  {
    column: 'mentions',
    statements: [`ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'`],
  },
  /* No wipe: a null pin time simply sorts last in the strip until the next sync fills it in. */
  { column: 'pinned_at', statements: [`ALTER TABLE messages ADD COLUMN pinned_at TEXT`] },
  /*
   * The quote a reply carries, and the seq it points at, as two columns rather than one.
   *
   * `reply_to` is the whole `MessageReplyRef` as JSON, following `mentions` - this is a
   * disposable cache whose only reader draws the whole message at once, and the server owns the
   * normalised copy. `reply_to_seq` is that JSON's `seq` lifted out into a real column, because
   * one write needs to find rows BY it: deleting a message has to strike it out of every quote
   * of it, and `WHERE json_extract(...)` for that would be both slower and a second place where
   * the shape of the JSON is spelled out.
   *
   * No wipe, following `mentions`. A row cached before these existed draws no quote box, which
   * is exactly what shipped before replies did, and it gains one when a sync overwrites it.
   *
   * Two steps rather than one with two statements, each keyed on the column it adds. A single
   * step keyed on `reply_to` that added both would be un-re-runnable after a half-applied run:
   * the step would still be selected, and its first statement would fail on a column that is
   * already there. Selection by absent column only converges if each step adds exactly one.
   */
  { column: 'reply_to_seq', statements: [`ALTER TABLE messages ADD COLUMN reply_to_seq INTEGER`] },
  { column: 'reply_to', statements: [`ALTER TABLE messages ADD COLUMN reply_to TEXT`] },
];

/**
 * The migration steps a database in this state still needs, in order.
 *
 * Pure, and separated from running them so the decision can be tested without a driver: hand it
 * the columns a table has, get back what is missing. `migrate` in `sqlite-store.ts` is then only
 * the two I/O calls around this.
 */
export function pendingMigrations(
  heldColumns: Iterable<string>,
): ReadonlyArray<{ column: string; statements: readonly string[] }> {
  const held = new Set(heldColumns);
  return MIGRATIONS.filter((migration) => !held.has(migration.column));
}
