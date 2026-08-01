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
  reactions      TEXT NOT NULL DEFAULT '[]',
  media_id       TEXT,
  document_name  TEXT,
  document_size  INTEGER,
  linked_poll_id TEXT,
  linked_event_id TEXT,
  linked_meeting_id TEXT,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (channel_id, seq)
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
