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

import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { SYSTEM_ACTOR_ID } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { appendMessage, deriveClientMsgId } from '../domain/append-message.ts';
import { publishToChannel } from '../bus/redis.ts';

export type OutboxEvent = {
  id: number;
  partitionKey: string;
  eventType: string;
  payload: Record<string, unknown>;
};

export type EffectDeps = {
  db: Db;
  redis: Redis;
  log: (level: 'info' | 'warn' | 'error', message: string, extra?: unknown) => void;
};

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
  deps.log('info', 'message.created (no effects until Phase 1)', {
    eventId: event.id,
    channelId: event.partitionKey,
    seq: event.payload['seq'],
  });
};

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
