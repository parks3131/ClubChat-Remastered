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
import { SYSTEM_ACTOR_ID, type MessageType, type NotificationType } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import type { Monitor } from '../monitoring.ts';
import type { Tracer } from '../dev/trace.ts';
import { users } from '../db/schema.ts';
import { appendMessage, deriveClientMsgId } from '../domain/append-message.ts';
import { publishToChannel, publishRevocation, publishUpdate } from '../bus/redis.ts';
import { reactionsForMessages } from '../domain/reactions.ts';
import { nextRevision } from '../domain/revisions.ts';
import { resolveAudience } from './audience.ts';
import {
  notificationKey,
  resolvePendingRequests,
  writeNotifications,
  type WriteNotificationsInput,
} from './notify.ts';
import { dispatchPush, PUSH_DEFERRAL_MS, type DispatchInput } from '../push/dispatch.ts';
import { DeferredPushPayload, enqueueDeferredPush } from '../push/deferral.ts';
import type { PushSender } from '../push/sender.ts';
import type { MediaStore } from '../media/store.ts';
import { deriveVariants } from '../media/derive.ts';

/**
 * A failure that retrying cannot fix.
 *
 * The retry path exists for a **transient** fault: a connection reset, a provider having a
 * bad minute, a lock contended for a moment. Waiting helps, so the drain waits and tries
 * again on a growing delay.
 *
 * Nothing about that helps a payload referencing a row that no longer exists, or bytes that
 * are not an image. Those produce the same failure on attempt eight as on attempt one, and
 * running them through the transient machinery costs twice over: the whole attempt budget is
 * burned discovering an answer already known, and once retries are spread across hours the
 * row sits unresolved for that entire time before anybody is told.
 *
 * Throw this instead and the drain parks the row immediately, with the same alarm it raises
 * for an exhausted budget - because the outcome is identical. An effect will never run.
 *
 * > **The default stays retryable, on purpose.** Misclassifying a transient fault as permanent
 * > loses the effect on its first bad second; misclassifying the reverse only wastes some
 * > retries. Reach for this where the failure is provably about the data, not the moment.
 */
export class PermanentEffectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentEffectError';
  }
}

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
   * Where a failed effect goes, beyond the log.
   *
   * Optional so every existing test constructs `EffectDeps` unchanged; the worker passes a real
   * one. Absent, failures still reach `log` exactly as before - this only adds a destination.
   */
  monitor?: Monitor | undefined;
  /**
   * How long a push waits before it is evaluated. Defaults to `PUSH_DEFERRAL_MS`.
   *
   * A number rather than the injected scheduler function this used to be, and the difference is
   * the whole of failure (a) below: `defer` was a hook set in seven test files and in no
   * production entrypoint, so the branch that actually ran in production - a bare `setTimeout`
   * with a `void` catch - was the one branch nothing exercised. The wait is now a `next_attempt_at`
   * on a real outbox row, so a test shortens it to zero and takes the identical path.
   */
  pushDeferralMs?: number | undefined;
  /**
   * The development trace.
   *
   * Optional for the same reason `monitor` is, and read only by the drain: an effect handler
   * has no business knowing whether anybody is watching. See `dev/trace.ts`.
   */
  tracer?: Tracer | undefined;
};

/**
 * Hand a push to the outbox, to be evaluated once the deferral has elapsed.
 *
 * > **This was a `setTimeout` until 2026-08-19, and every push in the product was
 * > fire-and-forget.** `drain.ts` stamps `processed_at = now()` as soon as `dispatch()` returns
 * > and nothing awaited the timer, so the row that caused the push closed eight seconds before
 * > the push was evaluated. A transient Postgres failure inside `dispatchPush` threw into a
 * > `void` and produced one log line with no event id, no notification type, no recipients and no
 * > `monitor.capture`; a `SIGTERM` on any deploy destroyed the pending timer with the row already
 * > marked done. `dm_message` and `chat_message` write no notification row by design, so for
 * > those there was no durable trace anywhere that a push had ever been attempted.
 * > `TECH/11` claimed a failed push send was "retried by the worker". No code path did.
 *
 * The row is the retry. See `push/deferral.ts` for why the outbox is already a scheduler and
 * what the payload has to carry; the short version is that `next_attempt_at` is a due-at the
 * drain's claim query already filters on, so a deferred push inherits redelivery, backoff,
 * parking and the parked alarm without any of them being written twice.
 *
 * **Awaited, and that is load-bearing.** If the insert fails, the handler throws and the causing
 * event is retried - which is the direction that cannot lose a push. The old call was a bare
 * statement, so the enqueue could not fail even in principle.
 *
 * `immediate` is for the two report types, which deliberately do not wait: see their handlers.
 */
async function schedulePush(
  deps: EffectDeps,
  input: DispatchInput & { partitionKey: string },
  opts: { immediate?: boolean } = {},
): Promise<void> {
  await enqueueDeferredPush(deps.db, {
    ...input,
    delayMs: opts.immediate === true ? 0 : (deps.pushDeferralMs ?? PUSH_DEFERRAL_MS),
  });
}

/**
 * Write the notification rows AND buzz the phones. **One act, not two.**
 *
 * > **This exists because the two halves were separable, and so they got separated.** Until
 * > 2026-08-14 fourteen call sites wrote a row and scheduled no push: every join request, every
 * > decision on one, every add, removal and role change, and a car group left without an
 * > Incharge. They filled the inbox and the badge and reached no phone, so the only way to learn
 * > that somebody had asked to join your club was to happen to open the app. Nothing said this
 * > was intended - `TECH/06` opens by calling push "a transport added to a fan-out that is
 * > already specified", which reads as though every type in the catalogue arrives.
 *
 * How the class hid: `writeNotifications` is a complete, correct, satisfying-looking call. There
 * is no error, no failing test and no missing case - the row really is written. What is absent is
 * a second statement nobody was reminded to write. Pairing them in one function is the only fix
 * that survives somebody adding a fifteenth type, which is why this is a helper rather than
 * fourteen added `schedule` blocks.
 *
 * **The four hand-rolled pushes that do NOT come through here** each carry something this
 * deliberately does not model, and each says so where it lives: `dm_message` and `chat_message`
 * write no rows at all, `message_reported` pushes immediately and without a cursor on purpose,
 * and the announcement and mention paths carry a chat context plus their own logging. This
 * function is the DEFAULT - a type that writes a row and wants an ordinary push - so that the
 * default cannot be half-done.
 */
async function notifyAndPush<K extends NotificationType>(
  deps: EffectDeps,
  input: WriteNotificationsInput<K>,
): Promise<{ created: number }> {
  const result = await writeNotifications(deps.db, input);

  /*
   * Deferred like every other push, even though none of these carries a channel and so none can
   * be suppressed by a read cursor. The eight seconds buy nothing here and cost nothing either,
   * and one timing rule is worth more than a second code path that has to justify itself. The
   * exception that genuinely needed immediacy - a report landing in a review queue - says so in
   * its own comment rather than being an option on this.
   */
  await schedulePush(deps, {
    outboxEventId: input.outboxEventId,
    type: input.type,
    params: input.params as Record<string, unknown>,
    recipients: input.recipients,
    // No channel to order against, so the club is the ordering domain. `push/deferral.ts`
    // prefixes it, which keeps these off the club's own partition.
    partitionKey: input.clubId ?? String(input.outboxEventId),
  });

  return result;
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
    /*
     * Redelivery, and it still publishes.
     *
     * > **This used to return here**, on the reasoning that a message which already exists was
     * > already published. That treats the append and the publish as one act, and they are two
     * > statements with a commit between them: an attempt that wrote the row and died before
     * > `publishToChannel` below leaves a message nobody was ever told about, and the retry then
     * > skipped the fan-out **forever**. The message is durable, so it surfaced on the next sync
     * > - which is why the symptom was "the card did not show up until I backgrounded the app"
     * > rather than a missing message.
     *
     * A duplicate is strictly cheaper than a loss here. The client applies `msg.new` under the
     * gap rule (SPEC/TECH/03), and `decideGap` answers `ignore` for any seq at or below the local
     * maximum - the frame is upserted on `(channel_id, seq)` and no backfill is triggered. So a
     * second publish of a seq the client holds costs one idempotent upsert; a skipped publish
     * costs the fan-out.
     */
    deps.log('info', 'system message already posted, publishing again', {
      eventId: args.eventId,
      seq: result.message.seq,
    });
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
    // Permanent: the payload is written once and frozen. A field absent on the first attempt
    // is absent on the eighth, so this is worth reporting now rather than in two hours.
    throw new PermanentEffectError('club.created payload missing mainChannelId or creatorId');
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
 * Message types whose arrival is itself the news, and so buzz a phone on their own.
 *
 * The exclusions are the interesting half, and each is a message that would otherwise buzz
 * twice or buzz wrongly:
 *
 *  - **`announcement`** has its own louder path a few lines below, which reaches the same people.
 *  - **`system`** is the worker's own writing ("X joined the club"). Nobody said it, so nobody is
 *    told about it - and letting the worker's writes buzz phones is how a bulk membership change
 *    becomes a hundred notifications.
 *  - **`poll`, `event`, `meeting`** are cards, and the object they stand for has already sent its
 *    own `poll_created` / `event_created` / `meeting_created` push from `makeCreationHandler`.
 *    Pushing the card as well would ring twice for one thing somebody made.
 */
const CONVERSATIONAL: readonly string[] = ['text', 'photo', 'document'];

/**
 * What a push shows on a lock screen when the message has no words of its own.
 *
 * A photo or a document sent without a caption has an empty `preview`, and every renderer in the
 * catalogue interpolates it - so the untreated version reads as "Alice: " with nothing after the
 * colon. Substituting a description here rather than in `renderNotification` keeps that function
 * pure over its params, which is what lets a second locale be another implementation of it rather
 * than a migration (see its own note).
 */
function previewForPush(payload: Record<string, unknown>, type: string): string {
  const body = String(payload['preview'] ?? '').slice(0, 140);
  if (body.length > 0) return body;
  return type === 'photo' ? 'sent a photo' : type === 'document' ? 'sent a document' : '';
}

/**
 * A message was created.
 *
 * Four kinds of notification can come out of one message, and each is gated separately:
 * announcements (everyone in the space), mentions (the named people), direct messages (the
 * other participant), and an ordinary message in a group chat (everyone else in the room). A
 * message can be more than one of them, which is why each carries its own idempotency slot.
 *
 * > **The fourth arrived on 2026-08-14 and reversed a deliberate silence.** Club, race and Eboard
 * > chat pushed nothing for an ordinary message on the reasoning that a message is addressed to a
 * > room and the room's unread count is the right granularity. It is the behaviour every product
 * > this replaces does not have, and the founder found it by testing push on a real phone and
 * > receiving nothing. ADR-0032 records the reversal and what it costs.
 *
 * **A member is buzzed at most once per message**, which is why the group-chat and announcement
 * branches both subtract the mentioned: they get the more specific "mentioned you" push instead,
 * and two buzzes for one message is the failure this ordering exists to avoid.
 *
 * **The subtraction is on the push and never on the rows.** A member who is named in an
 * announcement is entitled to both inbox rows - one says the club was told something, the other
 * says they were named in it, and they clear against different things. It is only the phone that
 * must not buzz twice, so the two lists are computed separately rather than one being derived
 * from the other.
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

  /*
   * An ordinary message in a room with more than two people in it.
   *
   * `announcement` is excluded by `CONVERSATIONAL` rather than by a second condition here, so
   * there is one list of which message types buzz and no chance of the two disagreeing.
   */
  const isGroupChat = context.scope !== 'dm' && CONVERSATIONAL.includes(type);

  if (!isAnnouncement && !isDirectMessage && !isGroupChat && mentioned.length === 0) return;

  const actorName = await displayName(deps.db, senderId);
  const preview = previewForPush(event.payload, type);

  /*
   * Everybody who is going to be told by name, and therefore must not also be told generically.
   *
   * Hoisted out of the group-chat branch on 2026-08-16, when it turned out the announcement
   * branch needed it too and had never had it.
   */
  const named = new Set(mentioned);

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

    /*
     * The rows went to everybody; the buzz skips whoever the mention branch is about to buzz.
     *
     * > **This pushed to `recipients` until 2026-08-16, so an announcement that also named
     * > somebody buzzed that person's phone twice** - "Riley: kit order closes Friday" and
     * > "Riley mentioned you", one phone, one message. The rule was already applied correctly one
     * > branch down, in the ordinary-message audience, and the two had simply never been read
     * > side by side. It predates per-message push and was made visible by it, because before
     * > that the second buzz was the only buzz.
     *
     * An announcement that names everybody in the room leaves this empty, and `dispatchPush`
     * returns without sending rather than treating an empty list as "everyone".
     */
    const buzzed = recipients.filter((userId) => !named.has(userId));

    // Deferred, then the cursor is re-read. Scheduling happens regardless of `created`,
    // because the push ledger - not the notification insert - is what makes the buzz
    // idempotent, and a redelivery after a crash between the two must still push.
    await schedulePush(deps, {
      outboxEventId: notificationKey(event.id, 0),
      type: 'announcement',
      params,
      recipients: buzzed,
      channelId,
      seq,
      partitionKey: channelId,
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
    await schedulePush(deps, {
      outboxEventId: notificationKey(event.id, 2),
      type: 'dm_message',
      params,
      recipients,
      // Both suppressions apply here and neither is DM-specific: the read cursor silences a
      // recipient who is already looking at the conversation, and a mute silences the buzz
      // while the unread count keeps climbing.
      channelId,
      seq,
      partitionKey: channelId,
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

    await schedulePush(deps, {
      outboxEventId: notificationKey(event.id, 1),
      type: 'mentioned',
      params,
      recipients,
      channelId,
      seq,
      partitionKey: channelId,
    });
  }

  if (isGroupChat) {
    /*
     * Everyone in the room except the sender, and except anybody already being told by name.
     *
     * The mention push says "Alice mentioned you" and this one says "Alice: ...", so somebody
     * named in a message would otherwise feel one phone buzz twice for one sentence and read
     * the weaker of the two lines second.
     */
    const recipients = (
      await resolveAudience(deps.db, {
        type: 'chat_message',
        actorId: senderId,
        clubId: context.clubId,
        channelId,
      })
    ).filter((userId) => !named.has(userId));

    const params = {
      clubId: context.clubId,
      channelId,
      channelName: context.name,
      seq,
      preview,
      actorName,
    };

    /*
     * **No notification row**, exactly like a direct message and for the same reason: the inbox
     * representation of unread chat is the computed per-channel row, so one row per message
     * would flood the feed with the per-message noise PRD/12 rule 8 rejects. Only the buzz is
     * per message. Slot 3, which `NOTIFICATION_SLOTS` has been holding for the next kind since
     * the keys were banded.
     */
    await schedulePush(deps, {
      outboxEventId: notificationKey(event.id, 3),
      type: 'chat_message',
      params,
      recipients,
      /*
       * Both suppressions matter more here than anywhere else in the catalogue, because this
       * is the only push that fires on every single message. The cursor means an open
       * conversation never buzzes at all, and mute means a member can switch a loud club off
       * without losing its unread count.
       */
      channelId,
      seq,
      partitionKey: channelId,
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
 * Who sent the message at this address, or null if it is gone.
 *
 * Read from the row rather than carried on the event, unlike `message.created`, which is handed
 * its sender. An edit is only ever made by the sender, so the row already knows - and re-reading
 * keeps this handler's whole input to an address, which is what makes a redelivery harmless.
 */
async function senderOf(db: Db, channelId: string, seq: number): Promise<string | null> {
  const rows = await db.execute<{ sender_id: string }>(sql`
    SELECT sender_id FROM messages
     WHERE channel_id = ${channelId}::uuid AND seq = ${seq}
     LIMIT 1
  `);
  return rows.rows[0]?.sender_id ?? null;
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
 * The club's Eboard space and the channel inside it.
 *
 * Two things need this and they are the same lookup: the space narrates its own membership
 * changes in its own chat, and somebody who loses access has to be force-unsubscribed from that
 * exact channel. The scope predicate matters here for the same reason it does in `clubContext` -
 * `scope_id` is a plain uuid shared by four scopes (ADR-0014), so matching on it alone would
 * match any channel whose scope happens to hold the same id.
 */
async function eboardContext(
  db: Db,
  clubId: string,
): Promise<{ eboardId: string; channelId: string } | null> {
  const rows = await db.execute<{ eboard_id: string; channel_id: string }>(sql`
    SELECT e.id AS eboard_id, ch.id AS channel_id
      FROM eboard_channels e
      JOIN channels ch ON ch.scope = 'eboard' AND ch.scope_id = e.id
     WHERE e.club_id = ${clubId}::uuid
  `);
  const row = rows.rows[0];
  return row ? { eboardId: row.eboard_id, channelId: row.channel_id } : null;
}

/**
 * A race's name and its chat, in one read.
 *
 * The join and departure handlers both need both, and both used to fetch the name alone -
 * which is exactly why neither narrated anything into race chat. `INNER JOIN` on the channel:
 * a race without one cannot be talked about, and there is nothing sensible to say into a
 * channel that does not exist.
 */
async function raceContext(
  db: Db,
  raceId: string,
): Promise<{ name: string; channelId: string } | null> {
  const rows = await db.execute<{ name: string; channel_id: string }>(sql`
    SELECT r.name, ch.id AS channel_id
      FROM races r
      JOIN channels ch ON ch.scope = 'race' AND ch.scope_id = r.id
     WHERE r.id = ${raceId}::uuid
  `);
  const row = rows.rows[0];
  return row ? { name: row.name, channelId: row.channel_id } : null;
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
    await notifyAndPush(deps, {
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

  await notifyAndPush(deps, {
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

  await notifyAndPush(deps, {
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

  // And settle it in every admin's inbox, including the decider's. Without this the other
  // admins keep an unread row asking them to do something that is already done.
  await resolvePendingRequests(deps.db, {
    type: 'club_join_request',
    scopeId: clubId,
    requesterId: userId,
    decision: approved ? 'approved' : 'denied',
    decidedByName: actorName,
  });
};

/**
 * A role changed.
 *
 * **One act with consequences in two rooms**, because promotion to admin auto-joins the Eboard
 * and demotion auto-removes (`PRD/10` rule 2). The club sees who was promoted; the board sees
 * who just arrived in it. Both lines name the actor - "X is now an admin" said what happened and
 * not who did it, which is the half people ask about afterwards.
 *
 * **Demotion also has to cut the socket, and that is the part with teeth.** `changeRole` deletes
 * the `eboard_memberships` row, but access was checked once at subscribe time and is never
 * rechecked per message (ADR-0007) - so without the revocation below, a demoted admin keeps
 * receiving the board's private chat live until they happen to reconnect. The gateway's own
 * contract names this case; it was the only one of the four that never called it.
 */
const onRoleChanged: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const userId = String(event.payload['userId']);
  const actorId = String(event.payload['actorId']);
  const newRole = String(event.payload['newRole']) as 'admin' | 'member';
  const promoted = newRole === 'admin';

  const club = await clubContext(deps.db, clubId);
  if (!club) return;

  const name = await displayName(deps.db, userId);
  const actorName = await displayName(deps.db, actorId);

  // No `scope`, so this keeps the derived client id it has always had. A message already
  // posted must stay the same message, or a redelivery would post a second copy beside it.
  await postSystemMessage(deps, {
    channelId: club.mainChannelId,
    body: promoted
      ? `${actorName} promoted ${name} as admin`
      : `${actorName} removed ${name} as admin`,
    eventId: event.id,
  });

  const eboard = await eboardContext(deps.db, clubId);
  if (eboard) {
    await postSystemMessage(deps, {
      channelId: eboard.channelId,
      body: promoted
        ? `${actorName} added ${name} to the group`
        : `${actorName} removed ${name} from the group`,
      eventId: event.id,
      // Distinct from the line above, which shares this event id. Same event, two messages,
      // two identities - otherwise the second would collide with the first's idempotency key.
      scope: 'eboard',
    });

    if (!promoted) {
      await publishRevocation(deps.redis, { userId, channelIds: [eboard.channelId] });
      deps.log('info', 'revoked Eboard subscription after demotion', { userId, clubId });
    }
  }

  await notifyAndPush(deps, {
    outboxEventId: notificationKey(event.id),
    type: 'role_changed',
    params: { clubId, clubName: club.name, actorName, newRole },
    recipients: [userId],
    actorId,
    clubId,
  });
};

/**
 * The Eboard's own membership effects.
 *
 * > **All three of these were emitted and had no handler at all.** The domain wrote
 * > `eboard.join_requested`, `eboard.membership_decided` and `eboard.member_departed` into the
 * > outbox from the day the space was built; `dispatch` throws on an unknown type, so every one
 * > of them retried five times and parked. The notification type was declared, its params had a
 * > schema, `audience.ts` resolved it to the current members and the inbox already cleared it
 * > when the roster opened. Only the handler was missing - failure mode 11, both ends complete
 * > with nothing joining them, and it is silent because the outbox is a retry queue and parking
 * > is what it does with work nobody claims.
 *
 * They are three calls into machinery that already existed, which is the point.
 */
const onEboardJoinRequested: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const eboardId = String(event.payload['eboardId']);
  const userId = String(event.payload['userId']);

  const club = await clubContext(deps.db, clubId);
  if (!club) return;

  // Current members only. An admin outside the space must not learn its business - which is
  // why this is not `clubAdminTier`, even though every member of it is an admin.
  const recipients = await resolveAudience(deps.db, {
    type: 'eboard_join_request',
    actorId: userId,
    clubId,
  });

  await notifyAndPush(deps, {
    outboxEventId: notificationKey(event.id),
    type: 'eboard_join_request',
    params: {
      clubId,
      clubName: club.name,
      eboardId,
      requesterName: await displayName(deps.db, userId),
      requesterId: userId,
    },
    recipients,
    actorId: userId,
    clubId,
  });
};

/**
 * Somebody was let into the Eboard, by an approval or by being added outright.
 *
 * **One sentence for one fact.** An approval and a direct add are the same thing happening -
 * an existing member let somebody in - so the group reads one line either way rather than two
 * wordings for a distinction only the database cares about. A DENIAL posts nothing: it is
 * addressed to the person who asked, and announcing a refusal to the room they were refused
 * entry to is a different and worse act.
 */
const onEboardMembershipDecided: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const userId = String(event.payload['userId']);
  const actorId = event.payload['actorId'] as string | null;
  const approved = event.payload['approved'] === true;
  const added = event.payload['added'] === true;

  const club = await clubContext(deps.db, clubId);
  const eboard = await eboardContext(deps.db, clubId);
  if (!club || !eboard) return;

  const name = await displayName(deps.db, userId);
  const actorName = actorId ? await displayName(deps.db, actorId) : 'An admin';

  if (approved) {
    await postSystemMessage(deps, {
      channelId: eboard.channelId,
      body: `${actorName} added ${name} to the group`,
      eventId: event.id,
      scope: 'eboard',
    });
  }

  await notifyAndPush(deps, {
    outboxEventId: notificationKey(event.id),
    /*
     * `member_added` for a direct add and `request_approved` for a decision, because the two
     * answer different questions for the person receiving them: one is news, the other is the
     * reply to something they asked. `PRD/12` lists them as separate rows for that reason.
     */
    type: added ? 'member_added' : approved ? 'request_approved' : 'request_denied',
    params: {
      clubId,
      clubName: club.name,
      actorName,
      scope: 'eboard',
      scopeName: 'Eboard & Council',
      // A denial has nowhere to send them, so it carries no scope id - the schema says so.
      ...(approved ? { scopeId: eboard.eboardId } : {}),
      // But it still names the board, so it wears the board's face. `subjectId` is identity and
      // never a destination, which is why it is a different field from the one above.
      subjectId: eboard.eboardId,
    } as never,
    recipients: [userId],
    actorId,
    clubId,
  });

  // Settle the other members' copies. `addEboardMember` already closes the request row on a
  // direct add, so this is the inbox half of a decision the data has already taken.
  await resolvePendingRequests(deps.db, {
    type: 'eboard_join_request',
    scopeId: eboard.eboardId,
    requesterId: userId,
    decision: approved ? 'approved' : 'denied',
    decidedByName: actorName,
  });
};

/**
 * Somebody left the Eboard, or was removed from it by the Owner.
 *
 * The revocation is the whole reason this cannot be a notification-only handler: the space is
 * private to its members and a live subscription outlives the row that justified it. Leaving is
 * announced but not notified - they were there when it happened, the same rule `onMemberJoined`
 * follows for somebody who joined an open club under their own steam.
 */
const onEboardMemberDeparted: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const userId = String(event.payload['userId']);
  const actorId = event.payload['actorId'] as string | null;

  const club = await clubContext(deps.db, clubId);
  const eboard = await eboardContext(deps.db, clubId);
  if (!club || !eboard) return;

  const name = await displayName(deps.db, userId);
  const actorName = actorId ? await displayName(deps.db, actorId) : null;

  await postSystemMessage(deps, {
    channelId: eboard.channelId,
    body: actorName ? `${actorName} removed ${name} from the group` : `${name} left the group`,
    eventId: event.id,
    scope: 'eboard',
  });

  if (actorId) {
    await notifyAndPush(deps, {
      outboxEventId: notificationKey(event.id),
      type: 'member_removed',
      params: {
        clubId,
        clubName: club.name,
        actorName: actorName ?? 'An admin',
        // The Eboard, not the club - losing the private space leaves their club membership and
        // their club chat exactly where they were.
        scope: 'eboard',
        scopeName: 'Eboard & Council',
        // Identity only. Same reason as the race case: the row names the board, so it must not
        // wear the club's face.
        subjectId: eboard.eboardId,
      },
      recipients: [userId],
      actorId,
      clubId,
    });
  }

  // Their club membership is untouched, so this revokes the Eboard channel alone - a
  // club-wide revocation would cut them out of chat they are still entitled to.
  await publishRevocation(deps.redis, { userId, channelIds: [eboard.channelId] });
  deps.log('info', 'revoked Eboard subscription after departure', { userId, clubId });
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

  await notifyAndPush(deps, {
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
/**
 * Leaving, being removed, and being banned: one handler, three reasons.
 *
 * The ban case narrates differently and notifies identically, which is a deliberate split rather
 * than an oversight (ADR-0021). Club chat reads "X was banned by Y", because public attribution is
 * what makes an open ban power safe - the same argument that lets any Eboard member cancel a
 * meeting. The person themselves gets the ordinary removal notification, unchanged, because
 * naming a ban in a push is confrontational and the refusal at the door tells them soon enough.
 *
 * > **The cost is recorded rather than hidden**: the subject is then the only party who is not
 * > told it was a ban. That is the same asymmetry found on 2026-08-05, where a race removal was
 * > narrated to the whole roster except the person it was about. Accepted here on purpose, and the
 * > first thing to revisit if members report confusion about why they cannot rejoin.
 */
function makeDepartureHandler(reason: 'removed' | 'left' | 'banned'): EffectHandler {
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
          reason === 'banned' && actorName
            ? `${name} was banned by ${actorName}`
            : reason === 'removed' && actorName
              ? `${name} was removed by ${actorName}`
              : `${name} left the club`,
        eventId: event.id,
      });

      if (reason !== 'left' && actorId) {
        await notifyAndPush(deps, {
          outboxEventId: notificationKey(event.id),
          type: 'member_removed',
          params: {
            clubId,
            clubName: club.name,
            actorName: actorName ?? 'An admin',
            // Stated rather than left to the fallback, so all three writers of this type name
            // their scope and the club case is not the one that reads as an omission.
            scope: 'club',
            scopeName: club.name,
          },
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
 * An account was deleted.
 *
 * The rows are already gone - `deleteOwnAccount` anonymises the user and drops every membership
 * in one transaction - so all that remains is telling the gateways to drop the sockets, and the
 * channel ids had to be captured before the delete, which is why they ride on the event. Exactly
 * the shape of `onClubDeleted` above, for exactly the same reason.
 *
 * There is no notification and no system message, deliberately. A departure that was already
 * narrated by the membership cascade does not need saying twice, and an account deletion is not
 * an announcement its former clubs are owed.
 */
const onAccountDeleted: EffectHandler = async (event, deps) => {
  const userId = event.payload['userId'] as string | undefined;
  const channelIds = (event.payload['channelIds'] as string[] | undefined) ?? [];
  if (!userId || channelIds.length === 0) return;

  await publishRevocation(deps.redis, { userId, channelIds });
  deps.log('info', 'account deleted, subscriptions revoked', {
    userId,
    channels: channelIds.length,
  });
};

/**
 * An account was suspended by a platform moderator.
 *
 * > **The half of ejection that a column cannot do.** `signin_blocked_at` makes the next HTTP
 * > request 401 and is re-asked on every gateway frame that reloads the access context - but a
 * > socket sitting there *receiving* sends no frames, so it re-asks nothing. Without this publish
 * > a suspended account carries on being delivered its clubs' conversations in real time until it
 * > happens to reconnect, which is precisely the defect proved on 2026-08-08 for a deleted one.
 *
 * Identical in shape to `onAccountDeleted` and deliberately a separate event rather than reusing
 * it: the two are different acts, one is reversible, and a log line reading "account deleted" for
 * a suspension would be a lie in the one place somebody goes to find out what happened.
 *
 * No notification and no system message. They cannot sign in to read one, and announcing a
 * suspension into their former clubs' chats would publish a moderation outcome to an audience
 * that did not report it.
 */
const onAccountSuspended: EffectHandler = async (event, deps) => {
  const userId = event.payload['userId'] as string | undefined;
  const channelIds = (event.payload['channelIds'] as string[] | undefined) ?? [];
  if (!userId || channelIds.length === 0) return;

  await publishRevocation(deps.redis, { userId, channelIds });
  deps.log('info', 'account suspended, subscriptions revoked', {
    userId,
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
 * Meetup CREATION is deliberately absent from every call site: creating one notifies nobody
 * and posts nothing.
 */
/**
 * Tell the people a post names.
 *
 * Shared by `news.created` and `news.tagged` because the two must produce **identical** rows: a
 * person named when the post went up and a person named an hour later by an edit have learned
 * exactly the same thing, and a second copy of this would be where that stopped being true.
 *
 * The slot differs and nothing else does. On a new post this is the second notification of the
 * event, so it takes the mention slot; on an edit it is the only one, so it takes slot 0.
 */
async function notifyNamedInPost(
  deps: EffectDeps,
  input: {
    event: OutboxEvent;
    slot: 0 | 1;
    clubId: string;
    actorId: string | null;
    params: { clubId: string; clubName: string; actorName: string; postId: string };
    named: string[];
  },
): Promise<void> {
  if (input.named.length === 0) return;

  const key = notificationKey(input.event.id, input.slot);

  await writeNotifications(deps.db, {
    outboxEventId: key,
    type: 'news_post_tagged',
    params: input.params,
    recipients: input.named,
    actorId: input.actorId,
    clubId: input.clubId,
  });

  // Deferred and scheduled regardless of whether rows were created, for the reason the
  // announcement branch gives: the push ledger is what makes the buzz idempotent, not the
  // notification insert, so a redelivery after a crash between the two must still push.
  await schedulePush(deps, {
    outboxEventId: key,
    type: 'news_post_tagged',
    params: input.params,
    recipients: input.named,
    partitionKey: input.clubId,
  });
}

function makeCreationHandler(config: {
  notificationType:
    | 'race_created'
    | 'event_created'
    | 'meeting_created'
    | 'news_post_created'
    | 'poll_created'
    | 'meetup_nudged';
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

      await schedulePush(deps, {
        outboxEventId: notificationKey(event.id),
        type: config.notificationType,
        params,
        recipients,
        partitionKey: clubId,
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
    // The admins travelling to this race. A stranded car group is the business of whoever is
    // going, not of every admin in the club.
    raceId: String(event.payload['raceId']),
  });

  await notifyAndPush(deps, {
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

/**
 * Someone gained race access. Force-unsubscribe on departure is the mirror of this.
 *
 * **Narrates the arrival into race chat**, which is the half that was missing entirely. Club
 * chat and Eboard chat have always said who joined and who let them in; race chat said nothing
 * at all, so approving somebody was completely invisible - not just quiet in the room, but
 * invisible everywhere, because an ordinary chat message is what gives a channel its unread
 * count. No message meant no unread, meant no badge, for every member of that race.
 */
const onRaceMembershipDecided: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const approved = event.payload['approved'] === true;
  const added = event.payload['added'] === true;
  const userId = String(event.payload['userId']);
  const actorId = event.payload['actorId'] as string | null;

  const club = await clubContext(deps.db, clubId);
  if (!club) return;

  const race = await raceContext(deps.db, String(event.payload['raceId']));
  const raceName = race?.name ?? 'the race';
  const actorName = actorId ? await displayName(deps.db, actorId) : 'An admin';

  /*
   * Only an approval is announced. A DENIAL posts nothing, for the reason
   * `onEboardMembershipDecided` already gives: it is addressed to the person who asked, and
   * announcing a refusal to the room they were refused entry to is a different, worse act.
   *
   * Three ways onto a roster and two sentences, split the way club chat splits them: somebody
   * who got themselves here "joined", somebody an admin put here "was added by" them. The Owner
   * letting themselves in is the first kind, not the second - "Owner was added by Owner" is
   * what naming the actor unconditionally would produce.
   */
  if (approved && race) {
    const joinerName = await displayName(deps.db, userId);
    await postSystemMessage(deps, {
      channelId: race.channelId,
      body:
        added && actorId && actorId !== userId
          ? `${joinerName} was added by ${actorName}`
          : `${joinerName} joined the race`,
      eventId: event.id,
    });
  }

  /*
   * Nobody is told about their own act (PRD/12 rule 10), and here that is not a nicety: the
   * Owner joining a race directly is the actor and the subject at once, so without this they
   * would be sent "you approved your request to join", about a request that never existed.
   *
   * `member_added` for a direct add and `request_approved` for a decision, which is the same
   * split `onEboardMembershipDecided` and `onMemberJoined` already make. This handler ignored
   * `added` and called every direct add an approval, so somebody an admin simply put on a
   * roster was told their request had been approved.
   */
  if (actorId !== userId) {
    await notifyAndPush(deps, {
      outboxEventId: notificationKey(event.id),
      type: added ? 'member_added' : approved ? 'request_approved' : 'request_denied',
      params: {
        clubId,
        clubName: club.name,
        actorName,
        scope: 'race',
        scopeName: raceName,
        ...(approved ? { scopeId: String(event.payload['raceId']) } : {}),
        // Identity, not a destination - a denied request names the race and must show it.
        subjectId: String(event.payload['raceId']),
      } as never,
      recipients: [userId],
      actorId,
      clubId,
    });
  }

  /*
   * Settle the roster admins' copies.
   *
   * Runs for a direct add too, not only for a decision on a request. Adding somebody who
   * happened to have a request open answers that request - `addRaceMember` closes the request
   * row itself, and this closes the notifications that pointed at it. Leaving them would put
   * the inbox and the roster into two different stories about the same person.
   */
  await resolvePendingRequests(deps.db, {
    type: 'race_join_request',
    scopeId: String(event.payload['raceId']),
    requesterId: userId,
    decision: approved ? 'approved' : 'denied',
    decidedByName: actorName,
  });
};

/**
 * Names, as a sentence: "Mike", "Mike and Alex", "Mike, Alex and 3 others".
 *
 * Two names in full and then a count. Listing eight makes a line nobody reads to the end, and
 * a bare "8 people" tells the room a number when what it wants is who - the first two names
 * are usually enough to know which group of people this was.
 */
function nameList(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const rest = names.length - 2;
  return `${names[0]}, ${names[1]} and ${rest} other${rest === 1 ? '' : 's'}`;
}

/**
 * Several people added to a roster in one act.
 *
 * **One event, one line, however many people.** The roster screen adds a whole selection at
 * once, and emitting a separate event per person would post a separate "was added by" line per
 * person - eight lines of near-identical text into a race that has just been filled, which is
 * chat noise manufactured out of an implementation detail. Each person still gets their own
 * `member_added` notification, because that one IS addressed to them individually.
 *
 * The singular add goes through here too, with a list of one, so there is no second wording to
 * keep in step.
 */
function makeMembersAddedHandler(
  scope: 'race' | 'eboard',
  line: (actorName: string, names: readonly string[]) => string,
): EffectHandler {
  return async (event, deps) => {
    const clubId = String(event.payload['clubId']);
    const actorId = String(event.payload['actorId']);
    const userIds = (event.payload['userIds'] as string[] | undefined) ?? [];
    if (userIds.length === 0) return;

    const club = await clubContext(deps.db, clubId);
    if (!club) return;

    /*
     * The two scopes answer "which chat, and what is it called" from different tables, so this
     * is the only branch in the handler. Everything after it is identical, which is the reason
     * the two share one.
     */
    let target: { name: string; channelId: string; scopeId: string } | null = null;
    if (scope === 'race') {
      const race = await raceContext(deps.db, String(event.payload['raceId']));
      if (race) target = { ...race, scopeId: String(event.payload['raceId']) };
    } else {
      const eboard = await eboardContext(deps.db, clubId);
      if (eboard) {
        target = {
          name: 'Eboard & Council',
          channelId: eboard.channelId,
          scopeId: eboard.eboardId,
        };
      }
    }
    if (!target) return;

    const actorName = await displayName(deps.db, actorId);
    // Resolved in the order they were added rather than by a name sort, so the two names the
    // line shows are the same two every time it is rendered.
    const names = [];
    for (const userId of userIds) names.push(await displayName(deps.db, userId));

    await postSystemMessage(deps, {
      channelId: target.channelId,
      body: line(actorName, names),
      eventId: event.id,
      scope,
    });

    await notifyAndPush(deps, {
      outboxEventId: notificationKey(event.id),
      type: 'member_added',
      params: {
        clubId,
        clubName: club.name,
        actorName,
        scope,
        scopeName: target.name,
        scopeId: target.scopeId,
      },
      recipients: userIds,
      actorId,
      clubId,
    });

    // Being added answers an outstanding request, so anybody else's copy of it stops asking.
    for (const userId of userIds) {
      await resolvePendingRequests(deps.db, {
        type: scope === 'race' ? 'race_join_request' : 'eboard_join_request',
        scopeId: target.scopeId,
        requesterId: userId,
        decision: 'approved',
        decidedByName: actorName,
      });
    }
  };
}

/**
 * Someone left or was removed from a race.
 *
 * Drops their subscription to that race's channel specifically. Their club membership is
 * untouched, so a blanket club-wide revocation would wrongly cut them out of club chat.
 *
 * **The revocation happens BEFORE the message is posted**, and the order is the point: the
 * line is about somebody's departure, and publishing it while they are still subscribed
 * delivers "Mike was removed by Sarah" to Mike, live, in a room he has just lost. Club chat
 * has no equivalent worry because leaving a club takes the channel with it.
 */
const onRaceMemberDeparted: EffectHandler = async (event, deps) => {
  const clubId = String(event.payload['clubId']);
  const raceId = String(event.payload['raceId']);
  const userId = String(event.payload['userId']);
  const actorId = event.payload['actorId'] as string | null;

  const race = await raceContext(deps.db, raceId);
  if (!race) return;

  await publishRevocation(deps.redis, { userId, channelIds: [race.channelId] });
  deps.log('info', 'revoked race subscriptions', { userId, raceId });

  // `actorId` is null when they left under their own steam, which is the same signal the club
  // departure handler reads to choose between the two sentences.
  const name = await displayName(deps.db, userId);
  const actorName = actorId ? await displayName(deps.db, actorId) : null;
  await postSystemMessage(deps, {
    channelId: race.channelId,
    body: actorName ? `${name} was removed by ${actorName}` : `${name} left the race`,
    eventId: event.id,
  });

  /*
   * Tell the person removed - the one member who cannot read the line just posted.
   *
   * The revocation above is deliberate, so the departure is narrated to the whole roster
   * EXCEPT its subject. That left race removal completely silent: club and Eboard removal have
   * written this row since Phase 1, race removal never did, and the founder's report was that
   * the race simply vanished from the phone of the person taken off it with nothing said. The
   * roster screen removes people the same way it adds them, and only one of the two halves was
   * telling anybody.
   *
   * Nothing is written when they left of their own accord: `actorId` is null then, the same
   * gate both sibling handlers use. Being told "you removed you" is noise, and they were the
   * one who did it.
   */
  if (actorId && actorName) {
    const club = await clubContext(deps.db, clubId);
    if (club) {
      await notifyAndPush(deps, {
        outboxEventId: notificationKey(event.id),
        type: 'member_removed',
        params: {
          clubId,
          clubName: club.name,
          actorName,
          // Named so the row says "removed you from Fall Classic" rather than naming the club,
          // which they are still a member of.
          scope: 'race',
          scopeName: race.name,
          // Identity only, never a destination - the row still points at the club, because the
          // race is the one thing they can no longer open. Without it the row named the race and
          // wore the CLUB's face, which reads as having lost the club. See PRD/12 rule 6a.
          subjectId: raceId,
        },
        recipients: [userId],
        actorId,
        clubId,
      });
    }
  }
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

    /*
     * **The removal allocates a revision, and this is the fourth mutation site rather than a
     * detail of this one.**
     *
     * The comment below used to say the publish was the ONLY route this change could travel.
     * That was true when it was written on 2026-08-01, and stopped being true on 2026-08-03 when
     * `last_rev` arrived precisely so a change had a second route - one that survives the client
     * not being there. This handler was not revisited, so it kept relying on the route it had.
     *
     * The cost was specific: a phone closed when a poll was deleted kept the card forever, and
     * kept it PINNED, because the same statement that clears `pinned` is the one that never
     * advertised itself. Sync asks for `rev > mark` and this row's rev had not moved.
     *
     * Per channel, not once for the batch. `last_rev` is a per-channel counter, so one revision
     * stamped across two channels would be a number that means something in one of them and is
     * either a duplicate or a skip in the other. The cascade matches on the object id alone and
     * nothing constrains it to a single channel, so the grouping is not hypothetical.
     *
     * In one transaction per channel with its own bump, for the same reason every other site is:
     * a revision that committed without its change would tell clients to skip past something
     * that did not happen.
     */
    const affected = await deps.db.execute<{ channel_id: string }>(sql`
      SELECT DISTINCT channel_id
        FROM messages
       WHERE ${sql.identifier(column)} = ${objectId}::uuid
         AND deleted_at IS NULL
    `);

    const removed: { rows: Array<{ channel_id: string; seq: number }> } = { rows: [] };

    for (const { channel_id: channelId } of affected.rows) {
      const rows = await deps.db.transaction(async (tx) => {
        const rev = await nextRevision(tx, channelId);
        // The channel is gone, so there is nobody left to tell and nothing to keep consistent.
        if (rev === null) return [];

        const updated = await tx.execute<{ channel_id: string; seq: number }>(sql`
          UPDATE messages
             SET deleted_at = now(), pinned = false, body = NULL, rev = ${rev}
           WHERE ${sql.identifier(column)} = ${objectId}::uuid
             AND channel_id = ${channelId}::uuid
             AND deleted_at IS NULL
          RETURNING channel_id, seq
        `);
        return updated.rows;
      });
      removed.rows.push(...rows);
    }

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

  /**
   * A message was corrected by its sender inside the edit window.
   *
   * Two halves, and they answer different audiences. Everyone with the conversation open gets the
   * new text as a `msg.update`; only somebody the edit newly @named gets a notification, and only
   * them - see the `addedMentions` note below.
   *
   * **Re-read at publish time rather than published from the payload**, the same choice
   * `message.pinned` and `message.reacted` make, and here it buys the same idempotency: two edits
   * a second apart are two events, and a redelivery of the first would otherwise republish its
   * snapshot over the second and put the older text back on every screen. Reading the row means a
   * redelivered event republishes current truth, so there is no ordering to get right.
   *
   * `editedAt` travels with `body` and is not inferred from the frame carrying one. A client that
   * received corrected text with no edit stamp would render it with no label - the message would
   * silently become something else, which is exactly what rule 9a exists to prevent.
   */
  'message.edited': async (event, deps) => {
    const channelId = String(event.payload['channelId'] ?? event.partitionKey);
    const seq = Number(event.payload['seq']);

    const rows = await deps.db.execute<{ body: string | null; edited_at: string | null }>(sql`
      SELECT body, edited_at
        FROM messages
       WHERE channel_id = ${channelId}::uuid AND seq = ${seq}
       LIMIT 1
    `);
    const row = rows.rows[0];
    // Deleted between the edit and this handler running. The delete published its own update
    // carrying the tombstone, and republishing the edited text over it would resurrect words
    // somebody has already removed.
    if (!row || row.edited_at === null) return;

    await publishUpdate(deps.redis, channelId, {
      channelId,
      seq,
      body: row.body,
      // `db.execute` does no column coercion, so a timestamptz arrives as the driver's string -
      // AGENTS.md 5.3 entry 7. Normalised through Date so the wire gets ISO-8601 with a `Z`,
      // which is what the schema validates.
      editedAt: new Date(row.edited_at).toISOString(),
    });

    /*
     * Only the names the edit ADDED.
     *
     * Carried on the event rather than re-derived, because by the time this runs the previous
     * mention set has already been replaced - the diff is the one fact about an edit that cannot
     * be recovered by reading the row. Notifying everyone named in the final text instead would
     * buzz the same person again every time the sender fixed a typo in a message that already
     * mentioned them.
     */
    const added = Array.isArray(event.payload['addedMentions'])
      ? (event.payload['addedMentions'] as unknown[]).map(String).filter((id) => id.length > 0)
      : [];
    if (added.length === 0) {
      deps.log('info', 'message.edited published', { eventId: event.id, channelId, seq });
      return;
    }

    const context = await channelContext(deps.db, channelId);
    if (!context) {
      deps.log('warn', 'message.edited for a channel that no longer exists', { channelId });
      return;
    }

    const senderId = await senderOf(deps.db, channelId, seq);
    const params = {
      clubId: context.clubId,
      channelId,
      channelName: context.name,
      seq,
      // Truncated to the same 140 the send path uses, so a push about an edited mention reads
      // identically to one about a fresh mention. Only text is editable, so the null branch is
      // unreachable rather than a case with its own copy.
      preview: (row.body ?? '').slice(0, 140),
      actorName: senderId ? await displayName(deps.db, senderId) : 'Someone',
    };

    /*
     * Through `resolveAudience` rather than straight to the list, so the same reachability rule
     * that guards a mention on the send path guards one added by an edit. `editMessage` already
     * filtered to the channel audience; this is the second gate, and it is the one that also
     * drops the sender if they somehow named themselves.
     */
    const recipients = await resolveAudience(deps.db, {
      type: 'mentioned',
      actorId: senderId,
      clubId: context.clubId,
      channelId,
      explicitRecipients: added,
    });

    await writeNotifications(deps.db, {
      outboxEventId: notificationKey(event.id, 0),
      type: 'mentioned',
      params,
      recipients,
      actorId: senderId,
      clubId: context.clubId,
    });

    await schedulePush(deps, {
      outboxEventId: notificationKey(event.id, 0),
      type: 'mentioned',
      params,
      recipients,
      channelId,
      seq,
      partitionKey: channelId,
    });

    deps.log('info', 'message.edited published', {
      eventId: event.id,
      channelId,
      seq,
      addedMentions: added.length,
    });
  },

  /**
   * A message was reported, and whoever reviews reports here is told.
   *
   * > **Reporting was silent until 2026-08-01.** The row landed in `message_reports` and waited
   * > for an admin to happen to open the Reports tab, which is a work queue nobody was told had
   * > work in it. Raised by the founder: "I didn't get any notification when a member reported."
   *
   * The audience is deliberately not "the club's admins": a race channel is reviewed by roster
   * members who are ALSO club admins, and a DM has no admin at all - its reviewers are platform
   * moderators, who belong to no club. `resolveAudience` routes all four through the list form of
   * the same predicate that decides who may open the queue, so nobody is ever told about work
   * they cannot reach.
   *
   * The reporter is dropped from the audience by `resolveAudience` - they know - which also
   * covers the common case of an admin reporting something themselves.
   */
  'message.reported': async (event, deps) => {
    const channelId = String(event.payload['channelId'] ?? event.partitionKey);
    const seq = Number(event.payload['seq']);
    const reporterId = String(event.payload['reporterId'] ?? '');

    const context = await channelContext(deps.db, channelId);
    if (!context) {
      deps.log('warn', 'message.reported for a channel that no longer exists', { channelId });
      return;
    }

    const recipients = await resolveAudience(deps.db, {
      type: 'message_reported',
      actorId: reporterId || null,
      clubId: context.clubId,
      channelId,
    });

    const params = {
      clubId: context.clubId,
      channelId,
      channelName: context.name,
      seq,
      actorName: reporterId ? await displayName(deps.db, reporterId) : 'Someone',
    };

    const { created } = await writeNotifications(deps.db, {
      outboxEventId: notificationKey(event.id, 0),
      type: 'message_reported',
      params,
      recipients,
      actorId: reporterId || null,
      clubId: context.clubId,
    });

    /*
     * Pushed with no deferral, and WITHOUT `channelId`/`seq`.
     *
     * Those two are what let `dispatchPush` suppress a push for somebody whose read cursor has
     * already passed the message - the right rule for an announcement, and the wrong one here.
     * Having read the conversation is not having reviewed the report; suppressing on it would
     * silence exactly the admin who is most active in that channel.
     *
     * > **It was `await dispatchPush(...)` inline until 2026-08-19, which put a call to Expo
     * > inside the drain's transaction** (`drain.ts` holds one open across the whole batch). One
     * > stalled provider request therefore froze the entire outbox - every system message, every
     * > card and every other notification - to make one report arrive a few hundred milliseconds
     * > sooner. It was also the only push in the product with no retry at all: a failure threw
     * > out of the handler, which is correct, but it took the causing event's whole attempt
     * > budget with it rather than retrying the push on its own.
     *
     * `immediate` keeps what the immediacy was for. The row is claimable on the next drain tick
     * rather than in eight seconds, so a moderator is told within about 250ms instead of
     * instantly - and the push now retries, alarms and survives a deploy like every other one.
     */
    await schedulePush(
      deps,
      {
        outboxEventId: notificationKey(event.id, 0),
        type: 'message_reported',
        params,
        recipients,
        partitionKey: context.clubId ?? channelId,
      },
      { immediate: true },
    );

    deps.log('info', 'message.reported notified', {
      eventId: event.id,
      channelId,
      scope: context.scope,
      recipients: recipients.length,
      created,
    });
  },

  /**
   * Somebody reported a person. Tell every platform moderator.
   *
   * The same shape as `message.reported` above with the channel taken out, and the two things that
   * follow from that are worth stating rather than inferring. There is **no `channelContext`**,
   * so nothing can fail on a channel that has since gone; and the audience needs no scope switch,
   * because a person report has exactly one destination (ADR-0035).
   *
   * **Pushed immediately and without a channel**, for the identical reason the type above is:
   * `dispatchPush` suppresses on a read cursor, and there is no conversation here whose cursor
   * could mean anything. Having read something is not having reviewed it.
   *
   * The params name the reporter and never the subject. That is enforced by the schema in
   * `@clubchat/shared` rather than remembered here, which is the point of validating params at the
   * write - see `notificationParams.user_reported`.
   */
  'user.reported': async (event, deps) => {
    const subjectId = String(event.payload['subjectId'] ?? event.partitionKey);
    const reporterId = String(event.payload['reporterId'] ?? '');

    const recipients = await resolveAudience(deps.db, {
      type: 'user_reported',
      actorId: reporterId || null,
      clubId: null,
    });

    const params = {
      actorName: reporterId ? await displayName(deps.db, reporterId) : 'Someone',
    };

    const { created } = await writeNotifications(deps.db, {
      outboxEventId: notificationKey(event.id, 0),
      type: 'user_reported',
      params,
      recipients,
      actorId: reporterId || null,
      clubId: null,
    });

    // No deferral and no channel, for the reason the type above gives - and off the drain's
    // transaction for the reason it gives too. `immediate` is the whole difference from an
    // ordinary push: the row is due now rather than in eight seconds.
    await schedulePush(
      deps,
      {
        outboxEventId: notificationKey(event.id, 0),
        type: 'user_reported',
        params,
        recipients,
        partitionKey: subjectId,
      },
      { immediate: true },
    );

    deps.log('info', 'user.reported notified', {
      eventId: event.id,
      subjectId,
      recipients: recipients.length,
      created,
    });
  },

  /**
   * A pin or unpin. Notifies nobody: pins are reference, not interruption.
   *
   * **Re-read at publish time rather than published from the payload**, which is the same choice
   * the reaction handler makes and for the same two reasons.
   *
   * The first is idempotency, free. Pin, unpin, pin again is three events; a redelivery of the
   * first would republish ITS snapshot over the current state, announcing a pin that has since
   * been removed. Reading the row now means a redelivered event republishes current truth, so
   * there is no ordering to get right and nothing to make the handler careful about.
   *
   * The second is that `pinned` alone was never the whole change. The strip orders by
   * `pinnedAt`, the payload never carried it, and a client receiving `pinned: true` with no time
   * stored a null and sorted the newest pin to the END of its strip. Reading the row supplies
   * both halves without the outbox event having to be widened, so no event already sitting in
   * the table is missing anything.
   *
   * One indexed lookup on a rare, human-initiated action, against a socket publish that was
   * happening anyway.
   */
  'message.pinned': async (event, deps) => {
    const channelId = String(event.payload['channelId'] ?? event.partitionKey);
    const seq = Number(event.payload['seq']);

    const rows = await deps.db.execute<{ pinned: boolean; pinned_at: string | null }>(sql`
      SELECT pinned, pinned_at
        FROM messages
       WHERE channel_id = ${channelId}::uuid AND seq = ${seq}
       LIMIT 1
    `);
    const row = rows.rows[0];
    // The message is gone, so there is no pin state to announce and nothing a client could do
    // with one. A deletion publishes its own update.
    if (!row) return;

    await publishUpdate(deps.redis, channelId, {
      channelId,
      seq,
      pinned: row.pinned,
      /*
       * `db.execute` does not apply Drizzle's column coercion, so a timestamptz arrives as the
       * driver's STRING rather than a Date - which is what the wire wants, and is exactly the
       * trap recorded as AGENTS.md 5.3 entry 7 in the other direction. Normalised through Date
       * anyway so the value is ISO-8601 with a `Z`, which is what the schema validates.
       */
      pinnedAt: row.pinned_at === null ? null : new Date(row.pinned_at).toISOString(),
    });
    deps.log('info', 'message.pinned published', {
      eventId: event.id,
      channelId,
      seq,
      pinned: row.pinned,
    });
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
  /**
   * A ban. Narrated as a ban, notified as a removal - see `makeDepartureHandler`.
   *
   * Only emitted when the banned person was actually a member: banning somebody who already left
   * bars them and narrates nothing, because nothing happened in the club to narrate.
   */
  'club.member_banned': makeDepartureHandler('banned'),
  'club.deleted': onClubDeleted,

  /**
   * Account lifecycle. One event, and it exists only to revoke.
   *
   * Emitted since 2026-08-08; before that, deleting an account published nothing and a live
   * socket kept delivering. See `onAccountDeleted`.
   */
  'account.deleted': onAccountDeleted,
  /*
   * Emitted by `setAccountSuspended`. Registered beside its sibling rather than sharing one
   * entry, because `effect-coverage.test.ts` scans producers for event-type literals and an
   * unclaimed one parks in silence - which is how three Eboard events lived unhandled for the
   * life of that space.
   */
  'account.suspended': onAccountSuspended,

  // The Eboard space. Emitted since the space was built, handled since none of it worked.
  'eboard.join_requested': onEboardJoinRequested,
  'eboard.membership_decided': onEboardMembershipDecided,
  /*
   * Same voice at every size, because "Sarah added Mike to the group" is already the shape a
   * longer list wants: only the middle grows.
   */
  'eboard.members_added': makeMembersAddedHandler(
    'eboard',
    (actorName, names) => `${actorName} added ${nameList(names)} to the group`,
  ),
  'eboard.member_departed': onEboardMemberDeparted,

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
    /*
     * The admins ON this roster, not the club's whole admin tier.
     *
     * Every club admin may decide a race request, but authority is not involvement: an owner
     * running none of the club's races was being paged for all of them. The people who need
     * to know somebody wants in are the ones already going. See `raceRosterAdmins`.
     */
    const recipients = await resolveAudience(deps.db, {
      type: 'race_join_request',
      actorId: String(event.payload['userId']),
      clubId,
      raceId: String(event.payload['raceId']),
    });
    await notifyAndPush(deps, {
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
  /*
   * One person keeps the passive line the rest of race chat uses ("Mike was added by Sarah"),
   * which sits beside "Mike joined the race" and "Mike left the race" as the same kind of
   * sentence about one person. A batch is an act by the adder, so it names them first.
   */
  'race.members_added': makeMembersAddedHandler('race', (actorName, names) =>
    names.length === 1
      ? `${names[0]} was added by ${actorName}`
      : `${actorName} added ${nameList(names)} to the race`,
  ),
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

  /*
   * Nudge: the one deliberate exception to Weekly Meetups notifying nobody.
   *
   * Reuses the creation handler for its audience resolution and push scheduling, and passes NO
   * card config - a nudge is a push, not a chat post. PRD/08 rule 11 keeps meetups out of chat,
   * and nudging one is not a reason to put it there: the point is to reach a phone that is not
   * currently looking at the app.
   */
  'meetup.nudged': makeCreationHandler({
    notificationType: 'meetup_nudged',
    buildParams: (event, ctx) => ({
      clubId: String(event.payload['clubId']),
      clubName: ctx.clubName,
      actorName: ctx.actorName,
      meetupId: String(event.payload['meetupId']),
      meetupDate: String(event.payload['meetupDate']),
      // Still carried, and it must be: `meetup_nudged` requires it and the rendered line reads
      // "... today at 18:30". It was dropped here alongside `location` on 2026-08-25 and the
      // producer never stopped emitting it, so every nudge threw in `parseNotificationParams`
      // and notified nobody at all.
      meetupTime: String(event.payload['meetupTime']),
      // `title`, never `location`: the place column was retired by ADR-0037 and removed by
      // ADR-0049. `String(null)` is the text "null", which is why the old one shipped a bug
      // rather than an empty string - see the note on the payload in `nudgeMeetup`.
      title: String(event.payload['title']),
    }),
  }),

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

  /**
   * A news post was published.
   *
   * **Not `makeCreationHandler`, and the reason is one line of it.** That helper writes rows to
   * an audience and pushes to the same list, which is right for every other creation and wrong
   * here: a post can NAME people, and somebody named would otherwise be buzzed twice about one
   * post - "Hillside posted club news" and "Riley named you in a post", seconds apart.
   *
   * The fix is the one the announcement branch above already runs, and it is deliberately the
   * same shape rather than a similar one:
   *
   *  - **Both inbox rows are written.** One says the club was told something, the other says
   *    they were named in it, and they clear against different things.
   *  - **Only the push list subtracts.** The named get the specific line instead of the generic
   *    one, so one message is one buzz.
   *
   * A post that names everybody in the club leaves the generic push list empty, and
   * `dispatchPush` returns without sending rather than reading an empty list as "everyone".
   *
   * News deliberately posts NO chat card: discussion belongs in chat, but the post itself lives
   * on the club's front page.
   */
  'news.created': async (event, deps) => {
    const clubId = String(event.payload['clubId']);
    const postId = String(event.payload['postId']);
    const actorId = (event.payload['actorId'] as string | null) ?? null;

    const club = await clubContext(deps.db, clubId);
    if (!club) return;

    const actorName = actorId ? await displayName(deps.db, actorId) : 'Someone';
    const params = { clubId, clubName: club.name, actorName, postId };

    const recipients = await resolveAudience(deps.db, {
      type: 'news_post_created',
      actorId,
      clubId,
    });

    /*
      Intersected with the generic audience rather than trusted from the payload. That drops the
      author naming themselves, and anybody who left the club between the post being written and
      this event being handled - both of which would otherwise be a notification to somebody who
      should not get one, produced by a list the API built minutes ago.
    */
    const audience = new Set(recipients);
    const named = (event.payload['taggedUserIds'] as unknown[] | undefined ?? [])
      .filter((userId): userId is string => typeof userId === 'string')
      .filter((userId) => audience.has(userId));
    const namedSet = new Set(named);

    if (recipients.length > 0) {
      await writeNotifications(deps.db, {
        outboxEventId: notificationKey(event.id, 0),
        type: 'news_post_created',
        params,
        recipients,
        actorId,
        clubId,
      });

      const buzzed = recipients.filter((userId) => !namedSet.has(userId));
      await schedulePush(deps, {
        outboxEventId: notificationKey(event.id, 0),
        type: 'news_post_created',
        params,
        recipients: buzzed,
        partitionKey: clubId,
      });
    }

    // Slot 1 is the mention slot, which is what being named in a post is.
    await notifyNamedInPost(deps, { event, slot: 1, clubId, actorId, params, named });
  },

  /**
   * Somebody was named in an EXISTING post, by an edit.
   *
   * PRD/06 rule 6 says editing notifies nobody, and that rule is about the post. Being named is
   * not about the post; it is about the person, and somebody added an hour later has not been
   * told anything yet. Only the difference is here - the domain computes it, so a fixed typo
   * re-buzzes nobody (ADR-0040).
   */
  'news.tagged': async (event, deps) => {
    const clubId = String(event.payload['clubId']);
    const postId = String(event.payload['postId']);
    const actorId = (event.payload['actorId'] as string | null) ?? null;

    const club = await clubContext(deps.db, clubId);
    if (!club) return;

    const actorName = actorId ? await displayName(deps.db, actorId) : 'Someone';
    const params = { clubId, clubName: club.name, actorName, postId };

    /* The same intersection as above, and for the same reason - `resolveAudience` is what knows
       who is still in this club and that the actor is not their own audience. */
    const audience = new Set(
      await resolveAudience(deps.db, { type: 'news_post_tagged', actorId, clubId }),
    );
    const named = (event.payload['taggedUserIds'] as unknown[] | undefined ?? [])
      .filter((userId): userId is string => typeof userId === 'string')
      .filter((userId) => audience.has(userId));

    await notifyNamedInPost(deps, { event, slot: 0, clubId, actorId, params, named });
  },

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
    if (result.undecodable) {
      // Warn, not error, and emphatically not a throw. The object is recorded as underivable
      // and the event is done; see the catch in `deriveVariants` for why parking on this would
      // be the wrong alarm.
      deps.log('warn', 'media does not decode, derivation abandoned', { mediaId });
      return;
    }
    deps.log('info', 'derived media variants', { mediaId, ...result });
  },

  /**
   * Evaluate a push whose deferral has elapsed.
   *
   * The consumer half of `push/deferral.ts`, and the only handler in this file that is produced
   * by another handler rather than by a command. Everything it needs is in the payload, because
   * the point of writing the row was that the process which scheduled it may be gone: a deploy,
   * a crash or an OOM between the two is the case this exists for.
   *
   * **The cursor and the mute are read HERE, now**, which is the whole reason the wait is a wait.
   * Capturing them at enqueue time would defeat ADR-0008 and buzz somebody who is looking at the
   * message as it arrives.
   *
   * **The provider call now happens inside the drain's transaction, and that is the trade this
   * makes.** Every effect in this engine does - `media.uploaded` downloads an object and re-encodes
   * it there - so a push is not a new kind of guest, but it is a far more frequent one now that
   * every chat message pushes. What bounds it is a timeout on the sender; without one, a provider
   * that hangs delays the batch behind it. Nothing is lost either way, because a row that is not
   * stamped is a row that is redelivered. The alternative, a second loop of its own for pushes,
   * is a redesign of the engine rather than a fix to it.
   *
   * **It rethrows**, so a failure is retried on the drain's backoff and finally parks with the
   * alarm `drain.ts` raises - which is what makes `TECH/11`'s "retried by the worker" true. The
   * message is decorated on the way out because a parked alarm reading "push.deferred #4181
   * failed: connection terminated" names nothing anybody can act on; what was lost, and how many
   * people did not hear about it, are the two facts worth carrying.
   */
  'push.deferred': async (event, deps) => {
    const parsed = DeferredPushPayload.safeParse(event.payload);
    if (!parsed.success) {
      // Permanent: the payload was written once and is frozen, so it will not parse on attempt
      // eight either. Worth reporting now rather than in two hours.
      throw new PermanentEffectError(
        `push.deferred payload does not parse: ${parsed.error.message}`,
      );
    }

    const input = parsed.data;
    try {
      const outcome = await dispatchPush(deps.db, deps.push, input);
      deps.log('info', `${input.type} push dispatched`, {
        eventId: event.id,
        notificationKey: input.outboxEventId,
        ...outcome,
      });
    } catch (error) {
      // A classification the dispatch made deliberately is not ours to overwrite.
      if (error instanceof PermanentEffectError) throw error;
      const n = input.recipients.length;
      throw new Error(
        `deferred ${input.type} push failed for ${n} recipient${n === 1 ? '' : 's'} (key ${input.outboxEventId})`,
        // The driver's error stays on the chain rather than being flattened into a string:
        // AGENTS.md 5.3 entry 1 is about exactly this, and a pg error code lives two causes down.
        { cause: error },
      );
    }
  },
};

export async function dispatch(event: OutboxEvent, deps: EffectDeps): Promise<void> {
  const handler = handlers[event.eventType];
  if (!handler) {
    /*
     * An unknown event type is a bug, not something to swallow: it means a producer
     * was deployed ahead of its consumer. Throwing routes it through the retry and
     * parking path where it is visible.
     *
     * **Deliberately NOT a `PermanentEffectError`,** which it superficially resembles. The
     * commonest way to reach this line is a rolling deploy: an old worker briefly sees an
     * event type only the new code handles. That resolves itself the moment the deploy
     * finishes, which makes it transient - and the retry schedule covers well over an hour,
     * so it heals with nobody paged. Parking on sight would turn every rolling deploy into
     * an incident.
     */
    throw new Error(`no handler for event type "${event.eventType}"`);
  }
  await handler(event, deps);
}
