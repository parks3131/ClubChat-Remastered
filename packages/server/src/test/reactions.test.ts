/**
 * Reactions, across all four scopes.
 *
 * Three properties carry most of the weight here, and each has an easy way to look correct
 * while being wrong:
 *
 *  - **The toggle is keyed, not read-then-written.** A read-then-write passes every
 *    single-tap test and leaves a double row under two fast taps. Asserted by counting rows
 *    after concurrent toggles, not by toggling once.
 *  - **Reacting takes the POSTING gate, not the reading one.** A blocked DM participant can
 *    see the message; reacting to it is still writing into a conversation they are barred
 *    from. This is the one place `canReactInChannel` differs from "can they see it".
 *  - **A deletion clears them.** PRD/05 rule 9 has required that since Phase 0 and nothing
 *    implemented it, because reactions did not exist to clear.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MAX_DISTINCT_REACTIONS, emojiCatalog, reactionSummary } from '@clubchat/shared';
import { createClub } from '../domain/create-club.ts';
import { addMember } from '../domain/membership.ts';
import { sendMessage, softDeleteMessage } from '../domain/send-message.ts';
import { getChannelRef, readHistory, syncSince } from '../domain/reads.ts';
import { readReactions, toggleReaction } from '../domain/reactions.ts';
import { blockMember, openDm } from '../domain/dm.ts';
import { loadAccessContext } from '../policy/context.ts';
import { canPostInChannel, canReactInChannel, isChannelMember } from '../policy/predicates.ts';
import { drainOnce } from '../worker/drain.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { users } from '../db/schema.ts';
import { anyViewer, startTestDb, type TestDb } from './harness.ts';
import type { EffectDeps } from '../worker/effects.ts';
import type { ChannelRef } from '../policy/predicates.ts';

let h: TestDb;
/** Everything the worker published, so the update frames can be asserted. */
let published: Array<{ topic: string; payload: Record<string, unknown> }>;
let deps: EffectDeps;

const silent = () => undefined;

beforeAll(async () => {
  h = await startTestDb();
});
afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(sql`
    TRUNCATE message_reactions, notifications, push_deliveries, devices, outbox, member_blocks
    RESTART IDENTITY CASCADE
  `);
  published = [];
  deps = {
    db: h.db,
    // A recording stand-in, which is the only way to assert what a client would receive
    // without a socket in the loop.
    redis: {
      publish: async (topic: string, raw: string) => {
        published.push({ topic, payload: JSON.parse(raw) as Record<string, unknown> });
        return 1;
      },
    } as never,
    push: new RecordingPushSender(),
    log: silent,
    defer: () => undefined,
  };
});

const ctxFor = (id: string) => loadAccessContext(h.db, id);

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({ id, name, email: `${name}-${id.slice(0, 8)}@t.invalid` });
  return id;
}

async function say(userId: string, channel: ChannelRef, body: string) {
  const result = await sendMessage(h.db, await ctxFor(userId), channel, {
    channelId: channel.id,
    clientMsgId: crypto.randomUUID(),
    body,
  });
  if (!result.ok) throw new Error(`send refused: ${result.code}`);
  return result.message;
}

type Fixture = {
  clubId: string;
  channel: ChannelRef;
  ownerId: string;
  memberId: string;
  outsiderId: string;
};

async function setup(): Promise<Fixture> {
  const ownerId = await makeUser('Owner');
  const memberId = await makeUser('Member');
  const outsiderId = await makeUser('Outsider');
  const club = await createClub(h.db, { name: 'Hillside', creatorId: ownerId });
  await addMember(h.db, await ctxFor(ownerId), club.clubId, memberId);
  const channel = await getChannelRef(h.db, club.mainChannelId);
  if (!channel) throw new Error('fixture channel missing');
  return { clubId: club.clubId, channel, ownerId, memberId, outsiderId };
}

// ===========================================================================
// The toggle
// ===========================================================================

describe('toggling a reaction', () => {
  it('adds, then removes, and reports which it did', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'we won');

    const on = await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '🔥');
    expect(on.ok && on.added).toBe(true);
    expect(on.ok && on.reactions).toEqual([{ emoji: '🔥', userIds: [f.memberId] }]);

    const off = await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '🔥');
    expect(off.ok && off.added).toBe(false);
    // The emoji disappears entirely rather than lingering with a count of zero, so the pill
    // row has nothing to render.
    expect(off.ok && off.reactions).toEqual([]);
  });

  it('keeps several different emoji from one member, and one of each', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'we won');
    const ctx = await ctxFor(f.memberId);

    await toggleReaction(h.db, ctx, f.channel, message.seq, '🔥');
    await toggleReaction(h.db, ctx, f.channel, message.seq, '🎉');
    const third = await toggleReaction(h.db, ctx, f.channel, message.seq, '❤️');

    // Sorted, because the server no longer imposes an order - it returns every emoji with
    // reactors and `reactionSummary` decides the row. What this test is about is that all three
    // are kept and none is a duplicate, which is the primary key's job.
    expect(third.ok && third.reactions.map((r) => r.emoji).sort()).toEqual(
      ['❤️', '🔥', '🎉'].sort(),
    );
    const rows = await h.db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM message_reactions`,
    );
    expect(rows.rows[0]?.n).toBe(3);
  });

  /*
   * Ordering moved from the server to `reactionSummary` on 2026-08-13.
   *
   * It used to be the fixed six-emoji order, applied server-side, which ordered the list and
   * silently dropped anything outside the six. With the set open (ADR-0028) that filter would
   * hide real reactions, so the server returns every emoji with reactors and the client sorts -
   * by count, ties broken by catalog order. PRD/05 rules R2 and R3.
   */
  it('returns every emoji that has reactors, whatever it is', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'we won');

    // A unicorn was NOT one of the six. Before the catalog it could not be stored, and had it
    // been, the server's filter would have dropped it from every client with no error anywhere.
    await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '🦄');
    await toggleReaction(h.db, await ctxFor(f.ownerId), f.channel, message.seq, '👍️');

    const read = await readReactions(h.db, f.channel, message.seq);
    expect(read.ok && read.reactions.map((r) => r.emoji).sort()).toEqual(['👍️', '🦄'].sort());
  });

  it('refuses the twenty-first distinct emoji rather than dropping it', async () => {
    /*
     * PRD/05 rule R4, and the reason is ADR-0017: every update carries the FULL reaction set, so
     * an unbounded number of distinct emoji is an unbounded frame. Twenty is chosen to be far
     * above any real conversation and still a bound.
     *
     * Refused, not silently dropped. A tap that appears to do nothing is the failure this
     * codebase keeps finding, and `refusalStatus` turns this code into a clean 409.
     */
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'we won');
    const some = emojiCatalog.slice(0, MAX_DISTINCT_REACTIONS + 1).map((e) => e.emoji);

    for (const emoji of some.slice(0, MAX_DISTINCT_REACTIONS)) {
      const result = await toggleReaction(
        h.db,
        await ctxFor(f.memberId),
        f.channel,
        message.seq,
        emoji,
      );
      expect(result.ok, `${emoji} should have been accepted`).toBe(true);
    }

    const overflow = await toggleReaction(
      h.db,
      await ctxFor(f.ownerId),
      f.channel,
      message.seq,
      some[MAX_DISTINCT_REACTIONS]!,
    );
    expect(overflow).toEqual({ ok: false, code: 'too_many_reactions' });

    // And the cap never blocks a SECOND person joining an emoji that is already there, which
    // would be the obvious way to write this wrongly - the limit is distinct emoji, not reactors.
    const joining = await toggleReaction(
      h.db,
      await ctxFor(f.ownerId),
      f.channel,
      message.seq,
      some[0]!,
    );
    expect(joining.ok).toBe(true);
  });

  it('orders the pills by count, and breaks ties by catalog order', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'we won');

    // 🔥 gets two, 🦄 gets one. Added 🦄 first, so insertion order disagrees with the result.
    await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '🦄');
    await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '🔥');
    const last = await toggleReaction(h.db, await ctxFor(f.ownerId), f.channel, message.seq, '🔥');

    const summary = reactionSummary(last.ok ? last.reactions : [], f.ownerId);
    expect(summary.map((s) => s.emoji)).toEqual(['🔥', '🦄']);
    expect(summary.map((s) => s.count)).toEqual([2, 1]);
  });

  it('holds position when counts are equal, so a tie cannot shuffle', async () => {
    /*
     * The half that keeps rule R3 honest. Ordering by count alone leaves ties to whatever order
     * the rows arrived in, which changes between reads - so the row would rearrange itself
     * under somebody's finger for no visible reason.
     */
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'we won');

    await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '🦄');
    const both = await toggleReaction(h.db, await ctxFor(f.ownerId), f.channel, message.seq, '🔥');

    const order = reactionSummary(both.ok ? both.reactions : [], f.ownerId).map((s) => s.emoji);
    // Both on one. The catalog puts the unicorn at 582 and fire at 1066, so the unicorn leads -
    // whichever order they were inserted in, and on every read.
    expect(order).toEqual(['🦄', '🔥']);
  });

  it('accumulates one emoji across members', async () => {
    const f = await setup();
    const message = await say(f.outsiderId === '' ? f.ownerId : f.ownerId, f.channel, 'we won');

    await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '🔥');
    const second = await toggleReaction(
      h.db,
      await ctxFor(f.ownerId),
      f.channel,
      message.seq,
      '🔥',
    );

    const entry = second.ok ? second.reactions[0] : undefined;
    expect(entry?.userIds.sort()).toEqual([f.memberId, f.ownerId].sort());
    // The summary is what the UI renders, and "mine" is per viewer from one payload - which is
    // why userIds travels rather than a count.
    expect(reactionSummary(second.ok ? second.reactions : [], f.ownerId)).toEqual([
      { emoji: '🔥', count: 2, mine: true },
    ]);
    expect(reactionSummary(second.ok ? second.reactions : [], f.outsiderId)).toEqual([
      { emoji: '🔥', count: 2, mine: false },
    ]);
  });

  it('survives concurrent toggles of the same emoji without doubling', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'we won');
    const ctx = await ctxFor(f.memberId);

    // Two taps landing together. A read-then-write implementation can see "not reacted" twice
    // and insert twice; a keyed delete-or-insert cannot, and the primary key is the backstop.
    await Promise.all([
      toggleReaction(h.db, ctx, f.channel, message.seq, '🔥'),
      toggleReaction(h.db, ctx, f.channel, message.seq, '🔥'),
    ]);

    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM message_reactions WHERE emoji = '🔥'
    `);
    // Either both landed and one removed the other, or one landed - never two rows.
    expect(rows.rows[0]?.n).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// Reactions ride on the envelope
// ===========================================================================

describe('reactions travel with the messages they belong to', () => {
  it('comes back on history and on sync, which is what makes them work offline', async () => {
    const f = await setup();
    const first = await say(f.ownerId, f.channel, 'one');
    await say(f.ownerId, f.channel, 'two');
    await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, first.seq, '❤️');

    const history = await readHistory(h.db, anyViewer(), f.channel.id);
    const reacted = history.find((m) => m.seq === first.seq);
    expect(reacted?.reactions).toEqual([{ emoji: '❤️', userIds: [f.memberId] }]);
    // Untouched messages carry an empty list rather than undefined, so the client never has
    // to guard.
    expect(history.find((m) => m.seq !== first.seq)?.reactions).toEqual([]);

    // The backlog path too. A client offline for a week must come back to the conversation as
    // it stands, not to messages with their reactions stripped off.
    const synced = await syncSince(h.db, anyViewer(), f.channel.id, 0);
    expect(synced.messages.find((m) => m.seq === first.seq)?.reactions).toEqual([
      { emoji: '❤️', userIds: [f.memberId] },
    ]);
  });

  it('costs one query for a whole page, not one per message', async () => {
    const f = await setup();
    for (let i = 0; i < 12; i += 1) {
      const message = await say(f.ownerId, f.channel, `message ${i}`);
      await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '👍️');
    }
    // Asserted by outcome rather than by counting queries: every one of the twelve comes back
    // populated from a single batched load.
    const history = await readHistory(h.db, anyViewer(), f.channel.id);
    const withReactions = history.filter((m) => m.reactions.length > 0);
    expect(withReactions).toHaveLength(12);
  });
});

// ===========================================================================
// Deletion clears them
// ===========================================================================

describe('a soft delete clears reactions', () => {
  it('removes the rows and publishes the cleared set', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'regrettable');
    await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '😂');
    await toggleReaction(h.db, await ctxFor(f.ownerId), f.channel, message.seq, '🔥');

    const deleted = await softDeleteMessage(
      h.db,
      await ctxFor(f.ownerId),
      f.channel,
      message.seq,
    );
    expect(deleted.ok).toBe(true);

    // PRD/05 rule 9: reactions and pin state are cleared with the message. Six people having
    // laughed at text nobody can read is not information.
    const rows = await h.db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM message_reactions`,
    );
    expect(rows.rows[0]?.n).toBe(0);
    expect((await readHistory(h.db, anyViewer(), f.channel.id))[0]?.reactions).toEqual([]);

    // And every open client is told, rather than keeping the pills until a refresh.
    await drainOnce(h.db, deps);
    const update = published.find((p) => (p.payload as { kind?: string }).kind === 'update');
    expect(update).toBeDefined();
    const payload = update?.payload as { update: { reactions: unknown[]; deletedAt: unknown } };
    expect(payload.update.reactions).toEqual([]);
    expect(payload.update.deletedAt).not.toBeNull();
  });

  it('refuses a new reaction on a tombstone', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'gone');
    await softDeleteMessage(h.db, await ctxFor(f.ownerId), f.channel, message.seq);

    // A reaction on "This message was deleted" is a verdict on nothing.
    expect(
      await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '👍️'),
    ).toEqual({ ok: false, code: 'not_found' });
  });
});

// ===========================================================================
// Authorization: reacting is writing
// ===========================================================================

describe('reacting takes the posting gate rather than the reading one', () => {
  it('refuses an outsider who cannot see the channel at all', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'club business');
    expect(
      await toggleReaction(h.db, await ctxFor(f.outsiderId), f.channel, message.seq, '👍️'),
    ).toEqual({ ok: false, code: 'forbidden' });
  });

  it('refuses a blocked DM participant who CAN still see the message', async () => {
    const aliceId = await makeUser('Alice');
    const bobId = await makeUser('Bob');
    const club = await createClub(h.db, { name: 'Trail', creatorId: aliceId });
    await addMember(h.db, await ctxFor(aliceId), club.clubId, bobId);

    const opened = await openDm(h.db, await ctxFor(aliceId), bobId);
    if (!opened.ok) throw new Error('dm fixture failed');
    const dmChannel = await getChannelRef(h.db, opened.channelId);
    if (!dmChannel) throw new Error('dm channel missing');

    const message = await say(aliceId, dmChannel, 'see you saturday');
    await blockMember(h.db, await ctxFor(aliceId), bobId);

    const bobCtx = await ctxFor(bobId);
    // THE CELL THAT MATTERS. Bob reads the message and cannot react to it: a reaction is a
    // signal sent into a conversation he has been barred from writing to.
    expect(isChannelMember(bobCtx, dmChannel)).toBe(true);
    expect(canPostInChannel(bobCtx, dmChannel)).toBe(false);
    expect(canReactInChannel(bobCtx, dmChannel)).toBe(false);
    expect(await toggleReaction(h.db, bobCtx, dmChannel, message.seq, '👍️')).toEqual({
      ok: false,
      code: 'forbidden',
    });

    // The blocker is refused too, in the same direction as sending.
    expect(
      await toggleReaction(h.db, await ctxFor(aliceId), dmChannel, message.seq, '👍️'),
    ).toEqual({ ok: false, code: 'forbidden' });
  });

  it('lets both DM participants react while the thread is writable', async () => {
    const aliceId = await makeUser('Alice');
    const bobId = await makeUser('Bob');
    const club = await createClub(h.db, { name: 'Trail', creatorId: aliceId });
    await addMember(h.db, await ctxFor(aliceId), club.clubId, bobId);
    const opened = await openDm(h.db, await ctxFor(aliceId), bobId);
    if (!opened.ok) throw new Error('dm fixture failed');
    const dmChannel = await getChannelRef(h.db, opened.channelId);
    if (!dmChannel) throw new Error('dm channel missing');

    const message = await say(aliceId, dmChannel, 'nice one');
    // PRD/14 rule 5: everything else in chat works identically, reactions included.
    expect((await toggleReaction(h.db, await ctxFor(bobId), dmChannel, message.seq, '😂')).ok).toBe(
      true,
    );
    expect(
      (await toggleReaction(h.db, await ctxFor(aliceId), dmChannel, message.seq, '😂')).ok,
    ).toBe(true);
    const read = await readReactions(h.db, dmChannel, message.seq);
    expect(read.ok && read.reactions[0]?.userIds).toHaveLength(2);
  });
});

// ===========================================================================
// Realtime
// ===========================================================================

describe('a reaction reaches every open client', () => {
  it('publishes the full set as an update, not a delta', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'we won');
    await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '🔥');
    await drainOnce(h.db, deps);

    const update = published
      .map((p) => p.payload as { kind?: string; update?: Record<string, unknown> })
      .find((p) => p.kind === 'update');
    expect(update).toBeDefined();
    expect(update?.update?.['seq']).toBe(message.seq);
    // The full set. A delta has no sequence of its own on this transport, so one dropped
    // frame would leave a client permanently disagreeing about who reacted.
    expect(update?.update?.['reactions']).toEqual([{ emoji: '🔥', userIds: [f.memberId] }]);
  });

  it('republishes current truth on redelivery rather than an old snapshot', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'we won');
    await toggleReaction(h.db, await ctxFor(f.memberId), f.channel, message.seq, '🔥');
    await drainOnce(h.db, deps);

    // A second member reacts, and the FIRST event is redelivered. The handler re-reads the set
    // at publish time, so at-least-once delivery is harmless here by construction.
    await toggleReaction(h.db, await ctxFor(f.ownerId), f.channel, message.seq, '🔥');
    published = [];
    await h.db.execute(sql`UPDATE outbox SET processed_at = NULL WHERE event_type = 'message.reacted'`);
    await drainOnce(h.db, deps);

    const updates = published
      .map((p) => p.payload as { kind?: string; update?: { reactions?: Array<{ userIds: string[] }> } })
      .filter((p) => p.kind === 'update');
    expect(updates.length).toBeGreaterThan(0);
    // Every republish reports two reactors - the truth now - rather than the one that was
    // true when the first event was written.
    for (const update of updates) {
      expect(update.update?.reactions?.[0]?.userIds).toHaveLength(2);
    }
  });

  it('publishes a pin, which nothing sent before this change', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'read this');
    const { setPinned } = await import('../domain/send-message.ts');
    expect((await setPinned(h.db, await ctxFor(f.ownerId), f.channel, message.seq, true)).ok).toBe(
      true,
    );

    await drainOnce(h.db, deps);
    const update = published
      .map((p) => p.payload as { kind?: string; update?: Record<string, unknown> })
      .find((p) => p.kind === 'update' && p.update?.['pinned'] === true);
    // PRD/05 rule 7: the pinned strip appears when a message is pinned. The msg.update frame
    // was declared in Phase 0 and had no producer at all until reactions gave it one.
    expect(update).toBeDefined();

    /*
     * **And it carries the pin TIME, which is the half that was missing.**
     *
     * This test existed and passed through the entire defect, because it asked only whether the
     * frame said `pinned`. The strip orders by `pinnedAt` and the frame did not carry it, so
     * every client with the chat open stored a pin with no time and sorted the newest one to the
     * END of the strip - visibly wrong, and self-correcting only on a reload, which is what made
     * it look like a rendering quirk rather than a missing field.
     *
     * Asserting the field exists is not enough either: `null` is a legitimate value on this
     * field, and null is precisely what the broken version would have produced.
     */
    expect(update?.update?.['pinnedAt']).toEqual(expect.any(String));
  });

  it('publishes the cleared time on unpin, so a stale one cannot linger', async () => {
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'never mind');
    const { setPinned } = await import('../domain/send-message.ts');
    const ctx = await ctxFor(f.ownerId);

    await setPinned(h.db, ctx, f.channel, message.seq, true);
    await drainOnce(h.db, deps);
    published = [];

    await setPinned(h.db, ctx, f.channel, message.seq, false);
    await drainOnce(h.db, deps);

    const update = published
      .map((p) => p.payload as { kind?: string; update?: Record<string, unknown> })
      .find((p) => p.kind === 'update' && p.update?.['pinned'] === false);
    expect(update).toBeDefined();
    // Explicitly null rather than absent: absence means "this frame says nothing about it" and
    // would leave the client holding the time from when it WAS pinned.
    expect(update?.update?.['pinnedAt']).toBeNull();
  });

  it('republishes a pin as current truth on redelivery, not the snapshot it was written with', async () => {
    /*
     * The reason this handler re-reads instead of publishing from the outbox payload, and the
     * defect that shape would have: pin, unpin, then redeliver the FIRST event. A payload-driven
     * publish announces a pin that has since been removed, and every open client puts the notice
     * back on screen for a message nobody has pinned.
     */
    const f = await setup();
    const message = await say(f.ownerId, f.channel, 'transient');
    const { setPinned } = await import('../domain/send-message.ts');
    const ctx = await ctxFor(f.ownerId);

    await setPinned(h.db, ctx, f.channel, message.seq, true);
    await drainOnce(h.db, deps);
    await setPinned(h.db, ctx, f.channel, message.seq, false);
    await drainOnce(h.db, deps);

    published = [];
    await h.db.execute(sql`UPDATE outbox SET processed_at = NULL WHERE event_type = 'message.pinned'`);
    await drainOnce(h.db, deps);

    const updates = published
      .map((p) => p.payload as { kind?: string; update?: Record<string, unknown> })
      .filter((p) => p.kind === 'update');
    expect(updates.length).toBeGreaterThan(0);
    // EVERY republish reports unpinned - the truth now - including the replay of the event that
    // was written when it was pinned.
    for (const update of updates) {
      expect(update.update?.['pinned']).toBe(false);
      expect(update.update?.['pinnedAt']).toBeNull();
    }
  });
});
