/**
 * The deferred push, as a durable row.
 *
 * > **Every push in this system was fire-and-forget until 2026-08-19.** `schedule()` in
 * > `worker/effects.ts` handed the evaluation to a bare `setTimeout(...).unref()`, and the drain
 * > stamps `processed_at = now()` the instant `dispatch()` returns - so the outbox row that
 * > caused the push closed **eight seconds before the push was evaluated**. Everything about that
 * > window was invisible. A transient Postgres error inside the evaluation threw into a `void`
 * > and produced one log line with no event id, no notification type and no recipients; a
 * > `SIGTERM` on any deploy destroyed the pending timer outright, with the row already marked
 * > done. For `dm_message` and `chat_message`, which write no notification row by design, there
 * > was then no trace anywhere that a push had ever been attempted.
 *
 * So the wait becomes a row rather than a timer. The outbox already has everything a scheduler
 * needs: `next_attempt_at` is a due-at the drain's claim query already filters on, `attempts`
 * and `last_error` are the retry ledger, and a row that runs out of attempts parks with the
 * alarm `drain.ts` already raises. A deferred push is therefore an ordinary effect that happens
 * to be claimable eight seconds from now, and it inherits redelivery, backoff, parking and
 * monitoring without any of them being written a second time.
 *
 * **Nothing about the deferral's meaning changed.** The wait still exists to lose a race against
 * the recipient's own read acknowledgement, and the read cursor is still re-read at evaluation
 * time rather than captured at enqueue - see `PUSH_DEFERRAL_MS` and ADR-0008. What changed is
 * only where the eight seconds are counted: in Postgres, where a restart cannot forget them.
 *
 * **Idempotency is unchanged and comes from the ledger, not from this row.** The payload carries
 * the ORIGINAL banded notification key (`notificationKey(eventId, slot)`), so a redelivered or
 * duplicated deferral dispatches under the same `(outbox_event_id, device_id)` pair that
 * `push_deliveries` already dedupes on. Two of these rows for one event cost one extra pair of
 * queries and buzz nobody twice.
 */

import { sql } from 'drizzle-orm';
import { NotificationType } from '@clubchat/shared';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { outbox } from '../db/schema.ts';
import type { DispatchInput } from './dispatch.ts';

/**
 * The event type the drain dispatches a deferred push through.
 *
 * Written out as a literal at the insert below as well, because `effect-coverage.test.ts` scans
 * the producer directories for `eventType: '...'` and would not see a constant. That scan is what
 * catches a producer whose consumer was never written, so it is worth the duplication - the
 * handler side asserts against this constant, so the two cannot drift silently.
 */
export const DEFERRED_PUSH_EVENT = 'push.deferred';

/**
 * What one deferred push needs to know at evaluation time.
 *
 * Parsed rather than cast on the way out. The payload is a `jsonb` column written by a process
 * that may be an older or newer build than the one reading it, which is precisely the situation
 * where a hand-written row type is an assertion rather than a check (AGENTS.md 5.3 entry 16).
 */
export const DeferredPushPayload = z.object({
  /** The banded notification key, NOT the id of the row carrying it. */
  outboxEventId: z.number(),
  type: NotificationType,
  params: z.record(z.string(), z.unknown()),
  recipients: z.array(z.string()),
  /** Present for chat-scoped pushes; drives cursor suppression and mute. */
  channelId: z.string().optional(),
  seq: z.number().optional(),
});
export type DeferredPushPayload = z.infer<typeof DeferredPushPayload>;

export type EnqueueDeferredPushInput = DispatchInput & {
  /**
   * The ordering domain, before the `push:` prefix this function adds.
   *
   * Usually the channel, so two pushes about one conversation stay in order with each other.
   * **Prefixed on purpose**: a push has no ordering relationship with the channel log, and
   * sharing a partition with it would let a slow provider delay a system message once Kafka
   * partitions by this key (ADR-0006). It also keeps "which events did this club produce"
   * answerable without a push row in the middle of the answer.
   */
  partitionKey: string;
  /** How long from now the row becomes claimable. `0` means the next drain tick. */
  delayMs: number;
};

/**
 * Write the deferred push to the outbox.
 *
 * Not in the drain's transaction, because an effect handler is handed the pool rather than that
 * transaction - so the failure this can produce is a duplicate row and never a missing one. If
 * the insert lands and the drain then dies before stamping `processed_at`, the causing event is
 * redelivered and enqueues a second deferral; both dispatch under the same ledger key and the
 * second buzzes nobody. If the insert fails, the handler throws and the causing event retries,
 * which is the direction that cannot lose the push.
 */
export async function enqueueDeferredPush(db: Db, input: EnqueueDeferredPushInput): Promise<void> {
  const payload: DeferredPushPayload = {
    outboxEventId: input.outboxEventId,
    type: input.type,
    params: input.params,
    recipients: [...input.recipients],
    ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
    ...(input.seq === undefined ? {} : { seq: input.seq }),
  };

  await db.insert(outbox).values({
    partitionKey: `push:${input.partitionKey}`,
    eventType: 'push.deferred',
    payload,
    /*
     * The database's clock, not the process's.
     *
     * The drain claims on `next_attempt_at <= now()` evaluated in Postgres, so computing the due
     * time in Node would compare two clocks - and the direction it fails is a push that is either
     * early enough to lose the race the deferral exists to win, or late by however far the worker
     * has drifted.
     */
    nextAttemptAt: sql`now() + (${input.delayMs} * interval '1 millisecond')`,
  });
}
