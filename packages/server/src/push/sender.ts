/**
 * The PushSender port, and its Expo implementation.
 *
 * A named interface with a thin adapter behind it, per the "build the seams, not the
 * scale" rule: swapping transport later is a new implementation of an existing port
 * rather than a rewrite. It also makes the pipeline testable without buzzing a real
 * phone, which is the difference between an asserted payload and a hopeful one.
 */

export type PushMessage = {
  token: string;
  title: string;
  body: string;
  /**
   * The deep-link destination, as structured data rather than a route string.
   *
   * Carried through to the device so tapping the notification lands on the exact
   * message. A route string here would recreate pitfall 8 on the wire: every historical
   * push payload would embed a literal that no navigation change could safely alter.
   */
  data: Record<string, unknown>;
};

export type PushReceipt = {
  token: string;
  ok: boolean;
  /** True when the provider says this token is permanently dead, not merely failing. */
  tokenInvalid: boolean;
  error?: string | undefined;
};

export interface PushSender {
  send(messages: readonly PushMessage[]): Promise<PushReceipt[]>;
}

/**
 * How long one batch may take before it is abandoned.
 *
 * There is a caller-shaped reason for this rather than a round number, the same as the one on
 * `ResendMailer`: `worker/effects.ts` awaits `dispatchPush` INLINE for `message.reported` and
 * `user.reported`, rather than handing it to `schedule()` like every other type. Those two awaits
 * happen inside the drain's transaction, which is holding `FOR UPDATE` on up to fifty claimed
 * outbox rows. A `fetch` with no signal against a host that accepts the connection and never
 * answers does not fail, retry or park - it simply never settles, so the transaction never
 * commits and every partition's effects stop with nothing in the log to say why.
 *
 * Ten seconds is well past a healthy Expo response and well short of anything worth waiting for.
 * A push that is abandoned is a phone that does not buzz; a drain that is stalled is a whole
 * product that has quietly stopped, so the trade is not close.
 */
export const PUSH_TIMEOUT_MS = 10_000;

/**
 * Expo Push Service.
 *
 * The right transport because the client is Expo and this abstracts APNs, FCM and web
 * push behind one path, so all three platforms use the same code.
 */
export class ExpoPushSender implements PushSender {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { endpoint?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.endpoint = opts.endpoint ?? 'https://exp.host/--/api/v2/push/send';
    // Bound, not bare. A getter returning the raw global and then being called as a
    // method throws "Illegal invocation" in a browser and silently works in Node - see
    // AGENTS.md 5.3 entry 6, which cost real time on the client side of this codebase.
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    // Overridable for tests only. A timeout that differs between production and the suite is a
    // timeout that has never been exercised where it matters.
    this.timeoutMs = opts.timeoutMs ?? PUSH_TIMEOUT_MS;
  }

  async send(messages: readonly PushMessage[]): Promise<PushReceipt[]> {
    if (messages.length === 0) return [];

    // Expo accepts up to 100 notifications per request. Batching matters: a 300-member
    // club announcement is a handful of requests rather than 300.
    const BATCH = 100;
    const receipts: PushReceipt[] = [];

    for (let i = 0; i < messages.length; i += BATCH) {
      const batch = messages.slice(i, i + BATCH);
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(
            batch.map((message) => ({
              to: message.token,
              title: message.title,
              body: message.body,
              data: message.data,
              sound: 'default',
            })),
          ),
          /*
           * A fresh deadline per batch, not one shared across all of them.
           *
           * A 300-member club announcement is three requests, and a single signal started before
           * the first would leave the last inheriting a clock that has already been running -
           * so a large club would fail purely for being large. Each batch gets the full window.
           */
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          // A transport failure is not a dead token. Marking tokens invalid here would
          // permanently silence every device in the batch over one bad afternoon.
          receipts.push(
            ...batch.map((m) => ({
              token: m.token,
              ok: false,
              tokenInvalid: false,
              error: `expo push returned ${response.status}`,
            })),
          );
          continue;
        }

        const body = (await response.json()) as {
          data?: Array<{ status?: string; details?: { error?: string } }>;
        };

        batch.forEach((message, index) => {
          const result = body.data?.[index];
          const ok = result?.status === 'ok';
          receipts.push({
            token: message.token,
            ok,
            // Only this specific error means the token will never work again.
            tokenInvalid: result?.details?.error === 'DeviceNotRegistered',
            error: ok ? undefined : (result?.details?.error ?? 'unknown'),
          });
        });
      } catch (error) {
        // Where the deadline above lands, alongside a refused connection and a DNS failure.
        // `tokenInvalid` stays false for all of them: a provider that did not answer is not a
        // device that has gone away, and confusing the two silences a phone permanently.
        receipts.push(
          ...batch.map((m) => ({
            token: m.token,
            ok: false,
            tokenInvalid: false,
            error: error instanceof Error ? error.message : String(error),
          })),
        );
      }
    }

    return receipts;
  }
}

/**
 * A sender that records instead of sending.
 *
 * Used by the Phase 1 gate to assert the payload and its deep link, which is the only way
 * to check "reaches a backgrounded phone as a push that deep-links to the right message"
 * without a phone in the loop.
 */
export class RecordingPushSender implements PushSender {
  readonly sent: PushMessage[] = [];
  /** Tokens to report as permanently dead, for exercising invalidation. */
  deadTokens = new Set<string>();

  async send(messages: readonly PushMessage[]): Promise<PushReceipt[]> {
    this.sent.push(...messages);
    return messages.map((message) => ({
      token: message.token,
      ok: !this.deadTokens.has(message.token),
      tokenInvalid: this.deadTokens.has(message.token),
    }));
  }

  reset() {
    this.sent.length = 0;
  }
}
