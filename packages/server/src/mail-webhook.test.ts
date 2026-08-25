/**
 * Resend's webhook signature, and the payload behind it.
 *
 * This is the whole security of an endpoint that is unauthenticated by construction: anybody on
 * the internet may POST attacker-controlled JSON at `/webhooks/resend`, and the only thing
 * separating Resend from them is an HMAC. So the assertions here are about REFUSAL first and
 * acceptance second.
 *
 * **No signature in this file is produced by the code under test.** That rule is
 * `packages/cdn-worker/test/harness.ts`'s, learned the expensive way: the media suite had 52
 * passing tests, two mutations were applied to the signing module, and all 52 stayed green
 * because every assertion signed and verified through the same implementation. Self-consistent
 * nonsense passes a round trip.
 *
 * The vectors below therefore come from an `openssl` pipeline that shares no code with
 * `mail-webhook.ts`, run once and pasted in as literals:
 *
 * ```
 * KEYTEXT='clubchat-webhook-vectors-only-32'
 * HEX=$(printf '%s' "$KEYTEXT" | xxd -p -c 256)
 * printf '%s' "whsec_$(printf '%s' "$KEYTEXT" | openssl base64 -A)"     # the secret
 * printf '%s' "$ID.$TIMESTAMP.$BODY" > signed.txt
 * openssl dgst -sha256 -mac HMAC -macopt hexkey:$HEX -binary signed.txt | openssl base64 -A
 * ```
 *
 * `SECRET` is a documentation value, not a credential: its key material is the ASCII string
 * `clubchat-webhook-vectors-only-32`, printed here in full, and it has never signed anything
 * outside this file.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import {
  WEBHOOK_TOLERANCE_SECONDS,
  decodeWebhookSecret,
  parseMailEvent,
  verifyWebhookSignature,
} from './mail-webhook.ts';

/** The `whsec_`-prefixed form, exactly as Resend's dashboard presents a signing secret. */
const SECRET = 'whsec_Y2x1YmNoYXQtd2ViaG9vay12ZWN0b3JzLW9ubHktMzI=';

const VECTOR_ID = 'msg_2VectorsOnlyNotReal';
const VECTOR_TIMESTAMP = '1787000000';

/**
 * A bounce payload with spaces in it, on purpose.
 *
 * Resend sends compact JSON, so a pretty-printed vector is not realism - it is the only way to
 * make the raw-body property VISIBLE. `JSON.stringify(JSON.parse(body))` of a compact body is
 * byte-identical to the body, so a test built on one could not tell a verifier that reads the raw
 * bytes from one that re-serializes the parsed object, which is the single likeliest way to get
 * this wrong. See the `re-serialized` case below.
 */
const VECTOR_BODY =
  '{ "type": "email.bounced", "created_at": "2026-08-25T10:00:00.000Z", "data": { "email_id": "56761188-7520-42d8-8898-ff6fc54ce618", "to": ["member@test.invalid"], "bounce": { "type": "Permanent", "subType": "General", "message": "The recipient mailbox does not exist." } } }';

const VECTOR_SIGNATURE = '1PGkHGGsVvJkCRF+oEWmLSnb34se4LcJAzWVzYiBHVc=';

const COMPLAINT_ID = 'msg_2ComplaintVectorOnly';
const COMPLAINT_TIMESTAMP = '1787000300';
const COMPLAINT_BODY =
  '{ "type": "email.complained", "created_at": "2026-08-25T10:05:00.000Z", "data": { "email_id": "0a3d1f22-6d5e-4a1e-9b77-8c2f0c1b4d55", "to": ["annoyed@test.invalid"] } }';
const COMPLAINT_SIGNATURE = 'r9GQ1QfT5xIkcho1+E03fHKXJSMbU8eidJ9/lcJnDVw=';

const FAILED_BODY =
  '{ "type": "email.failed", "created_at": "2026-08-25T10:06:00.000Z", "data": { "email_id": "9c9a2b31-1111-4c22-9333-4d5566778899", "to": ["quota@test.invalid"], "failed": { "reason": "reached_daily_quota" } } }';

const DELIVERED_BODY =
  '{ "type": "email.delivered", "created_at": "2026-08-25T10:07:00.000Z", "data": { "email_id": "1111aaaa-2222-4bbb-8ccc-3333dddd4444", "to": ["fine@test.invalid"] } }';

/** The moment the vector's own timestamp names, which is the only "now" that is inside tolerance. */
const VECTOR_NOW_MS = Number(VECTOR_TIMESTAMP) * 1000;

/** Headers as Fastify hands them over: lower-cased keys, string values. */
function headersFor(
  id: string,
  timestamp: string,
  signature: string,
  prefix: 'svix' | 'webhook' = 'svix',
): Record<string, string> {
  return {
    [`${prefix}-id`]: id,
    [`${prefix}-timestamp`]: timestamp,
    [`${prefix}-signature`]: signature,
  };
}

function verify(
  overrides: {
    secret?: string;
    headers?: Record<string, string | string[] | undefined>;
    rawBody?: string;
    nowMs?: number;
  } = {},
) {
  return verifyWebhookSignature({
    secret: overrides.secret ?? SECRET,
    headers: overrides.headers ?? headersFor(VECTOR_ID, VECTOR_TIMESTAMP, `v1,${VECTOR_SIGNATURE}`),
    rawBody: overrides.rawBody ?? VECTOR_BODY,
    nowMs: overrides.nowMs ?? VECTOR_NOW_MS,
  });
}

/**
 * The signature, derived a third way.
 *
 * `node:crypto` directly, with the key material written out as ASCII rather than decoded through
 * `decodeWebhookSecret`, so a change to how the secret is read cannot move both halves of the
 * comparison together. That is precisely the failure this project has already had once.
 */
function independentSignature(id: string, timestamp: string, body: string): string {
  return createHmac('sha256', Buffer.from('clubchat-webhook-vectors-only-32', 'utf8'))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
}

describe('the openssl vectors themselves', () => {
  /**
   * Ties the pasted literals to a derivation that does not go through `mail-webhook.ts` at all.
   * If this fails, the vectors were mistyped and every other assertion in the file is meaningless.
   */
  it('match a signature derived from node:crypto rather than from the module', () => {
    expect(independentSignature(VECTOR_ID, VECTOR_TIMESTAMP, VECTOR_BODY)).toBe(VECTOR_SIGNATURE);
    expect(independentSignature(COMPLAINT_ID, COMPLAINT_TIMESTAMP, COMPLAINT_BODY)).toBe(
      COMPLAINT_SIGNATURE,
    );
  });
});

describe('a signature Resend really produced', () => {
  it('is accepted, and hands back the delivery id it was signed with', () => {
    // The id is the idempotency key, so it comes out of the check that read it rather than being
    // fetched from the headers a second time.
    expect(verify()).toEqual({ ok: true, deliveryId: VECTOR_ID });
  });

  /** Both spellings of the secret. Svix's own libraries accept either, and so must this. */
  it('is accepted whether the secret carries the whsec_ prefix or not', () => {
    expect(verify({ secret: 'Y2x1YmNoYXQtd2ViaG9vay12ZWN0b3JzLW9ubHktMzI=' })).toEqual({
      ok: true,
      deliveryId: VECTOR_ID,
    });
  });

  /**
   * Svix documents `webhook-` prefixed aliases for Professional and Enterprise accounts. Which
   * tier this account is on could not be established from Resend's docs, so both spellings are
   * read - accepting one we may never receive costs nothing, and refusing one we do receive is
   * every bounce silently dropped.
   */
  it('is accepted under the webhook- prefixed header aliases', () => {
    expect(
      verify({ headers: headersFor(VECTOR_ID, VECTOR_TIMESTAMP, `v1,${VECTOR_SIGNATURE}`, 'webhook') }),
    ).toEqual({ ok: true, deliveryId: VECTOR_ID });
  });

  /**
   * A rotation puts two signatures in the header, space delimited, and only one of them is made
   * with the secret we hold. A verifier that reads the first entry and stops fails every webhook
   * for the length of the rotation.
   */
  it('is accepted when it is one entry among several', () => {
    const others = 'v1,YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=';
    expect(
      verify({ headers: headersFor(VECTOR_ID, VECTOR_TIMESTAMP, `${others} v1,${VECTOR_SIGNATURE}`) }),
    ).toEqual({ ok: true, deliveryId: VECTOR_ID });
  });

  /** Inside the window at both edges, and outside it one second later. */
  it('is accepted anywhere inside the tolerance window', () => {
    const edge = WEBHOOK_TOLERANCE_SECONDS * 1000;
    expect(verify({ nowMs: VECTOR_NOW_MS + edge })).toEqual({ ok: true, deliveryId: VECTOR_ID });
    expect(verify({ nowMs: VECTOR_NOW_MS - edge })).toEqual({ ok: true, deliveryId: VECTOR_ID });
  });
});

describe('a signature that is wrong, missing or stale', () => {
  /**
   * **The raw-body trap, and the reason this file's vector has spaces in it.**
   *
   * Fastify's default parser hands a route the PARSED object, so the obvious implementation
   * re-serializes it to check the signature. That produces different bytes for the same payload -
   * here, every space is gone - and every webhook 401s with a correct secret and a correct
   * signature. Resend states it plainly: "the cryptographic signature is sensitive to even the
   * slightest change".
   */
  it('is refused when the body was re-serialized rather than read raw', () => {
    const reserialized = JSON.stringify(JSON.parse(VECTOR_BODY));

    // The re-serialization really did change the bytes, or this case proves nothing.
    expect(reserialized).not.toBe(VECTOR_BODY);
    expect(verify({ rawBody: reserialized })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('is refused when one byte of the body changed', () => {
    const tampered = VECTOR_BODY.replace('member@test.invalid', 'attacker@test.invalid');
    expect(verify({ rawBody: tampered })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('is refused when the signature was made with a different secret', () => {
    // Same 32 bytes with one character changed, so the failure is the key and nothing else.
    expect(verify({ secret: 'whsec_Y2x1YmNoYXQtd2ViaG9vay12ZWN0b3JzLW9ubHktMzM=' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('is refused when the id or the timestamp was swapped for another delivery', () => {
    expect(
      verify({ headers: headersFor('msg_2SomethingElse', VECTOR_TIMESTAMP, `v1,${VECTOR_SIGNATURE}`) }),
    ).toEqual({ ok: false, reason: 'bad_signature' });

    // A timestamp still inside tolerance, so this is the signature failing rather than the clock.
    expect(
      verify({ headers: headersFor(VECTOR_ID, '1787000001', `v1,${VECTOR_SIGNATURE}`) }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  /**
   * A signature of the wrong LENGTH must be REFUSED, not thrown.
   *
   * `crypto.timingSafeEqual` throws `RangeError` on buffers of different lengths, so the naive
   * constant-time comparison turns a two-character signature into a 500 - which on this route
   * means an unhandled failure captured as an incident, from anybody who can reach the port.
   */
  it('is refused, and does not throw, when the signature is the wrong length', () => {
    expect(verify({ headers: headersFor(VECTOR_ID, VECTOR_TIMESTAMP, 'v1,YWJj') })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('is refused when the version is not v1', () => {
    expect(
      verify({ headers: headersFor(VECTOR_ID, VECTOR_TIMESTAMP, `v2,${VECTOR_SIGNATURE}`) }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  /** A bare signature with no version prefix is not the documented format and is not guessed at. */
  it('is refused when the version prefix is missing entirely', () => {
    expect(
      verify({ headers: headersFor(VECTOR_ID, VECTOR_TIMESTAMP, VECTOR_SIGNATURE) }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('is refused when any of the three headers is absent', () => {
    for (const missing of ['svix-id', 'svix-timestamp', 'svix-signature']) {
      const headers = headersFor(VECTOR_ID, VECTOR_TIMESTAMP, `v1,${VECTOR_SIGNATURE}`);
      delete headers[missing];
      expect(verify({ headers }), missing).toEqual({ ok: false, reason: 'missing_headers' });
    }
  });

  it('is refused when a header is present and empty', () => {
    expect(
      verify({ headers: headersFor(VECTOR_ID, VECTOR_TIMESTAMP, '   ') }),
    ).toEqual({ ok: false, reason: 'missing_headers' });
  });

  /**
   * A duplicated signing header arrives as an array, and there is no right way to pick one of
   * them. Refused rather than guessed at.
   */
  it('is refused when a signing header is sent twice', () => {
    const headers: Record<string, string | string[]> = headersFor(
      VECTOR_ID,
      VECTOR_TIMESTAMP,
      `v1,${VECTOR_SIGNATURE}`,
    );
    headers['svix-signature'] = [`v1,${VECTOR_SIGNATURE}`, 'v1,other'];
    expect(verify({ headers })).toEqual({ ok: false, reason: 'missing_headers' });
  });

  /**
   * The replay window, in both directions. A future timestamp matters as much as a past one: a
   * captured request whose clock is ahead would otherwise be accepted for as long as it takes the
   * receiver's clock to catch up.
   */
  it('is refused when the timestamp is outside the tolerance window', () => {
    const past = VECTOR_NOW_MS + (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000;
    const future = VECTOR_NOW_MS - (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000;

    expect(verify({ nowMs: past })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verify({ nowMs: future })).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('is refused when the timestamp is not a whole number of seconds', () => {
    for (const timestamp of ['not-a-number', '', '17870000.5', '0x1234']) {
      expect(
        verify({ headers: headersFor(VECTOR_ID, timestamp, `v1,${VECTOR_SIGNATURE}`) }),
        timestamp,
      ).toEqual({ ok: false, reason: timestamp === '' ? 'missing_headers' : 'bad_timestamp' });
    }
  });

  /**
   * A secret that cannot be decoded is a configuration fault, and it must be distinguishable from
   * a forged request - otherwise "the secret is wrong" and "somebody is poking at the endpoint"
   * look identical in the log, and the first is silent for as long as it takes to notice that no
   * bounce has ever been recorded.
   */
  it('is refused with its own reason when the configured secret is unusable', () => {
    for (const secret of ['whsec_not base64 at all', 'whsec_', '', 'whsec_c2hvcnQ=']) {
      expect(verify({ secret }), secret).toEqual({ ok: false, reason: 'bad_secret' });
    }
  });
});

describe('decoding a signing secret', () => {
  it('strips the whsec_ prefix and base64 decodes the rest', () => {
    const decoded = decodeWebhookSecret(SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded!.toString('utf8')).toBe('clubchat-webhook-vectors-only-32');
  });

  it('reads the prefixed and unprefixed spellings identically', () => {
    expect(decodeWebhookSecret(SECRET)).toEqual(
      decodeWebhookSecret('Y2x1YmNoYXQtd2ViaG9vay12ZWN0b3JzLW9ubHktMzI='),
    );
  });

  /** A pasted secret carries a trailing newline more often than anybody admits. */
  it('tolerates surrounding whitespace', () => {
    expect(decodeWebhookSecret(`  ${SECRET}\n`)).toEqual(decodeWebhookSecret(SECRET));
  });

  it('refuses anything that is not base64, or that is too short to be a key', () => {
    for (const raw of ['', 'whsec_', 'whsec_***', 'not base64', 'whsec_c2hvcnQ=']) {
      expect(decodeWebhookSecret(raw), raw).toBeNull();
    }
  });
});

describe('reading the payload', () => {
  const RECEIVED = new Date('2026-08-25T11:00:00.000Z');

  it('reads a hard bounce as one event against the address', () => {
    const parsed = parseMailEvent(JSON.parse(VECTOR_BODY), RECEIVED);

    expect(parsed).toEqual({
      ok: true,
      events: [
        {
          kind: 'bounced',
          email: 'member@test.invalid',
          bounceType: 'Permanent',
          detail: 'The recipient mailbox does not exist.',
          providerMessageId: '56761188-7520-42d8-8898-ff6fc54ce618',
          occurredAt: new Date('2026-08-25T10:00:00.000Z'),
        },
      ],
    });
  });

  it('reads a complaint', () => {
    const parsed = parseMailEvent(JSON.parse(COMPLAINT_BODY), RECEIVED);

    expect(parsed).toEqual({
      ok: true,
      events: [
        {
          kind: 'complained',
          email: 'annoyed@test.invalid',
          bounceType: null,
          detail: null,
          providerMessageId: '0a3d1f22-6d5e-4a1e-9b77-8c2f0c1b4d55',
          occurredAt: new Date('2026-08-25T10:05:00.000Z'),
        },
      ],
    });
  });

  it("reads a delivery failure, carrying Resend's reason", () => {
    const parsed = parseMailEvent(JSON.parse(FAILED_BODY), RECEIVED);

    expect(parsed).toEqual({
      ok: true,
      events: [
        expect.objectContaining({
          kind: 'failed',
          email: 'quota@test.invalid',
          detail: 'reached_daily_quota',
        }),
      ],
    });
  });

  /** `data.to` is an array in Resend's own examples, and a broadcast can carry several. */
  it('reads one event per recipient', () => {
    const payload = JSON.parse(VECTOR_BODY) as { data: { to: string[] } };
    payload.data.to = ['one@test.invalid', 'TWO@Test.Invalid', 'one@test.invalid'];

    const parsed = parseMailEvent(payload, RECEIVED);
    expect(parsed.ok).toBe(true);
    // Case folded, because an address is an inbox rather than a string, and de-duplicated so one
    // delivery cannot write the same address twice and break its own idempotency key.
    expect(parsed.ok && parsed.events.map((event) => event.email)).toEqual([
      'one@test.invalid',
      'two@test.invalid',
    ]);
  });

  /**
   * Every other event type is ACKNOWLEDGED and recorded nowhere. Resend retries anything that is
   * not a 2xx for ten hours, so refusing an `email.delivered` would turn a subscription somebody
   * widened in the dashboard into a retry storm.
   */
  it('acknowledges an event type it does not record, without recording it', () => {
    expect(parseMailEvent(JSON.parse(DELIVERED_BODY), RECEIVED)).toEqual({ ok: true, events: [] });
  });

  /** A correctly signed payload this cannot read means Resend changed their schema. */
  it('refuses a payload it cannot read, rather than inventing a row', () => {
    const cases: unknown[] = [
      null,
      'a string',
      42,
      [],
      {},
      { type: 42 },
      { type: 'email.bounced' },
      { type: 'email.bounced', data: null },
      { type: 'email.bounced', data: { to: [] } },
      { type: 'email.bounced', data: { to: [''] } },
      { type: 'email.bounced', data: { to: 'not-an-array-or-an-address' } },
    ];

    for (const payload of cases) {
      expect(parseMailEvent(payload, RECEIVED), JSON.stringify(payload)).toEqual({
        ok: false,
        reason: 'unreadable',
      });
    }
  });

  /**
   * A single string recipient is accepted, because Resend's docs show an array and a shape that
   * narrow is worth being lenient about in the direction that loses nothing.
   */
  it('accepts a single recipient given as a string', () => {
    const payload = JSON.parse(COMPLAINT_BODY) as { data: { to: unknown } };
    payload.data.to = 'solo@test.invalid';

    const parsed = parseMailEvent(payload, RECEIVED);
    expect(parsed.ok && parsed.events.map((event) => event.email)).toEqual(['solo@test.invalid']);
  });

  /**
   * A display name belongs to the header, not to the inbox. Storing `Sam <sam@x>` alongside
   * `sam@x` would put one person in the table under two keys, and neither would find the other.
   */
  it('unwraps a recipient written as a display name and an address', () => {
    const payload = JSON.parse(VECTOR_BODY) as { data: { to: unknown } };
    payload.data.to = ['Sam Member <Sam@Test.Invalid>', 'sam@test.invalid'];

    const parsed = parseMailEvent(payload, RECEIVED);
    expect(parsed.ok && parsed.events.map((event) => event.email)).toEqual(['sam@test.invalid']);
  });

  /** A missing or unreadable `created_at` falls back to when we received it, rather than failing. */
  it('falls back to the receipt time when the envelope carries no usable timestamp', () => {
    const payload = JSON.parse(COMPLAINT_BODY) as { created_at?: unknown };
    payload.created_at = 'not a date';

    const parsed = parseMailEvent(payload, RECEIVED);
    expect(parsed.ok && parsed.events[0]?.occurredAt).toEqual(RECEIVED);
  });
});

/**
 * The boot check, asserted here rather than in `test/config.test.ts`.
 *
 * It belongs with the rest of `loadConfig`'s cases and it is in this file because
 * `config.test.ts` is being edited by another agent in this same working tree, where a collision
 * is silent (AGENTS.md 2.5). Worth moving next to `SENTRY_TRACES_SAMPLE_RATE` once both changes
 * have landed; nothing about the assertion depends on where it lives.
 *
 * What it protects: a truncated or re-wrapped signing secret decodes to different, shorter key
 * material, every webhook then 401s, and that is invisible - it looks exactly like internet noise,
 * and there was never going to be a recorded bounce whose absence somebody would notice. A boot
 * failure naming the field is the honest version of it.
 */
describe('RESEND_WEBHOOK_SECRET', () => {
  /** A complete, minimal environment, copied from `test/config.test.ts`. */
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db.example.com/clubchat',
    REDIS_URL: 'redis://default:p@redis.example.com:6379',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    BETTER_AUTH_URL: 'https://api.clubchatapp.com',
    S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    S3_ACCESS_KEY_ID: 'access-key-id',
    S3_SECRET_ACCESS_KEY: 'secret-access-key',
    S3_BUCKET_PUBLIC: 'clubchat-identity',
    S3_BUCKET_PRIVATE: 'clubchat-content',
    MEDIA_SIGNING_SECRET: 'y'.repeat(32),
    MEDIA_CDN_BASE_URL: 'https://cdn.clubchatapp.com',
  } as unknown as NodeJS.ProcessEnv;

  it('is optional, because development and CI run the whole flow without one', () => {
    expect(loadConfig(base).RESEND_WEBHOOK_SECRET).toBeUndefined();
    // And empty means absent, the way every other optional variable here reads it - `fly secrets
    // set NAME=` and a bare key in `.env.example` both produce exactly this.
    expect(loadConfig({ ...base, RESEND_WEBHOOK_SECRET: '' }).RESEND_WEBHOOK_SECRET).toBeUndefined();
  });

  it('is kept verbatim when it is usable', () => {
    expect(loadConfig({ ...base, RESEND_WEBHOOK_SECRET: SECRET }).RESEND_WEBHOOK_SECRET).toBe(SECRET);
  });

  it('refuses to boot on a secret that cannot be decoded, naming the field', () => {
    for (const value of ['whsec_not base64', 'whsec_c2hvcnQ=', 'whsec_']) {
      expect(() => loadConfig({ ...base, RESEND_WEBHOOK_SECRET: value }), value).toThrow(
        /RESEND_WEBHOOK_SECRET/,
      );
    }
  });

  /** The error must not print the value it refused - it is a credential (non-negotiable 5). */
  it('never puts the rejected secret in the error', () => {
    const value = 'whsec_c2hvcnQ=';
    try {
      loadConfig({ ...base, RESEND_WEBHOOK_SECRET: value });
      throw new Error('expected loadConfig to refuse');
    } catch (error) {
      expect(String(error)).toContain('RESEND_WEBHOOK_SECRET');
      expect(String(error)).not.toContain('c2hvcnQ=');
    }
  });
});
