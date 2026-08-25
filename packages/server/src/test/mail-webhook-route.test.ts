/**
 * `POST /webhooks/resend`, through the real HTTP stack and against a real Postgres.
 *
 * `mail-webhook.test.ts` pins the cryptography and the payload reader as pure functions. What it
 * cannot tell you is any of the things that actually go wrong when a verifier is wired into a
 * server, and every one of them is silent:
 *
 *  1. **The raw body.** Fastify's default parser hands a route the PARSED object, and
 *     re-serializing it produces different bytes for the same payload. A route built on that 401s
 *     every genuine delivery, with the correct secret, and reads as a wrong one. The vectors here
 *     are pretty-printed on purpose so a re-serializing route cannot pass.
 *  2. **Placement.** A route "tidied" into `protectedRoutes` answers 401 to Resend forever. The
 *     control assertion is `/me` refusing in the same app.
 *  3. **Idempotency.** Resend documents at-least-once delivery with retries at 5s, 5m, 30m, 2h,
 *     5h and 10h, so a redelivery is the normal case rather than an edge one.
 *  4. **The alarm.** Recording a bounce nobody is told about is the original defect with a table
 *     added to it.
 *
 * **The clock is frozen at the vectors' own timestamp**, so every signature below is an `openssl`
 * literal rather than something this suite computed - the rule `packages/cdn-worker/test/harness.ts`
 * records, because 52 media tests once stayed green through two mutations by signing and verifying
 * through one implementation. Only `Date` is faked, for the reason that harness gives: faking
 * `setTimeout` under real async I/O hangs in a way that looks like a slow test.
 *
 * The vectors were produced by the pipeline documented in `src/mail-webhook.test.ts` and share no
 * code with anything under test. `SECRET`'s key material is the ASCII string
 * `clubchat-webhook-vectors-only-32`, printed here in full: it is a documentation value, not a
 * credential.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { mailEvents } from '../db/schema.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import type { KeyedRateLimiter } from '../bus/redis.ts';
import { FakeMediaStore } from '../media/store.ts';
import type { Monitor } from '../monitoring.ts';
import { allowAll, allowFirst } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';

const SECRET = 'whsec_Y2x1YmNoYXQtd2ViaG9vay12ZWN0b3JzLW9ubHktMzI=';

/**
 * The clock every test starts from.
 *
 * Each delivery then moves it to its OWN timestamp before injecting, so a vector is inside the
 * tolerance window by construction rather than by the vectors happening to have been generated
 * close together - which they were not, and which cost a debugging pass. A test about the window
 * itself passes `at` explicitly.
 */
const FROZEN_NOW_MS = 1_787_000_300_000;

type Vector = { id: string; timestamp: string; body: string; signature: string };

const HARD_BOUNCE: Vector = {
  id: 'msg_2VectorsOnlyNotReal',
  timestamp: '1787000000',
  body: '{ "type": "email.bounced", "created_at": "2026-08-25T10:00:00.000Z", "data": { "email_id": "56761188-7520-42d8-8898-ff6fc54ce618", "to": ["member@test.invalid"], "bounce": { "type": "Permanent", "subType": "General", "message": "The recipient mailbox does not exist." } } }',
  signature: '1PGkHGGsVvJkCRF+oEWmLSnb34se4LcJAzWVzYiBHVc=',
};

const COMPLAINT: Vector = {
  id: 'msg_2ComplaintVectorOnly',
  timestamp: '1787000300',
  body: '{ "type": "email.complained", "created_at": "2026-08-25T10:05:00.000Z", "data": { "email_id": "0a3d1f22-6d5e-4a1e-9b77-8c2f0c1b4d55", "to": ["annoyed@test.invalid"] } }',
  signature: 'r9GQ1QfT5xIkcho1+E03fHKXJSMbU8eidJ9/lcJnDVw=',
};

const SEND_FAILED: Vector = {
  id: 'msg_2FailedVectorOnly',
  timestamp: '1787000360',
  body: '{ "type": "email.failed", "created_at": "2026-08-25T10:06:00.000Z", "data": { "email_id": "9c9a2b31-1111-4c22-9333-4d5566778899", "to": ["quota@test.invalid"], "failed": { "reason": "reached_daily_quota" } } }',
  signature: 'moNDOvVbtRdBmK9mslMS/w1MxaEbYLY62aW3ULYP8fY=',
};

const DELIVERED: Vector = {
  id: 'msg_2DeliveredVectorOnly',
  timestamp: '1787000420',
  body: '{ "type": "email.delivered", "created_at": "2026-08-25T10:07:00.000Z", "data": { "email_id": "1111aaaa-2222-4bbb-8ccc-3333dddd4444", "to": ["fine@test.invalid"] } }',
  signature: '+y6y3TsxGCkAW/64uOPpfzWjC4TqXqSLAYD0RtWOPS8=',
};

/** A soft bounce: a full mailbox, which clears on its own and is not an incident. */
const SOFT_BOUNCE: Vector = {
  id: 'msg_2TransientVectorOnly',
  timestamp: '1787000480',
  body: '{ "type": "email.bounced", "created_at": "2026-08-25T10:08:00.000Z", "data": { "email_id": "22223333-4444-4555-8666-777788889999", "to": ["full-inbox@test.invalid"], "bounce": { "type": "Transient", "subType": "MailboxFull", "message": "The recipient mailbox is full." } } }',
  signature: '11cM3tqD+uYB7utQgmBNC6bM9cfVK8MO1BWHSJmL1k8=',
};

/** Valid JSON, correctly signed, and missing the one field that makes a bounce mean anything. */
const UNREADABLE: Vector = {
  id: 'msg_2UnreadableVectorOnly',
  timestamp: '1787000540',
  body: '{ "type": "email.bounced", "created_at": "2026-08-25T10:09:00.000Z", "data": { "email_id": "33334444-5555-4666-8777-88889999aaaa" } }',
  signature: 'W2AC8aX/3P0iq96lIp87RgP8rvmlsUOZjDO8xyvdgEg=',
};

/** Not JSON at all, and correctly signed. `JSON.parse` throws on this one. */
const TRUNCATED: Vector = {
  id: 'msg_2MalformedVectorOnly',
  timestamp: '1787000480',
  body: '{ "type": "email.bounced", "data": ',
  signature: 'ZXaucgGhpbtfb68Vk9w26CW1a67xkgz4qXgwiwAkia8=',
};

/** One delivery naming two people, which is why the idempotency key is a pair. */
const TWO_RECIPIENTS: Vector = {
  id: 'msg_2MultiVectorOnly',
  timestamp: '1787000600',
  body: '{ "type": "email.bounced", "created_at": "2026-08-25T10:10:00.000Z", "data": { "email_id": "44445555-6666-4777-8888-9999aaaabbbb", "to": ["first@test.invalid", "second@test.invalid"], "bounce": { "type": "Permanent", "subType": "General", "message": "No such user." } } }',
  signature: 'c01lcqTu3cifVvgbU1prVD/tDj1796puyMldSx3A2Gk=',
};

let h: TestDb;
let auth: Auth;

const baseConfig = {
  LOG_LEVEL: 'silent',
  CLIENT_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_URL: 'http://localhost:3000',
  S3_BUCKET_PUBLIC: 'identity',
  S3_BUCKET_PRIVATE: 'content',
  MEDIA_SIGNING_SECRET: 'test-signing-secret-not-real',
  MEDIA_CDN_BASE_URL: 'http://cdn.invalid/content',
  MEDIA_URL_MODE: 'cdn',
  RESEND_WEBHOOK_SECRET: SECRET,
} as unknown as Config;

type Captured = { where: string; context: Record<string, unknown> | undefined };

/** A monitor that records rather than sends, so the alarm itself can be asserted. */
function spyMonitor(): { captured: Captured[]; monitor: Monitor } {
  const captured: Captured[] = [];
  return {
    captured,
    monitor: {
      capture(_error, where, context) {
        captured.push({ where, context });
      },
      async flush() {},
    },
  };
}

function appWith(
  overrides: Partial<Config> = {},
  options: { monitor?: Monitor; limiter?: KeyedRateLimiter } = {},
): FastifyInstance {
  return buildApp({
    db: h.db,
    auth,
    config: { ...baseConfig, ...overrides },
    mediaStore: new FakeMediaStore(),
    monitor: options.monitor ?? spyMonitor().monitor,
    limiter: options.limiter ?? allowAll(),
  });
}

/** The three signing headers, in whichever spelling the caller wants. */
function signedHeaders(
  vector: Vector,
  overrides: Partial<Record<'id' | 'timestamp' | 'signature', string | undefined>> = {},
  prefix: 'svix' | 'webhook' = 'svix',
): Record<string, string> {
  const values = {
    id: vector.id,
    timestamp: vector.timestamp,
    signature: `v1,${vector.signature}`,
    ...overrides,
  };

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) headers[`${prefix}-${name}`] = value;
  }
  return headers;
}

/**
 * One delivery, injected exactly as Resend would send it.
 *
 * `payload` rather than Fastify's `body` option, because `body` would serialize an object and the
 * bytes are the whole point. A string payload is written to the socket unchanged.
 */
async function deliver(
  app: FastifyInstance,
  vector: Vector,
  headers: Record<string, string> = signedHeaders(vector),
  options: { at?: number } = {},
) {
  // The receiver's clock, which is what the tolerance window is measured against.
  vi.setSystemTime(options.at ?? Number(vector.timestamp) * 1000);

  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/resend',
    headers,
    payload: vector.body,
  });
  return { status: response.statusCode, headers: response.headers, body: response.body };
}

/**
 * Every row, read through the schema rather than through raw SQL.
 *
 * `db.execute` returns the driver's own strings - `occurred_at` arrives as
 * `'2026-08-25 10:00:00+00'` rather than as a `Date` - so a raw read would assert on the pg
 * driver's formatting instead of on what the application stores. Going through the table also
 * means a column renamed in `schema.ts` and not in the migration fails here.
 */
async function rows() {
  return h.db
    .select({
      providerEventId: mailEvents.providerEventId,
      kind: mailEvents.kind,
      email: mailEvents.email,
      bounceType: mailEvents.bounceType,
      detail: mailEvents.detail,
      providerMessageId: mailEvents.providerMessageId,
      occurredAt: mailEvents.occurredAt,
    })
    .from(mailEvents)
    .orderBy(mailEvents.occurredAt, mailEvents.email);
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: baseConfig.BETTER_AUTH_URL,
  });
}, 120_000);

afterAll(async () => {
  await h?.stop().catch(() => undefined);
});

beforeEach(async () => {
  // Only `Date`. See the file docblock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN_NOW_MS);
  await h.db.execute(sql`delete from mail_events`);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a delivery Resend really signed', () => {
  /**
   * The one that matters, and the one a re-serializing route cannot pass: these bytes carry
   * spaces, and `JSON.stringify(JSON.parse(body))` of them does not.
   */
  it('is accepted, and records the bounce against the address', async () => {
    const app = appWith();
    await app.ready();

    const response = await deliver(app, HARD_BOUNCE);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, recorded: 1 });

    expect(await rows()).toEqual([
      {
        providerEventId: 'msg_2VectorsOnlyNotReal',
        kind: 'bounced',
        email: 'member@test.invalid',
        bounceType: 'Permanent',
        detail: 'The recipient mailbox does not exist.',
        providerMessageId: '56761188-7520-42d8-8898-ff6fc54ce618',
        occurredAt: new Date('2026-08-25T10:00:00.000Z'),
      },
    ]);

    await app.close();
  });

  /**
   * Placement. Resend holds no session and never will, so the route must answer somebody who holds
   * nothing at all - and the control in the same app is what makes that sharp rather than
   * incidental: `/me` refuses through the same absent session, so a route moved into
   * `protectedRoutes` could not answer 200 here by accident.
   */
  it('is answered for a caller with no session, in an app where /me refuses', async () => {
    const app = appWith();
    await app.ready();

    expect((await deliver(app, HARD_BOUNCE)).status).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);

    await app.close();
  });

  /** Svix documents `webhook-` prefixed aliases; refusing one we do receive is every bounce lost. */
  it('is accepted under the webhook- prefixed header aliases', async () => {
    const app = appWith();
    await app.ready();

    const response = await deliver(app, HARD_BOUNCE, signedHeaders(HARD_BOUNCE, {}, 'webhook'));
    expect(response.status).toBe(200);
    expect(await rows()).toHaveLength(1);

    await app.close();
  });

  /** A charset on the content type is ordinary and must not fall through to a different parser. */
  it('is accepted when the content type carries a charset', async () => {
    const app = appWith();
    await app.ready();

    const headers = signedHeaders(HARD_BOUNCE);
    headers['content-type'] = 'application/json; charset=utf-8';

    expect((await deliver(app, HARD_BOUNCE, headers)).status).toBe(200);
    expect(await rows()).toHaveLength(1);

    await app.close();
  });

  it('records one row per recipient of a single delivery', async () => {
    const app = appWith();
    await app.ready();

    const response = await deliver(app, TWO_RECIPIENTS);
    expect(JSON.parse(response.body)).toEqual({ ok: true, recorded: 2 });
    expect((await rows()).map((row) => row.email)).toEqual([
      'first@test.invalid',
      'second@test.invalid',
    ]);

    await app.close();
  });

  /**
   * Resend retries anything that is not a 2xx for ten hours. A subscription somebody widens in the
   * dashboard must therefore be acknowledged rather than refused, and still write nothing.
   */
  it('acknowledges an event type it does not record, and writes nothing', async () => {
    const app = appWith();
    await app.ready();

    const response = await deliver(app, DELIVERED);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, recorded: 0 });
    expect(await rows()).toEqual([]);

    await app.close();
  });
});

describe('the same delivery arriving twice', () => {
  /**
   * The redelivery is the NORMAL case, not an edge one: a slow acknowledgement of ours is enough
   * to cause it, and Resend's own guidance is to key on `svix-id`.
   */
  it('is recorded once, and says so', async () => {
    const app = appWith();
    await app.ready();

    const first = await deliver(app, HARD_BOUNCE);
    const second = await deliver(app, HARD_BOUNCE);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ ok: true, recorded: 1 });
    // 200 rather than a conflict: Resend must stop retrying, and it did nothing wrong.
    expect(JSON.parse(second.body)).toEqual({ ok: true, recorded: 0 });
    expect(await rows()).toHaveLength(1);

    await app.close();
  });

  /**
   * And the alarm is raised ONCE. Without this the retry schedule turns one hard bounce into six
   * copies of the same incident, which is how an alert channel becomes something people mute.
   */
  it('raises the alarm only for the delivery that was new', async () => {
    const spy = spyMonitor();
    const app = appWith({}, { monitor: spy.monitor });
    await app.ready();

    await deliver(app, HARD_BOUNCE);
    await deliver(app, HARD_BOUNCE);
    await deliver(app, HARD_BOUNCE);

    expect(spy.captured.map((entry) => entry.where)).toEqual(['api.mail.bounced']);

    await app.close();
  });
});

describe('making somebody find out', () => {
  it('reports a hard bounce, naming the address and the bounce type', async () => {
    const spy = spyMonitor();
    const app = appWith({}, { monitor: spy.monitor });
    await app.ready();

    await deliver(app, HARD_BOUNCE);

    expect(spy.captured).toHaveLength(1);
    expect(spy.captured[0]?.where).toBe('api.mail.bounced');
    expect(spy.captured[0]?.context).toMatchObject({
      email: 'member@test.invalid',
      bounceType: 'Permanent',
      detail: 'The recipient mailbox does not exist.',
      providerMessageId: '56761188-7520-42d8-8898-ff6fc54ce618',
    });

    await app.close();
  });

  it('reports a complaint', async () => {
    const spy = spyMonitor();
    const app = appWith({}, { monitor: spy.monitor });
    await app.ready();

    await deliver(app, COMPLAINT);

    expect(spy.captured.map((entry) => entry.where)).toEqual(['api.mail.complained']);
    expect(spy.captured[0]?.context).toMatchObject({ email: 'annoyed@test.invalid' });

    await app.close();
  });

  it('reports a send that never left', async () => {
    const spy = spyMonitor();
    const app = appWith({}, { monitor: spy.monitor });
    await app.ready();

    await deliver(app, SEND_FAILED);

    expect(spy.captured.map((entry) => entry.where)).toEqual(['api.mail.failed']);
    expect(spy.captured[0]?.context).toMatchObject({ detail: 'reached_daily_quota' });

    await app.close();
  });

  /**
   * A full mailbox clears on its own. Reporting it would bury the hard bounces, which is the same
   * argument `monitoring.ts` makes for keeping `/health` out of the traces.
   */
  it('records a soft bounce and reports nobody', async () => {
    const spy = spyMonitor();
    const app = appWith({}, { monitor: spy.monitor });
    await app.ready();

    expect((await deliver(app, SOFT_BOUNCE)).status).toBe(200);

    expect((await rows()).map((row) => row.bounceType)).toEqual(['Transient']);
    expect(spy.captured).toEqual([]);

    await app.close();
  });
});

describe('a delivery that is not from Resend', () => {
  /** The whole security of the endpoint, so this is the assertion the rest of the file supports. */
  it('is refused when the signature does not match, and writes nothing', async () => {
    const spy = spyMonitor();
    const app = appWith({}, { monitor: spy.monitor });
    await app.ready();

    const forged = {
      ...HARD_BOUNCE,
      body: HARD_BOUNCE.body.replace('member@test.invalid', 'attacker@test.invalid'),
    };
    const response = await deliver(app, forged, signedHeaders(HARD_BOUNCE));

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'bad_signature' });
    expect(await rows()).toEqual([]);

    /*
     * Not captured, deliberately. Anybody who can reach the port can produce this, so capturing it
     * would hand a stranger a way to fill the error tracker - and the one cause that really is
     * ours, an unusable secret, is a boot failure in `config.ts` instead.
     */
    expect(spy.captured).toEqual([]);

    await app.close();
  });

  it('is refused when the signature was made with a different secret', async () => {
    const app = appWith({ RESEND_WEBHOOK_SECRET: 'whsec_Y2x1YmNoYXQtd2ViaG9vay12ZWN0b3JzLW9ubHktMzM=' });
    await app.ready();

    expect((await deliver(app, HARD_BOUNCE)).status).toBe(401);
    expect(await rows()).toEqual([]);

    await app.close();
  });

  it('is refused when any signing header is missing entirely', async () => {
    const app = appWith();
    await app.ready();

    for (const missing of ['id', 'timestamp', 'signature'] as const) {
      const response = await deliver(
        app,
        HARD_BOUNCE,
        signedHeaders(HARD_BOUNCE, { [missing]: undefined }),
      );
      expect(response.status, missing).toBe(401);
    }

    // And with no signing headers at all, which is what a curl at the URL looks like.
    const bare = await deliver(app, HARD_BOUNCE, { 'content-type': 'application/json' });
    expect(bare.status).toBe(401);
    expect(await rows()).toEqual([]);

    await app.close();
  });

  /**
   * The replay window. The vector's timestamp is real and its signature is valid; only the clock
   * has moved, which is exactly the shape of a captured request replayed later.
   */
  it('is refused when the timestamp is outside the tolerance window', async () => {
    const app = appWith();
    await app.ready();

    const tenMinutesLate = Number(HARD_BOUNCE.timestamp) * 1000 + 10 * 60 * 1000;

    expect((await deliver(app, HARD_BOUNCE, signedHeaders(HARD_BOUNCE), { at: tenMinutesLate }))
      .status).toBe(401);
    expect(await rows()).toEqual([]);

    await app.close();
  });

  /**
   * A short signature must be REFUSED rather than thrown. `crypto.timingSafeEqual` raises on
   * buffers of different lengths, so the naive comparison turns two characters from a stranger
   * into a 500 captured as an incident.
   */
  it('is refused, not crashed, by a signature of the wrong length', async () => {
    const spy = spyMonitor();
    const app = appWith({}, { monitor: spy.monitor });
    await app.ready();

    const response = await deliver(
      app,
      HARD_BOUNCE,
      signedHeaders(HARD_BOUNCE, { signature: 'v1,YWJj' }),
    );

    expect(response.status).toBe(401);
    expect(spy.captured).toEqual([]);

    await app.close();
  });
});

describe('a verified delivery this code cannot read', () => {
  /**
   * The process must not fall over, and somebody must be told. A payload we cannot read carrying a
   * signature made with OUR secret means Resend changed their schema - which is otherwise
   * completely silent: the deliveries keep arriving and the table keeps not growing.
   */
  it('answers 400 without crashing, and is reported', async () => {
    const spy = spyMonitor();
    const app = appWith({}, { monitor: spy.monitor });
    await app.ready();

    const response = await deliver(app, UNREADABLE);

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'unreadable' });
    expect(await rows()).toEqual([]);
    expect(spy.captured.map((entry) => entry.where)).toEqual(['api.mail.webhook']);

    // The payload itself is never attached: it carries member addresses, and Resend's own
    // dashboard holds the body already.
    expect(JSON.stringify(spy.captured[0]?.context)).not.toContain('email_id');

    await app.close();
  });

  /** Body bytes that are not JSON at all. `JSON.parse` throws, and the route absorbs it. */
  it('answers 400 for a body that is not JSON, and the app keeps serving', async () => {
    const app = appWith();
    await app.ready();

    expect((await deliver(app, TRUNCATED)).status).toBe(400);

    // Still alive and still correct, which is the half of "does not crash the process" that a
    // status code alone does not prove.
    expect((await deliver(app, HARD_BOUNCE)).status).toBe(200);
    expect(await rows()).toHaveLength(1);

    await app.close();
  });
});

describe('the route as an operational surface', () => {
  /**
   * A 429 is safe here in a way it is nowhere else - Resend retries on its own schedule, so the
   * event is delayed rather than lost - but it must still carry `Retry-After` and consume nothing.
   */
  it('refuses with 429 and a Retry-After once its bucket is empty', async () => {
    const app = appWith({}, { limiter: allowFirst(0) });
    await app.ready();

    const response = await deliver(app, HARD_BOUNCE);

    expect(response.status).toBe(429);
    expect(JSON.parse(response.body)).toEqual({ error: 'rate_limited' });
    expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(await rows()).toEqual([]);

    await app.close();
  });

  /**
   * The bucket is spent only by a caller who already proved they are Resend. Keyed ahead of the
   * signature check, a stranger could empty it with unsigned junk and every genuine delivery would
   * be refused until Resend gave up ten hours later.
   */
  it('spends no allowance on a request that failed verification', async () => {
    // Exactly one consumption available: the forged delivery below must not be the one to take it.
    const app = appWith({}, { limiter: allowFirst(1) });
    await app.ready();

    const forged = await deliver(
      app,
      HARD_BOUNCE,
      signedHeaders(HARD_BOUNCE, { signature: 'v1,YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=' }),
    );
    expect(forged.status).toBe(401);

    expect((await deliver(app, HARD_BOUNCE)).status).toBe(200);

    await app.close();
  });

  /**
   * With no secret configured this route cannot tell Resend from anybody else, so it accepts
   * nothing - and says so once, because it cannot recover on its own and reporting it per delivery
   * would be the same message forever.
   */
  it('refuses with 503 when no signing secret is configured, and reports itself once', async () => {
    const spy = spyMonitor();
    const app = appWith({ RESEND_WEBHOOK_SECRET: undefined }, { monitor: spy.monitor });
    await app.ready();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await deliver(app, HARD_BOUNCE);
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: 'not_configured' });
    }

    expect(await rows()).toEqual([]);
    expect(spy.captured).toHaveLength(1);
    expect(spy.captured[0]).toMatchObject({
      where: 'api.mail.webhook',
      context: { reason: 'not_configured' },
    });

    await app.close();
  });

  /** A webhook is a POST. Anything else is a wrong door rather than a refusal to authenticate. */
  it('does not answer a GET', async () => {
    const app = appWith();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/webhooks/resend' });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  /**
   * The body ceiling. The signature check is an HMAC over the whole body, so an unbounded body is
   * unbounded work for a caller who has proved nothing.
   */
  it('refuses a body far larger than any webhook Resend sends', async () => {
    const app = appWith();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/resend',
      headers: signedHeaders(HARD_BOUNCE),
      payload: `{"padding":"${'x'.repeat(200_000)}"}`,
    });

    expect(response.statusCode).toBe(413);
    expect(await rows()).toEqual([]);

    await app.close();
  });

  /**
   * The parser this route brings is encapsulated, so nothing else in the API may have changed
   * shape. `/api/auth/*` reads `request.body.email` to charge the per-address reset bucket, and it
   * would read `undefined` off a raw string.
   */
  it('leaves the rest of the API parsing JSON into objects', async () => {
    const app = appWith();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'nobody@test.invalid', password: 'wrong-password-entirely' }),
    });

    // Whatever better-auth answers, it is not a parser failure: a route handed a raw string where
    // it expected an object answers 400 or 500 with a serialization complaint.
    expect([401, 403, 404]).toContain(response.statusCode);

    await app.close();
  });
});
