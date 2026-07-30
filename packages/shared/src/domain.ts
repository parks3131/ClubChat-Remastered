/**
 * Domain vocabulary shared by every process and by the client.
 *
 * This module holds names and shapes only. Behaviour lives in the server's policy
 * and domain modules; putting a predicate here would give it a second home, which
 * is the failure mode SPEC/TECH/05-authorization.md exists to prevent.
 */

import { z } from 'zod';

/**
 * The reserved system actor.
 *
 * System messages are authored by this user, never by NULL. Postgres treats NULLs
 * as distinct inside a unique index, so a NULL sender_id would silently defeat
 * `UNIQUE (channel_id, sender_id, client_msg_id)` - and the one class of message
 * the worker retries after a crash is exactly the class the constraint would then
 * fail to protect. Seeded by the first migration.
 *
 * See SPEC/TECH/03-message-flows.md.
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000001';

/**
 * The four channel scopes.
 *
 * There is one chat implementation and it serves all four. A feature added to club
 * chat is added to every scope or it is an explicit parameter.
 * See SPEC/PRD/01-domain-model.md.
 */
export const channelScopes = ['club', 'race', 'eboard', 'dm'] as const;
export const ChannelScope = z.enum(channelScopes);
export type ChannelScope = z.infer<typeof ChannelScope>;

/** Club membership tiers. Owner is a strict superset of admin. */
export const clubRoles = ['owner', 'admin', 'member'] as const;
export const ClubRole = z.enum(clubRoles);
export type ClubRole = z.infer<typeof ClubRole>;

/**
 * The admin tier.
 *
 * Every audience query and authority check that filters on "admin" must match both
 * of these. A bare `admin` filter silently excludes a club whose only admin-tier
 * member is the Owner, which is every brand-new club. That bug shipped four
 * separate times in v1, which is why the tier is a named constant rather than a
 * literal repeated at each call site. See SPEC/PRD/02-roles-and-permissions.md.
 */
export const ADMIN_TIER: readonly ClubRole[] = ['owner', 'admin'];

export const joinPolicies = ['open', 'request'] as const;
export const JoinPolicy = z.enum(joinPolicies);
export type JoinPolicy = z.infer<typeof JoinPolicy>;

/**
 * Message types.
 *
 * Phase 0 only produces `text` and `system`, but the full set is declared here so
 * the wire format does not change shape when later phases start emitting the rest.
 * See SPEC/PRD/01-domain-model.md.
 */
export const messageTypes = [
  'text',
  'photo',
  'document',
  'announcement',
  'system',
  'poll',
  'event',
  'meeting',
] as const;
export const MessageType = z.enum(messageTypes);
export type MessageType = z.infer<typeof MessageType>;

export const platforms = ['ios', 'android', 'web'] as const;
export const Platform = z.enum(platforms);
export type Platform = z.infer<typeof Platform>;

export const Uuid = z.string().uuid();

/**
 * The reaction emoji set. Six, fixed, in this order.
 *
 * > **Deliberately not a full emoji picker.** SPEC/PRD/05 rejected one on the grounds
 * > that fast tap targets beat completeness: six large buttons are one tap, and a
 * > searchable grid of two thousand is a shopping trip. The order is part of the
 * > contract - it is the order they render in, so it must not be sorted at a call site.
 *
 * A full picker was requested on 2026-07-30 and is recorded as an open question in
 * SPEC/PRD/05 rather than half-built here. The `messages_reactions_emoji_valid` check
 * constraint is what makes this list the truth rather than a suggestion, and dropping it
 * is the first task of any change that widens the set - which forces whoever does it to
 * confront validating arbitrary Unicode at exactly the right moment.
 */
export const reactionEmoji = ['👍', '❤️', '😂', '🔥', '🎉', '😮'] as const;
export const ReactionEmoji = z.enum(reactionEmoji);
export type ReactionEmoji = z.infer<typeof ReactionEmoji>;

/**
 * Everyone who reacted with one emoji.
 *
 * `userIds` rather than a count, because a count cannot answer "did I react?" and cannot
 * render the who-reacted list. Reactions are visible to everyone by spec (SPEC/PRD/05
 * rule 4 of the acceptance list), so there is no identity to gate here - unlike poll
 * votes, where the count is public and the voters are not.
 */
export const MessageReaction = z.object({
  emoji: ReactionEmoji,
  userIds: z.array(Uuid),
});
export type MessageReaction = z.infer<typeof MessageReaction>;

/**
 * A message as it appears on the wire and in the client's local store.
 *
 * `seq` is the ordering. `createdAt` is for display only - a timestamp is not an
 * ordering, and clock skew is real. See SPEC/TECH/02-channel-log.md.
 *
 * `reactions` rides along on the envelope rather than being fetched separately, which is
 * what makes them survive airplane mode along with the messages they belong to. See
 * ADR-0017. Defaulted so a producer that predates them still parses.
 */
export const MessageEnvelope = z.object({
  id: Uuid,
  channelId: Uuid,
  seq: z.number().int().positive(),
  senderId: Uuid,
  type: MessageType,
  body: z.string().nullable(),
  clientMsgId: Uuid,
  pinned: z.boolean(),
  reactions: z.array(MessageReaction).default([]),
  /**
   * The attached object, for a `photo` or `document` message.
   *
   * > **Phase 3 stored these on `messages` and never put them on the wire**, so a client
   * > receiving a photo knew its `type` was `'photo'` and had no way to find the bytes. The
   * > pipeline was complete and unreachable at the same time.
   *
   * Not a URL. Media is fetched through the authorized `/media/:id` hop, which re-checks the
   * same membership predicate that protects the message on **every** request - so what travels
   * here is an id, and turning it into bytes is a separate, authorized step. A URL on the
   * envelope would be a capability leaking into history.
   */
  mediaId: Uuid.nullable().default(null),
  /** Shown on a document bubble. A photo carries neither. */
  documentName: z.string().nullable().default(null),
  documentSize: z.number().int().nonnegative().nullable().default(null),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type MessageEnvelope = z.infer<typeof MessageEnvelope>;

/** Human-readable size for a document bubble. Kept in shared so both platforms agree. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10 and none above, so "9.4 MB" and "12 MB" rather than "12.0 MB".
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Collapse reactions for rendering: count per emoji, and whether the viewer is in it.
 *
 * A pure function over the envelope, in shared, so the pill row cannot disagree between
 * platforms about what "mine" means - and so the server never has to build a
 * per-recipient payload. That is the whole reason `userIds` travels instead of a count:
 * one publish serves every viewer.
 *
 * Returns emoji in `reactionEmoji` order, skipping any with no reactors, so the row does
 * not reshuffle as counts change.
 */
export function reactionSummary(
  reactions: readonly MessageReaction[],
  viewerId: string | null,
): Array<{ emoji: ReactionEmoji; count: number; mine: boolean }> {
  const byEmoji = new Map(reactions.map((r) => [r.emoji, r.userIds]));
  const summary: Array<{ emoji: ReactionEmoji; count: number; mine: boolean }> = [];
  for (const emoji of reactionEmoji) {
    const userIds = byEmoji.get(emoji);
    if (!userIds || userIds.length === 0) continue;
    summary.push({
      emoji,
      count: userIds.length,
      mine: viewerId !== null && userIds.includes(viewerId),
    });
  }
  return summary;
}

/** Per-channel sync state, as handed to the client on `auth.ok`. */
export const ChannelState = z.object({
  id: Uuid,
  scope: ChannelScope,
  clubId: Uuid.nullable(),
  lastSeq: z.number().int().nonnegative(),
  lastReadSeq: z.number().int().nonnegative(),
});
export type ChannelState = z.infer<typeof ChannelState>;

export const Club = z.object({
  id: Uuid,
  name: z.string(),
  sport: z.string(),
  description: z.string().nullable(),
  joinPolicy: JoinPolicy,
  role: ClubRole,
  mainChannelId: Uuid,
});
export type Club = z.infer<typeof Club>;

/**
 * Unread count for a channel.
 *
 * Computed, never stored. `lastSeq - lastReadSeq` is O(1) and cannot drift; a
 * stored count can. See SPEC/PRD/16-cross-cutting-ux.md.
 */
export function unreadCount(state: {
  lastSeq: number;
  lastReadSeq: number;
}): number {
  return Math.max(0, state.lastSeq - state.lastReadSeq);
}
