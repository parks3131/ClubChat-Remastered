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
import { createClub } from '../domain/create-club.ts';
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
// MENTIONS
// ===========================================================================

describe('mentions', () => {
  it('notifies the mentioned member and nobody else', async () => {
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

    const rows = await h.db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipientId).toBe(f.memberId);
    expect(rows[0]?.type).toBe('mentioned');
    // An ordinary message notifies nobody, so the owner gets nothing.
    expect(push.sent.map((m) => m.token)).toEqual([
      `ExponentPushToken[m-${f.memberId.slice(0, 8)}]`,
    ]);
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

  it('keeps an announcement and a mention in the same message from colliding', async () => {
    // Both notifications derive their idempotency key from the same outbox event, so
    // without an offset one would silently overwrite the other.
    const f = await setupClub();
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
  });

  /**
   * > **A mention the text does not contain is not a mention.**
   *
   * The realistic path to this is not an attacker: it is somebody picking a name from the
   * autocomplete and then deleting it again before sending. Being notified about a message that
   * does not contain your name is confusing in a way no wording fixes, so the body is the
   * authority and the client's claim is only a hint.
   */
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
