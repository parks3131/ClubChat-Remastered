/**
 * The other direction of outbound mail: what Resend tells us afterwards.
 *
 * > **A hard bounce and a delivered message looked identical to this product.** ADR-0020 recorded
 * > it as the one thing it left open: "Resend has webhooks for both and nothing consumes them, so
 * > a hard bounce still means a reset link went nowhere and nothing in the product knows." A
 * > member asks for a password reset, is told to check their inbox, and nothing arrives - and the
 * > only trace anywhere is a row in somebody else's dashboard.
 *
 * This module is the pure half of closing that: verify a signature, then read a payload. It holds
 * no database, no Fastify and no configuration, because both halves are worth asserting without
 * either. The route that uses it is `api/mail-webhook.ts`; the rows it produces are written by
 * `domain/mail-events.ts`.
 *
 * ---
 *
 * **The scheme is Svix's, not Resend's own.** Resend delegates webhook signing to Svix and its
 * documentation points there for the algorithm. Read from
 * https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests and
 * https://docs.svix.com/receiving/verifying-payloads/how-manual on 2026-08-25 rather than from
 * memory, because every part of it is the kind of detail that is plausible and wrong:
 *
 *  - Headers `svix-id`, `svix-timestamp`, `svix-signature`. Svix documents `webhook-` prefixed
 *    aliases for Professional and Enterprise accounts; both spellings are read here.
 *  - The signed content is `${id}.${timestamp}.${body}`, joined with a literal full stop, over the
 *    **raw** request bytes. Resend: "the cryptographic signature is sensitive to even the
 *    slightest change".
 *  - HMAC-SHA256, base64 encoded.
 *  - The key is the secret with its `whsec_` prefix removed and the remainder **base64 decoded**.
 *    Not the prefixed string, and not the base64 text.
 *  - `svix-signature` is a space-delimited list of `v1,<base64>` entries. A rotation puts two
 *    there, so a match on ANY entry passes.
 *
 * Nothing here uses the `resend` or `svix` SDKs. `mail.ts` records why for the sending half - a
 * dependency wrapping one POST is a dependency to keep current for no return - and it holds
 * harder for this side, where the whole implementation is one HMAC over a string that
 * `node:crypto` already computes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How far a webhook's own timestamp may be from ours before it is refused.
 *
 * **A choice, not a documented constant.** Svix's manual-verification page says to check the
 * timestamp against "your tolerance" and names no number; five minutes is what Svix's own client
 * libraries use, and it is recorded in ADR-0047 as a decision rather than inherited as a fact.
 *
 * Applied in BOTH directions. A timestamp in the future matters as much as one in the past: a
 * captured request whose clock runs ahead would otherwise stay replayable until our clock caught
 * up with it.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * The shortest key material worth accepting, in bytes.
 *
 * Svix issues 24 bytes. This refuses anything under 16 so that a truncated paste - the half of a
 * secret that survived a copy out of a dashboard - is a boot failure with the field named, rather
 * than an endpoint that verifies nothing much and looks fine.
 */
const MIN_SECRET_BYTES = 16;

/** Only `v1` exists. An unknown version is refused rather than assumed compatible. */
const SIGNATURE_VERSION = 'v1';

export type SignatureFailure =
  /** The configured secret is absent, not base64, or too short to be a key. Our fault, not theirs. */
  | 'bad_secret'
  /** One of the three signing headers is absent, empty, or was sent twice. */
  | 'missing_headers'
  /** The timestamp header is not a whole number of seconds. */
  | 'bad_timestamp'
  /** The timestamp is outside the tolerance window, in either direction. */
  | 'stale_timestamp'
  /** No `v1` entry in the header matched what we computed. */
  | 'bad_signature';

export type SignatureResult =
  /**
   * Verified, and carrying the delivery's own id.
   *
   * Returned rather than re-read by the caller, because the id is the IDEMPOTENCY KEY and it must
   * be the same string that was signed. A caller reaching back into the headers for it would be a
   * second reader of the same value, free to disagree about which of the two documented header
   * spellings won - and the disagreement would present as a duplicate row rather than as an error.
   */
  | { ok: true; deliveryId: string }
  | { ok: false; reason: SignatureFailure };

/**
 * The key bytes behind a signing secret, or null if it is not one.
 *
 * Exported because `config.ts` refuses to boot on a secret this cannot read. A malformed secret
 * that is only discovered at request time presents as every webhook 401ing, which is
 * indistinguishable from a wrong secret and from internet noise - and it is silent, because
 * nothing was ever going to be recorded to notice the absence of.
 */
export function decodeWebhookSecret(raw: string | undefined): Buffer | null {
  // Trimmed for the reason `optionalEnv` and `parityFingerprint` both are: a value pasted into a
  // secret store carries a trailing newline more often than anybody admits.
  const trimmed = (raw ?? '').trim();
  const body = trimmed.startsWith('whsec_') ? trimmed.slice('whsec_'.length) : trimmed;

  /*
   * Checked against the alphabet before decoding, because `Buffer.from(x, 'base64')` is lenient:
   * it discards anything it does not recognise and returns a short buffer rather than failing. A
   * secret with a stray character in it would silently become a different, shorter key.
   */
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;

  const decoded = Buffer.from(body, 'base64');
  return decoded.length >= MIN_SECRET_BYTES ? decoded : null;
}

/** One header value, or null if it is absent, empty, or was sent more than once. */
function singleHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[`svix-${name}`] ?? headers[`webhook-${name}`];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Is this request really from Resend?
 *
 * The whole security of `POST /webhooks/resend`, which is unauthenticated by construction. Every
 * refusal below happens before the payload is parsed, let alone trusted.
 *
 * `nowMs` is a parameter rather than a call to `Date.now()` so the tolerance window can be
 * asserted at both its edges without a fake clock.
 */
export function verifyWebhookSignature(input: {
  secret: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  nowMs: number;
}): SignatureResult {
  const key = decodeWebhookSecret(input.secret);
  if (key === null) return { ok: false, reason: 'bad_secret' };

  const id = singleHeader(input.headers, 'id');
  const timestamp = singleHeader(input.headers, 'timestamp');
  const signatures = singleHeader(input.headers, 'signature');
  if (id === null || timestamp === null || signatures === null) {
    return { ok: false, reason: 'missing_headers' };
  }

  /*
   * A whole number of seconds and nothing else. `Number()` rather than `parseInt` for the reason
   * `trustProxyOption` gives: `parseInt('17870000.5')` is a plausible-looking number derived from
   * a value that is not one, and a timestamp read loosely is a replay window read loosely.
   */
  if (!/^-?\d+$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const sentSeconds = Number(timestamp);
  if (!Number.isSafeInteger(sentSeconds)) return { ok: false, reason: 'bad_timestamp' };

  const driftSeconds = Math.abs(input.nowMs / 1000 - sentSeconds);
  if (driftSeconds > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  /*
   * The raw body, exactly as it arrived. The route reaches this with a string because it registers
   * a content-type parser of its own; Fastify's default parser would have handed it the parsed
   * object, and re-serializing that produces different bytes for the same payload.
   */
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${input.rawBody}`)
    .digest();

  for (const entry of signatures.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma < 0) continue;
    if (entry.slice(0, comma) !== SIGNATURE_VERSION) continue;

    const provided = Buffer.from(entry.slice(comma + 1), 'base64');
    /*
     * The length check is not an optimisation, it is what stops `timingSafeEqual` throwing:
     * it raises `RangeError` on buffers of different lengths, so a two-character signature from
     * anybody who can reach the port would otherwise be an unhandled 500 captured as an incident.
     * The only thing the early exit leaks is the digest length, which is a constant 32.
     */
    if (provided.length !== expected.length) continue;
    if (timingSafeEqual(provided, expected)) return { ok: true, deliveryId: id };
  }

  return { ok: false, reason: 'bad_signature' };
}

/**
 * The three event types this product records.
 *
 * Deliberately not every type Resend emits. `email.sent`, `email.delivered`, `email.opened` and
 * the rest are the system working, and a table of them is a log nobody reads that grows with
 * every message. What is recorded is what somebody has to act on:
 *
 *  - `bounced` - the recipient's mail server rejected it. Permanently, for a hard bounce.
 *  - `complained` - it arrived and was marked as spam. A reputation event.
 *  - `failed` - it never left, because of our quota, our key, or our domain.
 */
export type MailEventKind = 'bounced' | 'complained' | 'failed';

/** Which Resend type maps to which kind. The only place the provider's spelling appears. */
const RECORDED_TYPES: Readonly<Record<string, MailEventKind>> = {
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

export type MailEvent = {
  kind: MailEventKind;
  /** Lower cased and trimmed, because an address is an inbox rather than a string. */
  email: string;
  /**
   * `Permanent`, `Transient` or `Undetermined` for a bounce, and null for everything else.
   *
   * The distinction is the whole of what makes a bounce actionable: `Permanent` is a hard bounce
   * and the address will never receive anything, `Transient` is a full mailbox that will clear on
   * its own, and `Undetermined` is a bounce whose reason Resend could not read. Only the first is
   * an incident.
   */
  bounceType: string | null;
  /** The provider's own words: a bounce message, or a failure reason such as `reached_daily_quota`. */
  detail: string | null;
  /** `data.email_id`: which send this is about, so a report ties back to a row in Resend. */
  providerMessageId: string | null;
  occurredAt: Date;
};

export type ParsedWebhook =
  | { ok: true; events: MailEvent[] }
  /**
   * A payload that could not be read at all - which, on a request whose signature has ALREADY
   * verified, means Resend changed their schema. Distinguished from an event type we ignore
   * precisely so that case can be reported rather than acknowledged.
   */
  | { ok: false; reason: 'unreadable' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A string field, or null. Never an empty string, which is the same as absent everywhere here. */
function stringField(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * One recipient, as an address, or null if it is not one.
 *
 * Two jobs beyond case folding. `Name <a@b.invalid>` is unwrapped, because a display name is a
 * property of the header rather than of the inbox and storing it would put the same person in the
 * table under two keys. And the shape is checked - one `@`, no whitespace - so that a `to` field
 * carrying something other than an address produces no recipients at all, which the caller reads
 * as "unreadable" rather than writing a row against a string.
 *
 * Deliberately not RFC 5322. The question here is "did we get an address or did the schema
 * change", and a validator strict enough to be interesting would reject real addresses.
 */
function normalizeAddress(raw: string): string | null {
  const angle = /<([^>]*)>/.exec(raw);
  const candidate = (angle?.[1] ?? raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate : null;
}

/**
 * The recipients of one delivery, case folded and de-duplicated.
 *
 * `data.to` is an ARRAY in every example Resend publishes, and a single string is accepted anyway:
 * being lenient in the direction that loses nothing is cheaper than a schema change silently
 * dropping every bounce. De-duplication is not tidiness - the same address twice in one delivery
 * would collide with itself on `(provider_event_id, email)` and turn a legitimate event into a
 * half-written one.
 */
function recipientsOf(data: Record<string, unknown>): string[] {
  const raw = data['to'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (list === null) return [];

  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const email = normalizeAddress(entry);
    if (email === null) continue;
    seen.add(email);
  }
  return [...seen];
}

/**
 * Read a verified payload into rows.
 *
 * Called only after `verifyWebhookSignature` has passed, which is the reason it can afford to be
 * strict: anything unreadable here came from Resend, so it is worth reporting rather than
 * shrugging off.
 *
 * `receivedAt` is the fallback for an envelope with no usable `created_at`. A row with a missing
 * timestamp would be worse than one that is a few seconds late.
 */
export function parseMailEvent(payload: unknown, receivedAt: Date): ParsedWebhook {
  if (!isRecord(payload)) return { ok: false, reason: 'unreadable' };

  const type = stringField(payload, 'type');
  if (type === null) return { ok: false, reason: 'unreadable' };

  const kind = RECORDED_TYPES[type];
  // A type we do not record is acknowledged, not refused. Resend retries anything that is not a
  // 2xx for ten hours, so a subscription somebody widened in the dashboard must not become a
  // retry storm.
  if (kind === undefined) return { ok: true, events: [] };

  const data = payload['data'];
  if (!isRecord(data)) return { ok: false, reason: 'unreadable' };

  const recipients = recipientsOf(data);
  if (recipients.length === 0) return { ok: false, reason: 'unreadable' };

  const bounce = isRecord(data['bounce']) ? data['bounce'] : undefined;
  const failed = isRecord(data['failed']) ? data['failed'] : undefined;

  const stamped = stringField(payload, 'created_at');
  const parsedAt = stamped === null ? Number.NaN : Date.parse(stamped);
  const occurredAt = Number.isNaN(parsedAt) ? receivedAt : new Date(parsedAt);

  return {
    ok: true,
    events: recipients.map((email) => ({
      kind,
      email,
      bounceType: stringField(bounce, 'type'),
      detail: stringField(bounce, 'message') ?? stringField(failed, 'reason'),
      providerMessageId: stringField(data, 'email_id'),
      occurredAt,
    })),
  };
}

/**
 * Is this the kind of event a person has to be told about tonight?
 *
 * A transient bounce is a full mailbox that clears on its own and an undetermined one is a bounce
 * Resend could not read; neither is an incident, and reporting them would bury the ones that are.
 * A hard bounce, a spam complaint and a send that never left all are.
 */
export function isReportable(event: MailEvent): boolean {
  return event.kind !== 'bounced' || event.bounceType === 'Permanent';
}
