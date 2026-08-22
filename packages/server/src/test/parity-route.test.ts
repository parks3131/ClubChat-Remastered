/**
 * `GET /__parity`, and the fact that an operator can read it holding nothing at all.
 *
 * The single likeliest failure in this deployment is the api and the CDN Worker holding different
 * `MEDIA_SIGNING_SECRET` values. It presents as every photo 403ing with both processes healthy and
 * both logs saying what they should, a trailing newline picked up by `wrangler secret put` is
 * enough to cause it, and it reads as a broken Worker rather than as a wrong password. Both sides
 * publish eight characters of an HMAC over one constant, so the whole class is eliminated by a
 * `diff` of two `curl`s instead of by an evening.
 *
 * What this file asserts is therefore mostly REACHABILITY and shape rather than cryptography:
 * `packages/shared` and `media-signing-vectors.test.ts` already pin `parityFingerprint` itself
 * against literal openssl values. The questions here are whether the route answers somebody with
 * no session, whether the limiter can silence it, whether two hosts holding one secret really do
 * answer identically, and whether the body says exactly three things and nothing else.
 *
 * **Nothing here derives an expected value through the module under test.** They come from the
 * literal openssl vectors and from an independent `node:crypto` HMAC, for the reason
 * `media-signing-vectors.json` records: an assertion that signs and checks through one
 * implementation passes on self-consistent nonsense, which is exactly how two mutations survived
 * 52 green media tests. A server-side test may reach for `node:crypto`; `packages/shared` may not,
 * which is why the independent derivation lives on this side of the line.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import vectors from '@clubchat/shared/media-signing-vectors.json' with { type: 'json' };
import { buildApp } from '../api/app.ts';
import type { Auth } from '../auth.ts';
import type { KeyedRateLimiter } from '../bus/redis.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { FakeMediaStore } from '../media/store.ts';
import { silentMonitor } from '../monitoring.ts';
import { allowAll, allowFirst } from './fake-limiter.ts';

/**
 * The one openssl-generated pair this file pins, copied from `media-signing-vectors.json` rather
 * than read out of it, so that the expected fingerprint is a literal sitting next to the assertion
 * that uses it. The tie back to the shared vectors is asserted below, so the copy cannot drift.
 */
const VECTOR_SECRET = 'vectors-only-never-a-real-secret';
const VECTOR_FINGERPRINT = 'JObr1MmT';

/** The published prefix length. Eight, and the number is the contract rather than a formatting choice. */
const FINGERPRINT_LENGTH = 8;

const baseConfig = {
  LOG_LEVEL: 'silent',
  CLIENT_ORIGIN: 'http://localhost:8081',
  BETTER_AUTH_URL: 'http://localhost:3000',
  S3_BUCKET_PUBLIC: 'identity',
  S3_BUCKET_PRIVATE: 'content',
  MEDIA_SIGNING_SECRET: VECTOR_SECRET,
  MEDIA_CDN_BASE_URL: 'http://cdn.invalid/content',
  MEDIA_URL_MODE: 'cdn',
} as unknown as Config;

/**
 * An `auth` that never finds a session, over a database that is not there.
 *
 * That is the operator's actual position at the moment this route is worth reading: mid-cutover,
 * against a brand-new production database, holding no token. It is also what makes the placement
 * assertion sharp rather than incidental - `/me` inside the protected scope answers 401 through
 * this same stub, so a `/__parity` that had been "tidied" into that scope could not answer 200
 * here by accident.
 */
const noSession = { api: { getSession: async () => null } } as unknown as Auth;

function appWith(
  overrides: Partial<Config> = {},
  limiter: KeyedRateLimiter = allowAll(),
): FastifyInstance {
  return buildApp({
    db: {} as unknown as Db,
    auth: noSession,
    config: { ...baseConfig, ...overrides },
    mediaStore: new FakeMediaStore(),
    monitor: silentMonitor(),
    limiter,
  });
}

/** One `GET /__parity` against a throwaway app, closed again whatever the assertion does. */
async function parity(
  overrides: Partial<Config> = {},
  limiter: KeyedRateLimiter = allowAll(),
): Promise<{ status: number; headers: Record<string, unknown>; raw: string; body: unknown }> {
  const app = appWith(overrides, limiter);
  await app.ready();
  try {
    const response = await app.inject({ method: 'GET', url: '/__parity' });
    return {
      status: response.statusCode,
      headers: response.headers as Record<string, unknown>,
      raw: response.body,
      body: JSON.parse(response.body),
    };
  } finally {
    await app.close();
  }
}

/** What the answer looks like once it has been read, without trusting its shape. */
function fieldsOf(body: unknown): { parity: unknown; previousParity: unknown; version: unknown } {
  const record = body as Record<string, unknown>;
  return {
    parity: record['parity'],
    previousParity: record['previousParity'],
    version: record['version'],
  };
}

/**
 * The fingerprint, derived a third way.
 *
 * `node:crypto` rather than `crypto.subtle`, and the message read from the vectors file rather
 * than imported from `media-signing.ts`. Importing `PARITY_MESSAGE` would make a change to what
 * the two sides sign invisible here: both halves of the comparison would move together, which is
 * precisely the failure this project has already had once.
 */
function independentFingerprint(secret: string): string {
  return createHmac('sha256', secret)
    .update(vectors.parity.message)
    .digest('base64url')
    .slice(0, FINGERPRINT_LENGTH);
}

describe('GET /__parity', () => {
  /**
   * THE ONE THAT MATTERS, and the assertion that should stop somebody moving this route into
   * `protectedRoutes` later.
   *
   * The Worker's half of this comparison cannot be authenticated at all - there is no session at
   * the edge - so an authenticated api side would mean obtaining a session token against a
   * brand-new production database at exactly the moment every photo is 403ing.
   */
  it('answers an operator who holds no session at all', async () => {
    const app = appWith();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/__parity' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      parity: VECTOR_FINGERPRINT,
      previousParity: null,
      version: 'unknown',
    });

    /*
     * The control, in the same app and with the same absent session: a route inside the protected
     * scope refuses. Without this the test above would also pass against an app whose session hook
     * had simply stopped working, which is the opposite defect.
     */
    const protectedRoute = await app.inject({ method: 'GET', url: '/me' });
    expect(protectedRoute.statusCode).toBe(401);

    await app.close();
  });

  /**
   * Outside the rate limiter, for the reason `rate-limit-routes.test.ts` records about `/health`.
   *
   * This endpoint is read WHILE something is already wrong, repeatedly, from two hosts at once. A
   * throttled diagnostic answers the one question it exists to answer with a 429.
   */
  it('is not rate limited', async () => {
    const answer = await parity({}, allowFirst(0));

    expect(answer.status).toBe(200);
    expect(fieldsOf(answer.body).parity).toBe(VECTOR_FINGERPRINT);
  });

  /**
   * The comparison an operator actually makes, in both directions.
   *
   * Two hosts holding one secret must agree, or a real match reads as a mismatch and the canary
   * sends somebody hunting a fault that does not exist. Two holding different secrets must differ,
   * or it reports parity that is not there, which is worse: it eliminates the true cause from the
   * search.
   */
  it('agrees across two hosts holding one secret, and differs when they hold two', async () => {
    const typed = 'a-secret-both-sides-were-given';
    const other = 'a-secret-only-one-side-was-given';

    const [api, worker, wrong] = await Promise.all([
      parity({ MEDIA_SIGNING_SECRET: typed }),
      parity({ MEDIA_SIGNING_SECRET: typed }),
      parity({ MEDIA_SIGNING_SECRET: other }),
    ]);

    expect(fieldsOf(api.body).parity).toBe(fieldsOf(worker.body).parity);
    expect(fieldsOf(api.body).parity).not.toBe(fieldsOf(wrong.body).parity);
  });

  /**
   * The specific accident this route exists to catch.
   *
   * `wrangler secret put` reads stdin, and an `echo` or an editor that adds a final newline stores
   * a secret one byte longer than the one on the Fly app. Both sides then look correctly
   * configured, every signature fails, and every photo 403s. A fingerprint that ignored trailing
   * whitespace would be worse than no fingerprint at all: it would report parity for the exact
   * fault it was deployed to find.
   */
  it('answers differently for a secret and the same secret with a trailing newline', async () => {
    const typed = 'a-secret-both-sides-were-given';

    const [clean, pasted] = await Promise.all([
      parity({ MEDIA_SIGNING_SECRET: typed }),
      parity({ MEDIA_SIGNING_SECRET: `${typed}\n` }),
    ]);

    expect(fieldsOf(clean.body).parity).not.toBe(fieldsOf(pasted.body).parity);
    expect(fieldsOf(pasted.body).parity).toBe(independentFingerprint(`${typed}\n`));
  });

  /**
   * Eight characters, and the right eight: the prefix of an HMAC derived here rather than there.
   *
   * The length is checked as well as the value because taking nine characters would still be a
   * value the two sides agreed on, and would still `diff` clean - it would just be a different
   * contract from the Worker's, which publishes eight. That is the shape of mismatch a
   * self-consistent test cannot see.
   */
  it('publishes exactly eight characters of an independently derived signature', async () => {
    // The literal pair above, against the shared openssl vectors, so the copy cannot drift.
    expect(vectors.parity.fingerprintLength).toBe(FINGERPRINT_LENGTH);
    expect(vectors.parity.cases).toContainEqual(
      expect.objectContaining({ secret: VECTOR_SECRET, fingerprint: VECTOR_FINGERPRINT }),
    );

    for (const secret of [VECTOR_SECRET, 'a-secret-both-sides-were-given', 'x'.repeat(64)]) {
      const answer = await parity({ MEDIA_SIGNING_SECRET: secret });
      const published = fieldsOf(answer.body).parity;

      expect(published, secret).toHaveLength(FINGERPRINT_LENGTH);
      expect(published, secret).toBe(independentFingerprint(secret));

      const full = createHmac('sha256', secret).update(vectors.parity.message).digest('base64url');
      expect(full.startsWith(published as string), secret).toBe(true);
    }
  });

  /**
   * `previousParity` is always null on the api, and it is a decision rather than an unfinished
   * field. The api signs and never verifies, so it holds no previous key; the field exists so both
   * sides answer in one shape and a `diff` of the two bodies has nothing spurious in it.
   */
  it('always reports a null previousParity, whatever the secret is', async () => {
    for (const secret of [VECTOR_SECRET, 'a-secret-both-sides-were-given']) {
      const answer = await parity({ MEDIA_SIGNING_SECRET: secret });
      expect(fieldsOf(answer.body).previousParity, secret).toBeNull();
    }
  });

  /** Which build is answering, so two hosts can be told apart mid-cutover. */
  it('reports the release the deploy set, and "unknown" when it set none', async () => {
    const released = await parity({ SENTRY_RELEASE: '9f1c8b2e' });
    expect(fieldsOf(released.body).version).toBe('9f1c8b2e');

    // Absent locally and in CI, where the source is on disk anyway. It must still be a string, so
    // the two bodies stay the same shape and a `diff` shows a value rather than a missing line.
    const local = await parity();
    expect(fieldsOf(local.body).version).toBe('unknown');
  });

  /**
   * `no-store`, because the answer is read during a change and a cached one is worse than none.
   *
   * A proxy or a browser holding the previous fingerprint for even a minute during a rotation
   * turns this route into a source of confident wrong answers.
   */
  it('is never cached', async () => {
    const answer = await parity();
    expect(answer.headers['cache-control']).toBe('no-store');
  });

  /**
   * The body carries three things and nothing else.
   *
   * This is an UNAUTHENTICATED endpoint, so the assertion is on the exact key set rather than on
   * the presence of the three: a later edit that adds the secret's length, the URL mode, the
   * bucket names or the previous key would be a leak nobody reviewed. The second assertion covers
   * the mutation the key set alone cannot see - the fingerprint replaced by the raw secret, which
   * leaves every key exactly where it was.
   */
  it('carries nothing but parity, previousParity and version, and never the secret', async () => {
    const secret = 'a-secret-both-sides-were-given';
    const answer = await parity({ MEDIA_SIGNING_SECRET: secret });

    expect(Object.keys(answer.body as Record<string, unknown>).sort()).toEqual([
      'parity',
      'previousParity',
      'version',
    ]);
    expect(answer.raw).not.toContain(secret);
    // Nor any part of it long enough to shorten a search for the rest.
    expect(answer.raw).not.toContain(secret.slice(0, 12));
  });
});
