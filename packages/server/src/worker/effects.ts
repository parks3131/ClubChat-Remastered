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
import { publishToChannel } from '../bus/redis.ts';
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

export const handlers: Record<string, EffectHandler> = {
  'club.created': onClubCreated,
  'message.created': onMessageCreated,
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
