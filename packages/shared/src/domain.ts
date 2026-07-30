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
 * A message as it appears on the wire and in the client's local store.
 *
 * `seq` is the ordering. `createdAt` is for display only - a timestamp is not an
 * ordering, and clock skew is real. See SPEC/TECH/02-channel-log.md.
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
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type MessageEnvelope = z.infer<typeof MessageEnvelope>;

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
