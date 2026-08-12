/**
 * The inbox, the badge, and the two clearing exceptions.
 *
 * The exceptions are the whole point of this file. A naive "opening the inbox marks
 * everything read" is one line of SQL and passes any test that only checks the badge went
 * to zero - while silently destroying the two row kinds that must survive a glance. One of
 * them lost the founder real join requests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createClub } from '../domain/create-club.ts';
import { sendMessage } from '../domain/send-message.ts';
import { getChannelRef } from '../domain/reads.ts';
import { loadAccessContext } from '../policy/context.ts';
import {
  badgeCount,
  markInboxRead,
  markRosterSeen,
  openChat,
  readInbox,
} from '../domain/inbox.ts';
import { writeNotifications } from '../worker/notify.ts';
import { clubMemberships, users } from '../db/schema.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
});
afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  // A throwaway container, which is why truncating is safe here and nowhere else.
  await h.db.execute(sql`TRUNCATE notifications, outbox RESTART IDENTITY CASCADE`);
});

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({
    id,
    name,
    email: `${name}-${id.slice(0, 8)}@test.invalid`,
  });
  return id;
}

async function setup() {
  const ownerId = await makeUser('Owner');
  const memberId = await makeUser('Member');
  const club = await createClub(h.db, {
    name: 'Hillside Running Club',
    sport: 'running',
    creatorId: ownerId,
  });
  await h.db
    .insert(clubMemberships)
    .values({ clubId: club.clubId, userId: memberId, role: 'member' });
  await h.db.execute(sql`TRUNCATE notifications RESTART IDENTITY CASCADE`);
  return { ...club, ownerId, memberId };
}

/** A pending club join request, addressed to the owner. */
async function pendingJoinRequest(clubId: string, ownerId: string, eventId: number) {
  await writeNotifications(h.db, {
    outboxEventId: eventId,
    type: 'club_join_request',
    params: {
      clubId,
      clubName: 'Hillside Running Club',
      requesterName: 'Hopeful',
      requesterId: crypto.randomUUID(),
    },
    recipients: [ownerId],
    actorId: null,
    clubId,
  });
}

async function anAnnouncementFor(clubId: string, channelId: string, userId: string, eventId: number) {
  await writeNotifications(h.db, {
    outboxEventId: eventId,
    type: 'announcement',
    params: {
      clubId,
      channelId,
      channelName: 'Hillside Running Club',
      seq: 2,
      preview: 'Bus at 6am',
      actorName: 'Owner',
    },
    recipients: [userId],
    actorId: null,
    clubId,
  });
}

describe('the two clearing exceptions', () => {
  it('clears an ordinary notification when the inbox is opened', async () => {
    const f = await setup();
    await anAnnouncementFor(f.clubId, f.mainChannelId, f.memberId, 1);

    expect(await badgeCount(h.db, f.memberId)).toBe(1);
    await markInboxRead(h.db, f.memberId);
    expect(await badgeCount(h.db, f.memberId)).toBe(0);
  });

  it('EXCEPTION 1: does not clear a pending join request when the inbox is opened', async () => {
    // "Only clears once you actually look." A row representing work waiting on you must
    // survive a glance at the inbox. The founder lost real join requests to the other
    // behaviour.
    const f = await setup();
    await pendingJoinRequest(f.clubId, f.ownerId, 10);

    expect(await badgeCount(h.db, f.ownerId)).toBe(1);
    await markInboxRead(h.db, f.ownerId);
    expect(
      await badgeCount(h.db, f.ownerId),
      'opening the inbox dismissed a pending join request',
    ).toBe(1);

    // It clears only when the roster is actually opened.
    const cleared = await markRosterSeen(h.db, f.ownerId, { kind: 'club', clubId: f.clubId });
    expect(cleared.cleared).toBe(1);
    expect(await badgeCount(h.db, f.ownerId)).toBe(0);
  });

  it('EXCEPTION 2: does not clear a chat unread when the inbox is opened', async () => {
    const f = await setup();
    const ctx = await loadAccessContext(h.db, f.ownerId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    await sendMessage(h.db, ctx, channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      body: 'unread by the member',
    });

    expect(await badgeCount(h.db, f.memberId)).toBe(1);
    await markInboxRead(h.db, f.memberId);
    expect(
      await badgeCount(h.db, f.memberId),
      'opening the inbox cleared a chat unread',
    ).toBe(1);

    // Only opening THAT CHAT clears it.
    await openChat(h.db, f.memberId, f.mainChannelId);
    expect(await badgeCount(h.db, f.memberId)).toBe(0);
  });

  it('scopes a roster clear to its own roster', async () => {
    // Opening one club's member list must not dismiss another club's pending requests.
    const f = await setup();
    const other = await createClub(h.db, {
      name: 'Other Club',
      sport: 'swimming',
      creatorId: f.ownerId,
    });
    await pendingJoinRequest(f.clubId, f.ownerId, 20);
    await pendingJoinRequest(other.clubId, f.ownerId, 21);

    await markRosterSeen(h.db, f.ownerId, { kind: 'club', clubId: f.clubId });

    const page = await readInbox(h.db, f.ownerId);
    const stillPending = page.rows.filter(
      (r) => r.kind === 'notification' && r.type === 'club_join_request' && !r.read,
    );
    expect(stillPending, 'clearing one roster cleared another club requests').toHaveLength(1);
  });
});

describe('the badge', () => {
  it('counts one per channel with unread, never a per-message sum', async () => {
    const f = await setup();
    const ctx = await loadAccessContext(h.db, f.ownerId);
    const channel = await getChannelRef(h.db, f.mainChannelId);

    // Twenty messages in one conversation is still ONE thing needing attention. A badge of
    // 20 would be noise.
    for (let i = 0; i < 20; i += 1) {
      await sendMessage(h.db, ctx, channel!, {
        channelId: f.mainChannelId,
        clientMsgId: crypto.randomUUID(),
        body: `message ${i}`,
      });
    }

    expect(await badgeCount(h.db, f.memberId)).toBe(1);
  });

  it('adds discrete notifications to the per-channel count', async () => {
    const f = await setup();
    const ctx = await loadAccessContext(h.db, f.ownerId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    await sendMessage(h.db, ctx, channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      body: 'unread',
    });
    await anAnnouncementFor(f.clubId, f.mainChannelId, f.memberId, 30);

    // One unread chat + one unread discrete row.
    expect(await badgeCount(h.db, f.memberId)).toBe(2);
  });

  it('is zero for a member with nothing waiting', async () => {
    const f = await setup();
    expect(await badgeCount(h.db, f.ownerId)).toBe(0);
  });
});

describe('the merged feed', () => {
  it('merges discrete rows and live chat-unread rows', async () => {
    const f = await setup();
    const ctx = await loadAccessContext(h.db, f.ownerId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    await sendMessage(h.db, ctx, channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      body: 'chat message',
    });
    await anAnnouncementFor(f.clubId, f.mainChannelId, f.memberId, 40);

    const page = await readInbox(h.db, f.memberId);
    const kinds = page.rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(['chat_unread', 'notification']);
  });

  it('renders text and a target for every row, from params', async () => {
    const f = await setup();
    await anAnnouncementFor(f.clubId, f.mainChannelId, f.memberId, 50);

    const page = await readInbox(h.db, f.memberId);
    const row = page.rows.find((r) => r.kind === 'notification');
    expect(row).toBeDefined();
    if (row?.kind !== 'notification') return;

    expect(row.body).toContain('Bus at 6am');
    expect(row.body).not.toContain('undefined');
    // Deep-links to the exact message, derived rather than stored.
    expect(row.target).toEqual({ kind: 'chat', channelId: f.mainChannelId, seq: 2 });
  });

  it('paginates discrete rows and does not repeat live rows on later pages', async () => {
    const f = await setup();
    const ctx = await loadAccessContext(h.db, f.ownerId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    await sendMessage(h.db, ctx, channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      body: 'unread',
    });
    for (let i = 0; i < 25; i += 1) {
      await anAnnouncementFor(f.clubId, f.mainChannelId, f.memberId, 100 + i);
    }

    const first = await readInbox(h.db, f.memberId, { limit: 20 });
    expect(first.nextCursor).not.toBeNull();
    expect(first.rows.filter((r) => r.kind === 'chat_unread')).toHaveLength(1);

    const second = await readInbox(h.db, f.memberId, {
      limit: 20,
      cursor: first.nextCursor!,
    });
    // The live row is current state, not history. Repeating it would show the same unread
    // conversation twice in one feed.
    expect(
      second.rows.filter((r) => r.kind === 'chat_unread'),
      'a live row repeated on page two',
    ).toHaveLength(0);
    expect(second.rows.length).toBeGreaterThan(0);
  });

  it('shows a member nothing from a club they are not in', async () => {
    const f = await setup();
    const outsider = await makeUser('Outsider');
    await sendMessage(
      h.db,
      await loadAccessContext(h.db, f.ownerId),
      (await getChannelRef(h.db, f.mainChannelId))!,
      { channelId: f.mainChannelId, clientMsgId: crypto.randomUUID(), body: 'private' },
    );

    const page = await readInbox(h.db, outsider);
    expect(page.rows).toHaveLength(0);
    expect(await badgeCount(h.db, outsider)).toBe(0);
  });
});

describe('caught up on N messages', () => {
  it('records a history row when a chat with unread is opened', async () => {
    const f = await setup();
    const ctx = await loadAccessContext(h.db, f.ownerId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    for (let i = 0; i < 3; i += 1) {
      await sendMessage(h.db, ctx, channel!, {
        channelId: f.mainChannelId,
        clientMsgId: crypto.randomUUID(),
        body: `m${i}`,
      });
    }

    const opened = await openChat(h.db, f.memberId, f.mainChannelId);
    expect(opened.caughtUp).toBe(3);

    const page = await readInbox(h.db, f.memberId);
    const caughtUp = page.rows.find(
      (r) => r.kind === 'notification' && r.type === 'chat_caught_up',
    );
    expect(caughtUp).toBeDefined();
    if (caughtUp?.kind !== 'notification') return;
    expect(caughtUp.body).toContain('3 messages');
    // Written already-read: the member is looking at those messages right now, so
    // surfacing it as unread would be telling them about what is on their screen.
    expect(caughtUp.read).toBe(true);
  });

  it('records nothing when opening a chat that was already caught up', async () => {
    const f = await setup();
    await openChat(h.db, f.memberId, f.mainChannelId);
    const first = await readInbox(h.db, f.memberId);

    await openChat(h.db, f.memberId, f.mainChannelId);
    const second = await readInbox(h.db, f.memberId);

    expect(second.rows).toHaveLength(first.rows.length);
  });

  it('does not add a second history row for re-opening at the same position', async () => {
    const f = await setup();
    const ctx = await loadAccessContext(h.db, f.ownerId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    await sendMessage(h.db, ctx, channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      body: 'one',
    });

    await openChat(h.db, f.memberId, f.mainChannelId);
    // Force the cursor back, as a client replaying a stale read would, and re-open.
    await h.db.execute(
      sql`UPDATE read_cursors SET last_read_seq = 0
           WHERE user_id = ${f.memberId} AND channel_id = ${f.mainChannelId}`,
    );
    await openChat(h.db, f.memberId, f.mainChannelId);

    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM notifications
       WHERE recipient_id = ${f.memberId} AND type = 'chat_caught_up'
    `);
    // The synthetic idempotency key is derived from (channel, seq), so the same position
    // cannot accumulate history rows.
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });
});

/**
 * Whose face each row wears (`PRD/12` rule 2c).
 *
 * > **The deciding case is three DIFFERENT pictures and a fourth subject with none.** A race and
 * > an Eboard channel both carry a club id, so an implementation that resolves a chat row against
 * > its club is wrong in exactly the way that looks right: every row still shows *a* picture, and
 * > it is the club's. `channel-access.ts` records the same trap for the Chats list, where it was a
 * > COALESCE whose fall-through never fired because the names were NOT NULL and the pictures were
 * > not. One picture in a fixture cannot tell the two implementations apart.
 */
describe('the picture on a row', () => {
  it('gives a race chat the race picture, never the club it belongs to', async () => {
    const f = await setup();
    await h.db.execute(sql`UPDATE clubs SET image = 'club-pic' WHERE id = ${f.clubId}`);

    const raceId = crypto.randomUUID();
    await h.db.execute(sql`
      INSERT INTO races (id, club_id, name, image) VALUES (${raceId}, ${f.clubId}, 'Spring Half', 'race-pic')
    `);
    const raceChannelId = crypto.randomUUID();
    await h.db.execute(sql`
      INSERT INTO channels (id, club_id, scope, scope_id, last_seq)
      VALUES (${raceChannelId}, ${f.clubId}, 'race', ${raceId}, 0)
    `);
    await h.db.execute(sql`
      INSERT INTO race_memberships (race_id, user_id) VALUES (${raceId}, ${f.memberId})
    `);

    await writeNotifications(h.db, {
      outboxEventId: 90,
      type: 'announcement',
      params: {
        clubId: f.clubId,
        channelId: raceChannelId,
        channelName: 'Spring Half',
        seq: 1,
        preview: 'Leaving at six',
        actorName: 'Owner',
      },
      recipients: [f.memberId],
      actorId: null,
      clubId: f.clubId,
    });

    const page = await readInbox(h.db, f.memberId);
    const row = page.rows.find((r) => r.kind === 'notification' && r.type === 'announcement');
    expect(row?.picture?.image).toBe('race-pic');
    expect(row?.picture?.image).not.toBe('club-pic');
    expect(row?.picture?.kind).toBe('group');
  });

  it('shows the requester on a join request, not the club', async () => {
    const f = await setup();
    await h.db.execute(sql`UPDATE clubs SET image = 'club-pic' WHERE id = ${f.clubId}`);
    const requesterId = await makeUser('Hopeful');
    await h.db.execute(sql`UPDATE users SET image = 'face-pic' WHERE id = ${requesterId}`);

    await writeNotifications(h.db, {
      outboxEventId: 91,
      type: 'club_join_request',
      params: {
        clubId: f.clubId,
        clubName: 'Hillside Running Club',
        requesterName: 'Hopeful',
        requesterId,
      },
      recipients: [f.ownerId],
      actorId: null,
      clubId: f.clubId,
    });

    const page = await readInbox(h.db, f.ownerId);
    const row = page.rows.find((r) => r.kind === 'notification');
    expect(row?.picture?.image).toBe('face-pic');
    // A person's fallback is their initial; a group's is a glyph. Getting this wrong draws
    // "H" inside a well that should hold a group glyph, or vice versa.
    expect(row?.picture?.kind).toBe('person');
  });

  it('gives the glyph tier no picture at all', async () => {
    const f = await setup();
    await h.db.execute(sql`UPDATE clubs SET image = 'club-pic' WHERE id = ${f.clubId}`);

    await writeNotifications(h.db, {
      outboxEventId: 92,
      type: 'poll_created',
      params: {
        clubId: f.clubId,
        clubName: 'Hillside Running Club',
        actorName: 'Owner',
        pollId: crypto.randomUUID(),
        question: 'Carpool or bus?',
      },
      recipients: [f.memberId],
      actorId: null,
      clubId: f.clubId,
    });

    const page = await readInbox(h.db, f.memberId);
    const row = page.rows.find((r) => r.kind === 'notification' && r.type === 'poll_created');
    // Asserted rather than assumed: a resolver that gave everything a face would put the club's
    // picture on "new poll", which is the thing rule 2c exists to prevent.
    expect(row?.picture).toBeNull();
  });

  it('resolves a subject with no picture to a fallback rather than to nothing', async () => {
    const f = await setup();
    // The club has no image at all, which is the ordinary case: most clubs never set one.
    await anAnnouncementFor(f.clubId, f.mainChannelId, f.memberId, 93);

    const page = await readInbox(h.db, f.memberId);
    const row = page.rows.find((r) => r.kind === 'notification');
    expect(row?.picture).not.toBeNull();
    expect(row?.picture?.image).toBeNull();
    // The name and the tint still arrive, because they are what the fallback is drawn from.
    expect(row?.picture?.name).toBe('Hillside Running Club');
    expect(row?.picture?.tintId).toBeTruthy();
  });

  it('gives a chat-unread row its conversation picture', async () => {
    const f = await setup();
    await h.db.execute(sql`UPDATE clubs SET image = 'club-pic' WHERE id = ${f.clubId}`);
    const ctx = await loadAccessContext(h.db, f.ownerId);
    const channel = await getChannelRef(h.db, f.mainChannelId);
    await sendMessage(h.db, ctx, channel!, {
      channelId: f.mainChannelId,
      clientMsgId: crypto.randomUUID(),
      body: 'anyone driving?',
    });

    const page = await readInbox(h.db, f.memberId);
    const row = page.rows.find((r) => r.kind === 'chat_unread');
    expect(row?.picture?.image).toBe('club-pic');
    expect(row?.picture?.kind).toBe('group');
  });
});
