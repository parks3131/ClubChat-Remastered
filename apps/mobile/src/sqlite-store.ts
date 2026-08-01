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
import type {
  MessageEnvelope,
  MessageMention,
  MessageReaction,
  MessageReplyRef,
} from '@clubchat/shared';
import {
  InMemoryMessageStore,
  strikeQuotedMessage,
  type MessagePatch,
  type MessageStore,
} from '@clubchat/client-core';
/*
 * The schema and its migrations live in a module that imports nothing native, so the suite can
 * run them against a real SQLite engine. This file is the driver half: it does the I/O and owns
 * no SQL of its own beyond the statements below.
 */
import { jsonListColumn, pendingMigrations, SCHEMA } from './sqlite-schema.ts';

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
  reply_to_seq: number | null;
  reply_to: string | null;
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

/** The same tolerance for the reply quote, which is one object rather than a list. */
function parseJsonObject<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
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
  // Null on a row cached before this column existed, which draws no quote box - what shipped
  // before replies, and right for the majority of messages, which answer nothing in particular.
  replyTo: parseJsonObject<MessageReplyRef>(row.reply_to),
  deletedAt: row.deleted_at,
  createdAt: row.created_at,
});

class SqliteMessageStore implements MessageStore {
  private readonly db: SQLite.SQLiteDatabase;

  /**
   * One writer at a time, for the whole store.
   *
   * > **A transaction belongs to the CONNECTION, not to the channel.** The client serializes
   * > message application per channel - right, because gap detection is a read-then-write of that
   * > channel's local max - but two DIFFERENT channels writing at the same moment still means two
   * > `withTransactionAsync` calls on one connection, and expo-sqlite answers that with `Error
   * > code 1: cannot start a transaction within a transaction`, then `cannot rollback - no
   * > transaction is active`. The insert dies and takes its message with it.
   * >
   * > Seen live on 2026-08-01: a sync running while an arriving card was applied. The per-channel
   * > queue could never have prevented it, because the two were not the same channel.
   *
   * So the lock lives here, where the single connection does. Callers do not have to know, which
   * is the point: `applyIncoming`, `syncChannel` and `loadOlder` all reach this store by
   * different routes and none of them can see the others.
   */
  private writes: Promise<unknown> = Promise.resolve();

  // Explicit assignment, not a parameter property, for consistency with the rest of the
  // repo. Metro would accept either; the server's runtime would not. See AGENTS.md 5.3.
  constructor(db: SQLite.SQLiteDatabase) {
    this.db = db;
  }

  /** Run `op` after every write already queued, whether that one succeeded or failed. */
  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writes.then(op, op);
    // Swallowed on the stored tail only, so one failed write does not reject every write queued
    // behind it. The caller still sees its own rejection.
    this.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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
    // Behind the store's write lock, because that transaction is connection-wide.
    await this.exclusive(() =>
      this.db.withTransactionAsync(async () => {
      for (const message of messages) {
        await this.db.runAsync(
          `INSERT INTO messages
             (channel_id, seq, id, sender_id, sender_name, sender_image, type, body, client_msg_id, pinned, pinned_at, reactions, mentions,
              media_id, document_name, document_size, linked_poll_id, linked_event_id, linked_meeting_id, reply_to_seq, reply_to, deleted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
             reply_to_seq = excluded.reply_to_seq,
             reply_to = excluded.reply_to,
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
          // Never a bare `JSON.stringify` for these two: they are NOT NULL, and an envelope from
          // a producer that predates either field would bind SQL NULL and lose the whole message.
          // See `jsonListColumn`.
          jsonListColumn(message.reactions),
          jsonListColumn(message.mentions),
          message.mediaId,
          message.documentName,
          message.documentSize,
          message.linkedPollId,
          message.linkedEventId,
          message.linkedMeetingId,
          // The seq as its own column so a delete can find every quote of that message, and the
          // whole ref as JSON so drawing one needs no second read. See `sqlite-schema.ts`.
          message.replyTo?.seq ?? null,
          // Nullable, so a missing field is simply no quote - but `== null` rather than
          // `=== null` so an absent one takes the same branch as an explicit one.
          message.replyTo == null ? null : JSON.stringify(message.replyTo),
          message.deletedAt,
          message.createdAt,
        );
        }
      }),
    );
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
      values.push(jsonListColumn(patch.reactions));
    }
    if (patch.deletedAt !== undefined) {
      assignments.push('deleted_at = ?');
      values.push(patch.deletedAt);
      // A tombstone loses its body, matching what the server stores. Otherwise the cache
      // would keep rendering text the server has already discarded.
      assignments.push('body = CASE WHEN ? IS NULL THEN body ELSE NULL END');
      values.push(patch.deletedAt);
    }

    /*
     * Behind the same write lock as `upsert`, and for a second reason on top of the connection's:
     * the strike below is a read-modify-write, so a writer landing between its read and its write
     * would have its change overwritten.
     */
    await this.exclusive(async () => {
      if (assignments.length > 0) {
        await this.db.runAsync(
          `UPDATE messages SET ${assignments.join(', ')} WHERE channel_id = ? AND seq = ?`,
          ...values,
          channelId,
          seq,
        );
      }

      /*
       * A delete also strikes this message out of every quote of it. See `strikeQuotedMessage`.
       *
       * Read-modify-write rather than a `json_set` in SQL: the shape of the stored ref is declared
       * in one place - the shared `MessageReplyRef` - and spelling its keys out in a SQL string
       * would be a second declaration that no compiler is checking. Replies to any one message are
       * few, and `reply_to_seq` is a real column precisely so this finds them by index.
       */
      if (patch.deletedAt === undefined || patch.deletedAt === null) return;
      const quoting = await this.db.getAllAsync<{ seq: number; reply_to: string | null }>(
        'SELECT seq, reply_to FROM messages WHERE channel_id = ? AND reply_to_seq = ?',
        channelId,
        seq,
      );
      for (const row of quoting) {
        const ref = parseJsonObject<MessageReplyRef>(row.reply_to);
        if (ref === null) continue;
        await this.db.runAsync(
          'UPDATE messages SET reply_to = ? WHERE channel_id = ? AND seq = ?',
          JSON.stringify(strikeQuotedMessage(ref)),
          channelId,
          row.seq,
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
