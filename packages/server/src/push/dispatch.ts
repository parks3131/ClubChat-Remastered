/**
 * Push dispatch: audience, deferral, cursor suppression, per-device fan-out.
 *
 * The one rule this file exists to enforce:
 *
 * > **Push suppression is decided by the read cursor, never by connection liveness.**
 *
 * That is a correctness requirement, not an optimisation. `last_read_seq >= N` is a fact
 * committed to Postgres: this member demonstrably saw the message. A live socket is proof
 * of nothing - a phone that dies, loses signal or is force-quit leaves a registry entry
 * alive until its TTL expires, and gating push on that entry silently swallows every
 * notification in the window. In the subsystem the roadmap calls the single biggest
 * functional gap in v1.
 *
 * Liveness may only ever ACCELERATE delivery. It may never suppress it. This module
 * therefore never touches Redis. See ADR-0008.
 */

import { sql } from 'drizzle-orm';
import { notificationTarget, renderNotification, type NotificationType } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { devices, pushDeliveries } from '../db/schema.ts';
import { mutedRecipients } from '../worker/audience.ts';
import type { PushMessage, PushSender } from './sender.ts';

/**
 * How long to wait before evaluating the audience.
 *
 * **This exists to lose a race, not to save work.** A member with the chat already open
 * receives the message over the socket and advances their cursor within a few hundred
 * milliseconds; without the delay the worker could evaluate first and push to someone
 * actively staring at the message. Eight seconds is far longer than that round trip and
 * far shorter than a human notices a notification being late.
 *
 * The cursor is re-read AT evaluation time, never captured when the event was enqueued -
 * capturing it early would defeat the entire point of waiting.
 */
export const PUSH_DEFERRAL_MS = 8_000;

export type DispatchInput = {
  outboxEventId: number;
  type: NotificationType;
  params: Record<string, unknown>;
  recipients: readonly string[];
  /** Present for chat-scoped notifications; drives cursor suppression and mute. */
  channelId?: string | undefined;
  /** The seq this notification is about. Suppression compares cursors against it. */
  seq?: number | undefined;
};

export type DispatchOutcome = {
  considered: number;
  suppressedByCursor: number;
  suppressedByMute: number;
  alreadyDelivered: number;
  pushed: number;
  invalidatedTokens: number;
};

/**
 * Evaluate and send. Call this AFTER the deferral has elapsed.
 *
 * The deferral is the caller's business (the worker schedules it) so this function stays
 * synchronous in its logic and directly testable - a `setTimeout` buried in here would
 * make every test wait eight seconds.
 */
export async function dispatchPush(
  db: Db,
  sender: PushSender,
  input: DispatchInput,
): Promise<DispatchOutcome> {
  const outcome: DispatchOutcome = {
    considered: input.recipients.length,
    suppressedByCursor: 0,
    suppressedByMute: 0,
    alreadyDelivered: 0,
    pushed: 0,
    invalidatedTokens: 0,
  };

  if (input.recipients.length === 0) return outcome;

  let remaining = [...new Set(input.recipients)];

  // --- Cursor suppression. The only thing that legitimately silences a push. ---
  if (input.channelId && input.seq !== undefined) {
    const readAlready = await readPastSeq(db, input.channelId, input.seq, remaining);
    outcome.suppressedByCursor = readAlready.size;
    remaining = remaining.filter((userId) => !readAlready.has(userId));
  }

  // --- Mute. Suppresses the buzz, not the unread count or the inbox row. ---
  if (input.channelId) {
    const muted = await mutedRecipients(db, input.channelId, remaining);
    outcome.suppressedByMute = muted.size;
    remaining = remaining.filter((userId) => !muted.has(userId));
  }

  if (remaining.length === 0) return outcome;

  // --- Per DEVICE, not per user. ---
  // A member with the web client open on a laptop and a backgrounded phone has NOT read
  // the message, so both are pushed and the phone rings. Only the cursor suppresses, and
  // it suppresses for that member everywhere at once - so reading on the laptop silences
  // the phone, which is the behaviour you want.
  const targets = await liveDevices(db, remaining);
  if (targets.length === 0) return outcome;

  // Rendered from the same function the inbox uses, so a push and the row it links to can
  // never disagree about what happened.
  const rendered = renderNotification({ type: input.type, params: input.params });
  const target = notificationTarget({ type: input.type, params: input.params });

  // Dedupe against what already went out. A duplicated database row can be cleaned up
  // later; a duplicated push has already buzzed somebody's phone.
  const delivered = await alreadyDelivered(
    db,
    input.outboxEventId,
    targets.map((t) => t.id),
  );
  outcome.alreadyDelivered = delivered.size;

  const toSend = targets.filter((device) => !delivered.has(device.id));
  if (toSend.length === 0) return outcome;

  const messages: PushMessage[] = toSend.map((device) => ({
    token: device.pushToken,
    title: rendered.title,
    body: rendered.body,
    data: { target, type: input.type },
  }));

  const receipts = await sender.send(messages);
  const byToken = new Map(receipts.map((r) => [r.token, r]));

  const deliveredRows: Array<{ outboxEventId: number; deviceId: string }> = [];
  const deadDeviceIds: string[] = [];

  for (const device of toSend) {
    const receipt = byToken.get(device.pushToken);
    if (receipt?.ok) {
      deliveredRows.push({ outboxEventId: input.outboxEventId, deviceId: device.id });
      outcome.pushed += 1;
    } else if (receipt?.tokenInvalid) {
      deadDeviceIds.push(device.id);
      // Recorded as delivered too: retrying a permanently dead token forever is pure
      // waste, and the in-app inbox is correct regardless because the notification row
      // exists independently of whether the push landed.
      deliveredRows.push({ outboxEventId: input.outboxEventId, deviceId: device.id });
    }
    // A transient failure records nothing, so the next redelivery retries it.
  }

  if (deliveredRows.length > 0) {
    await db.insert(pushDeliveries).values(deliveredRows).onConflictDoNothing();
  }

  if (deadDeviceIds.length > 0) {
    await db.execute(sql`
      UPDATE devices SET invalidated_at = now()
       WHERE id = ANY(${sql.param(deadDeviceIds)}::uuid[])
    `);
    outcome.invalidatedTokens = deadDeviceIds.length;
  }

  return outcome;
}

/**
 * Which recipients have already read past this seq.
 *
 * Read at evaluation time. `last_read_seq >= N` is committed proof the member saw it.
 */
async function readPastSeq(
  db: Db,
  channelId: string,
  seq: number,
  recipients: readonly string[],
): Promise<Set<string>> {
  if (recipients.length === 0) return new Set();
  const rows = await db.execute<{ user_id: string }>(sql`
    SELECT user_id FROM read_cursors
     WHERE channel_id = ${channelId}
       AND user_id = ANY(${sql.param(recipients as string[])}::uuid[])
       AND last_read_seq >= ${seq}
  `);
  return new Set(rows.rows.map((r) => r.user_id));
}

async function liveDevices(
  db: Db,
  userIds: readonly string[],
): Promise<Array<{ id: string; pushToken: string; userId: string }>> {
  const rows = await db.execute<{ id: string; push_token: string; user_id: string }>(sql`
    SELECT id, push_token, user_id FROM devices
     WHERE user_id = ANY(${sql.param(userIds as string[])}::uuid[])
       AND invalidated_at IS NULL
  `);
  return rows.rows.map((r) => ({ id: r.id, pushToken: r.push_token, userId: r.user_id }));
}

async function alreadyDelivered(
  db: Db,
  outboxEventId: number,
  deviceIds: readonly string[],
): Promise<Set<string>> {
  if (deviceIds.length === 0) return new Set();
  const rows = await db.execute<{ device_id: string }>(sql`
    SELECT device_id FROM push_deliveries
     WHERE outbox_event_id = ${outboxEventId}
       AND device_id = ANY(${sql.param(deviceIds as string[])}::uuid[])
  `);
  return new Set(rows.rows.map((r) => r.device_id));
}

/** Register or refresh a device's push token. */
export async function registerDevice(
  db: Db,
  input: { userId: string; pushToken: string; platform: 'ios' | 'android' | 'web' },
): Promise<{ id: string }> {
  const rows = await db
    .insert(devices)
    .values({
      userId: input.userId,
      pushToken: input.pushToken,
      platform: input.platform,
    })
    // The same physical device re-registering must UPDATE, not duplicate. Otherwise one
    // phone accumulates rows and receives N copies of every push. Re-registering also
    // clears invalidated_at: a token the provider once rejected can become live again
    // after a reinstall.
    .onConflictDoUpdate({
      target: devices.pushToken,
      set: {
        userId: input.userId,
        platform: input.platform,
        lastSeenAt: new Date(),
        invalidatedAt: null,
      },
    })
    .returning({ id: devices.id });

  const row = rows[0];
  if (!row) throw new Error('device upsert returned no row');
  return row;
}
