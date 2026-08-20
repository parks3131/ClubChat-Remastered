/**
 * The Expo transport, and the deadline it owes its caller.
 *
 * Worth asserting for the same reason `mail.test.ts` asserts the Resend one: nothing else ever
 * sees this request. What makes it more urgent than the mailer is where it is awaited.
 * `worker/effects.ts` calls `dispatchPush` INLINE for `message.reported` and `user.reported`,
 * inside the drain's transaction - the one holding `FOR UPDATE` on up to fifty outbox rows. A
 * `fetch` with no signal against a host that accepts the connection and never answers does not
 * fail, retry or park. It never settles, so the transaction never commits and every partition's
 * effects stop: no notifications, no cards, no system messages, and nothing in the log to say so.
 *
 * `fetch` is injected rather than globally stubbed, which is the same argument that puts the
 * transport in the constructor rather than having the sender reach for one.
 */

import { describe, expect, it } from 'vitest';
import { ExpoPushSender, type PushMessage } from './sender.ts';

const messagesFor = (count: number): PushMessage[] =>
  Array.from({ length: count }, (_unused, index) => ({
    token: `ExponentPushToken[device-${index}]`,
    title: 'Race day',
    body: 'Meet at the boathouse',
    data: { target: 'channel' },
  }));

/**
 * A host that accepts the request and never answers.
 *
 * It settles for exactly one reason: the caller's own signal. That is the property under test -
 * without a signal this promise is a permanent stall, which is what the drain was exposed to.
 */
function hangingFetch() {
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject((init.signal as AbortSignal).reason);
      });
    });
  }) as unknown as typeof fetch;
  return { signals, fetchImpl };
}

/** A host that answers every notification with `ok`. */
function healthyFetch() {
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    const sent = JSON.parse(String(init?.body)) as unknown[];
    return new Response(JSON.stringify({ data: sent.map(() => ({ status: 'ok' })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { signals, fetchImpl };
}

describe('a push that never comes back', () => {
  it('is abandoned on its own deadline rather than stalling the caller forever', async () => {
    const { fetchImpl } = hangingFetch();
    const sender = new ExpoPushSender({ fetchImpl, timeoutMs: 50 });

    const receipts = await sender.send(messagesFor(3));

    expect(receipts).toHaveLength(3);
    for (const receipt of receipts) {
      expect(receipt.ok).toBe(false);
      // A provider that did not answer is not a device that has gone away. Marking these
      // invalid would permanently silence three phones over one bad afternoon.
      expect(receipt.tokenInvalid).toBe(false);
      expect(receipt.error).toMatch(/timeout|abort/i);
    }
  });

  it('carries the deadline as a signal on the request itself', async () => {
    // Structural, and deliberately so: the assertion above proves the sender gives up, and this
    // one proves it gives up by cancelling the request rather than by racing a timer and leaving
    // the socket and the task behind.
    const { signals, fetchImpl } = healthyFetch();

    await new ExpoPushSender({ fetchImpl }).send(messagesFor(1));

    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('gives every batch its own deadline, not one shared across all of them', async () => {
    // Expo takes 100 notifications per request, so a 300-member announcement is several
    // requests. One signal shared between them would mean the last batch inheriting a clock
    // that started before the first, and a large club failing purely for being large.
    const { signals, fetchImpl } = healthyFetch();

    const receipts = await new ExpoPushSender({ fetchImpl }).send(messagesFor(150));

    expect(receipts).toHaveLength(150);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});
