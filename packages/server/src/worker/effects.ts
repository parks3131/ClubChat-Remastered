/**
 * Effect handlers. Every server-side effect lives here and nowhere else.
 *
 * Everything in this file must happen **automatically, server-side, regardless of
 * which client or screen triggered it**. Hooking the data change rather than the call
 * site is what makes a card appear whether a poll was created from the poll screen or
 * the chat "+" menu.
 *
 * **Delivery is at-least-once, so every handler must be idempotent.** That is enforced
 * structurally rather than by care: system messages and cards derive their
 * `client_msg_id` deterministically from the outbox event id and collide with
 * `UNIQUE (channel_id, sender_id, client_msg_id)` on redelivery.
 */

import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { SYSTEM_ACTOR_ID } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { appendMessage, deriveClientMsgId } from '../domain/append-message.ts';
import { publishToChannel, publishRevocation } from '../bus/redis.ts';
import { resolveAudience } from './audience.ts';
import { writeNotifications } from './notify.ts';
import { dispatchPush, PUSH_DEFERRAL_MS } from '../push/dispatch.ts';
import type { PushSender } from '../push/sender.ts';

export type OutboxEvent = {
  id: number;
  partitionKey: string;
  eventType: string;
  payload: Record<string, unknown>;
};

export type EffectDeps = {
  db: Db;
  redis: Redis;
  push: PushSender;
  log: (level: 'info' | 'warn' | 'error', message: string, extra?: unknown) => void;
  /**
   * Schedule the deferred push evaluation.
   *
   * Injected so tests can run it immediately instead of waiting eight seconds. The
   * deferral is real in production and exists to lose a race against the recipient's own
   * read acknowledgement - see PUSH_DEFERRAL_MS.
   */
  defer?: ((fn: () => Promise<void>, ms: number) => void) | undefined;
};

function schedule(deps: EffectDeps, fn: () => Promise<void>) {
  if (deps.defer) {
    deps.defer(fn, PUSH_DEFERRAL_MS);
    return;
  }
  setTimeout(() => {
    void fn().catch((error) =>
      deps.log('error', 'deferred push evaluation failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }, PUSH_DEFERRAL_MS).unref?.();
}

export type EffectHandler = (event: OutboxEvent, deps: EffectDeps) => Promise<void>;

/**
 * Post a server-authored message, then publish it.
 *
 * Uses the SAME appendMessage path as a user's send - same sequence allocation, same
 * ordering guarantees. There is deliberately no second write path into the log.
 *
 * The publish afterwards is why the worker talks to Redis at all: some effects ARE new
 * chat messages, so they have to reach everyone's open chat live for exactly the same
 * reason a typed message does.
 */
async function postSystemMessage(
  deps: EffectDeps,
  args: { channelId: string; body: string; eventId: number; scope?: string },
): Promise<void> {
  const result = await appendMessage(deps.db, {
    channelId: args.channelId,
    // Never NULL. Postgres treats NULLs as distinct in a unique index, so a null
    // sender would silently defeat the idempotency constraint that makes this handler
    // safe to retry.
    senderId: SYSTEM_ACTOR_ID,
    clientMsgId: deriveClientMsgId(args.scope ?? 'outbox', args.eventId),
    type: 'system',
    body: args.body,
  });

  if (result.deduplicated) {
    // Redelivery. The message already exists and was already published, so republishing
    // would deliver a duplicate to every open client.
    deps.log('info', 'system message already posted, skipping publish', {
      eventId: args.eventId,
      seq: result.message.seq,
    });
    return;
  }

  await publishToChannel(deps.redis, args.channelId, result.message);
}

/**
 * A club was created.
 *
 * The Phase 0 bootstrap effect. In v1 this was a chain of triggers firing each other
 * with implicit, untestable ordering; the rows themselves are now created in one
 * explicit transaction in createClub, and this handler only produces the effect that
 * must happen afterwards.
 */
const onClubCreated: EffectHandler = async (event, deps) => {
  const mainChannelId = event.payload['mainChannelId'];
  const creatorId = event.payload['creatorId'];
  const clubName = event.payload['clubName'];

  if (typeof mainChannelId !== 'string' || typeof creatorId !== 'string') {
    throw new Error(`club.created payload missing mainChannelId or creatorId`);
  }

  const rows = await deps.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, creatorId))
    .limit(1);
  const creatorName = rows[0]?.name ?? 'Someone';

  await postSystemMessage(deps, {
    channelId: mainChannelId,
    body: `${creatorName} created ${typeof clubName === 'string' ? clubName : 'this club'}`,
    eventId: event.id,
  });
};

/**
 * A message was created.
 *
 * A no-op in Phase 0, and deliberately still routed through the outbox rather than
 * omitted. Phase 1 attaches notification fan-out and push dispatch here, which is
 * where the audience rules and the read-cursor suppression will live. The event
 * existing now means that work is an added handler rather than a change to the send
 * path.
 */
const onMessageCreated: EffectHandler = async (event, deps) => {
  const channelId = String(event.payload['channelId'] ?? event.partitionKey);
  const seq = Number(event.payload['seq']);
  const senderId = String(event.payload['senderId'] ?? '');
  const type = String(event.payload['type'] ?? 'text');

  // Only two message types notify anyone. **Pinning notifies nobody; announcing always
  // does** - a pin is reference, an announcement is interruption. An ordinary text
  // message produces no discrete notification at all: its unread count is derived from
  // the log, never stored.
  const isAnnouncement = type === 'announcement';
  const mentioned = await mentionedUsers(deps.db, channelId, seq);

  if (!isAnnouncement && mentioned.length === 0) return;

  const context = await channelContext(deps.db, channelId);
  if (!context) {
    deps.log('warn', 'message.created for a channel that no longer exists', { channelId });
    return;
  }

  const actorName = await displayName(deps.db, senderId);
  const preview = String(event.payload['preview'] ?? '').slice(0, 140);

  if (isAnnouncement) {
    const recipients = await resolveAudience(deps.db, {
      type: 'announcement',
      actorId: senderId,
      clubId: context.clubId,
      channelId,
    });

    const params = {
      clubId: context.clubId,
      channelId,
      channelName: context.name,
      seq,
      preview,
      actorName,
    };

    const { created } = await writeNotifications(deps.db, {
      outboxEventId: event.id,
      type: 'announcement',
      params,
      recipients,
      actorId: senderId,
      clubId: context.clubId,
    });

    deps.log('info', 'announcement notifications written', {
      eventId: event.id,
      recipients: recipients.length,
      created,
    });

    // Deferred, then the cursor is re-read. Scheduling happens regardless of `created`,
    // because the push ledger - not the notification insert - is what makes the buzz
    // idempotent, and a redelivery after a crash between the two must still push.
    schedule(deps, async () => {
      const outcome = await dispatchPush(deps.db, deps.push, {
        outboxEventId: event.id,
        type: 'announcement',
        params,
        recipients,
        channelId,
        seq,
      });
      deps.log('info', 'announcement push dispatched', { eventId: event.id, ...outcome });
    });
  }

  if (mentioned.length > 0) {
    // A mention notifies the named member individually, and only if they can access the
    // chat - already guaranteed, because sendMessage filtered the list before storing it.
    const params = {
      clubId: context.clubId,
      channelId,
      channelName: context.name,
      seq,
      preview,
      actorName,
    };

    const recipients = await resolveAudience(deps.db, {
      type: 'mentioned',
      actorId: senderId,
      clubId: context.clubId,
      channelId,
      explicitRecipients: mentioned,
    });

    await writeNotifications(deps.db, {
      // Offset so a message that is BOTH an announcement and a mention does not have its
      // two notifications collide on the idempotency key.
      outboxEventId: event.id * 2 + 1,
      type: 'mentioned',
      params,
      recipients,
      actorId: senderId,
      clubId: context.clubId,
    });

    schedule(deps, async () => {
      const outcome = await dispatchPush(deps.db, deps.push, {
        outboxEventId: event.id * 2 + 1,
        type: 'mentioned',
        params,
        recipients,
        channelId,
        seq,
      });
      deps.log('info', 'mention push dispatched', { eventId: event.id, ...outcome });
    });
  }
};

/** The people named in a message, as stored. */
async function mentionedUsers(db: Db, channelId: string, seq: number): Promise<string[]> {
  const rows = await db.execute<{ user_id: string }>(sql`
    SELECT mm.user_id
      FROM message_mentions mm
      JOIN messages m ON m.id = mm.message_id
     WHERE m.channel_id = ${channelId} AND m.seq = ${seq}
  `);
  return rows.rows.map((r) => r.user_id);
}

/**
 * The channel's club and display name.
 *
 * The name is what a push notification's title shows, so it comes from the owning club,
 * race or Eboard rather than being invented at the call site.
 */
async function channelContext(
  db: Db,
  channelId: string,
): Promise<{ clubId: string | null; name: string } | null> {
  const rows = await db.execute<{
    club_id: string | null;
    name: string | null;
  }>(sql`
    SELECT c.club_id,
           COALESCE(e.name, cl.name) AS name
      FROM channels c
      LEFT JOIN clubs cl ON cl.id = c.club_id
      LEFT JOIN eboard_channels e ON c.scope = 'eboard' AND e.id = c.scope_id
     WHERE c.id = ${channelId}
  `);
  const row = rows.rows[0];
  if (!row) return null;
  return { clubId: row.club_id, name: row.name ?? 'ClubChat' };
}

async function displayName(db: Db, userId: string): Promise<string> {
  if (!userId) return 'Someone';
  const rows = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.name ?? 'Someone';
}

/** Look up a club's name and main channel once, for the system-message emitters. */
async function clubContext(
  db: Db,
  clubId: string,
): Promise<{ name: string; mainChannelId: string } | null> {
  const rows = await db.execute<{ name: string; main_channel_id: string }>(sql`
    SELECT cl.name, ch.id AS main_channel_id
      FROM clubs cl
      -- The scope predicate is not optional: joining on club_id alone also matches the
      -- club's eboard channel, and forgetting it produced "more than one row returned by a
      -- subquery" twice in v1.
      JOIN channels ch ON ch.club_id = cl.id AND ch.scope = 'club'
     WHERE cl.id = ${clubId}
  `);
  const row = rows.rows[0];
  return row ? { name: row.name, mainChannelId: row.main_channel_id } : null;
}

/**
 * Someone joined.
 *
 * Posts a system message and, when an admin did the adding, tells the person they were
 * added. A member who joined an open club under their own steam is told nothing - they were
 * there when it happened.
 */
const onMemberJoined: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const userId = String(event.payload['userId']);
  const actorId = event.payload['actorId'] as string | null;
  const via = String(event.payload['via']);

  const club = await clubContext(deps.db, clubId);
  if (!club) return;

  const joinerName = await displayName(deps.db, userId);
  const actorName = actorId ? await displayName(deps.db, actorId) : null;

  await postSystemMessage(deps, {
    channelId: club.mainChannelId,
    body: actorName
      ? `${joinerName} was added by ${actorName}`
      : `${joinerName} joined the club`,
    eventId: event.id,
  });

  // An approval produces its own "your request was approved" from club.join_decided.
  // Emitting "you were added" here as well would tell one person the same thing twice, so
  // the approval path suppresses it - which is why `via` is on the event at all.
  if (via === 'added' && actorId) {
    await writeNotifications(deps.db, {
      outboxEventId: event.id,
      type: 'member_added',
      params: {
        clubId,
        clubName: club.name,
        actorName: actorName ?? 'An admin',
        scope: 'club',
        scopeName: club.name,
        scopeId: clubId,
      },
      recipients: [userId],
      actorId,
      clubId,
    });
  }
};

/** A join request was filed. Notifies the admin tier - both admin AND owner. */
const onJoinRequested: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const userId = String(event.payload['userId']);

  const club = await clubContext(deps.db, clubId);
  if (!club) return;

  const recipients = await resolveAudience(deps.db, {
    type: 'club_join_request',
    // The requester is not an admin, so there is nobody to exclude - but passing the actor
    // keeps the exclusion rule uniform rather than special-cased.
    actorId: userId,
    clubId,
  });

  await writeNotifications(deps.db, {
    outboxEventId: event.id,
    type: 'club_join_request',
    params: {
      clubId,
      clubName: club.name,
      requesterName: await displayName(deps.db, userId),
      requesterId: userId,
    },
    recipients,
    actorId: userId,
    clubId,
  });
};

/**
 * A request was decided.
 *
 * **The decided row stays in the admin's feed tagged approved or denied** rather than
 * disappearing, so they keep a record of what they decided - that is the notification
 * written here for the requester, plus the request row's own status.
 */
const onJoinDecided: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const userId = String(event.payload['userId']);
  const actorId = String(event.payload['actorId']);
  const approved = event.payload['approved'] === true;

  const club = await clubContext(deps.db, clubId);
  if (!club) return;

  const actorName = await displayName(deps.db, actorId);

  if (approved) {
    await postSystemMessage(deps, {
      channelId: club.mainChannelId,
      body: `${await displayName(deps.db, userId)} joined the club`,
      eventId: event.id,
      scope: 'approved',
    });
  }

  await writeNotifications(deps.db, {
    outboxEventId: event.id,
    type: approved ? 'request_approved' : 'request_denied',
    params: {
      clubId,
      clubName: club.name,
      actorName,
      scope: 'club',
      scopeName: club.name,
      ...(approved ? { scopeId: clubId } : {}),
    } as never,
    recipients: [userId],
    actorId,
    clubId,
  });
};

/** A role changed. Announced in chat, and the affected member is told. */
const onRoleChanged: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const userId = String(event.payload['userId']);
  const actorId = String(event.payload['actorId']);
  const newRole = String(event.payload['newRole']) as 'admin' | 'member';

  const club = await clubContext(deps.db, clubId);
  if (!club) return;

  const name = await displayName(deps.db, userId);
  const actorName = await displayName(deps.db, actorId);

  await postSystemMessage(deps, {
    channelId: club.mainChannelId,
    body:
      newRole === 'admin'
        ? `${name} is now an admin`
        : `${name} is no longer an admin`,
    eventId: event.id,
  });

  await writeNotifications(deps.db, {
    outboxEventId: event.id,
    type: 'role_changed',
    params: { clubId, clubName: club.name, actorName, newRole },
    recipients: [userId],
    actorId,
    clubId,
  });
};

/**
 * Ownership was transferred.
 *
 * **One system message, not two.** The outgoing owner's demotion to admin is suppressed:
 * it is mechanically a role change but not a socially separate event, and posting both
 * reads as though something went wrong. This is also why transfer emits its own event type
 * instead of two role changes.
 */
const onOwnershipTransferred: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const toUserId = String(event.payload['toUserId']);
  const fromUserId = String(event.payload['fromUserId']);

  const club = await clubContext(deps.db, clubId);
  if (!club) return;

  const toName = await displayName(deps.db, toUserId);
  const fromName = await displayName(deps.db, fromUserId);

  await postSystemMessage(deps, {
    channelId: club.mainChannelId,
    body: `${fromName} transferred ownership to ${toName}`,
    eventId: event.id,
  });

  await writeNotifications(deps.db, {
    outboxEventId: event.id,
    type: 'role_changed',
    params: { clubId, clubName: club.name, actorName: fromName, newRole: 'owner' },
    recipients: [toUserId],
    actorId: fromUserId,
    clubId,
  });
};

/**
 * Someone left or was removed.
 *
 * Two effects, and the second is the one that is easy to forget: the departing member's
 * live sockets must be **force-unsubscribed**. Their membership row is already gone, but a
 * subscription was authorized once at subscribe time and is never rechecked per message, so
 * without this they keep receiving messages from a club they are no longer in - silently,
 * with nothing reporting it (ADR-0007).
 */
function makeDepartureHandler(reason: 'removed' | 'left'): EffectHandler {
  return async (event, deps) => {
    const clubId = String(event.payload['clubId']);
    const userId = String(event.payload['userId']);
    const actorId = event.payload['actorId'] as string | null;

    const club = await clubContext(deps.db, clubId);
    const name = await displayName(deps.db, userId);

    if (club) {
      const actorName = actorId ? await displayName(deps.db, actorId) : null;
      await postSystemMessage(deps, {
        channelId: club.mainChannelId,
        body:
          reason === 'removed' && actorName
            ? `${name} was removed by ${actorName}`
            : `${name} left the club`,
        eventId: event.id,
      });

      if (reason === 'removed' && actorId) {
        await writeNotifications(deps.db, {
          outboxEventId: event.id,
          type: 'member_removed',
          params: { clubId, clubName: club.name, actorName: actorName ?? 'An admin' },
          recipients: [userId],
          actorId,
          clubId,
        });
      }
    }

    await revokeChannelsForClub(deps, clubId, userId);
  };
}

/**
 * Drop a departing member's subscriptions to every channel in the club.
 *
 * Every channel, not just the main one: they lose the Eboard space and (from Phase 2) every
 * race chat in the club at the same moment.
 */
async function revokeChannelsForClub(deps: EffectDeps, clubId: string, userId: string) {
  const channels = await deps.db.execute<{ id: string }>(
    sql`SELECT id FROM channels WHERE club_id = ${clubId}`,
  );
  const channelIds = channels.rows.map((r) => r.id);
  if (channelIds.length === 0) return;

  await publishRevocation(deps.redis, { userId, channelIds });
  deps.log('info', 'revoked subscriptions for a departing member', {
    userId,
    channels: channelIds.length,
  });
}

/**
 * A club was deleted.
 *
 * The rows are already gone by database cascade. What remains is telling every gateway to
 * drop the sockets, since the channels those sockets subscribe to no longer exist - and the
 * ids had to be captured before the delete, which is why they ride on the event.
 */
const onClubDeleted: EffectHandler = async (event, deps) => {
  const channelIds = (event.payload['channelIds'] as string[] | undefined) ?? [];
  const memberIds = (event.payload['memberIds'] as string[] | undefined) ?? [];
  if (channelIds.length === 0) return;

  for (const userId of memberIds) {
    await publishRevocation(deps.redis, { userId, channelIds });
  }
  deps.log('info', 'club deleted, subscriptions revoked', {
    members: memberIds.length,
    channels: channelIds.length,
  });
};

export const handlers: Record<string, EffectHandler> = {
  'club.created': onClubCreated,
  'message.created': onMessageCreated,
  'message.deleted': async (event, deps) => {
    // The tombstone is already in the log and the client learns of it by sync. Nothing to
    // notify: a deletion is not an event anyone should be interrupted for.
    deps.log('info', 'message.deleted', { eventId: event.id });
  },
  'club.member_joined': onMemberJoined,
  'club.join_requested': onJoinRequested,
  'club.join_decided': onJoinDecided,
  'club.role_changed': onRoleChanged,
  'club.ownership_transferred': onOwnershipTransferred,
  'club.member_removed': makeDepartureHandler('removed'),
  'club.member_left': makeDepartureHandler('left'),
  'club.deleted': onClubDeleted,
};

export async function dispatch(event: OutboxEvent, deps: EffectDeps): Promise<void> {
  const handler = handlers[event.eventType];
  if (!handler) {
    // An unknown event type is a bug, not something to swallow: it means a producer
    // was deployed ahead of its consumer. Throwing routes it through the retry and
    // parking path where it is visible.
    throw new Error(`no handler for event type "${event.eventType}"`);
  }
  await handler(event, deps);
}
