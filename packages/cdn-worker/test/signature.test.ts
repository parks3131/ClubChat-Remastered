/**
 * The refusal half of the Worker: what it rejects, and the fact that it rejects before it reads.
 *
 * Every signature here is a literal from `@clubchat/shared/media-signing-vectors.json`. Nothing in
 * this file calls `signMediaUrl`, so an implementation that changes stops matching rather than
 * quietly agreeing with itself. See `harness.ts` for why that is the whole point.
 */

import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armBothTripwires,
  atMoment,
  bodyBytes,
  CONTENT_BYTES,
  emptyBuckets,
  HIT_STATUS,
  mediaUrl,
  rawMediaUrl,
  seedBothBuckets,
  useSigningKeys,
  VALID_NOW_MS,
  vectors,
} from './harness.ts';

const PHOTO = vectors.verify[0]!;

beforeEach(emptyBuckets);

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The whole `verify` table, driven from the table.
 *
 * Written as a loop over the JSON rather than as eleven hand-written cases so that a vector added
 * to the file is a test that runs here without anybody remembering to add it, and so that no
 * expectation in this file was typed by the same hand that typed the code.
 *
 * The object is seeded into BOTH buckets for every case, including the refusals. That is not
 * laziness about routing - it is what makes each refusal mean something: the bytes were sitting
 * there, reachable, and the Worker still said no.
 */
describe('the signature vectors, end to end through the Worker', () => {
  for (const vector of vectors.verify) {
    it(`${vector.accept ? 'serves' : 'refuses'}: ${vector.name}`, async () => {
      useSigningKeys(vectors.secret);
      atMoment(vector.nowMs);
      await seedBothBuckets(vector.objectKey, 'image/jpeg');

      const response = await SELF.fetch(mediaUrl(vector.objectKey, vector.exp, vector.sig));

      if (vector.accept) {
        expect(response.status).toBe(HIT_STATUS);
        expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
      } else {
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
        // A refusal that leaked the bytes would still have passed the status assertion.
        expect(await bodyBytes(response)).toEqual([]);
      }
    });
  }

  it('covers the boundary in both directions and the whole tamper table', () => {
    // A guard on the loop above: if the vectors file is ever trimmed, this suite would silently
    // shrink to nothing while still reporting green.
    expect(vectors.verify.filter((v) => v.accept)).toHaveLength(2);
    expect(vectors.verify.filter((v) => !v.accept)).toHaveLength(9);
  });
});

/**
 * The central claim in the file header of `src/index.ts`: "Every refusal happens before any R2
 * call". A status code alone cannot show that, because a Worker that reads first and checks
 * afterwards answers a bad signature with the same 403. These three tests make the ordering
 * observable.
 */
describe('refusal happens before the read', () => {
  it('does not return the bytes it is sitting on', async () => {
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await seedBothBuckets(PHOTO.objectKey, 'image/jpeg');

    const tampered = vectors.verify.find((v) => v.name === 'the last character flipped')!;
    const response = await SELF.fetch(mediaUrl(tampered.objectKey, tampered.exp, tampered.sig));

    expect(response.status).toBe(403);
    expect(await bodyBytes(response)).toEqual([]);
  });

  it('answers a key that exists and a key that does not exist identically', async () => {
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await seedBothBuckets(PHOTO.objectKey, 'image/jpeg');
    const absent = 'photo/2026-04/9f1c8b2e-0000-4000-8000-00000000dead';
    const badSig = vectors.verify.find((v) => v.name === 'the last character flipped')!.sig;

    const [present, missing] = await Promise.all([
      SELF.fetch(mediaUrl(PHOTO.objectKey, PHOTO.exp, badSig)),
      SELF.fetch(mediaUrl(absent, PHOTO.exp, badSig)),
    ]);

    // Compared as whole shapes rather than field by field, because the leak this guards against
    // is any observable difference at all: a header, a length, a status.
    const shape = async (response: Response): Promise<unknown> => ({
      status: response.status,
      headers: [...response.headers].sort(),
      body: await bodyBytes(response),
    });
    expect(await shape(present)).toEqual(await shape(missing));
    expect(present.status).toBe(403);
  });

  it('never touches either bucket when the signature is wrong', async () => {
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await seedBothBuckets(PHOTO.objectKey, 'image/jpeg');
    const disarm = armBothTripwires();
    try {
      const tampered = vectors.verify.find((v) => v.name === 'the last character flipped')!;
      // If the read came first this throws inside the Worker, which surfaces as a rejected fetch
      // or a 5xx rather than as a 403.
      const response = await SELF.fetch(mediaUrl(tampered.objectKey, tampered.exp, tampered.sig));
      expect(response.status).toBe(403);
    } finally {
      disarm();
    }
  });

  it('never touches either bucket when the signature is expired', async () => {
    const expired = vectors.verify.find((v) => v.name === 'refused one millisecond later')!;
    useSigningKeys(vectors.secret);
    atMoment(expired.nowMs);
    await seedBothBuckets(expired.objectKey, 'image/jpeg');
    const disarm = armBothTripwires();
    try {
      const response = await SELF.fetch(mediaUrl(expired.objectKey, expired.exp, expired.sig));
      expect(response.status).toBe(403);
    } finally {
      disarm();
    }
  });
});

/**
 * A missing query parameter is the one refusal that reaches the Worker's own code rather than
 * `verifyMediaSignature`, because `Number(null)` is 0 and would have been a perfectly finite
 * expiry. These prove the null checks in front of it, and that none of them is a crash.
 */
describe('missing and malformed query parameters', () => {
  const cases: ReadonlyArray<{ name: string; query: string }> = [
    { name: 'no exp', query: `sig=${PHOTO.sig}` },
    { name: 'no sig', query: `exp=${PHOTO.exp}` },
    { name: 'neither', query: '' },
    { name: 'an empty exp', query: `exp=&sig=${PHOTO.sig}` },
    { name: 'an exp that is not a number', query: `exp=soon&sig=${PHOTO.sig}` },
    { name: 'an exp of Infinity', query: `exp=Infinity&sig=${PHOTO.sig}` },
    // `searchParams.get` returns the FIRST value, so a smuggled leading parameter is the one that
    // counts. Worth pinning: the opposite convention would let a second `exp` override a signed one.
    { name: 'a smuggled first exp', query: `exp=1&exp=${PHOTO.exp}&sig=${PHOTO.sig}` },
    { name: 'a smuggled first sig', query: `exp=${PHOTO.exp}&sig=x&sig=${PHOTO.sig}` },
  ];

  for (const { name, query } of cases) {
    it(`refuses ${name} with 403 rather than throwing`, async () => {
      useSigningKeys(vectors.secret);
      atMoment(VALID_NOW_MS);
      await seedBothBuckets(PHOTO.objectKey, 'image/jpeg');

      const response = await SELF.fetch(rawMediaUrl(PHOTO.objectKey, query));

      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await bodyBytes(response)).toEqual([]);
    });
  }
});

/**
 * A Worker deployed before anybody ran `wrangler secret put`, and a Worker whose secret was set
 * from empty stdin. Both must refuse everything rather than throw inside `importKey`, and both are
 * the reason `verifyMediaSignature` treats an empty key list as false.
 */
describe('an unconfigured signing secret fails closed', () => {
  for (const [name, current] of [
    ['no MEDIA_SIGNING_SECRET binding at all', null],
    ['an empty MEDIA_SIGNING_SECRET', ''],
  ] as const) {
    it(`refuses a perfectly good signature with ${name}`, async () => {
      useSigningKeys(current);
      atMoment(VALID_NOW_MS);
      await seedBothBuckets(PHOTO.objectKey, 'image/jpeg');

      const response = await SELF.fetch(mediaUrl(PHOTO.objectKey, PHOTO.exp, PHOTO.sig));

      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await bodyBytes(response)).toEqual([]);
    });
  }

  it('serves that same URL the moment the secret is configured', async () => {
    // The other half of the pair. Without it, the two tests above would pass against a Worker that
    // refuses everything for any reason at all.
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await seedBothBuckets(PHOTO.objectKey, 'image/jpeg');

    const response = await SELF.fetch(mediaUrl(PHOTO.objectKey, PHOTO.exp, PHOTO.sig));

    expect(response.status).toBe(HIT_STATUS);
    expect(await bodyBytes(response)).toEqual([...CONTENT_BYTES]);
  });

  it('refuses when the secret differs from the one that signed the URL', async () => {
    // The parity canary's failure, seen from the media path: the api and the Worker holding
    // different values is one wrong character away, and this is what a member sees when it happens.
    useSigningKeys(vectors.rotation.strangerSecret);
    atMoment(VALID_NOW_MS);
    await seedBothBuckets(PHOTO.objectKey, 'image/jpeg');

    const response = await SELF.fetch(mediaUrl(PHOTO.objectKey, PHOTO.exp, PHOTO.sig));

    expect(response.status).toBe(403);
  });
});

/**
 * Rotation, driven from the vectors' own `rotation` table.
 *
 * The mapping from a vector to this Worker is exact: `secrets` is the ordered key list, current
 * first, and the Worker builds that list from `MEDIA_SIGNING_SECRET` followed by
 * `MEDIA_SIGNING_SECRET_PREVIOUS`. So `secrets[0]` becomes the current binding and `secrets[1]`
 * the previous one, the two order-independence vectors configure the Worker the other way round,
 * and the empty-list vector is a Worker with neither binding set.
 */
describe('key rotation, from the vectors rotation table', () => {
  for (const rotation of vectors.rotation.cases) {
    it(`${rotation.accept ? 'serves' : 'refuses'}: ${rotation.name}`, async () => {
      useSigningKeys(rotation.secrets[0] ?? null, rotation.secrets[1] ?? null);
      atMoment(rotation.nowMs);
      await seedBothBuckets(rotation.objectKey, 'image/jpeg');

      const response = await SELF.fetch(mediaUrl(rotation.objectKey, rotation.exp, rotation.sig));

      expect(response.status).toBe(rotation.accept ? HIT_STATUS : 403);
    });
  }

  it('is the rotation the README describes: previous key in, api key flipped, previous key out', async () => {
    // The three-step procedure as one narrative, because the table above proves each state and
    // nothing proves the transition between them.
    const minted = vectors.rotation.cases.find(
      (c) => c.name === 'mid-rotation: a URL minted by the previous key, with both keys offered',
    )!;
    atMoment(minted.nowMs);
    await seedBothBuckets(minted.objectKey, 'image/jpeg');
    const url = mediaUrl(minted.objectKey, minted.exp, minted.sig);

    // Step 0: only the old key is configured, and it is the current one. The URL resolves.
    useSigningKeys(vectors.rotation.previousSecret);
    expect((await SELF.fetch(url)).status).toBe(HIT_STATUS);

    // Step 1: the old key moves to previous, the new key becomes current. It still resolves.
    useSigningKeys(vectors.secret, vectors.rotation.previousSecret);
    expect((await SELF.fetch(url)).status).toBe(HIT_STATUS);

    // Step 3: the previous key is deleted once old URLs have aged out. Now it does not.
    useSigningKeys(vectors.secret);
    expect((await SELF.fetch(url)).status).toBe(403);
  });

  it('does not accept a previous key that is configured as an empty string', async () => {
    // `wrangler secret put` handed empty stdin stores an empty string, which is a valid HMAC key
    // that nothing signs with. Treated as absent, so it neither accepts nor costs an HMAC.
    const minted = vectors.rotation.cases.find(
      (c) => c.name === 'mid-rotation: a URL minted by the previous key, with both keys offered',
    )!;
    useSigningKeys(vectors.secret, '');
    atMoment(minted.nowMs);
    await seedBothBuckets(minted.objectKey, 'image/jpeg');

    const response = await SELF.fetch(mediaUrl(minted.objectKey, minted.exp, minted.sig));

    expect(response.status).toBe(403);
  });
});

describe('the binding list this suite depends on', () => {
  it('is the one wrangler.jsonc declares', () => {
    // Nothing checks src/env.ts against wrangler.jsonc, and a binding renamed in one and not the
    // other typechecks, deploys, and is undefined at the edge. This is the cheapest possible
    // tripwire on that, and it runs against the real miniflare environment built from the config.
    expect(typeof env.IDENTITY.get).toBe('function');
    expect(typeof env.CONTENT.get).toBe('function');
  });
});
