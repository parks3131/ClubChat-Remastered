import { describe, expect, it } from 'vitest';
import vectors from './media-signing-vectors.json' with { type: 'json' };
import {
  bucketRoleForObjectKey,
  hourAlignedExpiry,
  hourAlignedSigningWindow,
  kindToBucketRole,
  MEDIA_KINDS,
  signMediaUrl,
  signedMediaUrl,
  verifyMediaSignature,
} from './media-signing.ts';

/**
 * The signature is minted on Node and checked on `workerd`. These vectors are what stops the two
 * from drifting.
 *
 * **Why literal expected values rather than a round trip.** The media suite in `packages/server`
 * signs and verifies with one implementation, so it passes on anything self-consistent. Measured
 * on 2026-08-21: changing the signed separator from `:` to `|`, and the expiry compare from `<`
 * to `<=`, left all 52 of those tests green. Neither mutation survives this file.
 */
describe('the media signature, against fixed vectors', () => {
  it('reproduces every signature exactly', async () => {
    for (const v of vectors.sign) {
      expect(await signMediaUrl(vectors.secret, v.objectKey, v.exp), v.name).toBe(v.sig);
    }
  });

  it('builds the whole URL exactly, since the join is unsigned and can drift on its own', async () => {
    const config = { signingSecret: vectors.secret, cdnBaseUrl: vectors.cdnBaseUrl };
    for (const v of vectors.sign) {
      // The clock is chosen so hourAlignedExpiry lands on this vector's exp: one hour and one
      // millisecond before it, which ceils to exp - 3600 and then adds the headroom hour.
      const nowMs = (v.exp - 7200) * 1000 + 1;
      expect(hourAlignedExpiry(nowMs), v.name).toBe(v.exp);
      expect(await signedMediaUrl(config, v.objectKey, nowMs), v.name).toBe(v.url);
    }
  });

  it('accepts and refuses exactly as specified', async () => {
    for (const v of vectors.verify) {
      expect(
        await verifyMediaSignature(vectors.secret, v.objectKey, v.exp, v.sig, v.nowMs),
        v.name,
      ).toBe(v.accept);
    }
  });

  /*
   * The independent re-derivation of these vectors with `node:crypto` deliberately does NOT live
   * here: see `packages/server/src/test/media-signing-vectors.test.ts`.
   *
   * This package compiles with no Node types at all, which is what makes it safe to bundle into a
   * Worker, and importing `node:crypto` here breaks that. The typecheck catches it, which is how
   * this comment came to be written.
   */

  it('signs a 43 character base64url signature, with no padding and no + or /', async () => {
    for (const v of vectors.sign) {
      expect(v.sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});

describe('the hour-aligned window', () => {
  it('gives every viewer inside one hour the same expiry', () => {
    const base = Date.parse('2026-04-12T10:00:00.000Z');
    const first = hourAlignedExpiry(base + 1);
    expect(hourAlignedExpiry(base + 59 * 60_000)).toBe(first);
    expect(hourAlignedExpiry(base + 60 * 60_000 + 1)).not.toBe(first);
  });

  it('leaves more than an hour of validity to a URL issued at 10:59', () => {
    const issuedAt = Date.parse('2026-04-12T10:59:30.000Z');
    expect(hourAlignedExpiry(issuedAt) * 1000 - issuedAt).toBeGreaterThan(3_600_000);
  });

  it('pins the presign window to the floor of the hour, so it is stable within it', () => {
    const base = Date.parse('2026-04-12T10:00:00.000Z');
    const a = hourAlignedSigningWindow(base + 12_000);
    const b = hourAlignedSigningWindow(base + 25 * 60_000);
    expect(a).toEqual(b);
    expect(a.signingDateMs).toBe(base);
    // The presign window and the CDN expiry describe the same instant, by different arithmetic.
    expect(a.signingDateMs + a.expiresInSeconds * 1000).toBe(hourAlignedExpiry(base + 1) * 1000);
  });
});

describe('bucket routing by key prefix', () => {
  it('routes every kind this project issues', () => {
    for (const kind of MEDIA_KINDS) {
      expect(bucketRoleForObjectKey(`${kind}/2026-04/whatever`)).toBe(kindToBucketRole[kind]);
    }
  });

  it('routes each vector to the bucket it belongs in', () => {
    for (const v of vectors.sign) {
      expect(bucketRoleForObjectKey(v.objectKey), v.name).toBe(v.bucketRole);
    }
  });

  /**
   * Null rather than a default, and the default that was rejected was "fall back to the private
   * bucket". That is not fail-closed: it turns any unrecognised prefix into a probe of private
   * content. The edge answers 404 on null without reading a bucket at all.
   */
  it('refuses anything else rather than guessing', () => {
    for (const key of [
      'evil/2026-04/x',
      'photos/2026-04/x',
      'Photo/2026-04/x',
      '/photo/2026-04/x',
      'no-slash-at-all',
      '',
      '../photo/2026-04/x',
    ]) {
      expect(bucketRoleForObjectKey(key), key).toBeNull();
    }
  });
});
