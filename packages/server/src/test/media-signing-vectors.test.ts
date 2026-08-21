import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import vectors from '@clubchat/shared/media-signing-vectors.json' with { type: 'json' };
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
