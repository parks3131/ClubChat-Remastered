/**
 * Handler tests for the channel log, against a real Postgres.
 *
 * These run against the actual migrations rather than a convenient hand-rolled
 * schema, because the properties under test (gaplessness, idempotency) are enforced
 * by constraints and a locked read-modify-write. A mocked database would prove
 * nothing about either.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, count, eq, sql } from 'drizzle-orm';
import { SYSTEM_ACTOR_ID } from '@clubchat/shared';
import { appendMessage, ChannelGoneError, deriveClientMsgId } from './append-message.ts';
import { channels, messages, outbox } from '../db/schema.ts';
import { seedClub, seedUser, startTestDb, type TestDb } from '../test/harness.ts';

let h: TestDb;

/** Count rows matching a filter. Named so the assertions read as counts, not joins. */
async function countMessages(where: ReturnType<typeof sql>): Promise<number> {
  const rows = await h.db.select({ n: count() }).from(messages).where(where);
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  h = await startTestDb();
});

afterAll(async () => {
  await h?.stop();
});

describe('sequence allocation', () => {
  it('starts at 1 and increments by 1', async () => {
    const { channelId, ownerId } = await seedClub(h.db);

    const first = await appendMessage(h.db, {
      channelId,
      senderId: ownerId,
      clientMsgId: crypto.randomUUID(),
      body: 'one',
    });
    const second = await appendMessage(h.db, {
      channelId,
      senderId: ownerId,
      clientMsgId: crypto.randomUUID(),
      body: 'two',
    });

    expect(first.message.seq).toBe(1);
    expect(second.message.seq).toBe(2);
    expect(first.deduplicated).toBe(false);
  });

  it('advances the channel last_seq in step with the messages', async () => {
    const { channelId, ownerId } = await seedClub(h.db);

    for (let i = 0; i < 5; i += 1) {
      await appendMessage(h.db, {
        channelId,
        senderId: ownerId,
        clientMsgId: crypto.randomUUID(),
        body: `m${i}`,
      });
    }

    const [channel] = await h.db.select().from(channels).where(eq(channels.id, channelId));
    expect(channel?.lastSeq).toBe(5);
  });

  it('is per channel, not global', async () => {
    // seq is meaningful only within its channel and must never be compared across
    // channels. Two fresh channels both start at 1.
    const a = await seedClub(h.db);
    const b = await seedClub(h.db);

    const inA = await appendMessage(h.db, {
      channelId: a.channelId,
      senderId: a.ownerId,
      clientMsgId: crypto.randomUUID(),
      body: 'in a',
    });
    const inB = await appendMessage(h.db, {
      channelId: b.channelId,
      senderId: b.ownerId,
      clientMsgId: crypto.randomUUID(),
      body: 'in b',
    });

    expect(inA.message.seq).toBe(1);
    expect(inB.message.seq).toBe(1);
  });

  it('is gapless under concurrent sends to the same channel', async () => {
    // The row lock serializes concurrent sends. This is the property that makes a
    // gap MEAN something on the client: seeing 1, 2, 4 must prove 3 is missing
    // rather than merely suggest it.
    const { channelId, ownerId } = await seedClub(h.db);
    const senders = await Promise.all([
      seedUser(h.db, 'A'),
      seedUser(h.db, 'B'),
      seedUser(h.db, 'C'),
    ]);
    const all = [ownerId, ...senders];

    const CONCURRENT = 40;
    await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) =>
        appendMessage(h.db, {
          channelId,
          senderId: all[i % all.length]!,
          clientMsgId: crypto.randomUUID(),
          body: `concurrent ${i}`,
        }),
      ),
    );

    const rows = await h.db
      .select({ seq: messages.seq })
      .from(messages)
      .where(eq(messages.channelId, channelId))
      .orderBy(asc(messages.seq));

    expect(rows).toHaveLength(CONCURRENT);
    // No holes, no duplicates: exactly 1..N.
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: CONCURRENT }, (_, i) => i + 1));
  });
});

describe('idempotency', () => {
  it('a retry returns the original seq and writes no second row', async () => {
    const { channelId, ownerId } = await seedClub(h.db);
    const clientMsgId = crypto.randomUUID();

    const first = await appendMessage(h.db, {
      channelId,
      senderId: ownerId,
      clientMsgId,
      body: 'sent once',
    });
    const retry = await appendMessage(h.db, {
      channelId,
      senderId: ownerId,
      clientMsgId,
      body: 'sent once',
    });

    expect(retry.message.seq).toBe(first.message.seq);
    expect(retry.message.id).toBe(first.message.id);
    expect(first.deduplicated).toBe(false);
    expect(retry.deduplicated).toBe(true);

    // Assert the COUNT. Eyeballing a transcript would pass a build with a
    // duplication bug still in it.
    expect(await countMessages(eq(messages.channelId, channelId))).toBe(1);
  });

  it('does not burn a sequence number on a recognised retry', async () => {
    const { channelId, ownerId } = await seedClub(h.db);
    const clientMsgId = crypto.randomUUID();

    await appendMessage(h.db, { channelId, senderId: ownerId, clientMsgId, body: 'x' });
    await appendMessage(h.db, { channelId, senderId: ownerId, clientMsgId, body: 'x' });
    await appendMessage(h.db, { channelId, senderId: ownerId, clientMsgId, body: 'x' });

    const [channel] = await h.db.select().from(channels).where(eq(channels.id, channelId));
    // Three calls, one message, and the counter did not drift.
    expect(channel?.lastSeq).toBe(1);
  });

  it('survives a concurrent double-send of the same client_msg_id', async () => {
    // The race the fast path cannot catch: both calls miss the pre-check, both enter
    // the transaction, the loser hits the unique index. Its transaction rolls back,
    // which restores the counter, so the collision must leave NO gap behind.
    const { channelId, ownerId } = await seedClub(h.db);
    const clientMsgId = crypto.randomUUID();

    const results = await Promise.all([
      appendMessage(h.db, { channelId, senderId: ownerId, clientMsgId, body: 'racy' }),
      appendMessage(h.db, { channelId, senderId: ownerId, clientMsgId, body: 'racy' }),
      appendMessage(h.db, { channelId, senderId: ownerId, clientMsgId, body: 'racy' }),
    ]);

    const seqs = new Set(results.map((r) => r.message.seq));
    expect(seqs.size).toBe(1);

    expect(await countMessages(eq(messages.channelId, channelId))).toBe(1);

    const [channel] = await h.db.select().from(channels).where(eq(channels.id, channelId));
    expect(channel?.lastSeq).toBe(1);
  });

  it('scopes idempotency per sender, so one member retry cannot suppress another message', async () => {
    const { channelId, ownerId } = await seedClub(h.db);
    const other = await seedUser(h.db, 'Other');
    const sharedId = crypto.randomUUID();

    const a = await appendMessage(h.db, {
      channelId,
      senderId: ownerId,
      clientMsgId: sharedId,
      body: 'from owner',
    });
    const b = await appendMessage(h.db, {
      channelId,
      senderId: other,
      clientMsgId: sharedId,
      body: 'from other',
    });

    expect(a.message.seq).toBe(1);
    expect(b.message.seq).toBe(2);
    expect(b.deduplicated).toBe(false);
  });
});

describe('the outbox is written in the same transaction', () => {
  it('writes exactly one message.created event per new message', async () => {
    const { channelId, ownerId } = await seedClub(h.db);

    await appendMessage(h.db, {
      channelId,
      senderId: ownerId,
      clientMsgId: crypto.randomUUID(),
      body: 'hello',
    });

    const events = await h.db
      .select()
      .from(outbox)
      .where(eq(outbox.partitionKey, channelId));

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('message.created');
    expect(events[0]?.processedAt).toBeNull();
    // The partition key is the channel. Kafka guarantees ordering within a partition
    // only, so any other key would silently break per-channel ordering - with "a
    // system message arriving before the event that caused it" as the symptom.
    expect(events[0]?.partitionKey).toBe(channelId);
  });

  it('writes no outbox event for a deduplicated retry', async () => {
    // A retry must not re-fire the effects. The message already exists, so its
    // notifications and cards already happened.
    const { channelId, ownerId } = await seedClub(h.db);
    const clientMsgId = crypto.randomUUID();

    await appendMessage(h.db, { channelId, senderId: ownerId, clientMsgId, body: 'once' });
    await appendMessage(h.db, { channelId, senderId: ownerId, clientMsgId, body: 'once' });

    const events = await h.db
      .select()
      .from(outbox)
      .where(eq(outbox.partitionKey, channelId));
    expect(events).toHaveLength(1);
  });

  it('rolls the message back with the outbox when the transaction fails', async () => {
    // Either both land or neither does. Forced by pointing at a channel that does
    // not exist, so the UPDATE matches no row.
    const ghost = crypto.randomUUID();
    const ownerId = await seedUser(h.db, 'Ghost sender');

    await expect(
      appendMessage(h.db, {
        channelId: ghost,
        senderId: ownerId,
        clientMsgId: crypto.randomUUID(),
        body: 'into the void',
      }),
    ).rejects.toThrow(ChannelGoneError);

    const events = await h.db.select().from(outbox).where(eq(outbox.partitionKey, ghost));
    expect(events).toHaveLength(0);
  });
});

describe('system messages', () => {
  it('are authored by the seeded system actor, never NULL', async () => {
    const { channelId } = await seedClub(h.db);

    const result = await appendMessage(h.db, {
      channelId,
      senderId: SYSTEM_ACTOR_ID,
      clientMsgId: deriveClientMsgId('outbox', 12345),
      type: 'system',
      body: 'Alice joined the club',
    });

    expect(result.message.senderId).toBe(SYSTEM_ACTOR_ID);
    expect(result.message.type).toBe('system');
  });

  it('deduplicate across redelivery because the key is derived from the event id', async () => {
    // At-least-once delivery means the worker WILL reprocess events. A redelivered
    // outbox event must not post "X was added to the club" a second time, and the
    // unique index does that work only because the derived key is stable and the
    // sender is a non-null sentinel.
    const { channelId } = await seedClub(h.db);
    const outboxEventId = 987_654;

    const a = await appendMessage(h.db, {
      channelId,
      senderId: SYSTEM_ACTOR_ID,
      clientMsgId: deriveClientMsgId('outbox', outboxEventId),
      type: 'system',
      body: 'Bob was added by Alice',
    });
    const redelivered = await appendMessage(h.db, {
      channelId,
      senderId: SYSTEM_ACTOR_ID,
      clientMsgId: deriveClientMsgId('outbox', outboxEventId),
      type: 'system',
      body: 'Bob was added by Alice',
    });

    expect(redelivered.deduplicated).toBe(true);
    expect(redelivered.message.seq).toBe(a.message.seq);

    expect(
      await countMessages(sql`${messages.channelId} = ${channelId} AND ${messages.type} = 'system'`),
    ).toBe(1);
  });
});

describe('deriveClientMsgId', () => {
  it('is deterministic', () => {
    expect(deriveClientMsgId('outbox', 42)).toBe(deriveClientMsgId('outbox', 42));
  });

  it('separates scopes and keys', () => {
    expect(deriveClientMsgId('outbox', 42)).not.toBe(deriveClientMsgId('outbox', 43));
    expect(deriveClientMsgId('outbox', 42)).not.toBe(deriveClientMsgId('card', 42));
  });

  it('produces a well-formed v5-shaped uuid', () => {
    expect(deriveClientMsgId('outbox', 1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
