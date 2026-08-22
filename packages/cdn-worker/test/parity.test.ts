/**
 * `GET /__parity`, the canary for the single likeliest failure in this deployment: the api and the
 * Worker holding different `MEDIA_SIGNING_SECRET` values.
 *
 * That fault presents as every photo 403ing, which reads as a broken Worker rather than as a wrong
 * password, and a trailing newline on one side of `wrangler secret put` is enough to cause it.
 *
 * ## How "matches between two Workers holding the same secret" is proved here
 *
 * There is one Worker in this isolate, so comparing it to itself would prove only that the route
 * is deterministic. The vectors' `parity` section is the second side: its `fingerprint` values came
 * from the same `openssl` pipeline as every signature in the file, over the constant
 * `clubchat-media-signing-parity-v1`. Asserting the Worker against those literals is exactly the
 * comparison the README runs against the api in production, with the api's answer written down in
 * advance. Two sides that both match the literal match each other.
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { CDN_ORIGIN, emptyBuckets, useSigningKeys, vectors } from './harness.ts';

// Storage is shared across tests in this file and no pool option changes that: see the note on
// `emptyBuckets`. This file seeds nothing today, and states the obligation anyway, because the
// leak it prevents shows up in whichever test is added next rather than in this one.
beforeEach(emptyBuckets);

const CURRENT = vectors.parity.cases.find((c) => c.secret === vectors.secret)!;
const PREVIOUS = vectors.parity.cases.find((c) => c.secret === vectors.rotation.previousSecret)!;

interface ParityBody {
  parity: string | null;
  previousParity: string | null;
  version: string;
}

async function parity(): Promise<{ response: Response; body: ParityBody }> {
  const response = await SELF.fetch(`${CDN_ORIGIN}/__parity`);
  return { response, body: (await response.json()) as ParityBody };
}

describe('the parity canary', () => {
  it('answers the contract shape as JSON with no-store', async () => {
    useSigningKeys(vectors.secret);

    const { response, body } = await parity();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    // A cached answer during a rotation is worse than no answer: it would report the key the
    // Worker held an hour ago, at the one moment somebody is asking which key it holds now.
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(body).sort()).toEqual(['parity', 'previousParity', 'version']);
    expect(typeof body.version).toBe('string');
  });

  it('publishes the fingerprint the vectors say, not one it agreed with itself about', async () => {
    useSigningKeys(vectors.secret);

    const { body } = await parity();

    expect(body.parity).toBe(CURRENT.fingerprint);
    expect(body.previousParity).toBeNull();
  });

  it('publishes eight characters, which is what makes the two sides comparable', async () => {
    useSigningKeys(vectors.secret);

    const { body } = await parity();

    expect(body.parity).toHaveLength(vectors.parity.fingerprintLength);
    // The prefix of the full signature, recorded separately in the vectors precisely so that
    // taking the wrong number of characters cannot pass.
    expect(CURRENT.signature.startsWith(body.parity ?? '')).toBe(true);
  });

  it('changes when the secret changes', async () => {
    useSigningKeys(vectors.secret);
    const first = (await parity()).body;

    useSigningKeys(vectors.rotation.previousSecret);
    const second = (await parity()).body;

    expect(first.parity).toBe(CURRENT.fingerprint);
    expect(second.parity).toBe(PREVIOUS.fingerprint);
    expect(first.parity).not.toBe(second.parity);
  });

  it('reports both keys, in the right fields, mid-rotation', async () => {
    // What the founder sees while a rotation is in flight, and the thing that tells him the Worker
    // still accepts the key the api was signing with an hour ago.
    useSigningKeys(vectors.secret, vectors.rotation.previousSecret);

    const { body } = await parity();

    expect(body).toMatchObject({
      parity: CURRENT.fingerprint,
      previousParity: PREVIOUS.fingerprint,
    });
  });

  it('does not swap the two fields', async () => {
    // The same two secrets the other way round. Without this, a Worker that reported its previous
    // key as `parity` would pass every assertion above.
    useSigningKeys(vectors.rotation.previousSecret, vectors.secret);

    const { body } = await parity();

    expect(body).toMatchObject({
      parity: PREVIOUS.fingerprint,
      previousParity: CURRENT.fingerprint,
    });
  });

  it('reports null when no secret is configured at all', async () => {
    // The fastest possible answer to "why is every photo 403ing", and the reason this route exists.
    useSigningKeys(null);

    const { response, body } = await parity();

    expect(response.status).toBe(200);
    expect(body.parity).toBeNull();
    expect(body.previousParity).toBeNull();
  });

  it('reports null for a secret set to the empty string', async () => {
    // `wrangler secret put` handed empty stdin stores one, and an empty string is a perfectly valid
    // HMAC key that nothing in the world signs with. Absent and empty must read the same, or the
    // diagnostic reports a fingerprint of nothing while every request 403s.
    useSigningKeys('', '');

    const { body } = await parity();

    expect(body.parity).toBeNull();
    expect(body.previousParity).toBeNull();
  });

  it('is stable across requests with the same secret', async () => {
    useSigningKeys(vectors.secret);

    const [first, second] = await Promise.all([parity(), parity()]);

    expect(first.body.parity).toBe(second.body.parity);
  });

  it('answers before the media path, so no signature is required', async () => {
    // `/__parity` carries no exp and no sig. If it were routed as an object key it would be a 403,
    // and the one route you need while everything is 403ing would be the one you cannot reach.
    useSigningKeys(vectors.secret);

    const { response } = await parity();

    expect(response.status).not.toBe(403);
  });
});
