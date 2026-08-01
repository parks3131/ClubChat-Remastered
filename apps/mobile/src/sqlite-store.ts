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
import type { MessageEnvelope, MessageMention, MessageReaction } from '@clubchat/shared';
import {
  InMemoryMessageStore,
  type MessagePatch,
  type MessageStore,
} from '@clubchat/client-core';
/*
 * The schema and its migrations live in a module that imports nothing native, so the suite can
 * run them against a real SQLite engine. This file is the driver half: it does the I/O and owns
 * no SQL of its own beyond the statements below.
 */
import { pendingMigrations, SCHEMA } from './sqlite-schema.ts';

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(messages)');
  // Which steps are outstanding is decided by `pendingMigrations`, from what the table actually
  // has rather than from a stored version number - so a database in ANY prior state converges,
  // including one a failed earlier run left half done. This function is only the I/O around it.
  for (const migration of pendingMigrations(columns.map((column) => column.name))) {
    for (const statement of migration.statements) {
      await db.execAsync(statement);
    }
  }
}

type Row = {
  channel_id: string;
  seq: number;
  id: string;
  sender_id: string;
  sender_name: string | null;
  sender_image: string | null;
  mentions: string | null;
  type: string;
  body: string | null;
  client_msg_id: string;
  pinned: number;
  pinned_at: string | null;
  reactions: string | null;
  media_id: string | null;
  document_name: string | null;
  document_size: number | null;
  linked_poll_id: string | null;
  linked_event_id: string | null;
  linked_meeting_id: string | null;
  deleted_at: string | null;
  created_at: string;
};

/**
 * Reactions and mentions are stored as JSON strings.
 *
 * A child table keyed by `(channel_id, seq, emoji, user_id)` would be the normalised shape and
 * is the wrong trade here: this is a disposable cache whose only reader renders the whole
 * message at once, and the server already owns the normalised copy. Tolerates a null or
 * malformed value by returning an empty list, because a cache that throws on a bad row is
 * worse than one that shows a message without its pills.
 */
function parseJsonList<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as T[];
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
  // Cached with the message so an offline chat still says who is talking. A row written before
  // this column existed reads null and renders unattributed until the next sync fills it.
  senderName: row.sender_name,
  // Null on a row cached before this column existed, which draws the letter - the same thing
  // that shipped before, and correct anyway for anybody with no picture.
  senderImage: row.sender_image,
  type: row.type as MessageEnvelope['type'],
  body: row.body,
  clientMsgId: row.client_msg_id,
  pinned: row.pinned === 1,
  // Null on a row cached before this column existed. The strip orders by it, so such a row
  // simply sorts last until the next sync fills it in.
  pinnedAt: row.pinned_at,
  reactions: parseJsonList<MessageReaction>(row.reactions),
  // Empty on a row cached before this column existed, which renders the body as plain text -
  // what shipped before mentions, and right for the majority of messages, which name nobody.
  mentions: parseJsonList<MessageMention>(row.mentions),
  mediaId: row.media_id,
  documentName: row.document_name,
  documentSize: row.document_size,
  linkedPollId: row.linked_poll_id,
  linkedEventId: row.linked_event_id,
  linkedMeetingId: row.linked_meeting_id,
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
             (channel_id, seq, id, sender_id, sender_name, sender_image, type, body, client_msg_id, pinned, pinned_at, reactions, mentions,
              media_id, document_name, document_size, linked_poll_id, linked_event_id, linked_meeting_id, deleted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (channel_id, seq) DO UPDATE SET
             id = excluded.id,
             sender_id = excluded.sender_id,
             sender_name = excluded.sender_name,
             sender_image = excluded.sender_image,
             type = excluded.type,
             body = excluded.body,
             client_msg_id = excluded.client_msg_id,
             pinned = excluded.pinned,
             reactions = excluded.reactions,
             pinned_at = excluded.pinned_at,
             mentions = excluded.mentions,
             media_id = excluded.media_id,
             document_name = excluded.document_name,
             document_size = excluded.document_size,
             linked_poll_id = excluded.linked_poll_id,
             linked_event_id = excluded.linked_event_id,
             linked_meeting_id = excluded.linked_meeting_id,
             deleted_at = excluded.deleted_at,
             created_at = excluded.created_at`,
          message.channelId,
          message.seq,
          message.id,
          message.senderId,
          message.senderName,
          message.senderImage,
          message.type,
          message.body,
          message.clientMsgId,
          message.pinned ? 1 : 0,
          message.pinnedAt,
          JSON.stringify(message.reactions),
          JSON.stringify(message.mentions),
          message.mediaId,
          message.documentName,
          message.documentSize,
          message.linkedPollId,
          message.linkedEventId,
          message.linkedMeetingId,
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
