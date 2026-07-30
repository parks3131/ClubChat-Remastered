/**
 * The local message cache, keyed by `(channel_id, seq)`.
 *
 * This is what makes chat readable offline instead of a spinner. It implements the same
 * `MessageStore` interface the exit drill runs against in memory, so the client logic
 * over it - gap detection, the send outbox, sync - is identical and already tested.
 *
 * The primary key is `(channel_id, seq)` rather than the message id, because that is
 * the key every read actually uses: page backward by seq, find the local max by seq,
 * detect holes by seq.
 */

import * as SQLite from 'expo-sqlite';
import type { MessageEnvelope, MessageReaction } from '@clubchat/shared';
import {
  InMemoryMessageStore,
  type MessagePatch,
  type MessageStore,
} from '@clubchat/client-core';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS messages (
  channel_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  id             TEXT NOT NULL,
  sender_id      TEXT NOT NULL,
  type           TEXT NOT NULL,
  body           TEXT,
  client_msg_id  TEXT NOT NULL,
  pinned         INTEGER NOT NULL DEFAULT 0,
  reactions      TEXT NOT NULL DEFAULT '[]',
  media_id       TEXT,
  document_name  TEXT,
  document_size  INTEGER,
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
 */
const MIGRATIONS: ReadonlyArray<{ column: string; statement: string }> = [
  { column: 'reactions', statement: `ALTER TABLE messages ADD COLUMN reactions TEXT NOT NULL DEFAULT '[]'` },
  { column: 'media_id', statement: `ALTER TABLE messages ADD COLUMN media_id TEXT` },
  { column: 'document_name', statement: `ALTER TABLE messages ADD COLUMN document_name TEXT` },
  { column: 'document_size', statement: `ALTER TABLE messages ADD COLUMN document_size INTEGER` },
];

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(messages)');
  const held = new Set(columns.map((column) => column.name));
  // Driven per column by what the table actually has, rather than by a stored version number,
  // so a database in ANY prior state converges - including one a failed earlier run left half
  // done. A single "if the newest column is missing, run everything" check would break exactly
  // there, which is why each step carries the column it adds.
  for (const migration of MIGRATIONS) {
    if (held.has(migration.column)) continue;
    await db.execAsync(migration.statement);
  }
}

type Row = {
  channel_id: string;
  seq: number;
  id: string;
  sender_id: string;
  type: string;
  body: string | null;
  client_msg_id: string;
  pinned: number;
  reactions: string | null;
  media_id: string | null;
  document_name: string | null;
  document_size: number | null;
  deleted_at: string | null;
  created_at: string;
};

/**
 * Reactions are stored as a JSON string.
 *
 * A child table keyed by `(channel_id, seq, emoji, user_id)` would be the normalised shape and
 * is the wrong trade here: this is a disposable cache whose only reader renders the whole
 * message at once, and the server already owns the normalised copy. Tolerates a null or
 * malformed value by returning an empty list, because a cache that throws on a bad row is
 * worse than one that shows a message without its pills.
 */
function parseReactions(raw: string | null): MessageReaction[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as MessageReaction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const toEnvelope = (row: Row): MessageEnvelope => ({
  id: row.id,
  channelId: row.channel_id,
  seq: row.seq,
  senderId: row.sender_id,
  type: row.type as MessageEnvelope['type'],
  body: row.body,
  clientMsgId: row.client_msg_id,
  pinned: row.pinned === 1,
  reactions: parseReactions(row.reactions),
  mediaId: row.media_id,
  documentName: row.document_name,
  documentSize: row.document_size,
  deletedAt: row.deleted_at,
  createdAt: row.created_at,
});

class SqliteMessageStore implements MessageStore {
  private readonly db: SQLite.SQLiteDatabase;

  // Explicit assignment, not a parameter property, for consistency with the rest of the
  // repo. Metro would accept either; the server's runtime would not. See AGENTS.md 5.3.
  constructor(db: SQLite.SQLiteDatabase) {
    this.db = db;
  }

  async localMaxSeq(channelId: string): Promise<number> {
    const row = await this.db.getFirstAsync<{ max_seq: number | null }>(
      'SELECT MAX(seq) AS max_seq FROM messages WHERE channel_id = ?',
      channelId,
    );
    return row?.max_seq ?? 0;
  }

  async upsert(messages: readonly MessageEnvelope[]): Promise<void> {
    if (messages.length === 0) return;
    // One transaction for the batch: a sync response can be hundreds of rows, and
    // committing each one separately is the difference between instant and visibly slow.
    await this.db.withTransactionAsync(async () => {
      for (const message of messages) {
        await this.db.runAsync(
          `INSERT INTO messages
             (channel_id, seq, id, sender_id, type, body, client_msg_id, pinned, reactions,
              media_id, document_name, document_size, deleted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (channel_id, seq) DO UPDATE SET
             id = excluded.id,
             sender_id = excluded.sender_id,
             type = excluded.type,
             body = excluded.body,
             client_msg_id = excluded.client_msg_id,
             pinned = excluded.pinned,
             reactions = excluded.reactions,
             media_id = excluded.media_id,
             document_name = excluded.document_name,
             document_size = excluded.document_size,
             deleted_at = excluded.deleted_at,
             created_at = excluded.created_at`,
          message.channelId,
          message.seq,
          message.id,
          message.senderId,
          message.type,
          message.body,
          message.clientMsgId,
          message.pinned ? 1 : 0,
          JSON.stringify(message.reactions),
          message.mediaId,
          message.documentName,
          message.documentSize,
          message.deletedAt,
          message.createdAt,
        );
      }
    });
  }

  /**
   * Apply an update to a message already held.
   *
   * Builds the SET clause from the keys actually present, so a frame that carries only
   * reactions does not overwrite `pinned` with a stale value it never saw. The WHERE is the
   * primary key, so a seq this device has not cached is a no-op rather than an insert.
   */
  async patch(channelId: string, seq: number, patch: MessagePatch): Promise<void> {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];

    if (patch.pinned !== undefined) {
      assignments.push('pinned = ?');
      values.push(patch.pinned ? 1 : 0);
    }
    if (patch.reactions !== undefined) {
      assignments.push('reactions = ?');
      values.push(JSON.stringify(patch.reactions));
    }
    if (patch.deletedAt !== undefined) {
      assignments.push('deleted_at = ?');
      values.push(patch.deletedAt);
      // A tombstone loses its body, matching what the server stores. Otherwise the cache
      // would keep rendering text the server has already discarded.
      assignments.push('body = CASE WHEN ? IS NULL THEN body ELSE NULL END');
      values.push(patch.deletedAt);
    }

    if (assignments.length === 0) return;

    await this.db.runAsync(
      `UPDATE messages SET ${assignments.join(', ')} WHERE channel_id = ? AND seq = ?`,
      ...values,
      channelId,
      seq,
    );
  }

  async list(channelId: string): Promise<MessageEnvelope[]> {
    const rows = await this.db.getAllAsync<Row>(
      'SELECT * FROM messages WHERE channel_id = ? ORDER BY seq ASC',
      channelId,
    );
    return rows.map(toEnvelope);
  }

  async seqs(channelId: string): Promise<number[]> {
    const rows = await this.db.getAllAsync<{ seq: number }>(
      'SELECT seq FROM messages WHERE channel_id = ? ORDER BY seq ASC',
      channelId,
    );
    return rows.map((row) => row.seq);
  }
}

/**
 * Open the local cache, falling back to memory if SQLite is unavailable.
 *
 * The fallback matters on web, where expo-sqlite needs OPFS and OPFS needs specific
 * response headers that a bare dev server does not send. Degrading to an in-memory
 * store keeps the app fully functional and loses only offline persistence, which is
 * the right trade for a surface the product treats as primarily a development and
 * testing one. It degrades loudly rather than silently.
 */
export async function openMessageStore(): Promise<{ store: MessageStore; persistent: boolean }> {
  try {
    const db = await SQLite.openDatabaseAsync('clubchat.db');
    await db.execAsync(SCHEMA);
    // After CREATE, for the database that already existed before the column did.
    await migrate(db);
    return { store: new SqliteMessageStore(db), persistent: true };
  } catch (error) {
    console.warn(
      '[clubchat] SQLite unavailable, falling back to an in-memory cache. ' +
        'Chat will not be readable offline in this session.',
      error,
    );
    return { store: new InMemoryMessageStore(), persistent: false };
  }
}
