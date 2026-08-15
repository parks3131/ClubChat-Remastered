/**
 * The local cache's migrations, against a real SQLite engine.
 *
 * > **A client migration is the one piece of this codebase that runs exactly once per device and
 * > cannot be retried by hand.** It executes on the first launch after an update, against a
 * > database whose shape depends on which build that device last ran - and if it throws, every
 * > insert afterwards throws with it. That is not a degraded cache; it is chat showing nothing.
 *
 * `sqlite-store.ts` cannot be imported here - it pulls in `expo-sqlite`, which only loads on a
 * device - which is why the schema lives in a module of its own. The statements below are the
 * SAME strings that module ships, run through `node:sqlite`. It is the same engine: `ALTER TABLE
 * ... ADD COLUMN` and `PRAGMA table_info` are core SQLite, not driver behaviour.
 *
 * The important case is `an old database gains the column`, which is what upgrading actually is.
 * Building the table from `SCHEMA` and checking it already has every column would prove nothing:
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that exists, so a fresh database is the
 * one shape that never needs migrating.
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { jsonListColumn, MIGRATIONS, pendingMigrations, SCHEMA } from './sqlite-schema.ts';

/** The columns a table actually has, which is what drives the migration decision. */
function columnsOf(db: DatabaseSync, table = 'messages'): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

/** Run whatever steps this database still needs, exactly as `migrate` does. */
function migrate(db: DatabaseSync): void {
  for (const migration of pendingMigrations(columnsOf(db))) {
    for (const statement of migration.statements) db.exec(statement);
  }
}

/**
 * A database as some earlier build left it: the current schema minus everything added since.
 *
 * Derived from `MIGRATIONS` rather than pasted, so a step added later is automatically part of
 * every "older release" this file describes.
 */
function databaseAsOfBefore(column: string): DatabaseSync {
  const index = MIGRATIONS.findIndex((m) => m.column === column);
  if (index < 0) throw new Error(`no migration adds ${column}`);
  const absent = new Set(MIGRATIONS.slice(index).map((m) => m.column));

  const db = new DatabaseSync(':memory:');
  const columnLines = SCHEMA.slice(SCHEMA.indexOf('('), SCHEMA.lastIndexOf(')'))
    .split('\n')
    .filter((line) => {
      const name = line.trim().split(/\s+/)[0] ?? '';
      return !absent.has(name);
    });
  db.exec(`CREATE TABLE messages ${columnLines.join('\n')})`);
  return db;
}

const ROW = {
  channel_id: 'c1',
  seq: 1,
  id: 'm1',
  sender_id: 'u1',
  type: 'text',
  client_msg_id: 'cm1',
  created_at: '2026-08-01T00:00:00.000Z',
};

function insertOldRow(db: DatabaseSync): void {
  const columns = Object.keys(ROW).filter((c) => columnsOf(db).includes(c));
  db.prepare(
    `INSERT INTO messages (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((c) => (ROW as Record<string, string | number>)[c]!));
}

describe('upgrading a device that already has a cache', () => {
  it('adds sender_image to a database that predates it, and keeps what was cached', () => {
    const db = databaseAsOfBefore('sender_image');
    expect(columnsOf(db)).not.toContain('sender_image');
    insertOldRow(db);

    migrate(db);

    expect(columnsOf(db)).toContain('sender_image');
    /*
     * The rows survive, unlike the `sender_name` step which deliberately wipes. A null picture
     * draws the letter placeholder - exactly what shipped before the column existed - so making
     * every user refetch their whole history to replace a placeholder that already looks right
     * would be a cost with no visible payoff.
     */
    const rows = db.prepare('SELECT * FROM messages').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['sender_image']).toBeNull();
    expect(rows[0]!['id']).toBe('m1');
  });

  it('writes and reads the new column once migrated', () => {
    const db = databaseAsOfBefore('sender_image');
    migrate(db);

    // The real insert names sender_image; before the migration this statement is what would
    // throw, on every message, forever.
    db.prepare(
      `INSERT INTO messages (channel_id, seq, id, sender_id, sender_name, sender_image, type,
                             client_msg_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c1', 2, 'm2', 'u1', 'Sean', 'media-abc', 'text', 'cm2', ROW.created_at);

    const row = db.prepare('SELECT sender_image FROM messages WHERE seq = 2').get() as {
      sender_image: string;
    };
    expect(row.sender_image).toBe('media-abc');
  });

  it('converges a database from BEFORE the sender_name step, running both in order', () => {
    // Two releases behind, which is the case a single "is the newest column missing?" check
    // gets wrong: it would run only the last step and leave sender_name absent.
    const db = databaseAsOfBefore('sender_name');
    expect(columnsOf(db)).not.toContain('sender_name');
    expect(columnsOf(db)).not.toContain('sender_image');
    insertOldRow(db);

    migrate(db);

    const columns = columnsOf(db);
    expect(columns).toContain('sender_name');
    expect(columns).toContain('sender_image');
    // The sender_name step wipes, and it runs here - so the row is gone, on purpose. An
    // unattributed bubble is a visible defect on every message, which is worth one refetch.
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('converges the oldest database there is, in one pass', () => {
    const db = databaseAsOfBefore(MIGRATIONS[0]!.column);
    migrate(db);
    for (const migration of MIGRATIONS) expect(columnsOf(db)).toContain(migration.column);
    expect(pendingMigrations(columnsOf(db))).toHaveLength(0);
  });

  it('is a no-op on a database already at the current shape', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA.replace('PRAGMA journal_mode = WAL;', ''));
    insertOldRow(db);

    // Idempotence is not decoration: `migrate` runs on EVERY launch, not only after an update.
    // A step that re-ran would throw "duplicate column" - or, for sender_name, silently empty
    // the cache every single time the app opened.
    expect(pendingMigrations(columnsOf(db))).toHaveLength(0);
    migrate(db);
    migrate(db);
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 });
  });

  it('adds both reply columns, and keeps what was cached', () => {
    const db = databaseAsOfBefore('reply_to_seq');
    insertOldRow(db);

    migrate(db);

    // Both, and independently: they are two steps precisely so a run interrupted between them
    // resumes rather than trying to re-add the first.
    expect(columnsOf(db)).toContain('reply_to_seq');
    expect(columnsOf(db)).toContain('reply_to');
    // No wipe. A row with no quote renders exactly as it did before replies existed.
    const rows = db.prepare('SELECT * FROM messages').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['reply_to']).toBeNull();

    // The seq is a real column so a delete can find every quote of that message by index. The
    // ref itself is JSON, like reactions and mentions.
    db.prepare(
      `INSERT INTO messages (channel_id, seq, id, sender_id, type, client_msg_id, created_at,
                             reply_to_seq, reply_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c1', 2, 'm2', 'u1', 'text', 'cm2', ROW.created_at, 1, JSON.stringify({ seq: 1 }));

    const found = db
      .prepare('SELECT seq FROM messages WHERE channel_id = ? AND reply_to_seq = ?')
      .all('c1', 1) as Array<{ seq: number }>;
    expect(found).toEqual([{ seq: 2 }]);
  });

  it('resumes a half-applied run rather than starting over', () => {
    // What an interrupted upgrade leaves: some columns added, later ones not. Selection is per
    // column, so the remaining steps - and only those - run.
    const db = databaseAsOfBefore('linked_poll_id');
    db.exec('ALTER TABLE messages ADD COLUMN linked_poll_id TEXT');
    db.exec('ALTER TABLE messages ADD COLUMN linked_event_id TEXT');

    const outstanding = pendingMigrations(columnsOf(db)).map((m) => m.column);
    expect(outstanding).toEqual([
      'linked_meeting_id',
      'sender_name',
      'sender_image',
      'mentions',
      'pinned_at',
      'reply_to_seq',
      'reply_to',
      'edited_at',
    ]);

    migrate(db);
    expect(pendingMigrations(columnsOf(db))).toHaveLength(0);
  });
});

describe('a message from a producer that predates a field', () => {
  /**
   * The bug this closes, in full, because the symptom pointed nowhere near the cause.
   *
   * A poll/event/meeting card is the ONE kind of message published by the worker rather than the
   * gateway, and a worker process older than the `mentions` field sends an envelope without it.
   * `JSON.stringify(undefined)` is `undefined` rather than a string, so the bind was SQL NULL, the
   * insert died on `NOT NULL constraint failed: messages.mentions`, and the card was never cached
   * - it simply never appeared, with an unhandled promise rejection somewhere else on screen. It
   * looked like "creating a poll is broken" and it was a missing column value.
   */
  function insertEnvelope(db: DatabaseSync, values: Record<string, unknown>): void {
    const columns = Object.keys(values);
    db.prepare(
      `INSERT INTO messages (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).run(...(Object.values(values) as Array<string | number | null>));
  }

  it('stores it, defaulting the NOT NULL json columns instead of failing the insert', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA.replace('PRAGMA journal_mode = WAL;', ''));

    // Exactly what an older producer sends: no `mentions`, no `reactions`, no `replyTo`.
    const fromOldProducer = { mentions: undefined, reactions: undefined } as {
      mentions: undefined;
      reactions: undefined;
    };

    expect(() =>
      insertEnvelope(db, {
        ...ROW,
        reactions: jsonListColumn(fromOldProducer.reactions),
        mentions: jsonListColumn(fromOldProducer.mentions),
      }),
    ).not.toThrow();

    const row = db.prepare('SELECT reactions, mentions FROM messages WHERE seq = 1').get() as {
      reactions: string;
      mentions: string;
    };
    // An empty list, which is what `MessageEnvelope` itself defaults these to - so the cache
    // agrees with the contract rather than guessing.
    expect(row.mentions).toBe('[]');
    expect(row.reactions).toBe('[]');
  });

  it('is the raw stringify that fails, which is what made this worth a helper', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA.replace('PRAGMA journal_mode = WAL;', ''));

    /*
     * The old code, verbatim, and it throws. **The two drivers report it differently**, which is
     * worth knowing before reading a device log: Node's built-in SQLite refuses to bind
     * `undefined` at all ("Provided value cannot be bound to SQLite parameter 8"), while
     * expo-sqlite coerces it to NULL and lets the column object - "Error code 19: NOT NULL
     * constraint failed: messages.mentions", which is what the phone actually showed.
     *
     * Asserting only "it throws" is deliberate. Pinning the message would tie this test to one
     * driver's wording for a defect that is really "undefined reached the binder".
     */
    expect(() =>
      insertEnvelope(db, {
        ...ROW,
        mentions: JSON.stringify(undefined) as unknown as string,
      }),
    ).toThrow();
  });

  it('keeps a real list intact, so the fix is not just "always empty"', () => {
    expect(jsonListColumn([{ emoji: '🔥', userIds: ['u1'] }])).toBe(
      '[{"emoji":"🔥","userIds":["u1"]}]',
    );
    expect(jsonListColumn(null)).toBe('[]');
  });
});

describe('the migration list itself', () => {
  it('adds every column the schema declares, so the two cannot drift', () => {
    /*
     * The trap this closes: a column added to SCHEMA and not to MIGRATIONS works perfectly on
     * every new install and breaks every upgrade - which is the harder half to notice, because
     * the developer adding it is testing on a database they just created.
     */
    const fresh = new DatabaseSync(':memory:');
    fresh.exec(SCHEMA.replace('PRAGMA journal_mode = WAL;', ''));
    const declared = new Set(columnsOf(fresh));

    for (const migration of MIGRATIONS) {
      expect(declared).toContain(migration.column);
    }
  });

  it('names each column once, since a repeated step would throw on the second', () => {
    const names = MIGRATIONS.map((m) => m.column);
    expect(new Set(names).size).toBe(names.length);
  });
});
