import { describe, expect, it, vi } from 'vitest';
import vectors from './media-signing-vectors.json' with { type: 'json' };
import {
  bucketRoleForObjectKey,
  hourAlignedExpiry,
  hourAlignedSigningWindow,
  kindToBucketRole,
  MEDIA_KINDS,
  PARITY_MESSAGE,
  parityFingerprint,
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

/**
 * The first rotation vector minted by a given key whose clock is inside the validity window.
 *
 * The ordering tests below need a signature that only the current key matches and one that only
 * the previous key matches, and taking both from the vector table keeps them tied to the openssl
 * values rather than to anything this module produces.
 */
function liveVectorMintedBy(signedWith: 'current' | 'previous') {
  const found = vectors.rotation.cases.find(
    (c) => c.signedWith === signedWith && c.exp * 1000 >= c.nowMs,
  );
  if (found === undefined) throw new Error(`no live rotation vector signed with ${signedWith}`);
  return found;
}

/**
 * Which secrets a verification actually reached, and in what order.
 *
 * `verifyMediaSignature` imports one HMAC key per candidate secret, so spying on
 * `crypto.subtle.importKey` records the attempt order without the module having to report on
 * itself. vitest's `spyOn` calls through, so the verification underneath is the real one.
 *
 * This is the only way to see the two properties the result cannot show. Trying the keys in the
 * wrong order gives an identical answer for every input, and computing an HMAC against a URL that
 * has already expired gives an identical answer too. Both are still defects, and both are
 * invisible to any assertion on the boolean.
 */
async function secretsTried(
  secrets: readonly string[],
  objectKey: string,
  exp: number,
  sig: string,
  nowMs: number,
): Promise<{ accepted: boolean; tried: string[] }> {
  const decoder = new TextDecoder();
  const spy = vi.spyOn(crypto.subtle, 'importKey');
  try {
    const accepted = await verifyMediaSignature(secrets, objectKey, exp, sig, nowMs);
    const tried = spy.mock.calls.map((call) => decoder.decode(call[1] as unknown as Uint8Array));
    return { accepted, tried };
  } finally {
    spy.mockRestore();
  }
}

/**
 * Rotation, from the verifier's side.
 *
 * The Worker holds a current key and optionally a previous one; the api holds exactly one and
 * only ever signs with it. So a URL minted in the hour before a key flip keeps resolving until it
 * expires, and nobody's photos go dark during the change.
 */
describe('rotation: verifying against an ordered list of keys', () => {
  it('accepts and refuses exactly as the rotation vectors specify', async () => {
    for (const v of vectors.rotation.cases) {
      expect(
        await verifyMediaSignature(v.secrets, v.objectKey, v.exp, v.sig, v.nowMs),
        v.name,
      ).toBe(v.accept);
    }
  });

  /**
   * The widening is only safe if the old shape is genuinely untouched, and every existing caller
   * passes a string. So every original verify vector is replayed through a one-element list and
   * must give the identical answer.
   */
  it('answers identically for a plain string and for that string alone in a list', async () => {
    for (const v of vectors.verify) {
      const asString = await verifyMediaSignature(
        vectors.secret,
        v.objectKey,
        v.exp,
        v.sig,
        v.nowMs,
      );
      const asList = await verifyMediaSignature(
        [vectors.secret],
        v.objectKey,
        v.exp,
        v.sig,
        v.nowMs,
      );
      expect(asString, v.name).toBe(v.accept);
      expect(asList, v.name).toBe(asString);
    }
  });

  /**
   * An empty list is the accident this fails closed against: a Worker deployed with its secret
   * unset, or a caller that filtered a list down to nothing. Answering true there would open
   * every object in both buckets to anybody who can type a URL.
   */
  it('refuses an empty key list without computing anything', async () => {
    const v = liveVectorMintedBy('current');
    const { accepted, tried } = await secretsTried([], v.objectKey, v.exp, v.sig, v.nowMs);
    expect(accepted).toBe(false);
    expect(tried).toEqual([]);
  });

  it('tries the current key first and stops there when it matches', async () => {
    const v = liveVectorMintedBy('current');
    const { accepted, tried } = await secretsTried(
      [vectors.secret, vectors.rotation.previousSecret],
      v.objectKey,
      v.exp,
      v.sig,
      v.nowMs,
    );
    expect(accepted).toBe(true);
    // One attempt, and it is the current key. A list tried in the other order answers the same
    // boolean while making every ordinary request pay for a second HMAC.
    expect(tried).toEqual([vectors.secret]);
  });

  it('reaches the previous key only after the current one has failed', async () => {
    const v = liveVectorMintedBy('previous');
    const { accepted, tried } = await secretsTried(
      [vectors.secret, vectors.rotation.previousSecret],
      v.objectKey,
      v.exp,
      v.sig,
      v.nowMs,
    );
    expect(accepted).toBe(true);
    expect(tried).toEqual([vectors.secret, vectors.rotation.previousSecret]);
  });

  /**
   * The expiry check runs once, before any HMAC, exactly as it did when there was one key. Doing
   * it per key would multiply the cost of the cheapest possible refusal by the number of keys
   * configured, and an expired URL is the single most common refusal this thing will ever issue.
   */
  it('computes no HMAC at all for an expired URL, however many keys are offered', async () => {
    const v = liveVectorMintedBy('current');
    const { accepted, tried } = await secretsTried(
      [vectors.secret, vectors.rotation.previousSecret],
      v.objectKey,
      v.exp,
      v.sig,
      v.exp * 1000 + 1,
    );
    expect(accepted).toBe(false);
    expect(tried).toEqual([]);
  });
});

/**
 * The parity canary.
 *
 * The likeliest failure in this deployment is the api and the Worker holding different values of
 * MEDIA_SIGNING_SECRET, and it presents as every photo 403ing, which looks exactly like a broken
 * Worker. These vectors are what stop the two sides publishing fingerprints that could differ for
 * any reason other than the secret.
 */
describe('the parity fingerprint', () => {
  it('signs the constant recorded in the vectors, and not something else', () => {
    expect(PARITY_MESSAGE).toBe(vectors.parity.message);
  });

  it('reproduces the openssl fingerprint of both vector secrets', async () => {
    for (const v of vectors.parity.cases) {
      expect(await parityFingerprint(v.secret), v.name).toBe(v.fingerprint);
    }
  });

  /**
   * The published prefix and the full signature are recorded separately in the vectors, so
   * publishing the wrong number of characters cannot pass. Nine would still be a prefix of the
   * signature and still change when the secret changes; it simply would not be the thing the
   * other side prints.
   */
  it('publishes exactly the first 8 characters of the full signature', async () => {
    for (const v of vectors.parity.cases) {
      expect(v.signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(v.fingerprint, v.name).toHaveLength(vectors.parity.fingerprintLength);
      expect(v.signature.slice(0, vectors.parity.fingerprintLength), v.name).toBe(v.fingerprint);
      expect(await parityFingerprint(v.secret), v.name).toHaveLength(
        vectors.parity.fingerprintLength,
      );
    }
  });

  /**
   * What the fingerprint is FOR: it moves when the secret moves. A trailing newline picked up by
   * `wrangler secret put` is a different secret, and this is the diagnostic that says so out loud
   * instead of leaving somebody reading Worker logs.
   */
  it('changes when the secret changes, including for a single trailing newline', async () => {
    const clean = await parityFingerprint(vectors.secret);
    expect(await parityFingerprint(`${vectors.secret}\n`)).not.toBe(clean);
    expect(await parityFingerprint(vectors.rotation.previousSecret)).not.toBe(clean);
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

  /**
   * The whole routing table, driven from the vectors.
   *
   * Unlike every other section of that file these expectations are not openssl output, because
   * routing hashes nothing. They are the rule written down: a key routes only when it has a
   * slash, the text before it is non-empty, and that text is exactly one of MEDIA_KINDS.
   */
  it('routes exactly as the routing vectors specify', () => {
    for (const v of vectors.routing.cases) {
      expect(bucketRoleForObjectKey(v.objectKey), v.name).toBe(v.bucketRole);
    }
  });

  /**
   * The case a red team found on 2026-08-21, and the reason it survived a test suite that
   * already had a "refuses anything else" list in it.
   *
   * The prefix was computed as `slice(0, indexOf('/'))`. `indexOf` answers -1 when there is no
   * slash, and `slice` reads a negative end as "drop the last character" rather than as
   * "nothing", so a SLASHLESS key was silently routed on its own value minus one character.
   * `photos` became `photo` and was served out of the private bucket; driven end to end in
   * workerd it answered 200 with real bytes.
   *
   * Why the existing list missed it: it held `photos/2026-04/x`, which has a slash and so has a
   * genuinely unknown prefix, and `photo`, which loses a real character and becomes `phot`.
   * Neither is the broken shape. **The pairing below is the assertion.** Each kind is checked
   * slashless, slashless-plus-a-character, and in both slashed spellings, so the two cases that
   * look alike and behave differently sit next to each other. Derived from MEDIA_KINDS rather
   * than written out, so a fourth kind is covered the day it is added.
   */
  it('never routes a slashless key, however much it resembles a kind', () => {
    for (const kind of MEDIA_KINDS) {
      expect(bucketRoleForObjectKey(kind), kind).toBeNull();
      expect(bucketRoleForObjectKey(`${kind}s`), `${kind}s`).toBeNull();
      expect(bucketRoleForObjectKey(`${kind}Z`), `${kind}Z`).toBeNull();
      expect(bucketRoleForObjectKey(`x${kind}`), `x${kind}`).toBeNull();
      // The slashed spellings of the same two strings, which is what the old list covered. A
      // real prefix still routes; an unknown one still does not.
      expect(bucketRoleForObjectKey(`${kind}/2026-04/x`), kind).toBe(kindToBucketRole[kind]);
      expect(bucketRoleForObjectKey(`${kind}s/2026-04/x`), `${kind}s/`).toBeNull();
    }
  });

  /**
   * An empty first segment is refused on purpose.
   *
   * Stated plainly because this one passes today for the wrong reason: `''` happens not to be a
   * key of `kindToBucketRole`, so the refusal is a side effect of the lookup rather than a
   * decision. That is the shape failure mode 37 warns about, an assertion whose expected value
   * is also what the system does by accident, so the guard it pins is proved by mutation below
   * rather than by this test having ever been red.
   */
  it('refuses an empty first segment as a decision, not as a lookup miss', () => {
    for (const key of ['/photo/2026-04/x', '//photo/2026-04/x', '/', '/avatar/2026-04/x']) {
      expect(bucketRoleForObjectKey(key), key).toBeNull();
    }
  });

  /**
   * The other half of the same boundary: a trailing slash leaves a real first segment, so it
   * routes. Nothing is being read that could exist, since every key this project issues carries
   * a month and a uuid, but routing is a question about which bucket rather than about whether
   * an object is there, and answering it any other way would be a special case with no rule
   * behind it.
   */
  it('routes a real segment even when nothing follows the slash', () => {
    for (const kind of MEDIA_KINDS) {
      expect(bucketRoleForObjectKey(`${kind}/`), `${kind}/`).toBe(kindToBucketRole[kind]);
    }
  });
});
