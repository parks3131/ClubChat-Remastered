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
import type { MessageEnvelope } from '@clubchat/shared';
import { InMemoryMessageStore, type MessageStore } from '@clubchat/client-core';

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
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (channel_id, seq)
);
`;

type Row = {
  channel_id: string;
  seq: number;
  id: string;
  sender_id: string;
  type: string;
  body: string | null;
  client_msg_id: string;
  pinned: number;
  deleted_at: string | null;
  created_at: string;
};

const toEnvelope = (row: Row): MessageEnvelope => ({
  id: row.id,
  channelId: row.channel_id,
  seq: row.seq,
  senderId: row.sender_id,
  type: row.type as MessageEnvelope['type'],
  body: row.body,
  clientMsgId: row.client_msg_id,
  pinned: row.pinned === 1,
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
             (channel_id, seq, id, sender_id, type, body, client_msg_id, pinned, deleted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (channel_id, seq) DO UPDATE SET
             id = excluded.id,
             sender_id = excluded.sender_id,
             type = excluded.type,
             body = excluded.body,
             client_msg_id = excluded.client_msg_id,
             pinned = excluded.pinned,
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
          message.deletedAt,
          message.createdAt,
        );
      }
    });
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
