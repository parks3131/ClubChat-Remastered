/**
 * The local message store.
 *
 * An interface rather than a concrete implementation because the two consumers differ:
 * the Expo app persists to SQLite (keyed by `(channel_id, seq)`, which is what makes
 * chat readable offline instead of a spinner), while tests use the in-memory version.
 * The client logic that matters - gap detection, the send outbox, sync - is identical
 * over both, so it is written once against this interface and exercised by both.
 */

import type { MessageEnvelope, MessageReaction } from '@clubchat/shared';

export type PendingSend = {
  clientMsgId: string;
  channelId: string;
  body: string;
  /**
   * The kind of message. Defaults to text at the call site rather than here, so a caller
   * attaching media has to say so.
   *
   * `announcement` is client-originated like the other three, and is the only one of them that
   * is **authorized rather than merely accepted**: the server refuses it unless the sender is an
   * admin of that space, so widening this union grants nothing on its own. It was omitted here
   * until 2026-07-30, which is why the composer had no announcement control to build - the
   * server had enforced the rule since Phase 2 with nothing able to exercise it.
   */
  type?: 'text' | 'photo' | 'document' | 'announcement';
  /**
   * An object already uploaded AND completed, for a photo or document send.
   *
   * The upload finishes before the message is enqueued, deliberately: the send is retried
   * from the outbox across reconnects, and re-uploading bytes on every retry would be both
   * slow and wrong - the object is already durable and already verified.
   */
  mediaId?: string;
  /** For rendering the optimistic bubble before the ack arrives. */
  localUri?: string;
  documentName?: string;
  documentSize?: number;
  /**
   * Who the composer named, as user ids.
   *
   * Held on the outbox entry rather than recomputed at flush time, because a retry across a
   * reconnect has to send the same mentions as the first attempt - and by then the composer that
   * knew who was picked has been cleared.
   *
   * A claim, not an instruction: the server stores a mention only for somebody whose name is
   * actually in the body, so a stale id here can add nobody.
   */
  mentions?: readonly string[];
  /** Attempts so far. Surfaced so the UI can show "failed" after enough of them. */
  attempts: number;
  status: 'pending' | 'failed';
};

/**
 * The fields a `msg.update` frame can change on a message already held locally.
 *
 * Deliberately a narrow subset rather than a partial envelope: an update must never be able
 * to rewrite a message's body, sender or seq. Those are the log, and the log is append-only.
 */
export type MessagePatch = {
  pinned?: boolean;
  reactions?: MessageReaction[];
  deletedAt?: string | null;
};

export interface MessageStore {
  /** Highest contiguous seq held for a channel, or 0 if empty. */
  localMaxSeq(channelId: string): Promise<number>;
  /** Insert or replace by (channelId, seq). Must be idempotent. */
  upsert(messages: readonly MessageEnvelope[]): Promise<void>;
  /**
   * Apply a change to a message already held. A no-op if that seq is not held.
   *
   * A no-op rather than an insert, deliberately: a pin or a reaction on a message the client
   * has never seen is not enough information to render it, and inventing a row with an empty
   * body would put a blank bubble in the conversation. The next sync or history page brings
   * the message and its current reactions together.
   */
  patch(channelId: string, seq: number, patch: MessagePatch): Promise<void>;
  /** Oldest-first, for rendering. */
  list(channelId: string): Promise<MessageEnvelope[]>;
  /** Every seq held for a channel, ascending. For gap auditing. */
  seqs(channelId: string): Promise<number[]>;
}

export class InMemoryMessageStore implements MessageStore {
  /** channelId -> seq -> message. A Map keyed by seq gives upsert-by-seq for free. */
  private readonly byChannel = new Map<string, Map<number, MessageEnvelope>>();

  private channel(channelId: string): Map<number, MessageEnvelope> {
    let channel = this.byChannel.get(channelId);
    if (!channel) {
      channel = new Map();
      this.byChannel.set(channelId, channel);
    }
    return channel;
  }

  async localMaxSeq(channelId: string): Promise<number> {
    const channel = this.byChannel.get(channelId);
    if (!channel || channel.size === 0) return 0;
    return Math.max(...channel.keys());
  }

  async upsert(messages: readonly MessageEnvelope[]): Promise<void> {
    for (const message of messages) {
      this.channel(message.channelId).set(message.seq, message);
    }
  }

  async patch(channelId: string, seq: number, patch: MessagePatch): Promise<void> {
    const existing = this.byChannel.get(channelId)?.get(seq);
    if (!existing) return;
    // Spread the patch rather than assigning each field, so a key absent from the frame
    // leaves the current value alone. `deletedAt: null` is a legitimate value meaning "not
    // deleted", which is why absence and null have to stay distinguishable.
    this.channel(channelId).set(seq, { ...existing, ...patch });
  }

  async list(channelId: string): Promise<MessageEnvelope[]> {
    const channel = this.byChannel.get(channelId);
    if (!channel) return [];
    return [...channel.values()].sort((a, b) => a.seq - b.seq);
  }

  async seqs(channelId: string): Promise<number[]> {
    const channel = this.byChannel.get(channelId);
    if (!channel) return [];
    return [...channel.keys()].sort((a, b) => a - b);
  }
}

/**
 * Find holes in a channel's local sequence.
 *
 * Exact rather than heuristic, because `seq` is gapless server-side: if the local set
 * is {1,2,4} then 3 is definitively missing, not merely possibly missing. This is the
 * audit the exit drill asserts against, and it is also what a client can use to decide
 * it needs a sync rather than guessing.
 */
export function findGaps(seqs: readonly number[]): number[] {
  if (seqs.length === 0) return [];
  const holes: number[] = [];
  const sorted = [...seqs].sort((a, b) => a - b);
  // Sequences start at 1, so anything below the first held seq is history the client
  // simply has not paged back to yet - not a gap.
  for (let i = 1; i < sorted.length; i += 1) {
    for (let missing = sorted[i - 1]! + 1; missing < sorted[i]!; missing += 1) {
      holes.push(missing);
    }
  }
  return holes;
}
