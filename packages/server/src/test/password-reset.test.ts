/**
 * Forgotten passwords.
 *
 * Email and password is the only way into this product, so before this existed a forgotten
 * password was a lost account - there is no support desk behind it. `PRD/03` rules 13 to 16.
 *
 * Most of what is asserted here is **refusal**, and that is the shape of the feature: the reset
 * endpoint is the one unauthenticated write in the API that reaches a third party's inbox, and
 * almost every way it can go wrong is a way of telling a stranger something about somebody
 * else's account. The happy path is four lines; the rest of this file is the rules around it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../api/app.ts';
import { passwordResetLimitKey } from '../api/rate-limit.ts';
import { createAuth, type Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { assertProductionMailer, LoggingMailer, RecordingMailer } from '../mail.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { allowAll, recordingLimiter } from './fake-limiter.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;
let app: FastifyInstance;
let auth: Auth;
const mailer = new RecordingMailer();

const config = {
  LOG_LEVEL: 'error',
  CLIENT_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_URL: 'http://localhost:3000',
  S3_BUCKET_PUBLIC: 'identity',
  S3_BUCKET_PRIVATE: 'content',
  MEDIA_SIGNING_SECRET: 'test-signing-secret-not-real',
  MEDIA_CDN_BASE_URL: 'http://cdn.invalid/content',
  MEDIA_URL_MODE: 'cdn',
} as unknown as Config;

/**
 * The app's own scheme, which is what the client sends and what `trustedOrigins` lists.
 *
 * Every request below sets it explicitly, because a native client does not send an `Origin` of
 * its own and better-auth refuses a request without one. That is not test scaffolding - it is
 * the same header `session.ts` sends from the phone.
 */
const APP_ORIGIN = 'clubchat://';
const LANDING = 'clubchat://reset-password';

const ORIGINAL_PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-completely-different-one';

function emailFor(name: string): string {
  return `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
}

async function signUp(email: string): Promise<{ userId: string; token: string }> {
  const result = await auth.api.signUpEmail({
    body: { name: 'Reset Subject', email, password: ORIGINAL_PASSWORD },
  });
  const token = (result as { token?: string }).token;
  if (!token) throw new Error('sign-up returned no session token');
  return { userId: result.user.id, token };
}

function post(url: string, payload: unknown, instance: FastifyInstance = app) {
  return instance.inject({
    method: 'POST',
    url,
    headers: { origin: APP_ORIGIN },
    payload: payload as object,
  });
}

function requestReset(email: string, redirectTo: string = LANDING, instance = app) {
  return post('/api/auth/request-password-reset', { email, redirectTo }, instance);
}

/**
 * The token, taken out of the mail we actually sent.
 *
 * Deliberately read from the message rather than from the database: what matters is that the
 * thing a member receives is the thing that works, and a test that read the row directly would
 * pass even if the link in the email were malformed.
 */
function tokenFromLastMailTo(email: string): string {
  const message = mailer.lastTo(email);
  if (!message) throw new Error(`no mail was sent to ${email}`);
  const found = /\/reset-password\/([^?\s]+)/.exec(message.text);
  if (!found?.[1]) throw new Error(`no reset link in the mail to ${email}`);
  return found[1];
}

async function signInWith(email: string, password: string) {
  return post('/api/auth/sign-in/email', { email, password });
}

beforeAll(async () => {
  h = await startTestDb();
  auth = createAuth(h.db, {
    secret: 'test-secret-not-a-real-one',
    baseURL: config.BETTER_AUTH_URL,
    mailer,
  });
  app = buildApp({
    db: h.db,
    auth,
    config,
    mediaStore: new FakeMediaStore(),
    monitor: silentMonitor(),
    limiter: allowAll(),
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await h?.stop().catch(() => undefined);
});

beforeEach(() => {
  mailer.sent.length = 0;
  mailer.failWith = null;
});

describe('asking for a link', () => {
  it('mails one link, to the address on the account, carrying a token that works', async () => {
    const email = emailFor('Happy');
    await signUp(email);

    const asked = await requestReset(email);
    expect(asked.statusCode).toBe(200);

    expect(mailer.sent).toHaveLength(1);
    const message = mailer.sent[0]!;
    expect(message.to).toBe(email);
    expect(message.subject).toContain('password');

    const reset = await post('/api/auth/reset-password', {
      token: tokenFromLastMailTo(email),
      newPassword: NEW_PASSWORD,
    });
    expect(reset.statusCode).toBe(200);

    // The real proof is not the 200 above - it is that the two passwords have swapped places.
    expect((await signInWith(email, NEW_PASSWORD)).statusCode).toBe(200);
    expect((await signInWith(email, ORIGINAL_PASSWORD)).statusCode).toBe(401);
  });

  it('answers an unregistered address exactly as it answers a registered one', async () => {
    // PRD/03 rule 14. A different status, a different body, or a different message here turns
    // this endpoint into a test for whether somebody has an account, which clubs full of minors
    // must not hand to a stranger who knows an email address.
    const real = emailFor('Known');
    await signUp(real);

    const known = await requestReset(real);
    const unknown = await requestReset(emailFor('NeverSignedUp'));

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);

    // Identical answer, and only one of them actually sent anything.
    expect(mailer.sent.map((message) => message.to)).toEqual([real]);
  });

  it('sends nothing for a deleted account, because deletion released the address', async () => {
    // No rule was needed for this and none was written: `deleteAccount` rewrites the email to a
    // dead unique one so the person can sign up again with their own (PRD/03 rule 11), which
    // leaves nothing for a lookup on the original address to find. Asserted because it is a
    // property of one function that another function silently depends on.
    const email = emailFor('Departed');
    const { userId } = await signUp(email);
    await h.db.execute(sql`
      UPDATE users
         SET anonymized_at = now(),
             signin_blocked_at = now(),
             email = 'deleted+' || id::text || '@deleted.invalid'
       WHERE id = ${userId}
    `);

    expect((await requestReset(email)).statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(0);
  });

  it('still answers 200 when the mail transport is broken', async () => {
    // better-auth awaits `sendResetPassword` and swallows what it throws, which is the right
    // outcome for the requester - rule 14 gives them the same sentence either way - and means a
    // dead provider is invisible unless the call site logs it. Pinned so the swallowing is a
    // decision somebody made rather than one somebody discovers.
    const email = emailFor('Undeliverable');
    await signUp(email);
    mailer.failWith = new Error('provider is down');

    expect((await requestReset(email)).statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('the link itself', () => {
  it('works once', async () => {
    const email = emailFor('Reuse');
    await signUp(email);
    await requestReset(email);
    const token = tokenFromLastMailTo(email);

    expect((await post('/api/auth/reset-password', { token, newPassword: NEW_PASSWORD })).statusCode)
      .toBe(200);

    // A forwarded email, a shared screenshot, or a mailbox somebody else now reads.
    const second = await post('/api/auth/reset-password', {
      token,
      newPassword: 'third-password-entirely',
    });
    expect(second.statusCode).toBe(400);
    expect((await signInWith(email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('stops working after an hour', async () => {
    const email = emailFor('Expired');
    await signUp(email);
    await requestReset(email);
    const token = tokenFromLastMailTo(email);

    // Aged in place rather than waiting an hour. The row is better-auth's, and reaching into it
    // is the price of asserting a TTL at all - the alternative is trusting a config value.
    await h.db.execute(sql`
      UPDATE verifications
         SET expires_at = now() - interval '1 minute'
       WHERE identifier = ${`reset-password:${token}`}
    `);

    const late = await post('/api/auth/reset-password', { token, newPassword: NEW_PASSWORD });
    expect(late.statusCode).toBe(400);
    expect((await signInWith(email, ORIGINAL_PASSWORD)).statusCode).toBe(200);
  });

  it('refuses a token that was never issued, in the same shape as an expired one', async () => {
    const forged = await post('/api/auth/reset-password', {
      token: 'not-a-token-anybody-ever-minted',
      newPassword: NEW_PASSWORD,
    });
    expect(forged.statusCode).toBe(400);
  });

  it('hands the token to the app through a redirect, not to a browser', async () => {
    // The emailed link is HTTPS at our API, which validates the token and then bounces to the
    // app's own scheme. Mailing `clubchat://` directly would be simpler and frequently
    // unclickable: mail clients often decline to linkify a custom scheme.
    const email = emailFor('Redirect');
    await signUp(email);
    await requestReset(email);
    const token = tokenFromLastMailTo(email);

    const hop = await app.inject({
      method: 'GET',
      url: `/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(LANDING)}`,
      headers: { origin: APP_ORIGIN },
    });

    expect(hop.statusCode).toBe(302);
    const location = hop.headers['location'] as string;
    expect(location.startsWith(LANDING)).toBe(true);
    expect(new URL(location).searchParams.get('token')).toBe(token);
  });
});

describe('where the link is allowed to land', () => {
  it('refuses a redirect to an origin the server does not trust', async () => {
    // The open-redirect check, and the reason `disableOriginCheck: false` is set explicitly in
    // `auth.ts`: better-auth turns this off by itself whenever NODE_ENV=test, which would make
    // this exactly the assertion that cannot fail.
    const email = emailFor('Phished');
    await signUp(email);

    const refused = await requestReset(email, 'https://clubch4t.example/collect');
    expect(refused.statusCode).toBe(403);
    expect(mailer.sent).toHaveLength(0);
  });

  it('accepts the app scheme, which is what a real client sends', async () => {
    const email = emailFor('Trusted');
    await signUp(email);

    expect((await requestReset(email, LANDING)).statusCode).toBe(200);
    expect(tokenFromLastMailTo(email)).toBeTruthy();
  });
});

describe('signing out everywhere', () => {
  it('revokes the sessions that existed before the reset', async () => {
    // PRD/03 rule 15, and the reason the feature exists rather than a hardening extra: somebody
    // resets a password BECAUSE they think another person has it. A session left alive is that
    // person, still signed in.
    const email = emailFor('Compromised');
    const { token: sessionToken } = await signUp(email);

    const before = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(before.statusCode).toBe(200);

    await requestReset(email);
    await post('/api/auth/reset-password', {
      token: tokenFromLastMailTo(email),
      newPassword: NEW_PASSWORD,
    });

    const after = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('how often one address can be asked about', () => {
  it('charges a second bucket, keyed on the address rather than the caller', async () => {
    const limiter = recordingLimiter();
    const limited = buildApp({
      db: h.db,
      auth,
      config,
      mediaStore: new FakeMediaStore(),
      monitor: silentMonitor(),
      limiter,
    });
    await limited.ready();

    const email = emailFor('Flooded');
    await signUp(email);
    await requestReset(email, LANDING, limited);

    // Both limits, in order: the caller's, then the address's. The first protects us from the
    // sender; the second protects whoever owns the address from the sender.
    expect(limiter.keys.some((key) => key.startsWith('rate:http:auth:'))).toBe(true);
    expect(limiter.keys).toContain(passwordResetLimitKey(email));

    // The address never appears in the key. Redis is not where identity lives, and a
    // `KEYS rate:http:reset:*` should not enumerate everyone who ever forgot a password.
    expect(limiter.keys.some((key) => key.includes(email))).toBe(false);

    await limited.close();
  });

  it('treats a differently-cased address as the same inbox', () => {
    // Without the fold the limit is one Shift key away from doing nothing.
    expect(passwordResetLimitKey('Ada@Example.com')).toBe(passwordResetLimitKey('ada@example.com'));
    expect(passwordResetLimitKey(' ada@example.com ')).toBe(
      passwordResetLimitKey('ada@example.com'),
    );
    expect(passwordResetLimitKey('ada@example.com')).not.toBe(
      passwordResetLimitKey('bob@example.com'),
    );
  });

  it('leaves the rest of the auth endpoints on the caller bucket alone', async () => {
    const limiter = recordingLimiter();
    const limited = buildApp({
      db: h.db,
      auth,
      config,
      mediaStore: new FakeMediaStore(),
      monitor: silentMonitor(),
      limiter,
    });
    await limited.ready();

    await post('/api/auth/sign-in/email', { email: 'nobody@test.invalid', password: 'wrong' }, limited);

    expect(limiter.keys.every((key) => !key.startsWith('rate:http:reset:'))).toBe(true);
    await limited.close();
  });
});

describe('the transport', () => {
  it('refuses to start in production without one', () => {
    // ADR-0019 calls this the load-bearing half of deferring the provider. Booting production on
    // the logging transport would tell members to check an inbox that receives nothing, while the
    // working link sat in a log stream.
    const logging = new LoggingMailer({ info: () => undefined });

    expect(() => assertProductionMailer(logging, 'production')).toThrow(/refusing to start/);
    expect(() => assertProductionMailer(logging, 'development')).not.toThrow();
    expect(() => assertProductionMailer(logging, undefined)).not.toThrow();
    expect(() => assertProductionMailer(new RecordingMailer(), 'production')).not.toThrow();
  });
});
