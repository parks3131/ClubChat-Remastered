/**
 * The wire contract. One definition, shared by client and server, so the two
 * cannot drift. See SPEC/TECH/10-protocol.md.
 *
 * Envelope: { t: <type>, id: <correlation id>, d: <payload> }
 */

import { z } from 'zod';
import {
  ChannelScope,
  ChannelState,
  MessageEnvelope,
  MessageType,
  Platform,
  Uuid,
} from './domain.ts';

// ---------------------------------------------------------------------------
// Client to server
// ---------------------------------------------------------------------------

/** First frame. The socket is closed if it does not arrive within 5 seconds. */
export const AuthFrame = z.object({
  token: z.string().min(1),
  deviceId: Uuid,
  platform: Platform,
});

/** Authorized here, once. Rejected ids come back in the reply. */
export const SubscribeFrame = z.object({
  channelIds: z.array(Uuid).min(1).max(200),
});

export const UnsubscribeFrame = z.object({
  channelIds: z.array(Uuid).min(1).max(200),
});

/**
 * `clientMsgId` is generated once on the device, before the first attempt, and
 * reused across every retry. That is what makes the client's send outbox safe to
 * retry aggressively: a redelivered send hits
 * `UNIQUE (channel_id, sender_id, client_msg_id)` and the handler returns the
 * existing row's seq rather than posting twice.
 */
export const MsgSendFrame = z.object({
  clientMsgId: Uuid,
  channelId: Uuid,
  type: MessageType.default('text'),
  body: z.string().min(1).max(8_000).nullish(),
  mediaId: Uuid.nullish(),
  mentions: z.array(Uuid).max(200).optional(),
});

/** Advances the read cursor. The only thing that clears an unread count. */
export const MsgReadFrame = z.object({
  channelId: Uuid,
  upToSeq: z.number().int().nonnegative(),
});

export const PingFrame = z.object({});

export const ClientFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), id: z.string().optional(), d: AuthFrame }),
  z.object({ t: z.literal('subscribe'), id: z.string().optional(), d: SubscribeFrame }),
  z.object({ t: z.literal('unsubscribe'), id: z.string().optional(), d: UnsubscribeFrame }),
  z.object({ t: z.literal('msg.send'), id: z.string().optional(), d: MsgSendFrame }),
  z.object({ t: z.literal('msg.read'), id: z.string().optional(), d: MsgReadFrame }),
  z.object({ t: z.literal('ping'), id: z.string().optional(), d: PingFrame }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---------------------------------------------------------------------------
// Server to client
// ---------------------------------------------------------------------------

/**
 * The client immediately knows every channel with a gap, before fetching a single
 * message: compare each `lastSeq` against its own local max.
 */
export const AuthOk = z.object({
  sessionId: z.string(),
  userId: Uuid,
  serverTime: z.string().datetime(),
  channels: z.array(ChannelState),
});

export const authErrCodes = [
  'invalid_token',
  'expired_token',
  'signin_blocked',
  'timeout',
  'malformed',
] as const;
export const AuthErr = z.object({ code: z.enum(authErrCodes) });

export const SubscribeResult = z.object({
  granted: z.array(Uuid),
  rejected: z.array(Uuid),
});

export const MsgAck = z.object({
  clientMsgId: Uuid,
  messageId: Uuid,
  channelId: Uuid,
  seq: z.number().int().positive(),
  createdAt: z.string().datetime(),
});

export const msgErrCodes = [
  'rate_limited',
  'forbidden',
  'channel_gone',
  'malformed',
  /**
   * The attached object was never completed.
   *
   * Distinct from `forbidden` on purpose: the client's correct response is to finish the
   * upload and retry the same `client_msg_id`, not to give up. Collapsing it into a generic
   * failure would turn a recoverable state into a lost message.
   */
  'media_not_ready',
] as const;
export const MsgErr = z.object({
  clientMsgId: Uuid,
  code: z.enum(msgErrCodes),
});

export const MsgUpdate = z.object({
  channelId: Uuid,
  seq: z.number().int().positive(),
  pinned: z.boolean().optional(),
  deletedAt: z.string().datetime().nullable().optional(),
});

export const ServerFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth.ok'), id: z.string().optional(), d: AuthOk }),
  z.object({ t: z.literal('auth.err'), id: z.string().optional(), d: AuthErr }),
  z.object({ t: z.literal('subscribed'), id: z.string().optional(), d: SubscribeResult }),
  z.object({ t: z.literal('msg.ack'), id: z.string().optional(), d: MsgAck }),
  z.object({ t: z.literal('msg.err'), id: z.string().optional(), d: MsgErr }),
  z.object({ t: z.literal('msg.new'), id: z.string().optional(), d: MessageEnvelope }),
  z.object({ t: z.literal('msg.update'), id: z.string().optional(), d: MsgUpdate }),
  z.object({ t: z.literal('pong'), id: z.string().optional(), d: z.object({}) }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

// ---------------------------------------------------------------------------
// The gap rule
// ---------------------------------------------------------------------------

export type GapDecision =
  /** In order. Append and advance. */
  | { action: 'append'; syncAfter: false }
  /** A hole exists behind this message. Append it, then backfill. */
  | { action: 'append'; syncAfter: true }
  /** Already held. Drop it. */
  | { action: 'ignore'; syncAfter: false };

/**
 * Decide what to do with an arriving `seq` given the client's local maximum.
 *
 * This lives in shared, with its own test, because it is the single rule standing
 * between the client and silent message loss, and because it must be applied
 * **identically to `msg.new` and to the client's own `msg.ack`**.
 *
 * The `msg.ack` case is the subtle one. Suppose local max is 3 and seq 4 was missed
 * while the socket was flapping. The client sends, and gets back `msg.ack {seq: 5}`.
 * Skip the gap check on that path and the client appends its own message at 5, sets
 * local max to 5, and holds a **permanent** hole at 4 - permanent because every
 * later `msg.new` at 6 then satisfies `local_max + 1` and never triggers a sync. The
 * client believes it is caught up and is not.
 *
 * Note the asymmetry the return type encodes: on a gap the message is still
 * appended. The send succeeded and must not vanish from the UI; the sync backfills
 * the hole behind it.
 *
 * See SPEC/TECH/08-client-architecture.md.
 */
export function decideGap(arrivingSeq: number, localMaxSeq: number): GapDecision {
  if (arrivingSeq <= localMaxSeq) return { action: 'ignore', syncAfter: false };
  if (arrivingSeq === localMaxSeq + 1) return { action: 'append', syncAfter: false };
  return { action: 'append', syncAfter: true };
}

export { ChannelScope, ChannelState, MessageEnvelope };
