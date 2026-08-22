/**
 * Bucket routing, which is exhaustive by design: `avatar/` to identity, `photo/` and `document/`
 * to content, and anything else a 404 that never touches R2.
 *
 * The refusal is the interesting half. Falling back to the private bucket would turn a typo into a
 * probe of private content, and it would do it silently, because a fallback that happens to find
 * nothing looks exactly like the 404 that was supposed to happen.
 *
 * This is the one file that signs. The vectors deliberately contain no unroutable key - there is
 * no reason to publish an `openssl` signature for a prefix this project never issues - so the
 * signature here is setup rather than the thing under assertion: it exists only so that the
 * request reaches the routing decision at all, and every assertion below is about what comes after
 * it. Using the real signer for that is honest; using it to produce a value an assertion then
 * checks would not be.
 */

import { signMediaUrl } from '@clubchat/shared/media-signing';
import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armBothTripwires,
  armTripwire,
  atMoment,
  bodyBytes,
  CDN_ORIGIN,
  CONTENT_BYTES,
  emptyBuckets,
  HIT_STATUS,
  IDENTITY_BYTES,
  mediaUrl,
  seedBothBuckets,
  useSigningKeys,
  VALID_NOW_MS,
  vectors,
} from './harness.ts';

/** Every vector expiry is later than this, so one clock makes the whole `sign` table live. */
const EXP = vectors.verify[0]!.exp;

beforeEach(emptyBuckets);

afterEach(() => {
  vi.useRealTimers();
});

/** A validly signed URL for a key the vectors do not cover. See the file header. */
async function signedUrlFor(objectKey: string): Promise<string> {
  const sig = await signMediaUrl(vectors.secret, objectKey, EXP);
  return mediaUrl(objectKey, EXP, sig);
}

/**
 * The routing table, taken from the vectors' own `bucketRole` field.
 *
 * Every `sign` vector names the bucket its key belongs to, so this loop is the routing rule as the
 * vectors state it rather than as this package restates it. Both buckets hold the key with
 * different bytes, so the body is what says which one answered.
 */
describe('the kinds that route, from the vectors sign table', () => {
  for (const vector of vectors.sign) {
    it(`reads ${vector.name} from the ${vector.bucketRole} bucket`, async () => {
      useSigningKeys(vectors.secret);
      atMoment(VALID_NOW_MS);
      await seedBothBuckets(vector.objectKey, 'image/webp');

      const response = await SELF.fetch(mediaUrl(vector.objectKey, vector.exp, vector.sig));

      expect(response.status).toBe(HIT_STATUS);
      expect(await bodyBytes(response)).toEqual([
        ...(vector.bucketRole === 'identity' ? IDENTITY_BYTES : CONTENT_BYTES),
      ]);
    });
  }

  it('covers all three kinds', () => {
    // Without this the loop above could shrink to one kind and still report green.
    expect(new Set(vectors.sign.map((v) => v.objectKey.slice(0, v.objectKey.indexOf('/'))))).toEqual(
      new Set(['photo', 'avatar', 'document']),
    );
  });
});

/**
 * Everything that is not one of the three kinds. Each of these is seeded into both buckets with
 * real bytes first, so a 404 means the routing refused rather than that the read happened to miss.
 */
describe('every other prefix is a 404 that never reads', () => {
  const unroutable = [
    'nope/2026-04/x',
    // The plurals, which is what a person types from memory.
    'photos/2026-04/x',
    'avatars/2026-04/x',
    'documents/2026-04/x',
    // Case, because `Object.hasOwn` is exact and the api always lowercases.
    'Photo/2026-04/x',
    'AVATAR/2026-04/x',
    // A prefix that is a prefix of a real kind, and one that a real kind is a prefix of.
    'phot/2026-04/x',
    'photo-original/2026-04/x',
    // No slash at all, so there is no first segment to route by.
    'photo',
    'avatar',
    // A leading slash, which makes the first segment empty.
    '/2026-04/x',
    // The traversal attempt, which is not decoded and therefore is simply a key that is not signed
    // for a kind. Included because it is the shape somebody will try.
    '..%2F..%2Fphoto/2026-04/x',
  ];

  for (const objectKey of unroutable) {
    it(`refuses ${JSON.stringify(objectKey)} with 404 and no-store`, async () => {
      useSigningKeys(vectors.secret);
      atMoment(VALID_NOW_MS);
      await seedBothBuckets(objectKey, 'image/webp');

      const response = await SELF.fetch(await signedUrlFor(objectKey));

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      // The object was sitting in both buckets. A fallback would have answered with bytes.
      expect(await bodyBytes(response)).toEqual([]);
    });
  }

  it('does not read either bucket for an unroutable prefix', async () => {
    // The ordering as a fact rather than an inference: with both bindings armed to throw on any
    // read, a 404 can only mean the routing refused first.
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    const url = await signedUrlFor('nope/2026-04/x');
    const disarm = armBothTripwires();
    try {
      const response = await SELF.fetch(url);

      expect(response.status).toBe(404);
    } finally {
      disarm();
    }
  });

  it('refuses an unroutable prefix that is signed and whose bytes exist', async () => {
    // The requirement stated plainly, with the bytes present, so the assertion is "404 rather than
    // the bytes" and not merely "404".
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await env.IDENTITY.put('nope/2026-04/x', IDENTITY_BYTES);
    await env.CONTENT.put('nope/2026-04/x', CONTENT_BYTES);

    const response = await SELF.fetch(await signedUrlFor('nope/2026-04/x'));

    expect(response.status).toBe(404);
    expect(await bodyBytes(response)).toEqual([]);
  });

  it('refuses an unsigned unroutable prefix with 403, not 404', async () => {
    // Order of operations, from the other direction: the signature is checked BEFORE routing, so a
    // caller with no signature learns nothing about which prefixes exist.
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);

    const response = await SELF.fetch(`${CDN_ORIGIN}/nope/2026-04/x`);

    expect(response.status).toBe(403);
  });

  it('is byte-identical to the 404 for an object that is simply not there', async () => {
    /*
     * Both are 404, and their status, headers and body must be identical.
     *
     * The two are different facts: one says "this prefix is not a kind this project issues", the
     * other says "this key is not in the bucket". Told apart by anything IN THE RESPONSE, they
     * would let anybody holding a signature ask the CDN which object keys exist.
     *
     * **The claim is about the response, and deliberately not about timing.** The two cannot be
     * indistinguishable in time and it would be dishonest to imply it: an unroutable prefix returns
     * before any R2 call at all, and a miss returns after a full round trip to the bucket, so the
     * difference is structural rather than incidental. This suite does not measure it and could
     * not: `workerd` clamps `performance.now()` inside a request precisely to deny that kind of
     * measurement. The practical impact is nil for a different and better reason than the clamp,
     * which is that reaching either branch requires a valid signature for the very key being
     * probed, and holding one is already permission to fetch that object.
     *
     * Both keys are validly signed and neither is seeded, so the only difference between the two
     * requests is the prefix.
     */
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);

    const unroutable = await SELF.fetch(await signedUrlFor('nope/2026-04/x'));
    const missing = await SELF.fetch(
      await signedUrlFor('photo/2026-04/9f1c8b2e-0000-4000-8000-00000000dead'),
    );

    const shape = async (response: Response): Promise<unknown> => ({
      status: response.status,
      headers: [...response.headers].sort(),
      body: await bodyBytes(response),
    });
    expect(await shape(missing)).toEqual(await shape(unroutable));
    expect(missing.status).toBe(404);
  });

  it('answers the bare root with 403 rather than routing an empty key', async () => {
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);

    const response = await SELF.fetch(`${CDN_ORIGIN}/`);

    expect(response.status).toBe(403);
  });
});

/**
 * REGRESSION, 2026-08-21: a slashless key must not route, because one of them reached the private
 * bucket.
 *
 * `bucketRoleForObjectKey` read `objectKey.slice(0, objectKey.indexOf('/'))`. `indexOf` answers
 * `-1` when there is no slash, and `slice(0, -1)` drops the LAST CHARACTER rather than returning
 * the empty string. So `photos` became `photo`, `avatars` became `avatar` and `documents` became
 * `document`, and every one of them routed to a bucket and read it. A red-team pass seeded ten
 * bytes at the key `photos` in `clubchat-content`, signed `photos:1776078000`, and was answered 200
 * with the private object.
 *
 * ## Why the tests here did not catch it, which is the part worth keeping
 *
 * This file already covered `photos/2026-04/x` and `photo`. Neither is the broken shape.
 * `photos/2026-04/x` HAS a slash, so its first segment genuinely is `photos` and it genuinely is
 * not a kind. `photo` loses a real character and becomes `phot`, which is also not a kind. The gap
 * was the exact intersection of the two: **a slashless key whose last character removal lands on a
 * real kind.** Every key below is that shape, and each is seeded into BOTH buckets first, so a
 * regression is answered with bytes rather than with a status.
 *
 * The Worker-level test exists as well as the one in `packages/shared` on purpose. The unit test
 * proves the function returns `null`; only this one proves that nothing downstream of it reads a
 * bucket anyway.
 */
describe('REGRESSION: a slashless key reached the private bucket', () => {
  const slashless: ReadonlyArray<{ key: string; became: string; bucket: string }> = [
    { key: 'photos', became: 'photo', bucket: 'clubchat-content' },
    { key: 'avatars', became: 'avatar', bucket: 'clubchat-identity' },
    { key: 'documents', became: 'document', bucket: 'clubchat-content' },
    { key: 'photoX', became: 'photo', bucket: 'clubchat-content' },
    { key: 'photo.', became: 'photo', bucket: 'clubchat-content' },
    { key: 'avatarZ', became: 'avatar', bucket: 'clubchat-identity' },
  ];

  for (const { key, became, bucket } of slashless) {
    it(`refuses ${JSON.stringify(key)}, which used to read ${became} in ${bucket}`, async () => {
      useSigningKeys(vectors.secret);
      atMoment(VALID_NOW_MS);
      await seedBothBuckets(key, 'text/html');

      const response = await SELF.fetch(await signedUrlFor(key));

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      // The object was in both buckets. Under the defect this was the private object's bytes.
      expect(await bodyBytes(response)).toEqual([]);
    });
  }

  it('does not read either bucket for any of them', async () => {
    // The refusal as an ordering fact. With both bindings armed to throw on any read, a 404 can
    // only mean routing declined before the read, which is the property the defect broke.
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    const urls = await Promise.all(slashless.map(({ key }) => signedUrlFor(key)));
    const disarm = armBothTripwires();
    try {
      const statuses = await Promise.all(
        urls.map((url) => SELF.fetch(url).then((response) => response.status)),
      );

      expect(statuses).toEqual(slashless.map(() => 404));
    } finally {
      disarm();
    }
  });
});

/**
 * The shapes a correction must not break.
 *
 * A fix that refuses a slashless key is one over-correction away from refusing something real, and
 * the failure would be silent in the other direction: every photo 404s and it reads as a broken
 * bucket. These are the positive half.
 */
describe('the shapes the correction must leave working', () => {
  it('still routes and reads a well-formed key of every kind', async () => {
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    // One vector per kind, taken from the sign table by prefix so the keys stay the vectors' own.
    const oneOfEachKind = ['photo/', 'avatar/', 'document/'].map(
      (prefix) => vectors.sign.find((vector) => vector.objectKey.startsWith(prefix))!,
    );

    for (const vector of oneOfEachKind) {
      await seedBothBuckets(vector.objectKey, 'image/webp');
      const response = await SELF.fetch(mediaUrl(vector.objectKey, vector.exp, vector.sig));

      expect(response.status).toBe(HIT_STATUS);
      expect(await bodyBytes(response)).toEqual([
        ...(vector.bucketRole === 'identity' ? IDENTITY_BYTES : CONTENT_BYTES),
      ]);
    }
  });

  it('routes a trailing-slash key to content and 404s on the READ, not at routing', async () => {
    /*
     * `photo/` has a slash at index 5, so the first segment is `photo`, which is a real kind. It
     * therefore routes to the content bucket and the 404 that follows comes from the object not
     * being there. Checked against the fixed function rather than assumed, because "refused at
     * routing" and "missing from the bucket" are the same 404 to a caller and only a tripwire can
     * tell them apart.
     *
     * Nothing in production can produce this key - the api mints `${kind}/${YYYY-MM}/${uuid}` and
     * no signature for `photo/` has ever existed - so this pins behaviour rather than defends a
     * path. It is here so an over-correction that starts refusing a key with an empty SECOND
     * segment is visible, since the same edit would refuse `photo/2026-04/` shapes too.
     */
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    const url = await signedUrlFor('photo/');

    // 1. It reaches the read: the content tripwire fires rather than a 404 coming back.
    const disarm = armTripwire('CONTENT');
    const reachedTheRead = await SELF.fetch(url).then(
      (response) => `status ${response.status}`,
      () => 'read attempted' as const,
    );
    disarm();
    expect(reachedTheRead).toBe('read attempted');

    // 2. With nothing stored there, the read misses and that is the 404.
    expect((await SELF.fetch(url)).status).toBe(404);

    // 3. With something stored there, the same request is served, which is only possible if
    //    routing sent it to the content bucket.
    await env.CONTENT.put('photo/', CONTENT_BYTES);
    const served = await SELF.fetch(url);
    expect(served.status).toBe(HIT_STATUS);
    expect(await bodyBytes(served)).toEqual([...CONTENT_BYTES]);
  });
});
