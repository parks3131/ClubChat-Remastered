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
import { SYSTEM_ACTOR_ID, type MessageType } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { appendMessage, deriveClientMsgId } from '../domain/append-message.ts';
import { publishToChannel, publishRevocation, publishUpdate } from '../bus/redis.ts';
import { reactionsForMessages } from '../domain/reactions.ts';
import { resolveAudience } from './audience.ts';
import { notificationKey, writeNotifications } from './notify.ts';
import { dispatchPush, PUSH_DEFERRAL_MS } from '../push/dispatch.ts';
import type { PushSender } from '../push/sender.ts';
import type { MediaStore } from '../media/store.ts';
import { deriveVariants } from '../media/derive.ts';

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
  /** Present in the worker, which derives thumbnails and runs the storage GC. */
  media?: MediaStore | undefined;
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
  args: {
    channelId: string;
    body: string;
    eventId: number;
    scope?: string;
    /**
     * Who the message is FROM. Defaults to the system actor.
     *
     * A card names the person who made the thing, so it is posted as them and renders as their
     * bubble - which is what it is. A plain system line ("X joined the club") stays unattributed,
     * because nobody said it.
     */
    senderId?: string;
    /** `poll`, `event` or `meeting` for a card; `system` for a narration line. */
    type?: MessageType;
    /** Set when this message is a card, so a later delete can find it. */
    linkedPollId?: string | null;
    linkedEventId?: string | null;
    linkedMeetingId?: string | null;
  },
): Promise<void> {
  const result = await appendMessage(deps.db, {
    channelId: args.channelId,
    linkedPollId: args.linkedPollId ?? null,
    linkedEventId: args.linkedEventId ?? null,
    linkedMeetingId: args.linkedMeetingId ?? null,
    // Never NULL. Postgres treats NULLs as distinct in a unique index, so a null
    // sender would silently defeat the idempotency constraint that makes this handler
    // safe to retry.
    senderId: args.senderId ?? SYSTEM_ACTOR_ID,
    clientMsgId: deriveClientMsgId(args.scope ?? 'outbox', args.eventId),
    type: args.type ?? 'system',
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
 * Three kinds of notification can come out of one message, and each is gated separately:
 * announcements (everyone in the space), mentions (the named people), and direct messages (the
 * other participant). A message can be more than one of them, which is why each carries its
 * own idempotency slot.
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

  // The channel is loaded before the early return, because a direct message notifies its
  // recipient whatever its type is - and whether this is a DM is a property of the channel.
  const context = await channelContext(deps.db, channelId);
  if (!context) {
    deps.log('warn', 'message.created for a channel that no longer exists', { channelId });
    return;
  }

  // A DM is the one scope where an ordinary message notifies anyone. Everywhere else an
  // ordinary text produces no discrete notification and no push: its unread count comes from
  // the log. A system message is excluded - a DM has none, but the worker's own writes must
  // never be able to buzz a phone.
  const isDirectMessage = context.scope === 'dm' && type !== 'system';

  if (!isAnnouncement && !isDirectMessage && mentioned.length === 0) return;

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
      outboxEventId: notificationKey(event.id, 0),
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
        outboxEventId: notificationKey(event.id, 0),
        type: 'announcement',
        params,
        recipients,
        channelId,
        seq,
      });
      deps.log('info', 'announcement push dispatched', { eventId: event.id, ...outcome });
    });
  }

  if (isDirectMessage) {
    // Exactly one recipient: the audience of a dm channel is its two participants and
    // `resolveAudience` removes the actor. **Blocking does not remove the other one** - the
    // block prevented the send in the first place, so a message that exists here was
    // authorized when it was written, and its recipient is entitled to know about it.
    const recipients = await resolveAudience(deps.db, {
      type: 'dm_message',
      actorId: senderId,
      clubId: null,
      channelId,
    });

    const params = {
      // Always null. A DM belongs to no club, and the params schema says `z.null()` rather
      // than nullable so a handler that invented one fails the write.
      clubId: null,
      channelId,
      conversationId: context.scopeId,
      // The sender's name, not the channel's: a conversation has no name of its own, and the
      // recipient is always the other participant.
      channelName: actorName,
      seq,
      preview,
      actorName,
    };

    // **No notification row.** The inbox representation of an unread DM is the same computed
    // chat-unread row every other scope gets, so writing one per message would both flood the
    // feed and contradict "computed on read, never stored". Push only. See ADR-0015.
    schedule(deps, async () => {
      const outcome = await dispatchPush(deps.db, deps.push, {
        outboxEventId: notificationKey(event.id, 2),
        type: 'dm_message',
        params,
        recipients,
        // Both suppressions apply here and neither is DM-specific: the read cursor silences a
        // recipient who is already looking at the conversation, and a mute silences the buzz
        // while the unread count keeps climbing.
        channelId,
        seq,
      });
      deps.log('info', 'direct message push dispatched', { eventId: event.id, ...outcome });
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
      // Its own slot, so a message that is BOTH an announcement and a mention does not have
      // its two notifications collide on the idempotency key - and, since the slots are
      // disjoint per event, cannot collide with a different event's either.
      outboxEventId: notificationKey(event.id, 1),
      type: 'mentioned',
      params,
      recipients,
      actorId: senderId,
      clubId: context.clubId,
    });

    schedule(deps, async () => {
      const outcome = await dispatchPush(deps.db, deps.push, {
        outboxEventId: notificationKey(event.id, 1),
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
): Promise<{ clubId: string | null; scope: string; scopeId: string; name: string } | null> {
  const rows = await db.execute<{
    club_id: string | null;
    scope: string;
    scope_id: string;
    name: string | null;
  }>(sql`
    SELECT c.club_id,
           c.scope,
           c.scope_id::text AS scope_id,
           -- Most specific first. A race and an Eboard channel both carry a club_id, so
           -- putting the club ahead of them titled every race chat with the club's name.
           COALESCE(r.name, e.name, cl.name) AS name
      FROM channels c
      LEFT JOIN clubs cl ON cl.id = c.club_id
      LEFT JOIN eboard_channels e ON c.scope = 'eboard' AND e.id = c.scope_id
      LEFT JOIN races r ON c.scope = 'race' AND r.id = c.scope_id
     WHERE c.id = ${channelId}
  `);
  const row = rows.rows[0];
  if (!row) return null;
  // A dm has no name of its own, only two people. The caller substitutes the sender's name,
  // which is what the recipient wants to see and needs no per-recipient query, since a
  // conversation has exactly one other participant.
  return {
    clubId: row.club_id,
    scope: row.scope,
    scopeId: row.scope_id,
    name: row.name ?? 'ClubChat',
  };
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
      outboxEventId: notificationKey(event.id),
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
    outboxEventId: notificationKey(event.id),
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
    outboxEventId: notificationKey(event.id),
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
    outboxEventId: notificationKey(event.id),
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
    outboxEventId: notificationKey(event.id),
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
          outboxEventId: notificationKey(event.id),
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

/**
 * A generic "content was created" effect.
 *
 * Races, events, meetings, news posts and polls all resolve to the same three steps: work out
 * the audience, write the rows, schedule the push. Sharing one function keeps the audience
 * rules in one place rather than repeated five times with five chances to omit the
 * exclude-the-actor rule.
 *
 * Routines are deliberately absent from every call site: creating a workout notifies nobody
 * and posts nothing.
 */
function makeCreationHandler(config: {
  notificationType:
    | 'race_created'
    | 'event_created'
    | 'meeting_created'
    | 'news_post_created'
    | 'poll_created';
  buildParams: (
    event: OutboxEvent,
    ctx: { clubName: string; actorName: string },
  ) => Record<string, unknown>;
  /** Where the chat card goes, if this creation posts one. */
  cardChannel?: (event: OutboxEvent, db: Db) => Promise<string | null>;
  /** The card's message type, which is what tells the client to draw the object inline. */
  cardType?: MessageType;
  cardBody?: (event: OutboxEvent, ctx: { actorName: string }) => string;
  /** Which object the card is for, so deleting that object can remove the card. */
  cardLink?: (event: OutboxEvent) => {
    linkedPollId?: string | null;
    linkedEventId?: string | null;
    linkedMeetingId?: string | null;
  };
  /** Overrides the default club-wide audience, for scoped things. */
  audience?: (event: OutboxEvent, db: Db) => Promise<string[]>;
}): EffectHandler {
  return async (event, deps) => {
    const clubId = String(event.payload['clubId']);
    const actorId = (event.payload['actorId'] as string | null) ?? null;

    const club = await clubContext(deps.db, clubId);
    if (!club) return;

    const actorName = actorId ? await displayName(deps.db, actorId) : 'Someone';
    const params = config.buildParams(event, { clubName: club.name, actorName });

    const recipients = config.audience
      ? // Scoped audiences still exclude the actor, which is why the result goes through
        // resolveAudience rather than being used directly.
        await resolveAudience(deps.db, {
          type: config.notificationType,
          actorId,
          clubId,
          explicitRecipients: await config.audience(event, deps.db),
        })
      : await resolveAudience(deps.db, {
          type: config.notificationType,
          actorId,
          clubId,
        });

    if (recipients.length > 0) {
      await writeNotifications(deps.db, {
        outboxEventId: notificationKey(event.id),
        type: config.notificationType,
        params: params as never,
        recipients,
        actorId,
        clubId,
      });

      schedule(deps, async () => {
        const outcome = await dispatchPush(deps.db, deps.push, {
          outboxEventId: notificationKey(event.id),
          type: config.notificationType,
          params,
          recipients,
        });
        deps.log('info', `${config.notificationType} push dispatched`, {
          eventId: event.id,
          ...outcome,
        });
      });
    }

    // The card, if this creation posts one. Produced here rather than at the call site so it
    // appears whether the object was created from its own screen or from chat's "+" menu.
    if (config.cardChannel && config.cardBody) {
      const channelId = await config.cardChannel(event, deps.db);
      if (channelId) {
        await postSystemMessage(deps, {
          channelId,
          body: config.cardBody(event, { actorName }),
          eventId: event.id,
          scope: 'card',
          /*
           * From the person who created it, and typed as what it is.
           *
           * A card is somebody putting a question to the room, so it belongs in their bubble
           * rather than in the unattributed centre column with "X joined the club". `actorId`
           * is null only for a creation nobody performed, which is not a case that exists
           * today; the system actor is the honest fallback if one ever appears.
           */
          senderId: actorId ?? SYSTEM_ACTOR_ID,
          ...(config.cardType ? { type: config.cardType } : {}),
          ...(config.cardLink ? config.cardLink(event) : {}),
        });
      }
    }
  };
}

/** The channel a poll's card belongs in: its own scope's channel. */
async function pollCardChannel(event: OutboxEvent, db: Db): Promise<string | null> {
  const scope = String(event.payload['scope']);
  const scopeId = String(event.payload['scopeId']);
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM channels WHERE scope = ${scope} AND scope_id = ${scopeId}::uuid
  `);
  return rows.rows[0]?.id ?? null;
}

/** Roster members of a race. NEVER unioned with club admins. */
async function raceRosterAudience(event: OutboxEvent, db: Db): Promise<string[]> {
  const raceId = String(event.payload['raceId'] ?? event.payload['scopeId']);
  const rows = await db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM race_memberships WHERE race_id = ${raceId}::uuid`,
  );
  return rows.rows.map((r) => r.user_id);
}

/** Members of an Eboard space. */
async function eboardAudience(event: OutboxEvent, db: Db): Promise<string[]> {
  const eboardId = String(event.payload['eboardId'] ?? event.payload['scopeId']);
  const rows = await db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM eboard_memberships WHERE eboard_id = ${eboardId}::uuid`,
  );
  return rows.rows.map((r) => r.user_id);
}

/** A poll's audience, by scope. The race branch is roster members only. */
async function pollScopeAudience(event: OutboxEvent, db: Db): Promise<string[]> {
  const scope = String(event.payload['scope']);
  if (scope === 'race') return raceRosterAudience(event, db);
  if (scope === 'eboard') return eboardAudience(event, db);
  const rows = await db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM club_memberships WHERE club_id = ${String(event.payload['clubId'])}`,
  );
  return rows.rows.map((r) => r.user_id);
}

/**
 * A car group lost its Incharge.
 *
 * Notifies every club ADMIN - both admin and owner - that the group needs a new one. A plain
 * member leaving their car raises no event at all, so reaching this handler already means the
 * departing person was the Incharge.
 */
const onInchargeLeft: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const club = await clubContext(deps.db, clubId);
  if (!club) return;

  const raceRows = await deps.db.execute<{ name: string }>(
    sql`SELECT name FROM races WHERE id = ${String(event.payload['raceId'])}::uuid`,
  );

  const recipients = await resolveAudience(deps.db, {
    type: 'car_group_incharge_left',
    // No actor to exclude: the notification is about somebody's departure, and an admin who
    // happens to be that person still needs to know the group needs covering.
    actorId: null,
    clubId,
  });

  await writeNotifications(deps.db, {
    outboxEventId: notificationKey(event.id),
    type: 'car_group_incharge_left',
    params: {
      clubId,
      clubName: club.name,
      raceId: String(event.payload['raceId']),
      raceName: raceRows.rows[0]?.name ?? 'the race',
      groupNumber: Number(event.payload['groupNumber'] ?? 0),
      departedName: await displayName(deps.db, String(event.payload['userId'])),
    },
    recipients,
    actorId: null,
    clubId,
  });
};

/** Someone gained race access. Force-unsubscribe on departure is the mirror of this. */
const onRaceMembershipDecided: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const approved = event.payload['approved'] === true;
  const userId = String(event.payload['userId']);
  const actorId = event.payload['actorId'] as string | null;

  const club = await clubContext(deps.db, clubId);
  if (!club) return;

  const raceRows = await deps.db.execute<{ name: string }>(
    sql`SELECT name FROM races WHERE id = ${String(event.payload['raceId'])}::uuid`,
  );
  const raceName = raceRows.rows[0]?.name ?? 'the race';

  await writeNotifications(deps.db, {
    outboxEventId: notificationKey(event.id),
    type: approved ? 'request_approved' : 'request_denied',
    params: {
      clubId,
      clubName: club.name,
      actorName: actorId ? await displayName(deps.db, actorId) : 'An admin',
      scope: 'race',
      scopeName: raceName,
      ...(approved ? { scopeId: String(event.payload['raceId']) } : {}),
    } as never,
    recipients: [userId],
    actorId,
    clubId,
  });
};

/**
 * Someone left or was removed from a race.
 *
 * Drops their subscription to that race's channel specifically. Their club membership is
 * untouched, so a blanket club-wide revocation would wrongly cut them out of club chat.
 */
const onRaceMemberDeparted: EffectHandler = async (event, deps) => {
  const raceId = String(event.payload['raceId']);
  const userId = String(event.payload['userId']);

  const rows = await deps.db.execute<{ id: string }>(
    sql`SELECT id FROM channels WHERE scope = 'race' AND scope_id = ${raceId}::uuid`,
  );
  const channelIds = rows.rows.map((r) => r.id);
  if (channelIds.length === 0) return;

  await publishRevocation(deps.redis, { userId, channelIds });
  deps.log('info', 'revoked race subscriptions', { userId, raceId });
};

/** A race was deleted. Its channel is gone, so every roster member's socket must drop it. */
const onRaceDeleted: EffectHandler = async (event, deps) => {
  const channelIds = (event.payload['channelIds'] as string[] | undefined) ?? [];
  const memberIds = (event.payload['memberIds'] as string[] | undefined) ?? [];
  for (const userId of memberIds) {
    if (channelIds.length > 0) await publishRevocation(deps.redis, { userId, channelIds });
  }
};

/**
 * Remove the chat card for a deleted object.
 *
 * **Deleting the underlying poll, event or meeting removes its card**, rather than leaving a
 * dead link that navigates nowhere.
 *
 * The card is soft-deleted like any other message rather than being removed outright: a
 * message vanishing mid-conversation makes the replies around it unreadable, and that reasoning
 * does not stop applying just because the message happens to be a card. What the reader sees is
 * the ordinary "This message was deleted" tombstone.
 *
 * Idempotent: the update is scoped to rows not already deleted, so redelivery is a no-op.
 */
/**
 * Soft-delete the card a creation posted, so a deleted object leaves no dead link.
 *
 * Usable both as a whole handler and as a step inside a larger one - `meeting.deleted` removes
 * its card AND narrates the cancellation, and calls this for the first half.
 */
function removeCards(
  column: 'linked_poll_id' | 'linked_event_id' | 'linked_meeting_id',
  payloadKey: string,
): EffectHandler {
  return async (event, deps) => {
    const objectId = event.payload[payloadKey];
    if (typeof objectId !== 'string') return;

    const removed = await deps.db.execute<{ channel_id: string; seq: number }>(sql`
      UPDATE messages
         SET deleted_at = now(), pinned = false, body = NULL
       WHERE ${sql.identifier(column)} = ${objectId}::uuid
         AND deleted_at IS NULL
      RETURNING channel_id, seq
    `);

    for (const row of removed.rows) {
      /*
       * Published as an UPDATE, the same frame `message.deleted` sends.
       *
       * > **This was a hand-rolled `redis.publish` with an envelope that nothing could read**,
       * > and the effect was worse than no publish at all. `Published` treats a payload with no
       * > `kind` as a new MESSAGE, so a frame carrying only `{channelId, seq, deletedAt}` went
       * > out claiming to be a whole message and arrived as one that could not be parsed. The
       * > deletion reached no client.
       * >
       * > And because history syncs forward from the last seq a client holds, a card already in
       * > the cache is never re-read - so the publish is the ONLY route this can travel, and a
       * > cancelled meeting kept its card indefinitely, on every device, including across a
       * > reload. Found by cancelling one and watching the card outlive it.
       *
       * The reactions and pin are cleared alongside, exactly as a deleted message clears them,
       * so nobody is left holding pills for a card that is gone.
       */
      await publishUpdate(deps.redis, row.channel_id, {
        channelId: row.channel_id,
        seq: row.seq,
        reactions: [],
        pinned: false,
        deletedAt: new Date().toISOString(),
      });
    }

    deps.log('info', 'card removed for deleted object', {
      column,
      objectId,
      cards: removed.rows.length,
    });
  };
}

export const handlers: Record<string, EffectHandler> = {
  'club.created': onClubCreated,
  'message.created': onMessageCreated,
  /**
   * A message was soft-deleted.
   *
   * **Notifies nobody** - a deletion is not an event anyone should be interrupted for - but it
   * IS published, so every open client replaces the bubble with a tombstone rather than
   * showing text that no longer exists until the next refresh. PRD/05 rule 9 says the
   * tombstone is what *every other member* sees.
   */
  'message.deleted': async (event, deps) => {
    const channelId = String(event.payload['channelId'] ?? event.partitionKey);
    const seq = Number(event.payload['seq']);
    await publishUpdate(deps.redis, channelId, {
      channelId,
      seq,
      // Reactions were cleared with the message, so the update carries the empty set
      // explicitly rather than leaving clients holding the old pills.
      reactions: [],
      pinned: false,
      deletedAt: new Date().toISOString(),
    });
    deps.log('info', 'message.deleted published', { eventId: event.id, channelId, seq });
  },

  /** A pin or unpin. Notifies nobody: pins are reference, not interruption. */
  'message.pinned': async (event, deps) => {
    const channelId = String(event.payload['channelId'] ?? event.partitionKey);
    const seq = Number(event.payload['seq']);
    await publishUpdate(deps.redis, channelId, {
      channelId,
      seq,
      pinned: event.payload['pinned'] === true,
    });
    deps.log('info', 'message.pinned published', { eventId: event.id, channelId, seq });
  },

  /**
   * A reaction was toggled.
   *
   * Re-reads the set at publish time rather than trusting the payload, which makes the handler
   * idempotent for free: a redelivered event republishes the current truth instead of an older
   * snapshot. That is the property the full-set-not-delta choice buys - there is no ordering to
   * get wrong, because the last publish to arrive is correct whichever one it was.
   */
  'message.reacted': async (event, deps) => {
    const channelId = String(event.payload['channelId'] ?? event.partitionKey);
    const messageId = String(event.payload['messageId'] ?? '');
    const seq = Number(event.payload['seq']);
    if (!messageId) {
      deps.log('warn', 'message.reacted with no messageId', { eventId: event.id });
      return;
    }

    const reactions = (await reactionsForMessages(deps.db, [messageId])).get(messageId) ?? [];
    await publishUpdate(deps.redis, channelId, { channelId, seq, reactions });
    deps.log('info', 'message.reacted published', {
      eventId: event.id,
      channelId,
      seq,
      emoji: reactions.length,
    });
  },
  'club.member_joined': onMemberJoined,
  'club.join_requested': onJoinRequested,
  'club.join_decided': onJoinDecided,
  'club.role_changed': onRoleChanged,
  'club.ownership_transferred': onOwnershipTransferred,
  'club.member_removed': makeDepartureHandler('removed'),
  'club.member_left': makeDepartureHandler('left'),
  'club.deleted': onClubDeleted,

  // Phase 2. Each is one call into machinery that already existed.
  'race.created': makeCreationHandler({
    notificationType: 'race_created',
    buildParams: (event, ctx) => ({
      clubId: String(event.payload['clubId']),
      clubName: ctx.clubName,
      actorName: ctx.actorName,
      raceId: String(event.payload['raceId']),
      raceName: String(event.payload['raceName']),
    }),
    cardChannel: async (event) => String(event.payload['mainChannelId'] ?? '') || null,
    cardBody: (event, ctx) => `${ctx.actorName} created ${String(event.payload['raceName'])}`,
  }),
  'race.join_requested': async (event, deps) => {
    const clubId = String(event.payload['clubId']);
    const club = await clubContext(deps.db, clubId);
    if (!club) return;
    const raceRows = await deps.db.execute<{ name: string }>(
      sql`SELECT name FROM races WHERE id = ${String(event.payload['raceId'])}::uuid`,
    );
    // The club's admin tier decides race requests, so they are the audience - not the
    // race roster, who have no say in it.
    const recipients = await resolveAudience(deps.db, {
      type: 'race_join_request',
      actorId: String(event.payload['userId']),
      clubId,
    });
    await writeNotifications(deps.db, {
      outboxEventId: notificationKey(event.id),
      type: 'race_join_request',
      params: {
        clubId,
        clubName: club.name,
        raceId: String(event.payload['raceId']),
        raceName: raceRows.rows[0]?.name ?? 'a race',
        requesterName: await displayName(deps.db, String(event.payload['userId'])),
        requesterId: String(event.payload['userId']),
      },
      recipients,
      actorId: String(event.payload['userId']),
      clubId,
    });
  },
  'race.membership_decided': onRaceMembershipDecided,
  'race.member_departed': onRaceMemberDeparted,
  'race.deleted': onRaceDeleted,
  'race.incharge_left': onInchargeLeft,

  'event.created': makeCreationHandler({
    cardType: 'event',
    notificationType: 'event_created',
    buildParams: (event, ctx) => ({
      clubId: String(event.payload['clubId']),
      clubName: ctx.clubName,
      actorName: ctx.actorName,
      eventId: String(event.payload['eventId']),
      title: String(event.payload['title']),
    }),
    cardChannel: async (_event, db) => {
      const rows = await db.execute<{ id: string }>(sql`
        SELECT id FROM channels
         WHERE club_id = ${String(_event.payload['clubId'])} AND scope = 'club'
      `);
      return rows.rows[0]?.id ?? null;
    },
    cardBody: (event, ctx) => `${ctx.actorName} added an event: ${String(event.payload['title'])}`,
    cardLink: (event) => ({ linkedEventId: String(event.payload['eventId']) }),
  }),
  'event.deleted': removeCards('linked_event_id', 'eventId'),

  'meeting.created': makeCreationHandler({
    cardType: 'meeting',
    notificationType: 'meeting_created',
    audience: eboardAudience,
    buildParams: (event, ctx) => ({
      clubId: String(event.payload['clubId']),
      clubName: ctx.clubName,
      actorName: ctx.actorName,
      eboardId: String(event.payload['eboardId']),
      meetingId: String(event.payload['meetingId']),
      title: String(event.payload['title']),
    }),
    cardChannel: async (event, db) => {
      const rows = await db.execute<{ id: string }>(sql`
        SELECT id FROM channels
         WHERE scope = 'eboard' AND scope_id = ${String(event.payload['eboardId'])}::uuid
      `);
      return rows.rows[0]?.id ?? null;
    },
    cardBody: (event, ctx) => `${ctx.actorName} scheduled ${String(event.payload['title'])}`,
    cardLink: (event) => ({ linkedMeetingId: String(event.payload['meetingId']) }),
  }),
  /**
   * A meeting was cancelled.
   *
   * **The card goes and a line takes its place.** Every other deletion in the product just
   * removes its card, which is right for a poll or an event: those are things that existed and
   * now do not. A meeting is different because the space PLANNED AROUND it - members were
   * notified, it sat on their calendar, and somebody may have kept the slot free. A card that
   * silently disappears tells them none of that happened.
   *
   * So the conversation says who called it off, by name. Any member may cancel any meeting, and
   * this line is what makes that rule accountable rather than merely permissive - the two were
   * decided together and should not be separated.
   */
  'meeting.deleted': async (event, deps) => {
    await removeCards('linked_meeting_id', 'meetingId')(event, deps);

    const eboardId = event.payload['eboardId'];
    const title = event.payload['title'];
    if (typeof eboardId !== 'string') return;

    const rows = await deps.db.execute<{ id: string }>(sql`
      SELECT id FROM channels WHERE scope = 'eboard' AND scope_id = ${eboardId}::uuid
    `);
    const channelId = rows.rows[0]?.id;
    if (!channelId) return;

    const actorId = event.payload['actorId'];
    const actorName =
      typeof actorId === 'string' ? await displayName(deps.db, actorId) : 'Someone';

    await postSystemMessage(deps, {
      channelId,
      // Names the meeting, not just "the meeting": a board with two on the calendar cannot act
      // on a line that does not say which one is off.
      body:
        typeof title === 'string' && title.length > 0
          ? `${actorName} cancelled ${title}`
          : `${actorName} cancelled a meeting`,
      eventId: event.id,
      /*
       * Its OWN idempotency scope, distinct from the 'card' scope the creation used. Both derive
       * their client message id from the outbox event id, so sharing a scope across two different
       * events would be fine - but sharing one within a redelivery of THIS event is what keeps a
       * retry from posting the line twice.
       */
      scope: 'cancel',
    });
  },

  'news.created': makeCreationHandler({
    notificationType: 'news_post_created',
    buildParams: (event, ctx) => ({
      clubId: String(event.payload['clubId']),
      clubName: ctx.clubName,
      actorName: ctx.actorName,
      postId: String(event.payload['postId']),
    }),
    // News deliberately posts NO chat card: discussion belongs in chat, but the post itself
    // lives on the club's front page.
  }),

  'poll.created': makeCreationHandler({
    cardType: 'poll',
    notificationType: 'poll_created',
    audience: pollScopeAudience,
    buildParams: (event, ctx) => ({
      clubId: String(event.payload['clubId']),
      clubName: ctx.clubName,
      actorName: ctx.actorName,
      pollId: String(event.payload['pollId']),
      question: String(event.payload['question']),
    }),
    cardChannel: pollCardChannel,
    cardBody: (event, ctx) =>
      `${ctx.actorName} created a poll: ${String(event.payload['question'])}`,
    cardLink: (event) => ({ linkedPollId: String(event.payload['pollId']) }),
  }),
  'poll.deleted': removeCards('linked_poll_id', 'pollId'),

  /**
   * Derive thumbnails for a completed upload.
   *
   * An effect rather than part of the request: uploading must not wait on encoding. If the
   * worker is down the variants simply do not exist yet, and the download path falls back to
   * the original - a slower image rather than a broken one.
   */
  'media.uploaded': async (event, deps) => {
    if (!deps.media) {
      deps.log('warn', 'media.uploaded with no store configured', { eventId: event.id });
      return;
    }
    const mediaId = String(event.payload['mediaId']);
    const result = await deriveVariants(deps.db, deps.media, mediaId);
    deps.log('info', 'derived media variants', { mediaId, ...result });
  },
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
