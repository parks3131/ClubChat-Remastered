/**
 * THE PHASE 3.5 EXIT GATE.
 *
 * SPEC/TECH/16: *"Done when: a blocked member can neither open a thread nor send into an
 * existing one, in either direction; a DM report reaches the moderation queue and reaches no
 * club admin; and a muted conversation produces no push while still incrementing its unread
 * count."*
 *
 * Three clauses, and each has a half that is easy to fake:
 *
 *  - **"in either direction"** is the whole of the blocking clause. A one-directional block
 *    passes every test written from the blocker's point of view and leaves the blocked party
 *    sending into a void. So every refusal here is asserted from BOTH sides.
 *  - **"and reaches no club admin"** is the whole of the report clause. Proving a moderator can
 *    see a report proves nothing about who else can, so the club's own Owner is driven against
 *    every reading path and must be refused by all of them.
 *  - **"while still incrementing its unread count"** is the whole of the mute clause. A mute
 *    implemented as "mark read" silences the push too and would pass a push-only assertion.
 *
 * Each clause also carries a mutation check: the authorization is deleted, the gate is re-run,
 * and it must fail. A gate that still passes with the check removed was never testing it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createClub } from '../domain/create-club.ts';
import { addMember, changeRole, leaveClub } from '../domain/membership.ts';
import { sendMessage } from '../domain/send-message.ts';
import { getChannelRef, listAccessibleChannels, readHistory } from '../domain/reads.ts';
import { badgeCount, openChat, readInbox } from '../domain/inbox.ts';
import {
  blockMember,
  canonicalPair,
  listBlocks,
  listDmThreads,
  muteChannel,
  openDm,
  readChannelMeta,
  searchDmCandidates,
  unblockMember,
  unmuteChannel,
} from '../domain/dm.ts';
import {
  dismissReport,
  listChannelReports,
  listDmReportQueue,
  listModerationReads,
  MODERATION_CONTEXT_RADIUS,
  readReportedContext,
  reportMessage,
} from '../domain/moderation.ts';
import { channelAudienceById } from '../domain/channel-access.ts';
import { accessContextOf, loadAccessContext, type AccessContext } from '../policy/context.ts';
import {
  canDeleteMessage,
  canOpenDm,
  canPinInChannel,
  canPostInChannel,
  canPostInDm,
  isChannelMember,
  type ChannelRef,
} from '../policy/predicates.ts';
import { drainOnce } from '../worker/drain.ts';
import { notificationKey, NOTIFICATION_SLOTS } from '../worker/notify.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { registerDevice } from '../push/dispatch.ts';
import { users } from '../db/schema.ts';
import { startTestDb, type TestDb } from './harness.ts';
import type { EffectDeps } from '../worker/effects.ts';

let h: TestDb;
let push: RecordingPushSender;
let deferred: Array<() => Promise<void>>;
let deps: EffectDeps;

const silent = () => undefined;

beforeAll(async () => {
  h = await startTestDb();
});
afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  push = new RecordingPushSender();
  deferred = [];
  // Several assertions below are deliberately unfiltered - "no push at all" is a stronger claim
  // than "no push to this person", and it only means anything if each test starts empty.
  // Truncating is safe here and nowhere else: this is a throwaway container.
  await h.db.execute(sql`
    TRUNCATE notifications, push_deliveries, devices, channel_mutes, outbox,
             member_blocks, message_reports, moderation_reads
    RESTART IDENTITY CASCADE
  `);
  deps = {
    db: h.db,
    redis: { publish: async () => 1 } as never,
    push,
    log: silent,
    defer: (fn) => deferred.push(fn),
  };
});

/** Drain the outbox, then run whatever push evaluation it deferred. */
async function drainAndPush(): Promise<void> {
  await drainOnce(h.db, deps);
  const pending = [...deferred];
  deferred = [];
  for (const fn of pending) await fn();
}

const ctxFor = (id: string) => loadAccessContext(h.db, id);

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({ id, name, email: `${name}-${id.slice(0, 8)}@t.invalid` });
  return id;
}

async function makeModerator(name: string): Promise<string> {
  const id = await makeUser(name);
  await h.db.execute(sql`UPDATE users SET is_platform_moderator = true WHERE id = ${id}`);
  return id;
}

type Fixture = {
  clubId: string;
  clubChannelId: string;
  ownerId: string;
  aliceId: string;
  bobId: string;
  strangerId: string;
  conversationId: string;
  dmChannelId: string;
  dmChannel: ChannelRef;
};

/**
 * A club with an Owner and two ordinary members who hold a DM, plus a stranger in no club.
 *
 * The Owner exists to be refused: they are the most privileged person in the club the
 * conversation's participants belong to, and they must still be unable to read a word of it.
 */
async function setup(): Promise<Fixture> {
  const ownerId = await makeUser('Owner');
  const aliceId = await makeUser('Alice');
  const bobId = await makeUser('Bob');
  const strangerId = await makeUser('Stranger');

  const club = await createClub(h.db, { name: 'Hillside', sport: 'running', creatorId: ownerId });
  await addMember(h.db, await ctxFor(ownerId), club.clubId, aliceId);
  await addMember(h.db, await ctxFor(ownerId), club.clubId, bobId);

  const opened = await openDm(h.db, await ctxFor(aliceId), bobId);
  if (!opened.ok) throw new Error('fixture could not open the conversation');

  const dmChannel = await getChannelRef(h.db, opened.channelId);
  if (!dmChannel) throw new Error('fixture dm channel missing');

  return {
    clubId: club.clubId,
    clubChannelId: club.mainChannelId,
    ownerId,
    aliceId,
    bobId,
    strangerId,
    conversationId: opened.conversationId,
    dmChannelId: opened.channelId,
    dmChannel,
  };
}

/** Send as a user through the authorized command, the way the gateway does. */
async function say(userId: string, channel: ChannelRef, body: string) {
  return sendMessage(h.db, await ctxFor(userId), channel, {
    channelId: channel.id,
    clientMsgId: crypto.randomUUID(),
    body,
  });
}

// ===========================================================================
// The conversation itself
// ===========================================================================

describe('one thread per pair of people, ever', () => {
  it('returns the same thread whichever side opens it, however many times', async () => {
    const f = await setup();

    const again = await openDm(h.db, await ctxFor(f.aliceId), f.bobId);
    const fromBob = await openDm(h.db, await ctxFor(f.bobId), f.aliceId);

    expect(again.ok && again.conversationId).toBe(f.conversationId);
    expect(fromBob.ok && fromBob.conversationId).toBe(f.conversationId);
    // The channel is the same one too, not merely the conversation. A second channel on the
    // same conversation would split the log in half.
    expect(fromBob.ok && fromBob.channelId).toBe(f.dmChannelId);

    const count = await h.db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM dm_conversations`,
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it('stays one thread when the pair shares a second club', async () => {
    const f = await setup();
    // Two people in three clubs have one conversation, not three. That is the reason
    // channels.club_id is nullable for this scope at all.
    const second = await createClub(h.db, {
      name: 'Trail Club',
      sport: 'trail',
      creatorId: f.aliceId,
    });
    await addMember(h.db, await ctxFor(f.aliceId), second.clubId, f.bobId);

    const again = await openDm(h.db, await ctxFor(f.aliceId), f.bobId);
    expect(again.ok && again.conversationId).toBe(f.conversationId);
  });

  it('sorts the pair into the order the database check demands', () => {
    // Postgres compares uuid as raw bytes and lowercase hex compares identically, so the
    // lowercasing is not cosmetic: an uppercase input sorts before every lowercase one and
    // would produce a pair the CHECK rejects.
    expect(canonicalPair('BBBB', 'aaaa')).toEqual(['aaaa', 'bbbb']);
    expect(canonicalPair('aaaa', 'bbbb')).toEqual(['aaaa', 'bbbb']);
    expect(canonicalPair('bbbb', 'aaaa')).toEqual(['aaaa', 'bbbb']);
  });

  it('has exactly two participants, and a club has nothing to do with it', async () => {
    const f = await setup();
    const audience = await channelAudienceById(h.db, f.dmChannelId);
    expect(audience.sort()).toEqual([f.aliceId, f.bobId].sort());
    // Not the Owner, not the whole club.
    expect(audience).not.toContain(f.ownerId);
    expect(f.dmChannel.clubId).toBeNull();
  });

  it('is refused for somebody who shares no club, and for oneself', async () => {
    const f = await setup();
    const asAlice = await ctxFor(f.aliceId);

    expect(await openDm(h.db, asAlice, f.strangerId)).toEqual({ ok: false, code: 'not_found' });
    expect(await openDm(h.db, asAlice, f.aliceId)).toEqual({ ok: false, code: 'invalid' });
    // There is no global user search: a stranger is not offered either.
    const candidates = await searchDmCandidates(h.db, asAlice, {});
    expect(candidates.map((c) => c.userId)).not.toContain(f.strangerId);
    expect(candidates.map((c) => c.userId)).toContain(f.bobId);
  });

  it('appears in the channel list and the unread machinery, like every other scope', async () => {
    const f = await setup();
    await say(f.aliceId, f.dmChannel, 'can you drive saturday');

    const bobChannels = await listAccessibleChannels(h.db, f.bobId);
    const dm = bobChannels.find((c) => c.id === f.dmChannelId);
    expect(dm, 'the dm channel must appear in the accessible list').toBeDefined();
    expect(dm?.scope).toBe('dm');
    expect(dm?.clubId).toBeNull();
    expect((dm?.lastSeq ?? 0) - (dm?.lastReadSeq ?? 0)).toBe(1);

    // And it is invisible to the Owner of the club both participants are in.
    const ownerChannels = await listAccessibleChannels(h.db, f.ownerId);
    expect(ownerChannels.map((c) => c.id)).not.toContain(f.dmChannelId);

    // The inbox merges it as a chat-unread row, named after the other person.
    const inbox = await readInbox(h.db, f.bobId);
    const row = inbox.rows.find((r) => r.kind === 'chat_unread' && r.channelId === f.dmChannelId);
    expect(row).toBeDefined();
    expect(row?.kind === 'chat_unread' && row.channelName).toBe('Alice');
  });
});

describe('a DM has no admins, but it does have pins', () => {
  it('refuses an announcement from either participant', async () => {
    const f = await setup();
    for (const [name, id] of [
      ['alice', f.aliceId],
      ['bob', f.bobId],
    ] as const) {
      const result = await sendMessage(h.db, await ctxFor(id), f.dmChannel, {
        channelId: f.dmChannelId,
        clientMsgId: crypto.randomUUID(),
        type: 'announcement',
        body: 'listen up',
      });
      expect(result, `announcement from ${name}`).toEqual({ ok: false, code: 'forbidden' });
    }
  });

  it('lets either participant pin, which isChannelAdmin alone would have denied', async () => {
    const f = await setup();
    // PRD/14 rule 4 says a DM has no admins AND that either participant may pin for reference.
    // Those only coexist because pinning is its own predicate rather than an alias of
    // isChannelAdmin - which is how it was written until this phase.
    for (const id of [f.aliceId, f.bobId]) {
      expect(canPinInChannel(await ctxFor(id), f.dmChannel)).toBe(true);
    }
    expect(canPinInChannel(await ctxFor(f.ownerId), f.dmChannel)).toBe(false);
  });

  /*
   * The chat screen decides whether to OFFER the announcement toggle and Delete from the channel
   * meta, so the meta has to carry both capabilities as their own fields. Pinned here because
   * getting either wrong is silent: a control that should not be there still refuses on the
   * server, and a control that should be there just never appears.
   */
  it('reports announce and delete authority on the meta, and never from canPin', async () => {
    const f = await setup();

    const asOwner = await readChannelMeta(h.db, await ctxFor(f.ownerId), f.clubChannelId);
    const asMember = await readChannelMeta(h.db, await ctxFor(f.aliceId), f.clubChannelId);
    if (!asOwner.ok || !asMember.ok) throw new Error('club channel meta unreadable');

    expect(asOwner.canAnnounce).toBe(true);
    expect(asOwner.canDeleteAnyMessage).toBe(true);
    // A plain member gets neither, and the screen therefore renders neither control.
    expect(asMember.canAnnounce).toBe(false);
    expect(asMember.canDeleteAnyMessage).toBe(false);

    /*
     * The DM row is the one that proves these are not aliases of `canPin`.
     *
     * Both participants CAN pin (rule 4 above) and neither may announce or delete the other's
     * message, because a DM has no admin. A client computing either from `canPin` would offer
     * both to both people in every DM in the product.
     */
    const asAlice = await readChannelMeta(h.db, await ctxFor(f.aliceId), f.dmChannelId);
    if (!asAlice.ok) throw new Error('dm meta unreadable');
    expect(asAlice.canPin).toBe(true);
    expect(asAlice.canAnnounce).toBe(false);
    expect(asAlice.canDeleteAnyMessage).toBe(false);
  });

  it('refuses a member deleting somebody else\'s message, and allows their own', async () => {
    const f = await setup();
    const clubChannel = await getChannelRef(h.db, f.clubChannelId);
    if (!clubChannel) throw new Error('club channel missing');

    const posted = await sendMessage(h.db, await ctxFor(f.aliceId), clubChannel, {
      channelId: f.clubChannelId,
      clientMsgId: crypto.randomUUID(),
      type: 'text',
      body: 'mine',
    });
    if (!posted.ok) throw new Error('fixture message not sent');

    // Proved by attempting it, not by reading the rule. Bob is a plain member, so somebody
    // else's message is not his to remove.
    expect(
      canDeleteMessage(await ctxFor(f.bobId), clubChannel, { senderId: f.aliceId }),
    ).toBe(false);
    // Her own always is, with no admin standing at all.
    expect(
      canDeleteMessage(await ctxFor(f.aliceId), clubChannel, { senderId: f.aliceId }),
    ).toBe(true);
    // And the club Owner may remove anybody's.
    expect(
      canDeleteMessage(await ctxFor(f.ownerId), clubChannel, { senderId: f.aliceId }),
    ).toBe(true);
  });
});

// ===========================================================================
// GATE 1: blocking, in either direction
// ===========================================================================

describe('GATE: a blocked member can neither open a thread nor send, in either direction', () => {
  it('refuses both parties, while leaving history readable to both', async () => {
    const f = await setup();
    await say(f.aliceId, f.dmChannel, 'can you drive saturday');
    await say(f.bobId, f.dmChannel, 'yes');

    const blocked = await blockMember(h.db, await ctxFor(f.aliceId), f.bobId);
    expect(blocked.ok).toBe(true);

    // --- Neither can SEND. The blocked party's refusal is the one that matters: a
    // one-directional block leaves them sending into a void.
    const fromAlice = await say(f.aliceId, f.dmChannel, 'actually no');
    const fromBob = await say(f.bobId, f.dmChannel, 'hello?');
    expect(fromAlice, 'the blocker must not be able to send either').toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(fromBob, 'the blocked party must not be able to send').toEqual({
      ok: false,
      code: 'forbidden',
    });

    // --- Neither can OPEN a thread, and the refusal is indistinguishable from "no such
    // member". A distinguishable code would make the block detectable by anyone who calls
    // the endpoint, which defeats hiding it everywhere else.
    const strangerRefusal = await openDm(h.db, await ctxFor(f.aliceId), f.strangerId);
    expect(await openDm(h.db, await ctxFor(f.bobId), f.aliceId)).toEqual(strangerRefusal);
    expect(await openDm(h.db, await ctxFor(f.aliceId), f.bobId)).toEqual(strangerRefusal);

    // --- Both still READ. Blocking does not delete the conversation, and hiding history
    // would be a different feature with a different name.
    for (const id of [f.aliceId, f.bobId]) {
      const ctx = await ctxFor(id);
      expect(isChannelMember(ctx, f.dmChannel), `read access for ${id}`).toBe(true);
      const history = await readHistory(h.db, f.dmChannelId);
      expect(history).toHaveLength(2);
      expect(history[0]?.body).toBe('can you drive saturday');
    }

    // --- Each is absent from the other's search, in both directions.
    const aliceSees = await searchDmCandidates(h.db, await ctxFor(f.aliceId), {});
    const bobSees = await searchDmCandidates(h.db, await ctxFor(f.bobId), {});
    expect(aliceSees.map((c) => c.userId)).not.toContain(f.bobId);
    expect(bobSees.map((c) => c.userId)).not.toContain(f.aliceId);
    // The Owner is unaffected: a block is between two people, not a club-wide event.
    expect(bobSees.map((c) => c.userId)).toContain(f.ownerId);
  });

  it('states a reason to each side without telling the blocked party who did it', async () => {
    const f = await setup();
    await blockMember(h.db, await ctxFor(f.aliceId), f.bobId);

    const forAlice = await readChannelMeta(h.db, await ctxFor(f.aliceId), f.dmChannelId);
    const forBob = await readChannelMeta(h.db, await ctxFor(f.bobId), f.dmChannelId);

    expect(forAlice.ok && forAlice.canPost).toBe(false);
    expect(forBob.ok && forBob.canPost).toBe(false);
    // The blocker is told what they did and offered the way back.
    expect(forAlice.ok && forAlice.postDeniedReason).toBe('you_blocked_them');
    expect(forAlice.ok && forAlice.peer?.blockedByMe).toBe(true);
    // The blocked party learns they cannot send and NOT that they were blocked - the same
    // answer they would get from having lost the last shared club.
    expect(forBob.ok && forBob.postDeniedReason).toBe('unavailable');
    expect(forBob.ok && forBob.peer?.blockedByMe).toBe(false);
  });

  it('only ever shows a member their own blocks', async () => {
    const f = await setup();
    await blockMember(h.db, await ctxFor(f.aliceId), f.bobId);

    expect((await listBlocks(h.db, await ctxFor(f.aliceId))).map((b) => b.userId)).toEqual([
      f.bobId,
    ]);
    // "Who has blocked you" is never returned, or rule 6 would be pointless.
    expect(await listBlocks(h.db, await ctxFor(f.bobId))).toEqual([]);
  });

  it('is idempotent, and unblocking restores sending without replaying anything', async () => {
    const f = await setup();
    const asAlice = await ctxFor(f.aliceId);
    await blockMember(h.db, asAlice, f.bobId);
    // A double tap must not error.
    expect((await blockMember(h.db, await ctxFor(f.aliceId), f.bobId)).ok).toBe(true);

    // A message attempted during the block was refused at the time, not held.
    const refused = await say(f.bobId, f.dmChannel, 'held?');
    expect(refused.ok).toBe(false);

    await unblockMember(h.db, await ctxFor(f.aliceId), f.bobId);
    const now = await say(f.bobId, f.dmChannel, 'back');
    expect(now.ok).toBe(true);

    const history = await readHistory(h.db, f.dmChannelId);
    // Exactly one message: nothing was retroactively delivered.
    expect(history.map((m) => m.body)).toEqual(['back']);
    // Unblocking somebody who is not blocked is a no-op rather than an error.
    expect((await unblockMember(h.db, await ctxFor(f.aliceId), f.bobId)).ok).toBe(true);
  });

  it('lets a blocked member still report, which is when they most need to', async () => {
    const f = await setup();
    const said = await say(f.aliceId, f.dmChannel, 'something awful');
    expect(said.ok).toBe(true);

    // Bob blocks Alice, THEN reports her message. Gating reporting on the ability to send
    // would take the reporting path away at exactly the moment it is needed.
    await blockMember(h.db, await ctxFor(f.bobId), f.aliceId);
    const report = await reportMessage(
      h.db,
      await ctxFor(f.bobId),
      f.dmChannel,
      said.ok ? said.message.seq : 0,
    );
    expect(report.ok).toBe(true);
  });

  it('MUTATION: deleting the block check from canPostInDm lets a blocked send through', async () => {
    // The mutation, run against the predicate rather than the database: the fabricated context
    // is exactly what a blocked participant's real one looks like.
    const conversationId = 'c0ffee00-0000-4000-8000-000000000001';
    const peer = 'd0d0d0d0-0000-4000-8000-000000000002';
    const blockedCtx: AccessContext = accessContextOf({
      userId: '11111111-1111-4111-8111-111111111111',
      dmThreads: [{ conversationId, otherUserId: peer, sharesClub: true }],
      blockedEither: [peer],
    });

    expect(canPostInDm(blockedCtx, conversationId)).toBe(false);

    // The mutant: participation and a shared club, with the block ignored. It says yes, which
    // is the failure the real predicate exists to prevent.
    const mutant = (ctx: AccessContext, id: string): boolean => {
      const thread = ctx.dmThreads.get(id);
      return thread !== undefined && thread.sharesClub;
    };
    expect(mutant(blockedCtx, conversationId)).toBe(true);
  });

  it('MUTATION: reading the block one-directionally lets the blocked party keep sending', () => {
    // `blockedEither` is symmetric because the context collapsed both directions when it
    // loaded. This is what a one-directional read would have produced instead.
    const conversationId = 'c0ffee00-0000-4000-8000-000000000003';
    const blocker = 'aaaa0000-0000-4000-8000-000000000004';
    const blockedParty = accessContextOf({
      userId: 'bbbb0000-0000-4000-8000-000000000005',
      dmThreads: [{ conversationId, otherUserId: blocker, sharesClub: true }],
      // What "blocked BY me only" would load for the person on the receiving end: nothing.
      blockedEither: [],
    });
    expect(canPostInDm(blockedParty, conversationId)).toBe(true);
    // Which is why the loader reads `blocker_id = me OR blocked_id = me`, asserted for real in
    // the round trip above rather than only here.
  });
});

// ===========================================================================
// Read-only, not deleted: losing the last shared club
// ===========================================================================

describe('losing the last shared club makes a thread read-only, and re-joining undoes it', () => {
  it('flips both ways with no job and no stored flag', async () => {
    const f = await setup();
    await say(f.aliceId, f.dmChannel, 'see you at practice');

    await leaveClub(h.db, await ctxFor(f.bobId), f.clubId);

    // Read-only for BOTH: writability is a property of the pair, not of who left.
    for (const id of [f.aliceId, f.bobId]) {
      const ctx = await ctxFor(id);
      expect(canPostInChannel(ctx, f.dmChannel), `post for ${id}`).toBe(false);
      expect(isChannelMember(ctx, f.dmChannel), `read for ${id}`).toBe(true);
    }
    expect((await say(f.aliceId, f.dmChannel, 'hello?')).ok).toBe(false);

    // History survives. The thread is read-only, not deleted - the same principle as a message
    // never being hard-deleted.
    expect(await readHistory(h.db, f.dmChannelId)).toHaveLength(1);
    const threads = await listDmThreads(h.db, await ctxFor(f.bobId));
    expect(threads.map((t) => t.conversationId)).toContain(f.conversationId);
    expect(threads[0]?.canPost).toBe(false);

    // Re-joining makes it writable again with nothing to backfill, because nothing was ever
    // stored. That is the whole argument of ADR-0016, asserted rather than reasoned about.
    await addMember(h.db, await ctxFor(f.ownerId), f.clubId, f.bobId);
    expect((await say(f.aliceId, f.dmChannel, 'welcome back')).ok).toBe(true);
    expect(canPostInChannel(await ctxFor(f.bobId), f.dmChannel)).toBe(true);
  });

  it('a read-only thread reports the neutral reason, not the block one', async () => {
    const f = await setup();
    await leaveClub(h.db, await ctxFor(f.bobId), f.clubId);
    const meta = await readChannelMeta(h.db, await ctxFor(f.aliceId), f.dmChannelId);
    // Indistinguishable from having been blocked, which is what keeps a block quiet.
    expect(meta.ok && meta.postDeniedReason).toBe('unavailable');
  });
});

// ===========================================================================
// GATE 2: a DM report reaches the moderation queue and no club admin
// ===========================================================================

describe('GATE: a DM report reaches platform moderators and reaches no club admin', () => {
  it('routes by the reported channel scope, in both directions', async () => {
    const f = await setup();
    const moderatorId = await makeModerator('Moderator');

    const dmSaid = await say(f.aliceId, f.dmChannel, 'something awful');
    const clubChannel = await getChannelRef(h.db, f.clubChannelId);
    const clubSaid = await say(f.aliceId, clubChannel!, 'something rude in club chat');
    expect(dmSaid.ok && clubSaid.ok).toBe(true);

    await reportMessage(h.db, await ctxFor(f.bobId), f.dmChannel, dmSaid.ok ? dmSaid.message.seq : 0);
    await reportMessage(
      h.db,
      await ctxFor(f.bobId),
      clubChannel!,
      clubSaid.ok ? clubSaid.message.seq : 0,
    );

    // --- The moderator sees the DM report, and ONLY the DM report.
    const queue = await listDmReportQueue(h.db, await ctxFor(moderatorId));
    expect(queue.ok).toBe(true);
    const queued = queue.ok ? queue.reports : [];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.messageId).toBe(dmSaid.ok ? dmSaid.message.id : '');
    expect(queued[0]?.conversationId).toBe(f.conversationId);
    expect(queued[0]?.reporters.map((r) => r.userId)).toEqual([f.bobId]);
    // Metadata only. The list is not a door into the conversation; readReportedContext is,
    // and it is logged.
    expect(Object.keys(queued[0] ?? {})).not.toContain('body');

    // --- The club Owner - the most privileged person in the club both participants are in -
    // is refused by every path into that DM report.
    const asOwner = await ctxFor(f.ownerId);
    expect(await listDmReportQueue(h.db, asOwner)).toEqual({ ok: false, code: 'not_found' });
    expect(await listChannelReports(h.db, asOwner, f.dmChannel)).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(
      await readReportedContext(h.db, asOwner, dmSaid.ok ? dmSaid.message.id : ''),
    ).toEqual({ ok: false, code: 'not_found' });
    expect(await dismissReport(h.db, asOwner, dmSaid.ok ? dmSaid.message.id : '')).toEqual({
      ok: false,
      code: 'not_found',
    });

    // --- And the converse, which is the half that proves the routing is a selection rather
    // than a blanket grant: the club report goes to the Owner and NOT to the moderator.
    const clubReports = await listChannelReports(h.db, asOwner, clubChannel!);
    expect(clubReports.ok && clubReports.reports).toHaveLength(1);
    expect(clubReports.ok && clubReports.reports[0]?.body).toBe('something rude in club chat');

    const asModerator = await ctxFor(moderatorId);
    // A platform moderator has no standing at all in a club channel. They are not a tier
    // above Owner; they hold exactly one capability.
    expect(await listChannelReports(h.db, asModerator, clubChannel!)).toEqual({
      ok: false,
      code: 'not_found',
    });
    const modQueue = await listDmReportQueue(h.db, asModerator);
    expect(modQueue.ok && modQueue.reports.map((r) => r.messageId)).not.toContain(
      clubSaid.ok ? clubSaid.message.id : '',
    );
  });

  it('narrows the moderator read to a window and logs it', async () => {
    const f = await setup();
    const moderatorId = await makeModerator('Moderator');

    // Twenty-five messages, so the window is provably a window rather than "all of them".
    let reportedSeq = 0;
    let reportedId = '';
    for (let i = 1; i <= 25; i += 1) {
      const sent = await say(i % 2 === 0 ? f.bobId : f.aliceId, f.dmChannel, `message ${i}`);
      if (i === 13 && sent.ok) {
        reportedSeq = sent.message.seq;
        reportedId = sent.message.id;
      }
    }
    await reportMessage(h.db, await ctxFor(f.bobId), f.dmChannel, reportedSeq);

    const context = await readReportedContext(h.db, await ctxFor(moderatorId), reportedId);
    expect(context.ok).toBe(true);
    if (!context.ok) return;

    expect(context.reportedSeq).toBe(reportedSeq);
    expect(context.fromSeq).toBe(reportedSeq - MODERATION_CONTEXT_RADIUS);
    expect(context.toSeq).toBe(reportedSeq + MODERATION_CONTEXT_RADIUS);
    expect(context.messages).toHaveLength(MODERATION_CONTEXT_RADIUS * 2 + 1);
    // Nowhere near the 25 that exist. Moderation is not a licence to browse.
    expect(context.messages.map((m) => m.body)).not.toContain('message 1');
    expect(context.messages.map((m) => m.body)).not.toContain('message 25');

    // The read is logged, with the window that was actually served.
    const trail = await listModerationReads(h.db, await ctxFor(moderatorId));
    expect(trail.ok && trail.reads).toHaveLength(1);
    expect(trail.ok && trail.reads[0]?.fromSeq).toBe(context.fromSeq);
    expect(trail.ok && trail.reads[0]?.toSeq).toBe(context.toSeq);
    expect(trail.ok && trail.reads[0]?.channelId).toBe(f.dmChannelId);
  });

  it('clamps the window at the start of the log rather than asking for seq zero', async () => {
    const f = await setup();
    const moderatorId = await makeModerator('Moderator');
    const first = await say(f.aliceId, f.dmChannel, 'the very first message');
    await reportMessage(h.db, await ctxFor(f.bobId), f.dmChannel, first.ok ? first.message.seq : 0);

    const context = await readReportedContext(
      h.db,
      await ctxFor(moderatorId),
      first.ok ? first.message.id : '',
    );
    // seq is constrained positive by the schema, so a window starting below 1 would be a query
    // for rows that cannot exist.
    expect(context.ok && context.fromSeq).toBe(1);
  });

  it('a moderator cannot read a conversation nobody reported', async () => {
    const f = await setup();
    const moderatorId = await makeModerator('Moderator');
    const said = await say(f.aliceId, f.dmChannel, 'private');

    // No report filed. The queue is the only door, and it is not ajar.
    expect(
      await readReportedContext(h.db, await ctxFor(moderatorId), said.ok ? said.message.id : ''),
    ).toEqual({ ok: false, code: 'not_found' });
    expect(isChannelMember(await ctxFor(moderatorId), f.dmChannel)).toBe(false);
    const trail = await listModerationReads(h.db, await ctxFor(moderatorId));
    expect(trail.ok && trail.reads).toHaveLength(0);
  });

  it('reporting twice is a no-op, and nobody can report themselves', async () => {
    const f = await setup();
    const said = await say(f.aliceId, f.dmChannel, 'x');
    const seq = said.ok ? said.message.seq : 0;

    const first = await reportMessage(h.db, await ctxFor(f.bobId), f.dmChannel, seq);
    const second = await reportMessage(h.db, await ctxFor(f.bobId), f.dmChannel, seq);
    expect(first.ok && first.alreadyReported).toBe(false);
    // Still a success - the outcome the reporter wanted is true - but no second row.
    expect(second.ok && second.alreadyReported).toBe(true);

    const rows = await h.db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM message_reports`,
    );
    expect(rows.rows[0]?.n).toBe(1);

    expect(await reportMessage(h.db, await ctxFor(f.aliceId), f.dmChannel, seq)).toEqual({
      ok: false,
      code: 'forbidden',
    });
    // And an outsider cannot report into a conversation they cannot read.
    expect(await reportMessage(h.db, await ctxFor(f.ownerId), f.dmChannel, seq)).toEqual({
      ok: false,
      code: 'forbidden',
    });
  });

  it('tells the other participant nothing', async () => {
    const f = await setup();
    const said = await say(f.aliceId, f.dmChannel, 'reportable');
    await reportMessage(h.db, await ctxFor(f.bobId), f.dmChannel, said.ok ? said.message.seq : 0);
    await drainAndPush();

    // No notification to anyone, and no push. A report is a work list entry, not an event.
    const notifications = await h.db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'dm_message'`,
    );
    expect(notifications.rows[0]?.n).toBe(0);
    expect(
      push.sent.some((m) => (m.body ?? '').includes('report')),
      'a report must not surface as a push to anybody',
    ).toBe(false);
  });

  it('lets a moderator dismiss a DM report and a club admin dismiss a club one', async () => {
    const f = await setup();
    const moderatorId = await makeModerator('Moderator');
    const said = await say(f.aliceId, f.dmChannel, 'x');
    await reportMessage(h.db, await ctxFor(f.bobId), f.dmChannel, said.ok ? said.message.seq : 0);

    const dismissed = await dismissReport(
      h.db,
      await ctxFor(moderatorId),
      said.ok ? said.message.id : '',
    );
    expect(dismissed.ok && dismissed.dismissed).toBe(1);

    const open = await listDmReportQueue(h.db, await ctxFor(moderatorId));
    expect(open.ok && open.reports).toHaveLength(0);
    const all = await listDmReportQueue(h.db, await ctxFor(moderatorId), {
      includeDismissed: true,
    });
    // Kept, never deleted: the record of what was decided survives.
    expect(all.ok && all.reports).toHaveLength(1);
    expect(all.ok && all.reports[0]?.dismissedAt).not.toBeNull();
  });

  it('MUTATION: routing reports to space admins with no dm branch exposes the conversation', async () => {
    const f = await setup();
    // The mutant is the natural implementation - "reports go to the admins of that space" -
    // applied without noticing a DM has none. `isChannelAdmin` is false for the scope, so it
    // refuses both participants; the danger is the version that falls back to the CLUB, which
    // is what a scope-blind lookup on channels.club_id would do. Here the club is null, so the
    // fallback would have to reach for the participants' clubs - and this asserts the shape
    // that makes it impossible: the channel carries no club at all.
    expect(f.dmChannel.clubId).toBeNull();
    const asOwner = await ctxFor(f.ownerId);
    // No club id on the channel means no path from the Owner's club role to this conversation.
    expect(isChannelMember(asOwner, f.dmChannel)).toBe(false);
    expect(canOpenDm(asOwner, { userId: f.aliceId, clubIds: [f.clubId] })).toBe(true);
    // The Owner may DM Alice, which is a different thing entirely from reading Alice's DMs.
  });
});

// ===========================================================================
// GATE 3: a muted conversation produces no push, and still counts
// ===========================================================================

describe('GATE: a muted conversation produces no push while its unread count still climbs', () => {
  it('silences the buzz and leaves the count alone', async () => {
    const f = await setup();
    await registerDevice(h.db, { userId: f.bobId, pushToken: 'bob-phone', platform: 'ios' });

    // --- First, the control. An UNMUTED direct message must push, or the mute assertion
    // below would pass against a build that never pushed DMs at all.
    await say(f.aliceId, f.dmChannel, 'unmuted one');
    await drainAndPush();
    expect(push.sent.map((m) => m.token)).toEqual(['bob-phone']);
    expect(push.sent[0]?.title).toBe('Alice');
    expect(push.sent[0]?.body).toBe('unmuted one');
    push.reset();

    // --- Now mute, and send again.
    const muted = await muteChannel(h.db, await ctxFor(f.bobId), f.dmChannel, null);
    expect(muted.ok).toBe(true);

    const before = await listDmThreads(h.db, await ctxFor(f.bobId));
    const unreadBefore = before[0]?.unread ?? 0;

    await say(f.aliceId, f.dmChannel, 'muted one');
    await drainAndPush();

    // No push to anybody, not merely none to Bob.
    expect(push.sent, 'a muted conversation must produce no push').toHaveLength(0);

    // And the count still climbed. A mute implemented as "mark as read" would silence the
    // push too and pass a push-only assertion while silently marking things read.
    const after = await listDmThreads(h.db, await ctxFor(f.bobId));
    expect(after[0]?.unread).toBe(unreadBefore + 1);
    expect(after[0]?.muted).toBe(true);
    // The badge counts the conversation too, muted or not.
    expect(await badgeCount(h.db, f.bobId)).toBeGreaterThan(0);

    // --- Unmuting restores the buzz.
    await unmuteChannel(h.db, await ctxFor(f.bobId), f.dmChannel);
    await say(f.aliceId, f.dmChannel, 'audible again');
    await drainAndPush();
    expect(push.sent.map((m) => m.body)).toEqual(['audible again']);
  });

  it('suppresses by the read cursor as well, which is a different mechanism', async () => {
    const f = await setup();
    await registerDevice(h.db, { userId: f.bobId, pushToken: 'bob-phone', platform: 'ios' });

    const sent = await say(f.aliceId, f.dmChannel, 'already seen');
    // Read BEFORE the deferred evaluation runs, which is the race the eight-second deferral
    // exists to lose. The cursor is re-read at evaluation time, not captured at enqueue.
    await drainOnce(h.db, deps);
    const { markRead } = await import('../domain/reads.ts').then((m) => ({
      markRead: m.advanceReadCursor,
    }));
    await markRead(h.db, f.bobId, f.dmChannelId, sent.ok ? sent.message.seq : 0);
    for (const fn of deferred) await fn();

    expect(push.sent).toHaveLength(0);
  });

  it('never pushes the sender their own message', async () => {
    const f = await setup();
    await registerDevice(h.db, { userId: f.aliceId, pushToken: 'alice-phone', platform: 'ios' });
    await registerDevice(h.db, { userId: f.bobId, pushToken: 'bob-phone', platform: 'ios' });

    await say(f.aliceId, f.dmChannel, 'mine');
    await drainAndPush();
    expect(push.sent.map((m) => m.token)).toEqual(['bob-phone']);
  });

  it('writes no inbox row for a direct message, only the computed unread', async () => {
    const f = await setup();
    await say(f.aliceId, f.dmChannel, 'no row for this');
    await drainAndPush();

    const rows = await h.db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'dm_message'`,
    );
    // A row per message would flood the feed and contradict "computed on read, never stored".
    expect(rows.rows[0]?.n).toBe(0);

    const inbox = await readInbox(h.db, f.bobId);
    // Filtered to this conversation: Bob also has unread system messages in club chat from
    // being added to the club, which is correct and not what this test is about.
    const unread = inbox.rows.filter(
      (r) => r.kind === 'chat_unread' && r.channelId === f.dmChannelId,
    );
    expect(unread).toHaveLength(1);
    expect(unread[0]?.kind === 'chat_unread' && unread[0].count).toBe(1);
  });

  it('records a caught-up row for a DM, with the null club_id the schema relaxed for it', async () => {
    const f = await setup();
    await say(f.aliceId, f.dmChannel, 'one');
    await say(f.aliceId, f.dmChannel, 'two');

    // The only place a dm-scoped notification row is written, and therefore the only exercise of
    // `notifications.club_id` being nullable. TECH/09 relaxed that column for this scope; if the
    // column were NOT NULL, opening a DM with unread messages would fail here rather than
    // anywhere obvious.
    const opened = await openChat(h.db, f.bobId, f.dmChannelId);
    expect(opened.caughtUp).toBe(2);

    const rows = await h.db.execute<{ club_id: string | null; params: Record<string, unknown> }>(sql`
      SELECT club_id::text AS club_id, params FROM notifications
       WHERE recipient_id = ${f.bobId} AND type = 'chat_caught_up'
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.club_id).toBeNull();
    // Named after the other participant, not 'ClubChat'. A conversation has no name of its own.
    expect(rows.rows[0]?.params['channelName']).toBe('Alice');
    expect(rows.rows[0]?.params['clubId']).toBeNull();

    // Re-opening at the same position adds nothing: the synthetic idempotency key is derived from
    // (channel, seq) and is negative, so it cannot collide with a real outbox event either.
    await openChat(h.db, f.bobId, f.dmChannelId);
    const again = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM notifications
       WHERE recipient_id = ${f.bobId} AND type = 'chat_caught_up'
    `);
    expect(again.rows[0]?.n).toBe(1);
  });

  it('mutes any scope, not only a dm', async () => {
    const f = await setup();
    const clubChannel = await getChannelRef(h.db, f.clubChannelId);
    // channel_mutes has existed since Phase 1 precisely so mute was not a DM-only feature.
    expect((await muteChannel(h.db, await ctxFor(f.bobId), clubChannel!, null)).ok).toBe(true);
    // And an outsider cannot mute a channel they cannot read - a mute row is a small write,
    // but it is still a write against a channel id.
    expect(await muteChannel(h.db, await ctxFor(f.strangerId), clubChannel!, null)).toEqual({
      ok: false,
      code: 'not_found',
    });
  });
});

// ===========================================================================
// Regressions this phase fixed elsewhere
// ===========================================================================

describe('the race scope reaches the machinery Phase 2 forgot to wire it into', () => {
  it('puts a race chat in its roster members channel list and in nobody else', async () => {
    const ownerId = await makeUser('RaceOwner');
    const rosterId = await makeUser('OnRoster');
    const managerId = await makeUser('AdminOffRoster');
    const club = await createClub(h.db, { name: 'Track', sport: 'running', creatorId: ownerId });
    await addMember(h.db, await ctxFor(ownerId), club.clubId, rosterId);
    await addMember(h.db, await ctxFor(ownerId), club.clubId, managerId);
    // A club admin who did NOT create the race, so they manage every race in the club and hold
    // no roster row for this one. That is the actor the race matrix exists for.
    await changeRole(h.db, await ctxFor(ownerId), club.clubId, managerId, 'admin');

    const { createRace, addRaceMember } = await import('../domain/races.ts');
    // The creator gets a roster row deliberately - being an admin gives them management, and
    // this is what gives them the access management does not confer.
    const race = await createRace(h.db, await ctxFor(ownerId), {
      clubId: club.clubId,
      name: 'Spring Half',
      raceDate: '2026-09-01',
    });
    if (!race.ok) throw new Error('race fixture failed');
    await addRaceMember(h.db, await ctxFor(ownerId), race.raceId, rosterId);

    const raceChannel = await h.db.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM channels WHERE scope = 'race' AND scope_id = ${race.raceId}`,
    );
    const raceChannelId = raceChannel.rows[0]?.id;
    expect(raceChannelId).toBeDefined();

    // Before this phase, listAccessibleChannels had no race branch: a roster member's chat
    // never appeared in their channel list, never produced an unread count and never a badge.
    const forRoster = await listAccessibleChannels(h.db, rosterId);
    expect(forRoster.map((c) => c.id)).toContain(raceChannelId);

    // The other admin manages this race and is not on its roster, so they get nothing.
    // Management authority is not access, and the fix must not have widened it into one.
    const forManager = await listAccessibleChannels(h.db, managerId);
    expect(forManager.map((c) => c.id)).not.toContain(raceChannelId);

    // And the audience function agrees, which is what makes an announcement in race chat
    // reach the roster rather than nobody - and reach only the roster.
    const audience = await channelAudienceById(h.db, raceChannelId!);
    expect(audience.sort()).toEqual([ownerId, rosterId].sort());
    expect(audience).not.toContain(managerId);
  });
});

describe('notification idempotency keys are injective', () => {
  it('never lets two (event, kind) pairs collide', () => {
    // The bug this replaced: announcements keyed on event.id and mentions on event.id * 2 + 1,
    // which overlap - a mention on event 3 and an announcement on event 7 both key as 7, and
    // the second is silently dropped as already delivered.
    const seen = new Map<number, string>();
    for (let eventId = 1; eventId <= 500; eventId += 1) {
      for (const slot of [0, 1, 2, 3] as const) {
        const key = notificationKey(eventId, slot);
        const label = `${eventId}:${slot}`;
        expect(seen.has(key), `${label} collides with ${seen.get(key)}`).toBe(false);
        seen.set(key, label);
      }
    }
  });

  it('keeps every real key clear of the negative space synthetic ones use', () => {
    // The poll closing-soon reminder and the chat-caught-up row derive negative keys precisely
    // so they cannot collide with a real outbox id whatever the multiplier is.
    expect(notificationKey(1, 0)).toBeGreaterThan(0);
    expect(NOTIFICATION_SLOTS).toBeGreaterThanOrEqual(3);
  });
});

describe('a chat header wears its own face, never the club\'s', () => {
  /*
   * `channelDisplayName` carries a load-bearing COALESCE order - most specific first - because a
   * race channel and an Eboard channel BOTH carry a `club_id`, so putting the club first titles
   * every one of them with the club's name. That bug shipped once and the fragment exists to stop
   * it recurring.
   *
   * `channelDisplayImage` is the same COALESCE one column over, and inherits the same trap
   * silently: get the order wrong and every race chat shows the club's name correctly beside the
   * club's picture, which looks deliberate. So the picture is pinned the same way the name is,
   * with three DIFFERENT images so "showed its own" and "showed the club's" cannot both pass.
   */
  it('gives a race chat the race picture and an Eboard chat the space picture', async () => {
    const ownerId = await makeUser('FaceOwner');
    const club = await createClub(h.db, { name: 'Faces', sport: 'running', creatorId: ownerId });

    const { createRace, updateRace } = await import('../domain/races.ts');
    const { updateEboard } = await import('../domain/eboard.ts');

    const race = await createRace(h.db, await ctxFor(ownerId), {
      clubId: club.clubId,
      name: 'Own Face Invitational',
      raceDate: '2026-09-15',
    });
    if (!race.ok) throw new Error('race fixture failed');

    const eboard = await h.db.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM eboard_channels WHERE club_id = ${club.clubId}`,
    );
    const eboardId = eboard.rows[0]!.id;

    const CLUB_IMAGE = crypto.randomUUID();
    const RACE_IMAGE = crypto.randomUUID();
    const EBOARD_IMAGE = crypto.randomUUID();
    await h.db.execute(sql`UPDATE clubs SET image = ${CLUB_IMAGE} WHERE id = ${club.clubId}`);
    await updateRace(h.db, await ctxFor(ownerId), race.raceId, { image: RACE_IMAGE });
    await updateEboard(h.db, await ctxFor(ownerId), eboardId, { image: EBOARD_IMAGE });

    const channelOf = async (scope: string, scopeId: string) => {
      const rows = await h.db.execute<{ id: string }>(
        sql`SELECT id::text AS id FROM channels WHERE scope = ${scope} AND scope_id = ${scopeId}`,
      );
      return rows.rows[0]!.id;
    };

    const ctx = await ctxFor(ownerId);
    const clubMeta = await readChannelMeta(h.db, ctx, club.mainChannelId);
    const raceMeta = await readChannelMeta(h.db, ctx, await channelOf('race', race.raceId));
    const eboardMeta = await readChannelMeta(h.db, ctx, await channelOf('eboard', eboardId));
    if (!clubMeta.ok || !raceMeta.ok || !eboardMeta.ok) throw new Error('meta read refused');

    expect(clubMeta.image).toBe(CLUB_IMAGE);
    expect(raceMeta.image, 'race chat wore the club picture').toBe(RACE_IMAGE);
    expect(eboardMeta.image, 'Eboard chat wore the club picture').toBe(EBOARD_IMAGE);

    // The name it is paired with, asserted here too - the two COALESCEs have to move together,
    // and a test that checks only one lets the other drift.
    expect(raceMeta.name).toBe('Own Face Invitational');
    expect(eboardMeta.name).toBe('Eboard & Council');
  });

  it('falls back to no picture rather than the club\'s when a race has none', async () => {
    const ownerId = await makeUser('NoFaceOwner');
    const club = await createClub(h.db, { name: 'Fallback', sport: 'running', creatorId: ownerId });
    await h.db.execute(sql`UPDATE clubs SET image = ${crypto.randomUUID()} WHERE id = ${club.clubId}`);

    const { createRace } = await import('../domain/races.ts');
    const race = await createRace(h.db, await ctxFor(ownerId), {
      clubId: club.clubId,
      name: 'Pictureless',
      raceDate: '2026-09-15',
    });
    if (!race.ok) throw new Error('race fixture failed');

    const rows = await h.db.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM channels WHERE scope = 'race' AND scope_id = ${race.raceId}`,
    );
    const meta = await readChannelMeta(h.db, await ctxFor(ownerId), rows.rows[0]!.id);
    if (!meta.ok) throw new Error('meta read refused');

    // Null, so the client draws the race's INITIAL. Borrowing the club's picture here is the
    // failure that looks most like success: a plausible face over the right name.
    expect(meta.image, 'a race with no picture borrowed the club\'s').toBeNull();
  });
});

/**
 * **Reporting tells the people who review reports, and nobody else.**
 *
 * Reporting wrote a row into a work queue and told nobody there was work in it, for every phase
 * it existed. Raised by the founder on 2026-08-01: "I didn't get any notification when a member
 * reported."
 *
 * The audience is the interesting part, and the reason this lives beside the DM gate above: it is
 * NOT "the club's admins". A DM has no admin at all - its reviewers are platform moderators, who
 * belong to no club - and that single fact is what the deferral note on `reportMessage` named as
 * the missing piece. The two cases are asserted together because getting either one wrong is a
 * privacy failure rather than a missing convenience.
 */
describe('a report notifies whoever reviews it', () => {
  /** Who was told about a report in THIS channel. Scoped, because the table outlives each test. */
  async function toldAbout(channelId: string): Promise<string[]> {
    const rows = await h.db.execute<{ recipient_id: string }>(sql`
      SELECT recipient_id::text AS recipient_id
        FROM notifications
       WHERE type = 'message_reported' AND params->>'channelId' = ${channelId}
    `);
    return rows.rows.map((r) => r.recipient_id);
  }

  it('tells the club admin tier, and neither the reporter nor the reported member', async () => {
    const f = await setup();
    const clubChannel = await getChannelRef(h.db, f.clubChannelId);
    // Alice and Bob are ordinary members; the club's admin tier is the Owner alone.
    const said = await say(f.aliceId, clubChannel!, 'something rude in club chat');
    expect(said.ok).toBe(true);

    await reportMessage(h.db, await ctxFor(f.bobId), clubChannel!, said.ok ? said.message.seq : 0);
    await drainAndPush();

    const told = await toldAbout(f.clubChannelId);
    expect(told).toEqual([f.ownerId]);
    // The reporter knows - they did it - and being told about your own report is noise.
    expect(told).not.toContain(f.bobId);
    /*
     * And the reported member is not told, which is the one that matters.
     *
     * PRD/05 rule 10 and PRD/14 rule 7 both keep reporting invisible to its subject, and a
     * notification is the loudest possible way to break that. Alice is an ordinary member here,
     * so she is outside the audience for the ordinary reason - but this asserts the outcome
     * rather than the mechanism, because the mechanism is what a future change would alter.
     */
    expect(told).not.toContain(f.aliceId);
  });

  it('tells platform moderators for a DM, and no club admin', async () => {
    const f = await setup();
    const moderatorId = await makeModerator('QueueModerator');

    const said = await say(f.aliceId, f.dmChannel, 'something awful');
    expect(said.ok).toBe(true);
    await reportMessage(h.db, await ctxFor(f.bobId), f.dmChannel, said.ok ? said.message.seq : 0);
    await drainAndPush();

    const told = await toldAbout(f.dmChannelId);
    expect(told).toContain(moderatorId);
    /*
     * EVERY recipient is a platform moderator, asserted rather than an exact list.
     *
     * Earlier tests in this file leave their own moderators behind, and they are all legitimate
     * recipients - a DM report goes to the platform's moderators, however many exist. Pinning
     * the assertion to one id would make this test a hostage to the order the file runs in;
     * asserting the property is both leak-proof and the thing actually worth guaranteeing.
     */
    const nonModerators = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM users
       WHERE id = ANY(${sql.param(told)}::uuid[]) AND NOT is_platform_moderator
    `);
    expect(Number(nonModerators.rows[0]?.n), 'a non-moderator was told about a DM report').toBe(0);
    /*
     * The club Owner is NOT told, and this is the assertion that matters most.
     *
     * They are the most privileged person in a club both participants belong to - and a DM
     * belongs to no club, so they have no standing over it at all. PRD/14 rule 7 keeps a DM
     * report away from every club admin, and announcing that one exists would breach that
     * before anybody opened anything.
     */
    expect(told).not.toContain(f.ownerId);
    expect(told).not.toContain(f.bobId);
  });

  it('does not notify again when the same person reports the same message twice', async () => {
    const f = await setup();
    const clubChannel = await getChannelRef(h.db, f.clubChannelId);
    const said = await say(f.aliceId, clubChannel!, 'rude, again');
    const seq = said.ok ? said.message.seq : 0;

    await reportMessage(h.db, await ctxFor(f.bobId), clubChannel!, seq);
    await reportMessage(h.db, await ctxFor(f.bobId), clubChannel!, seq);
    await drainAndPush();

    // One report row means one event means one notification. Without the guard on the insert,
    // tapping Report repeatedly would let one member buzz every admin as often as they liked.
    expect(await toldAbout(f.clubChannelId)).toHaveLength(1);
  });
});
