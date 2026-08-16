/**
 * THE PHASE 1 EXIT GATE, plus the rules around it.
 *
 * SPEC/TECH/16-build-phases.md: *"Done when: an announcement in club chat reaches a
 * backgrounded phone as a push that deep-links to the right message."*
 *
 * A `RecordingPushSender` stands in for the phone, which is the only way to assert the
 * payload AND its destination. "It appeared on my phone" cannot check that the deep link
 * carries the right seq.
 *
 * The suppression tests matter as much as the delivery one. ADR-0008 exists because
 * gating push on connection liveness silently swallows notifications, and a test that only
 * proves push happens would pass a build that pushed to everyone always.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { notificationTarget, type NotificationTarget } from '@clubchat/shared';
import { appendMessage } from '../domain/append-message.ts';
import { createClub } from '../domain/create-club.ts';
import { addMember, changeRole, joinClub, setJoinPolicy } from '../domain/membership.ts';
import { addRaceMember, createRace } from '../domain/races.ts';
import { sendMessage, setPinned, softDeleteMessage } from '../domain/send-message.ts';
import { advanceReadCursor, getChannelRef } from '../domain/reads.ts';
import { loadAccessContext } from '../policy/context.ts';
import { drainOnce } from '../worker/drain.ts';
import { resolveAudience } from '../worker/audience.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { registerDevice, unregisterDevice } from '../push/dispatch.ts';
import {
  channelMutes,
  clubMemberships,
  devices,
  messageMentions,
  notifications,
  users,
} from '../db/schema.ts';
import { startTestDb, type TestDb } from './harness.ts';
import type { EffectDeps } from '../worker/effects.ts';

let h: TestDb;
let push: RecordingPushSender;
/** Deferred pushes, run on demand instead of after eight real seconds. */
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

  // Clear the volatile tables between tests, so an assertion like "no notifications at
  // all" means what it says. Several assertions below are deliberately unfiltered - that
  // is the stronger form, since a filtered query cannot catch a notification sent to the
  // wrong person - and they only work if each test starts empty.
  //
  // Truncating is safe here and nowhere else: this is a throwaway container, which is
  // exactly why the harness starts one rather than using the development database
  // (AGENTS.md non-negotiable 3).
  await h.db.execute(
    sql`TRUNCATE notifications, push_deliveries, devices, channel_mutes, outbox RESTART IDENTITY CASCADE`,
  );

  deps = {
    db: h.db,
    // The push path never consults Redis, deliberately - wipe Redis and push still works,
    // because suppression is the read cursor. Passing a stub proves that by construction:
    // if anything reached for Redis these tests would fail.
    redis: null as never,
    push,
    log: silent,
    defer: (fn) => deferred.push(fn),
  };
});

/** Drain the outbox, then run whatever push evaluations it scheduled. */
async function drainAndDeliver() {
  await drainOnce(h.db, deps);
  const pending = [...deferred];
  deferred = [];
  for (const fn of pending) await fn();
}

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({
    id,
    name,
    email: `${name.toLowerCase()}-${id.slice(0, 8)}@test.invalid`,
  });
  return id;
}

type Fixture = {
  clubId: string;
  channelId: string;
  ownerId: string;
  adminId: string;
  memberId: string;
};

async function setupClub(): Promise<Fixture> {
  const ownerId = await makeUser('Owner');
  const adminId = await makeUser('Admin');
  const memberId = await makeUser('Member');

  const club = await createClub(h.db, {
    name: 'Hillside Running Club',
    sport: 'running',
    creatorId: ownerId,
  });
  await h.db.insert(clubMemberships).values([
    { clubId: club.clubId, userId: adminId, role: 'admin' },
    { clubId: club.clubId, userId: memberId, role: 'member' },
  ]);

  // Drain the club.created bootstrap so it does not confuse later assertions.
  await drainAndDeliver();
  push.reset();

  return {
    clubId: club.clubId,
    channelId: club.mainChannelId,
    ownerId,
    adminId,
    memberId,
  };
}

async function announce(f: Fixture, actorId: string, body: string) {
  const ctx = await loadAccessContext(h.db, actorId);
  const channel = await getChannelRef(h.db, f.channelId);
  if (!channel) throw new Error('no channel');
  return sendMessage(h.db, ctx, channel, {
    channelId: f.channelId,
    clientMsgId: crypto.randomUUID(),
    type: 'announcement',
    body,
  });
}

// ===========================================================================
// THE GATE
// ===========================================================================

describe('Phase 1 gate: an announcement reaches a backgrounded phone', () => {
  it('pushes to a registered device and deep-links to the exact message', async () => {
    const f = await setupClub();

    // The member's phone. Backgrounded, so no socket and no advanced cursor.
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[member-phone]',
      platform: 'ios',
    });

    const sent = await announce(f, f.adminId, 'Bus leaves at 6am sharp from the gym');
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    await drainAndDeliver();

    // --- reached the phone ---
    expect(push.sent).toHaveLength(1);
    const message = push.sent[0]!;
    expect(message.token).toBe('ExponentPushToken[member-phone]');
    expect(message.title).toBe('Hillside Running Club');
    expect(message.body).toContain('Bus leaves at 6am sharp');
    expect(message.body).toContain('Admin');

    // --- deep-links to the RIGHT message, not merely to the conversation ---
    const target = message.data['target'] as NotificationTarget;
    expect(target).toEqual({
      kind: 'chat',
      channelId: f.channelId,
      seq: sent.message.seq,
    });

    // --- and the in-app row exists independently of whether the push landed ---
    const rows = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, f.memberId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('announcement');
    // The row stores params, not prose. Its text is rendered on read.
    expect(rows[0]).not.toHaveProperty('body');
    expect(notificationTarget({ type: 'announcement', params: rows[0]!.params as never })).toEqual(
      target,
    );
  });

  it('renders the push from the same function as the inbox, so the two cannot disagree', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[consistency]',
      platform: 'android',
    });

    await announce(f, f.adminId, 'Kit order closes Friday');
    await drainAndDeliver();

    const rows = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, f.memberId));
    const { renderNotification } = await import('@clubchat/shared');
    const fromRow = renderNotification({
      type: 'announcement',
      params: rows[0]!.params as never,
    });

    expect(push.sent[0]?.title).toBe(fromRow.title);
    expect(push.sent[0]?.body).toBe(fromRow.body);
  });
});

// ===========================================================================
// SUPPRESSION - the half a delivery-only test would miss
// ===========================================================================

describe('push suppression is by read cursor, never by liveness', () => {
  it('does not push to someone whose cursor already passed the message', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[already-read]',
      platform: 'ios',
    });

    const sent = await announce(f, f.adminId, 'Read this before the push evaluates');
    if (!sent.ok) return;

    // The member reads it - over the socket, in the 8 seconds before evaluation. This is
    // exactly the race the deferral exists to lose.
    await advanceReadCursor(h.db, f.memberId, f.channelId, sent.message.seq);

    await drainAndDeliver();

    expect(push.sent, 'pushed to someone who had already read it').toHaveLength(0);

    // The notification ROW still exists. Suppression silences the buzz, not the record.
    const rows = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, f.memberId));
    expect(rows).toHaveLength(1);
  });

  it('re-reads the cursor at evaluation time rather than capturing it earlier', async () => {
    // If the cursor were captured when the event was enqueued, reading during the
    // deferral would not suppress - which would make the whole deferral pointless.
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[reads-during-deferral]',
      platform: 'ios',
    });

    const sent = await announce(f, f.adminId, 'Read me mid-deferral');
    if (!sent.ok) return;

    // Drain writes the rows and SCHEDULES the push, but does not run it yet.
    await drainOnce(h.db, deps);
    expect(push.sent).toHaveLength(0);

    // The read lands after scheduling, before evaluation.
    await advanceReadCursor(h.db, f.memberId, f.channelId, sent.message.seq);

    for (const fn of deferred) await fn();
    expect(push.sent, 'the cursor was captured too early').toHaveLength(0);
  });

  it('still pushes when the cursor is behind the message', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[behind]',
      platform: 'ios',
    });

    const sent = await announce(f, f.adminId, 'You have not seen this');
    if (!sent.ok) return;

    // Read up to the message BEFORE this one. Being nearly caught up is not being
    // caught up.
    await advanceReadCursor(h.db, f.memberId, f.channelId, sent.message.seq - 1);
    await drainAndDeliver();

    expect(push.sent).toHaveLength(1);
  });

  it('pushes every live device of an unread member, because a laptop is not a phone', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[laptop]',
      platform: 'web',
    });
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[pocket]',
      platform: 'ios',
    });

    await announce(f, f.adminId, 'Two devices, one member');
    await drainAndDeliver();

    // Per device, not per user.
    expect(push.sent.map((m) => m.token).sort()).toEqual([
      'ExponentPushToken[laptop]',
      'ExponentPushToken[pocket]',
    ]);
  });

  it('suppresses for that member everywhere at once when they read anywhere', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[laptop2]',
      platform: 'web',
    });
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[pocket2]',
      platform: 'ios',
    });

    const sent = await announce(f, f.adminId, 'Reading on the laptop silences the phone');
    if (!sent.ok) return;
    await advanceReadCursor(h.db, f.memberId, f.channelId, sent.message.seq);
    await drainAndDeliver();

    // The cursor is per member, so one read covers both devices. That is the behaviour
    // you want and it falls out of suppressing on the cursor rather than the socket.
    expect(push.sent).toHaveLength(0);
  });

  it('does not push to an invalidated token', async () => {
    const f = await setupClub();
    const registered = await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[dead]',
      platform: 'ios',
    });
    await h.db
      .update(devices)
      .set({ invalidatedAt: new Date() })
      .where(eq(devices.id, registered.id));

    await announce(f, f.adminId, 'Nobody is listening');
    await drainAndDeliver();

    expect(push.sent).toHaveLength(0);
  });

  it('marks a token invalid when the provider reports it dead', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[will-die]',
      platform: 'ios',
    });
    push.deadTokens.add('ExponentPushToken[will-die]');

    await announce(f, f.adminId, 'This token is gone');
    await drainAndDeliver();

    const rows = await h.db
      .select()
      .from(devices)
      .where(eq(devices.pushToken, 'ExponentPushToken[will-die]'));
    expect(rows[0]?.invalidatedAt).not.toBeNull();
  });
});

describe('signing out deregisters the phone', () => {
  it('stops pushing to a device that signed out', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[handed-on]',
      platform: 'ios',
    });

    const gone = await unregisterDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[handed-on]',
    });
    expect(gone.removed).toBe(1);

    await announce(f, f.adminId, 'Meet at the track');
    await drainAndDeliver();

    // The point of the whole change: whoever holds this phone now hears nothing addressed to
    // the member who signed out of it.
    expect(push.sent).toHaveLength(0);
  });

  it('refuses to deregister a token belonging to somebody else', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[not-yours]',
      platform: 'ios',
    });

    // The admin supplies a token that is not theirs. Deleting on the token alone would let
    // anybody who learned one silence another member's phone.
    const attempt = await unregisterDevice(h.db, {
      userId: f.adminId,
      pushToken: 'ExponentPushToken[not-yours]',
    });
    expect(attempt.removed).toBe(0);

    await announce(f, f.adminId, 'Still listening');
    await drainAndDeliver();
    expect(push.sent).toHaveLength(1);
  });

  it('is silent about a token that was never registered', async () => {
    const f = await setupClub();
    const missing = await unregisterDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[never-existed]',
    });
    // No throw, no distinction. The route answers 204 either way rather than telling a caller
    // whether a token they named exists.
    expect(missing.removed).toBe(0);
  });

  it('lets the same phone come back, bound to whoever signs in next', async () => {
    const f = await setupClub();
    const token = 'ExponentPushToken[shared-phone]';

    await registerDevice(h.db, { userId: f.memberId, pushToken: token, platform: 'ios' });
    await unregisterDevice(h.db, { userId: f.memberId, pushToken: token });
    // The next person signs in on the same handset.
    await registerDevice(h.db, { userId: f.adminId, pushToken: token, platform: 'ios' });

    const rows = await h.db.select().from(devices).where(eq(devices.pushToken, token));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(f.adminId);
  });
});

describe('mute', () => {
  it('silences the push but still records the notification and the unread count', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[muted]',
      platform: 'ios',
    });
    await h.db.insert(channelMutes).values({ userId: f.memberId, channelId: f.channelId });

    await announce(f, f.adminId, 'Muted conversation');
    await drainAndDeliver();

    expect(push.sent, 'pushed into a muted conversation').toHaveLength(0);

    // Mute is not "mark as read". The row exists and the unread count still accrues.
    const rows = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, f.memberId));
    expect(rows).toHaveLength(1);

    const cursor = await h.db.execute<{ unread: number }>(sql`
      SELECT c.last_seq - COALESCE(rc.last_read_seq, 0) AS unread
        FROM channels c
        LEFT JOIN read_cursors rc ON rc.channel_id = c.id AND rc.user_id = ${f.memberId}
       WHERE c.id = ${f.channelId}
    `);
    expect(Number(cursor.rows[0]?.unread)).toBeGreaterThan(0);
  });
});

// ===========================================================================
// AUDIENCE
// ===========================================================================

describe('audience', () => {
  it('excludes the actor from their own announcement', async () => {
    const f = await setupClub();
    for (const userId of [f.ownerId, f.adminId, f.memberId]) {
      await registerDevice(h.db, {
        userId,
        pushToken: `ExponentPushToken[${userId.slice(0, 8)}]`,
        platform: 'ios',
      });
    }

    await announce(f, f.adminId, 'You are never told about your own action');
    await drainAndDeliver();

    // Owner and member, not the admin who sent it.
    expect(push.sent).toHaveLength(2);
    const rows = await h.db.select().from(notifications);
    expect(rows.map((r) => r.recipientId).sort()).toEqual([f.memberId, f.ownerId].sort());
  });

  it('includes the Owner in an admin-tier audience', async () => {
    // The bug that shipped four times: a bare `role = 'admin'` filter excludes a club
    // whose only admin-tier member is its Owner, which is every brand-new club.
    const f = await setupClub();
    const audience = await resolveAudience(h.db, {
      type: 'club_join_request',
      actorId: null,
      clubId: f.clubId,
    });
    expect(audience.sort()).toEqual([f.adminId, f.ownerId].sort());
    expect(audience, 'the Owner was excluded from the admin tier').toContain(f.ownerId);
  });

  it('reaches every club member for an announcement, not just admins', async () => {
    const f = await setupClub();
    const audience = await resolveAudience(h.db, {
      type: 'announcement',
      actorId: f.adminId,
      clubId: f.clubId,
      channelId: f.channelId,
    });
    expect(audience.sort()).toEqual([f.memberId, f.ownerId].sort());
  });

  it('does not notify a non-member', async () => {
    const f = await setupClub();
    const outsider = await makeUser('Outsider');
    await registerDevice(h.db, {
      userId: outsider,
      pushToken: 'ExponentPushToken[outsider]',
      platform: 'ios',
    });

    await announce(f, f.adminId, 'Club business only');
    await drainAndDeliver();

    expect(push.sent.map((m) => m.token)).not.toContain('ExponentPushToken[outsider]');
  });
});

// ===========================================================================
// IDEMPOTENCY
// ===========================================================================

describe('at-least-once delivery is absorbed', () => {
  it('does not duplicate notifications or pushes when an event is redelivered', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[redeliver]',
      platform: 'ios',
    });

    await announce(f, f.adminId, 'Processed twice');
    await drainAndDeliver();

    expect(push.sent).toHaveLength(1);

    // Simulate redelivery by un-processing the outbox row and draining again, which is
    // exactly what a consumer restart or a relay retry produces.
    await h.db.execute(sql`UPDATE outbox SET processed_at = NULL WHERE processed_at IS NOT NULL`);
    await drainAndDeliver();

    const rows = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, f.memberId));
    expect(rows, 'redelivery duplicated the inbox row').toHaveLength(1);
    // A duplicated row can be cleaned up. A duplicated push has already buzzed a phone.
    expect(push.sent, 'redelivery buzzed the phone twice').toHaveLength(1);
  });
});

// ===========================================================================
// PINNING vs ANNOUNCING, and the column-level authority trap
// ===========================================================================

describe('pinning never notifies; announcing always does', () => {
  it('sends no push and writes no notification when a message is pinned', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.memberId,
      pushToken: 'ExponentPushToken[pin]',
      platform: 'ios',
    });

    const ctx = await loadAccessContext(h.db, f.memberId);
    const channel = await getChannelRef(h.db, f.channelId);
    const sent = await sendMessage(h.db, ctx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      body: 'an ordinary message',
    });
    if (!sent.ok) return;
    await drainAndDeliver();
    push.reset();

    const adminCtx = await loadAccessContext(h.db, f.adminId);
    const pinned = await setPinned(h.db, adminCtx, channel!, sent.message.seq, true);
    expect(pinned.ok).toBe(true);
    await drainAndDeliver();

    // Pins are reference, not interruption.
    expect(push.sent).toHaveLength(0);
    const rows = await h.db.select().from(notifications);
    expect(rows).toHaveLength(0);
  });
});

describe('column-level authority', () => {
  it('refuses a member posting an announcement', async () => {
    const f = await setupClub();
    const result = await announce(f, f.memberId, 'I am not an admin');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden');
  });

  it('refuses a member pinning, even their own message', async () => {
    // Attempted directly, bypassing any UI. "The button is hidden" is not evidence.
    const f = await setupClub();
    const ctx = await loadAccessContext(h.db, f.memberId);
    const channel = await getChannelRef(h.db, f.channelId);
    const sent = await sendMessage(h.db, ctx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      body: 'mine',
    });
    if (!sent.ok) return;

    const pinned = await setPinned(h.db, ctx, channel!, sent.message.seq, true);
    expect(pinned.ok).toBe(false);
  });

  it('lets a member delete their own message but not pin it', async () => {
    // The exact split that a single row-level rule got wrong in v1. Gating the whole row
    // on admin would have cost the sender their legitimate delete; gating it on
    // sender-or-admin let any member retro-flip their own message into an announcement.
    const f = await setupClub();
    const ctx = await loadAccessContext(h.db, f.memberId);
    const channel = await getChannelRef(h.db, f.channelId);
    const sent = await sendMessage(h.db, ctx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      body: 'delete me',
    });
    if (!sent.ok) return;

    expect((await setPinned(h.db, ctx, channel!, sent.message.seq, true)).ok).toBe(false);
    expect((await softDeleteMessage(h.db, ctx, channel!, sent.message.seq)).ok).toBe(true);
  });

  it('refuses a member deleting somebody else message, but allows an admin', async () => {
    const f = await setupClub();
    const memberCtx = await loadAccessContext(h.db, f.memberId);
    const adminCtx = await loadAccessContext(h.db, f.adminId);
    const channel = await getChannelRef(h.db, f.channelId);

    const ownerCtx = await loadAccessContext(h.db, f.ownerId);
    const byOwner = await sendMessage(h.db, ownerCtx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      body: 'the owner said this',
    });
    if (!byOwner.ok) return;

    expect((await softDeleteMessage(h.db, memberCtx, channel!, byOwner.message.seq)).ok).toBe(
      false,
    );
    expect((await softDeleteMessage(h.db, adminCtx, channel!, byOwner.message.seq)).ok).toBe(true);
  });

  it('refuses a client trying to originate a system message', async () => {
    // A forged "Riley was removed from the club" would be indistinguishable from the
    // real thing, so `system` is not a type a client may send at all.
    const f = await setupClub();
    const ctx = await loadAccessContext(h.db, f.ownerId);
    const channel = await getChannelRef(h.db, f.channelId);
    const result = await sendMessage(h.db, ctx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      type: 'system',
      body: 'Member was removed by Owner',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_type');
  });
});

// ===========================================================================
// THE TYPES THAT WROTE A ROW AND RANG NOTHING
// ===========================================================================

/**
 * Membership, roles and requests reach a phone, not just the inbox.
 *
 * > **Fourteen call sites wrote a notification row and scheduled no push**, found on 2026-08-14
 * > while checking whether "push is done" was actually true. Every join request, every decision
 * > on one, every add, removal and role change, and a car group left without an Incharge: all of
 * > them filled the badge and rang nothing. The tell is that there is nothing to see -
 * > `writeNotifications` is a complete and correct call, and what was missing was a second
 * > statement nobody was reminded to write.
 *
 * These assert the buzz specifically, because the ROWS were already tested and those tests all
 * passed throughout. `notifyAndPush` is the structural fix; this is the part a helper cannot
 * prove about itself.
 */
describe('membership and requests reach a phone', () => {
  /*
   * These handlers post a system message into club chat ("Owner promoted Member as admin")
   * before they notify, and publishing that goes over Redis - which this file deliberately
   * passes as `null` so that any reach for it fails loudly (see the note on `deps`). That
   * guarantee is about the PUSH path, so these get a Redis that swallows publishes and nothing
   * else changes: the audience, the ledger and the sender are all still the real ones.
   *
   * Without it the handler throws before it ever reaches the notify, the event goes back for
   * retry, and the test reads as "membership does not push" - which is exactly the conclusion
   * this describe block exists to check, so it would have been a convincing false negative.
   */
  async function drainPublishing() {
    await drainOnce(h.db, { ...deps, redis: { publish: async () => 0 } as never });
    const pending = [...deferred];
    deferred = [];
    for (const fn of pending) await fn();
  }

  it('rings every admin when somebody asks to join', async () => {
    const f = await setupClub();
    await registerDevice(h.db, {
      userId: f.ownerId,
      pushToken: 'ExponentPushToken[owner-phone]',
      platform: 'ios',
    });
    await registerDevice(h.db, {
      userId: f.adminId,
      pushToken: 'ExponentPushToken[admin-phone]',
      platform: 'ios',
    });

    // A request-policy club, so joining files a request rather than admitting outright.
    await setJoinPolicy(h.db, await loadAccessContext(h.db, f.ownerId), f.clubId, 'request');
    const outsider = await makeUser('Outsider');
    const asked = await joinClub(h.db, outsider, f.clubId);
    if (!asked.ok) throw new Error('join request failed');
    await drainPublishing();

    /*
     * Both admins, and the requester is not an admin so there is nobody else to reach.
     *
     * This is the one that matters most of the nine: PRD/12 rule 4 goes out of its way to stop a
     * join request clearing when the inbox is merely opened, with the note "the founder lost real
     * join requests this way" - and until this change the only way to learn of one was to happen
     * to open the app.
     */
    expect(push.sent.map((m) => m.token).sort()).toEqual([
      'ExponentPushToken[admin-phone]',
      'ExponentPushToken[owner-phone]',
    ]);
    expect(push.sent[0]?.body).toContain('asked to join');
  });

  it('rings the member whose role changed, and nobody else', async () => {
    const f = await setupClub();
    const tokens = new Map<string, string>();
    for (const userId of [f.ownerId, f.adminId, f.memberId]) {
      const token = `ExponentPushToken[r-${userId.slice(0, 8)}]`;
      await registerDevice(h.db, { userId, pushToken: token, platform: 'ios' });
      tokens.set(userId, token);
    }

    await changeRole(
      h.db,
      await loadAccessContext(h.db, f.ownerId),
      f.clubId,
      f.memberId,
      'admin',
    );
    await drainPublishing();

    // Addressed to one person. A role change is not club news.
    expect(push.sent.map((m) => m.token)).toEqual([tokens.get(f.memberId)!]);
    expect(push.sent[0]?.body).toContain('admin');
  });

  it('rings somebody added to a club directly', async () => {
    const f = await setupClub();
    const newcomer = await makeUser('Newcomer');
    await registerDevice(h.db, {
      userId: newcomer,
      pushToken: 'ExponentPushToken[newcomer]',
      platform: 'ios',
    });

    await addMember(h.db, await loadAccessContext(h.db, f.ownerId), f.clubId, newcomer);
    await drainPublishing();

    expect(push.sent.map((m) => m.token)).toContain('ExponentPushToken[newcomer]');
  });
});

// ===========================================================================
// ORDINARY CHAT MESSAGES
// ===========================================================================

/**
 * The push that fires on every message, added 2026-08-14. See ADR-0032.
 *
 * These are the tests that would have caught the thing being reversed: club chat was silent by
 * design, the design was written down in three places, and the only way to notice was to hold a
 * phone and wait for it. What is asserted here is the pair of facts that make per-message push
 * survivable - it never writes a row, and both suppressions still work - because without those
 * this is just "buzz everybody, always".
 */
describe('an ordinary message in group chat', () => {
  /** Register a phone per user and return the tokens, keyed by user id. */
  async function phonesFor(userIds: readonly string[]): Promise<Map<string, string>> {
    const tokens = new Map<string, string>();
    for (const userId of userIds) {
      const token = `ExponentPushToken[c-${userId.slice(0, 8)}]`;
      await registerDevice(h.db, { userId, pushToken: token, platform: 'ios' });
      tokens.set(userId, token);
    }
    return tokens;
  }

  async function say(f: Fixture, actorId: string, body: string) {
    const ctx = await loadAccessContext(h.db, actorId);
    const channel = await getChannelRef(h.db, f.channelId);
    if (!channel) throw new Error('no channel');
    return sendMessage(h.db, ctx, channel, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      body,
    });
  }

  it('buzzes everyone else in the room and writes nothing to the inbox', async () => {
    const f = await setupClub();
    const tokens = await phonesFor([f.ownerId, f.adminId, f.memberId]);

    await say(f, f.adminId, 'are we still on for six');
    await drainAndDeliver();

    // Everyone but the sender. The admin said it, so the admin's own phone stays quiet.
    expect(push.sent.map((m) => m.token).sort()).toEqual(
      [tokens.get(f.ownerId)!, tokens.get(f.memberId)!].sort(),
    );

    /*
     * **No rows, at all.** This is the half that keeps PRD/12 rule 8 intact: the badge and the
     * feed are still one entry per channel, computed from the log. A row per message is the
     * flood the rule rejects, and it is what a careless version of this change would ship.
     */
    expect(await h.db.select().from(notifications)).toHaveLength(0);
  });

  it('reads as the room, then the speaker, then what they said', async () => {
    const f = await setupClub();
    await phonesFor([f.memberId]);

    await say(f, f.adminId, 'bus leaves from the car park');
    await drainAndDeliver();

    // The club is the title, because it is what tells you whether this matters before you have
    // read a word. A DM is deliberately the other way round - there the sender IS the room.
    expect(push.sent[0]?.title).toBe('Hillside Running Club');
    expect(push.sent[0]?.body).toBe('Admin: bus leaves from the car park');
  });

  it('lands on the conversation rather than on this one message', async () => {
    const f = await setupClub();
    await phonesFor([f.memberId]);

    await say(f, f.adminId, 'first');
    await drainAndDeliver();

    /*
     * No `seq`, unlike an announcement or a mention. Those are about one specific message; this
     * fires on every message, so by the time somebody taps it the interesting place is the first
     * thing they have not read - which is where chat opens on its own.
     */
    expect(push.sent[0]?.data['target']).toEqual({ kind: 'chat', channelId: f.channelId });
  });

  it('stays silent for somebody who has already read past it', async () => {
    const f = await setupClub();
    await phonesFor([f.memberId]);

    const sent = await say(f, f.adminId, 'anyone bringing cones');
    if (!sent.ok) throw new Error('send failed');

    // Read before the deferral elapses, which is exactly the race the eight seconds exist to
    // lose. The cursor is re-read at evaluation time, so this suppresses.
    await advanceReadCursor(h.db, f.memberId, f.channelId, sent.message.seq);
    await drainAndDeliver();

    expect(push.sent, 'buzzed a phone that was already looking at the message').toHaveLength(0);
  });

  it('is silenced by a mute, which is the control that makes a loud club bearable', async () => {
    const f = await setupClub();
    await phonesFor([f.memberId]);
    await h.db.insert(channelMutes).values({ userId: f.memberId, channelId: f.channelId });

    await say(f, f.adminId, 'seven messages about parking');
    await drainAndDeliver();

    expect(push.sent, 'pushed into a muted conversation').toHaveLength(0);
  });

  it('describes a photo that arrives without a caption', async () => {
    const f = await setupClub();
    await phonesFor([f.memberId]);

    // Straight through appendMessage: the point is a message whose body is genuinely null, which
    // is every photo sent without a caption.
    await appendMessage(h.db, {
      channelId: f.channelId,
      senderId: f.adminId,
      clientMsgId: crypto.randomUUID(),
      type: 'photo',
      body: null,
    });
    await drainAndDeliver();

    // Untreated, the renderer interpolates an empty preview and this reads "Admin: " - a name,
    // a colon, and nothing, on a lock screen.
    expect(push.sent[0]?.body).toBe('Admin: sent a photo');
  });

  it('buzzes a race roster and not the whole club', async () => {
    const f = await setupClub();
    const tokens = await phonesFor([f.ownerId, f.adminId, f.memberId]);

    // Owner creates the race and walks onto its roster; the admin joins. The MEMBER stays off it.
    const race = await createRace(h.db, await loadAccessContext(h.db, f.ownerId), {
      clubId: f.clubId,
      name: 'Spring Half',
      raceDate: '2026-04-12',
    });
    if (!race.ok) throw new Error('race creation failed');
    await addRaceMember(h.db, await loadAccessContext(h.db, f.ownerId), race.raceId, f.adminId);
    await drainAndDeliver();
    push.reset();

    const ctx = await loadAccessContext(h.db, f.adminId);
    const channel = await getChannelRef(h.db, race.channelId);
    await sendMessage(h.db, ctx, channel!, {
      channelId: race.channelId,
      clientMsgId: crypto.randomUUID(),
      body: 'bring your own cones',
    });
    await drainAndDeliver();

    /*
     * > **The roster, never the roster union the club's admins.** This is rule 2 at the top of
     * > `audience.ts`, which shipped wrong four separate times in v1 - and it is the reason
     * > `chat_message` resolves through `channelAudienceById` rather than sitting with the
     * > club-wide types. Getting it wrong here would buzz every member of the club about a
     * > conversation they cannot open.
     *
     * The member is in the club and not on this roster, so their phone stays silent. The admin
     * sent it, so theirs does too.
     */
    expect(push.sent.map((m) => m.token)).toEqual([tokens.get(f.ownerId)!]);
  });

  it('never buzzes for a system message, which nobody said', async () => {
    const f = await setupClub();
    await phonesFor([f.ownerId, f.memberId]);

    await appendMessage(h.db, {
      channelId: f.channelId,
      senderId: f.adminId,
      clientMsgId: crypto.randomUUID(),
      type: 'system',
      body: 'Member was removed by Owner',
    });
    await drainAndDeliver();

    /*
     * The worker writes these itself. Letting them buzz would turn one bulk membership change
     * into a notification per line, from an author who does not exist.
     */
    expect(push.sent, 'a system line buzzed a phone').toHaveLength(0);
  });
});

// ===========================================================================
// MENTIONS
// ===========================================================================

describe('mentions', () => {
  it('writes a row only for the mentioned member, and buzzes each phone exactly once', async () => {
    const f = await setupClub();
    for (const userId of [f.ownerId, f.memberId]) {
      await registerDevice(h.db, {
        userId,
        pushToken: `ExponentPushToken[m-${userId.slice(0, 8)}]`,
        platform: 'ios',
      });
    }

    const ctx = await loadAccessContext(h.db, f.adminId);
    const channel = await getChannelRef(h.db, f.channelId);
    await sendMessage(h.db, ctx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      // The name has to be IN the body: a mention is only stored for somebody the text
      // actually names, so that deleting the name before sending takes the mention with it.
      body: '@Member can you drive on Saturday?',
      mentions: [f.memberId],
    });
    await drainAndDeliver();

    // Only a mention writes a ROW. `chat_message` is push-only, so the owner's buzz below
    // leaves nothing in anybody's inbox - ADR-0032.
    const rows = await h.db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipientId).toBe(f.memberId);
    expect(rows[0]?.type).toBe('mentioned');

    /*
     * > **Both phones buzz, and neither buzzes twice.** Until 2026-08-14 the owner got nothing,
     * > because an ordinary message notified nobody; they now get the ordinary chat push. The
     * > mentioned member must NOT get both - "Admin mentioned you" is the better of the two
     * > lines, and receiving it alongside a plain "Admin: ..." is one message ringing a phone
     * > twice. That is why the group-chat audience subtracts the mentioned.
     */
    const memberToken = `ExponentPushToken[m-${f.memberId.slice(0, 8)}]`;
    const ownerToken = `ExponentPushToken[m-${f.ownerId.slice(0, 8)}]`;
    expect(push.sent).toHaveLength(2);
    expect(push.sent.filter((m) => m.token === memberToken)).toHaveLength(1);

    const byToken = new Map(push.sent.map((m) => [m.token, m]));
    expect(byToken.get(memberToken)?.data['type']).toBe('mentioned');
    expect(byToken.get(ownerToken)?.data['type']).toBe('chat_message');
  });

  it('drops a mention of someone who cannot access the chat', async () => {
    // A client can name anyone by editing the payload. Autocomplete is UX, not
    // enforcement.
    const f = await setupClub();
    const outsider = await makeUser('Outsider');

    const ctx = await loadAccessContext(h.db, f.adminId);
    const channel = await getChannelRef(h.db, f.channelId);
    await sendMessage(h.db, ctx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      body: 'hey stranger',
      mentions: [outsider],
    });
    await drainAndDeliver();

    const rows = await h.db.select().from(notifications);
    expect(rows, 'manufactured a notification into a chat the target cannot open').toHaveLength(
      0,
    );
  });

  it('gives an announced mention two rows and one buzz', async () => {
    /*
     * The two halves of the same message pull in opposite directions, and both are right.
     *
     *  - **Two rows.** Both notifications derive their idempotency key from the same outbox
     *    event, so without an offset one would silently overwrite the other. The member is
     *    entitled to both: one says the club was told something, the other says they were named
     *    in it, and they clear against different things.
     *  - **One buzz.** One phone, one message.
     *
     * > **The buzz half was wrong until 2026-08-16.** The announcement push went to the whole
     * > channel audience, so a member named in an announcement got "Admin: kit order closes
     * > Friday" and "Admin mentioned you" seconds apart. The identical rule was already applied
     * > correctly one branch down, in the ordinary-message audience, and the two had never been
     * > read side by side. This test asserted the rows and stopped, which is why nothing caught
     * > it - the assertion that was missing is the one that had to be added, not fixed.
     */
    const f = await setupClub();
    for (const userId of [f.ownerId, f.memberId]) {
      await registerDevice(h.db, {
        userId,
        pushToken: `ExponentPushToken[a-${userId.slice(0, 8)}]`,
        platform: 'ios',
      });
    }

    const ctx = await loadAccessContext(h.db, f.adminId);
    const channel = await getChannelRef(h.db, f.channelId);
    await sendMessage(h.db, ctx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      type: 'announcement',
      // Capitalised to match the member's actual name. The match is exact rather than
      // case-insensitive, because the stored name is what the client looks for in the body to
      // highlight - a case-folded match would store "Member" against text reading "@member" and
      // highlight nothing. Picking from the autocomplete always inserts the exact name.
      body: 'kit order closes Friday, @Member please confirm',
      mentions: [f.memberId],
    });
    await drainAndDeliver();

    const forMember = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, f.memberId));
    expect(forMember.map((r) => r.type).sort()).toEqual(['announcement', 'mentioned']);

    const memberToken = `ExponentPushToken[a-${f.memberId.slice(0, 8)}]`;
    const ownerToken = `ExponentPushToken[a-${f.ownerId.slice(0, 8)}]`;

    expect(
      push.sent.filter((m) => m.token === memberToken).map((m) => m.data['type']),
      'the mentioned member was buzzed for the announcement as well',
    ).toEqual(['mentioned']);

    // And the subtraction took only the named: everybody else still hears the announcement,
    // which is the way a fix like this goes wrong in the other direction.
    expect(push.sent.filter((m) => m.token === ownerToken).map((m) => m.data['type'])).toEqual([
      'announcement',
    ]);
  });

  /**
   * > **A mention the text does not contain is not a mention.**
   *
   * The realistic path to this is not an attacker: it is somebody picking a name from the
   * autocomplete and then deleting it again before sending. Being notified about a message that
   * does not contain your name is confusing in a way no wording fixes, so the body is the
   * authority and the client's claim is only a hint.
   */
  /**
   * A name that is the PREFIX of another name must not be dragged in with it.
   *
   * Reported 2026-08-08. `body.includes('@' + name)` cannot tell a name from the start of a
   * longer one, so "@Parks RPK" contained "@Parks" and notified a member who was never mentioned.
   * Word boundaries do not help - the next character is a space - so the rule is that a longer
   * candidate matching at the same index wins.
   */
  it('does not mention a member whose name is a prefix of the person actually named', async () => {
    const f = await setupClub();
    const ctx = await loadAccessContext(h.db, f.adminId);
    const channel = await getChannelRef(h.db, f.channelId);

    // Two members, one name a prefix of the other.
    await h.db.update(users).set({ name: 'Parks RPK' }).where(eq(users.id, f.memberId));
    const shortId = await makeUser('Parks');
    await h.db
      .insert(clubMemberships)
      .values({ clubId: f.clubId, userId: shortId, role: 'member' });

    const sent = await sendMessage(h.db, ctx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      body: '@Parks RPK are you running tomorrow?',
      // The client claims both, as an over-eager composer would.
      mentions: [f.memberId, shortId],
    });
    expect(sent.ok).toBe(true);
    const messageId = sent.ok ? sent.message.id : '';

    const stored = await h.db
      .select()
      .from(messageMentions)
      .where(eq(messageMentions.messageId, messageId));

    expect(stored.map((row) => row.name)).toEqual(['Parks RPK']);
    expect(
      stored.some((row) => row.userId === shortId),
      'a member whose name is merely a prefix was notified',
    ).toBe(false);
  });

  it('still mentions the short name when it is the one actually written', async () => {
    const f = await setupClub();
    const ctx = await loadAccessContext(h.db, f.adminId);
    const channel = await getChannelRef(h.db, f.channelId);

    await h.db.update(users).set({ name: 'Parks RPK' }).where(eq(users.id, f.memberId));
    const shortId = await makeUser('Parks');
    await h.db
      .insert(clubMemberships)
      .values({ clubId: f.clubId, userId: shortId, role: 'member' });

    const sent = await sendMessage(h.db, ctx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      // Only the short name appears, so the longer one must not steal it.
      body: '@Parks how did it go?',
      mentions: [f.memberId, shortId],
    });
    const messageId = sent.ok ? sent.message.id : '';

    const stored = await h.db
      .select()
      .from(messageMentions)
      .where(eq(messageMentions.messageId, messageId));
    expect(stored.map((row) => row.name)).toEqual(['Parks']);
  });

  it('stores no mention when the body does not name the person', async () => {
    const f = await setupClub();
    const ctx = await loadAccessContext(h.db, f.adminId);
    const channel = await getChannelRef(h.db, f.channelId);

    const sent = await sendMessage(h.db, ctx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      // The claim names the member; the text does not.
      body: 'can you drive on Saturday?',
      mentions: [f.memberId],
    });
    expect(sent.ok).toBe(true);
    const messageId = sent.ok ? sent.message.id : '';
    await drainAndDeliver();

    // Scoped to this message: the table is shared with every other test in this file.
    const stored = await h.db
      .select()
      .from(messageMentions)
      .where(eq(messageMentions.messageId, messageId));
    expect(stored).toHaveLength(0);
    const rows = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, f.memberId));
    expect(rows).toHaveLength(0);
  });

  /**
   * The name is taken from the user record, never from the caller, so no request can make an
   * arbitrary run of characters highlight as somebody else.
   */
  it('stores the name as written, so a later rename cannot unhighlight old messages', async () => {
    const f = await setupClub();
    const ctx = await loadAccessContext(h.db, f.adminId);
    const channel = await getChannelRef(h.db, f.channelId);

    const sent = await sendMessage(h.db, ctx, channel!, {
      channelId: f.channelId,
      clientMsgId: crypto.randomUUID(),
      body: '@Member are you in?',
      mentions: [f.memberId],
    });
    const messageId = sent.ok ? sent.message.id : '';

    const stored = await h.db
      .select()
      .from(messageMentions)
      .where(eq(messageMentions.messageId, messageId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('Member');

    // Rename them. The stored mention still describes the characters sitting in the body, which
    // is the whole point of storing it rather than re-joining on read.
    await h.db.update(users).set({ name: 'Renamed Person' }).where(eq(users.id, f.memberId));
    const after = await h.db
      .select()
      .from(messageMentions)
      .where(eq(messageMentions.messageId, messageId));
    expect(after[0]?.name).toBe('Member');
  });
});
