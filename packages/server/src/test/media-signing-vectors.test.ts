import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import vectors from '@clubchat/shared/media-signing-vectors.json' with { type: 'json' };
import {
  PARITY_MESSAGE,
  parityFingerprint,
  verifyMediaSignature as verifyAgainstKeys,
} from '@clubchat/shared/media-signing';
import { signedMediaUrl, verifyMediaSignature } from '../media/pipeline.ts';
import type { MediaConfig } from '../media/pipeline.ts';

/**
 * The server half of the cross-runtime contract.
 *
 * `packages/shared` owns the implementation and asserts the vectors against it. Two things can
 * only be checked from here:
 *
 *  1. **An independent HMAC.** The vectors were generated with `openssl dgst -sha256 -hmac`; this
 *     re-derives them a third way with `node:crypto`, written out rather than imported. A mistake
 *     would have to be made identically in three places to survive. It cannot live in
 *     `packages/shared`, which compiles with no Node types precisely so it can be bundled into a
 *     Worker.
 *  2. **The wrappers this process actually calls.** `signedMediaUrl` in `pipeline.ts` takes a
 *     `MediaConfig` and defaults its clock, and it is that function, not the shared one, that
 *     mints the URL a member's browser follows.
 */
describe('the signing vectors, from the server side', () => {
  const config = {
    signingSecret: vectors.secret,
    cdnBaseUrl: vectors.cdnBaseUrl,
    publicBucket: 'clubchat-identity',
    privateBucket: 'clubchat-content',
    urlMode: 'cdn',
  } as unknown as MediaConfig;

  it('re-derives every vector with an independent node:crypto HMAC', () => {
    for (const v of vectors.sign) {
      const independent = createHmac('sha256', vectors.secret)
        .update(`${v.objectKey}:${v.exp}`)
        .digest('base64url');
      expect(independent, v.name).toBe(v.sig);
    }
  });

  it("mints the vector URL through the server's own wrapper", async () => {
    for (const v of vectors.sign) {
      const nowMs = (v.exp - 7200) * 1000 + 1;
      expect(await signedMediaUrl(config, v.objectKey, nowMs), v.name).toBe(v.url);
    }
  });

  it("accepts and refuses through the server's own wrapper", async () => {
    for (const v of vectors.verify) {
      expect(
        await verifyMediaSignature(config, v.objectKey, v.exp, v.sig, v.nowMs),
        v.name,
      ).toBe(v.accept);
    }
  });
});

/**
 * The three secrets the rotation vectors name, resolved to their literal strings.
 *
 * `signedWith` in the vector table says which key minted that case's signature. Reading it here
 * is what lets `node:crypto` re-derive the signature, and then the whole expected outcome, with
 * no help from the module under test.
 */
function secretNamed(signedWith: string): string {
  const secrets: Record<string, string> = {
    current: vectors.secret,
    previous: vectors.rotation.previousSecret,
    stranger: vectors.rotation.strangerSecret,
  };
  const secret = secrets[signedWith];
  if (secret === undefined) throw new Error(`rotation vectors name no secret "${signedWith}"`);
  return secret;
}

/**
 * Rotation, re-derived rather than replayed.
 *
 * The api signs and never verifies, so nothing in `packages/server` holds a previous key and the
 * pipeline wrapper still takes exactly one secret. What this file can still do, and what the
 * Worker's own suite cannot, is compute the answer a second way: `node:crypto` says which keys
 * really match, and the module has to agree with that rather than with itself.
 */
describe('rotation, from the server side', () => {
  it('re-derives every rotation signature with an independent node:crypto HMAC', () => {
    for (const v of vectors.rotation.cases) {
      const independent = createHmac('sha256', secretNamed(v.signedWith))
        .update(`${v.objectKey}:${v.exp}`)
        .digest('base64url');
      expect(independent, v.name).toBe(v.sig);
    }
  });

  /**
   * Not the signatures but the ANSWERS. Every `accept` in the table is recomputed here from the
   * expiry rule and an independent HMAC per offered key, so a wrong expectation written into the
   * vectors fails here rather than being asserted against itself forever.
   *
   * Note what this says about the empty list: `some` over no keys is false, which is the
   * fail-closed behaviour stated as arithmetic rather than as a special case.
   */
  it('re-derives every rotation OUTCOME, not merely the signatures', () => {
    for (const v of vectors.rotation.cases) {
      const live = v.exp * 1000 >= v.nowMs;
      const matches = v.secrets.some(
        (secret) =>
          createHmac('sha256', secret).update(`${v.objectKey}:${v.exp}`).digest('base64url') ===
          v.sig,
      );
      expect(live && matches, v.name).toBe(v.accept);
    }
  });

  it('agrees with that independent answer when the key list goes through the module', async () => {
    for (const v of vectors.rotation.cases) {
      expect(
        await verifyAgainstKeys(v.secrets, v.objectKey, v.exp, v.sig, v.nowMs),
        v.name,
      ).toBe(v.accept);
    }
  });

  /**
   * The api's own wrapper is unchanged and still takes one secret, which is the decision rather
   * than an omission: it signs and never verifies, so a `MEDIA_SIGNING_SECRET_PREVIOUS` on the Fly
   * app would be an environment variable nothing reads. Asserted so that adding one later has to
   * be a deliberate change to this expectation.
   */
  it("leaves the api's single-key wrapper alone, since the api never verifies in production", async () => {
    const config = {
      signingSecret: vectors.rotation.previousSecret,
      cdnBaseUrl: vectors.cdnBaseUrl,
    } as unknown as MediaConfig;
    const previousOnly = vectors.rotation.cases.find(
      (c) => c.signedWith === 'previous' && c.exp * 1000 >= c.nowMs,
    );
    if (previousOnly === undefined) throw new Error('no live rotation vector signed as previous');
    expect(
      await verifyMediaSignature(
        config,
        previousOnly.objectKey,
        previousOnly.exp,
        previousOnly.sig,
        previousOnly.nowMs,
      ),
    ).toBe(true);
    expect(
      await verifyMediaSignature(
        { ...config, signingSecret: vectors.secret } as unknown as MediaConfig,
        previousOnly.objectKey,
        previousOnly.exp,
        previousOnly.sig,
        previousOnly.nowMs,
      ),
    ).toBe(false);
  });
});

/**
 * The parity canary, re-derived the same independent way.
 *
 * Both sides publish this over `GET /__parity`, and the whole diagnostic is worthless if the two
 * sides can compute it differently. `node:crypto` here, `crypto.subtle` in the module, `openssl`
 * in the vectors: three implementations that have to agree on eight characters.
 */
describe('the parity fingerprint, from the server side', () => {
  it('signs the constant the vectors record', () => {
    expect(PARITY_MESSAGE).toBe(vectors.parity.message);
  });

  it('re-derives both fingerprints with an independent node:crypto HMAC', async () => {
    for (const v of vectors.parity.cases) {
      const independent = createHmac('sha256', v.secret).update(PARITY_MESSAGE).digest('base64url');
      expect(independent, v.name).toBe(v.signature);
      expect(independent.slice(0, vectors.parity.fingerprintLength), v.name).toBe(v.fingerprint);
      expect(await parityFingerprint(v.secret), v.name).toBe(v.fingerprint);
    }
  });

  /**
   * Eight characters of base64url is 48 bits of an HMAC-SHA256 over a constant printed in this
   * repo, so recovering the key from it is a full key search. Recorded as a test because the
   * value is published unauthenticated, and a later change that widened it would deserve to stop
   * here and be argued rather than merged.
   */
  it('publishes 8 characters, no more', async () => {
    expect(vectors.parity.fingerprintLength).toBe(8);
    for (const v of vectors.parity.cases) {
      expect(await parityFingerprint(v.secret), v.name).toHaveLength(8);
    }
  });
});
