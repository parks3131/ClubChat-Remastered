/**
 * The success half of the Worker: real bytes out of a real bucket, and the headers around them.
 *
 * Everything here starts from a vector, so no signature in this file was produced by the code that
 * checks it. The bytes are seeded by the test, which is the other half of the pair: a status code
 * says a response happened, and only comparing the body says the right object answered.
 */

import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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

/** The ordinary photo, and the vector that says which millisecond it is valid at. */
const PHOTO = vectors.verify[0]!;
const AVATAR = vectors.sign.find((v) => v.bucketRole === 'identity')!;
const THUMB = vectors.sign.find((v) => v.objectKey.endsWith('.thumb.webp'))!;

/** Ten bytes, binary and not text, so a body that survived a text round trip would be visible. */
const PAYLOAD = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0xfb, 0xfc, 0xfd, 0xfe, 0xff]);

beforeEach(emptyBuckets);

afterEach(() => {
  vi.useRealTimers();
});

async function seedPhoto(contentType = 'image/jpeg'): Promise<void> {
  useSigningKeys(vectors.secret);
  atMoment(VALID_NOW_MS);
  await env.CONTENT.put(PHOTO.objectKey, PAYLOAD, { httpMetadata: { contentType } });
}

function photoUrl(): string {
  return mediaUrl(PHOTO.objectKey, PHOTO.exp, PHOTO.sig);
}

/** The two headers every response built from a stored object carries. */
const NOSNIFF = 'nosniff';
const OBJECT_CSP = "default-src 'none'; sandbox";

describe('a real byte read', () => {
  it('serves the exact stored bytes with the hit headers', async () => {
    await seedPhoto();

    const response = await SELF.fetch(photoUrl());

    expect(response.status).toBe(HIT_STATUS);
    expect(await bodyBytes(response)).toEqual([...PAYLOAD]);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    // The stored Content-Type and not one guessed from the path. Originals carry no file
    // extension, so the upload's record of the type is the only record there is.
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
  });

  it('serves a stored type that the key cannot possibly imply', async () => {
    // A PDF whose key has no extension. If the Worker ever guessed from the path this is the
    // assertion that would notice, and a document served as octet-stream downloads rather than
    // opening.
    await seedPhoto('application/pdf');

    const response = await SELF.fetch(photoUrl());

    expect(response.headers.get('content-type')).toBe('application/pdf');
  });

  it('does not let the uploader choose the edge lifetime', async () => {
    // `writeHttpMetadata` writes a Cache-Control too if one was stored at upload time, which is
    // why the Worker sets its own AFTER calling it. Reversing those two lines is invisible unless
    // an object actually carries the header.
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await env.CONTENT.put(PHOTO.objectKey, PAYLOAD, {
      httpMetadata: { contentType: 'image/jpeg', cacheControl: 'private, max-age=1' },
    });

    const response = await SELF.fetch(photoUrl());

    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('serves a derived variant, whose key carries two dots', async () => {
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await env.CONTENT.put(THUMB.objectKey, PAYLOAD, { httpMetadata: { contentType: 'image/webp' } });

    const response = await SELF.fetch(mediaUrl(THUMB.objectKey, THUMB.exp, THUMB.sig));

    expect(response.status).toBe(HIT_STATUS);
    expect(await bodyBytes(response)).toEqual([...PAYLOAD]);
  });
});

/**
 * Which bucket answered, proved by the bytes rather than by reading the routing table.
 *
 * The same key goes into BOTH buckets with different contents, so a Worker that reads the wrong
 * bucket still finds an object and still answers 200. Only the body says which one it was.
 */
describe('both buckets', () => {
  it('reads an avatar from IDENTITY while CONTENT holds the same key', async () => {
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await seedBothBuckets(AVATAR.objectKey, 'image/webp');

    const response = await SELF.fetch(mediaUrl(AVATAR.objectKey, AVATAR.exp, AVATAR.sig));

    expect(response.status).toBe(HIT_STATUS);
    expect(await bodyBytes(response)).toEqual([...IDENTITY_BYTES]);
  });

  it('reads a photo from CONTENT while IDENTITY holds the same key', async () => {
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await seedBothBuckets(PHOTO.objectKey, 'image/webp');

    const response = await SELF.fetch(photoUrl());

    expect(response.status).toBe(HIT_STATUS);
    expect(await bodyBytes(response)).toEqual([...CONTENT_BYTES]);
  });
});

describe('an object that is not there', () => {
  it('is a 404 with no-store', async () => {
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    // Nothing seeded. The signature is a valid vector, so the only reason to refuse is the miss.

    const response = await SELF.fetch(photoUrl());

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await bodyBytes(response)).toEqual([]);
  });

  // The other half of this - that a miss is indistinguishable from an unroutable prefix - lives in
  // `routing.test.ts`, because the comparison needs a validly signed unroutable key and that file
  // is the one allowed to sign.
});

describe('method handling', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    it(`answers ${method} with 405 and an Allow header`, async () => {
      await seedPhoto();

      const response = await SELF.fetch(photoUrl(), { method });

      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await bodyBytes(response)).toEqual([]);
    });
  }

  it('rejects the method before it looks at the path', async () => {
    // The diagnostic route is not exempt, and the ordering is what guarantees that rather than a
    // second check inside it.
    const response = await SELF.fetch(`${CDN_ORIGIN}/__parity`, { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('answers HEAD with no body and the length the body would have had', async () => {
    await seedPhoto();

    const response = await SELF.fetch(photoUrl(), { method: 'HEAD' });

    expect(response.status).toBe(HIT_STATUS);
    expect(await bodyBytes(response)).toEqual([]);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    // Carried by hand, because there is no body for the runtime to infer it from - which is the
    // whole reason a client sends a HEAD. It read `NaN` for the whole life of the first version.
    expect(response.headers.get('content-length')).toBe(String(PAYLOAD.length));
  });

  it('answers HEAD for a missing object with 404, not an empty 200', async () => {
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);

    const response = await SELF.fetch(photoUrl(), { method: 'HEAD' });

    expect(response.status).toBe(404);
  });
});

/**
 * Conditional and Range, which the Worker does not implement: it hands `request.headers` straight
 * to R2 as both `onlyIf` and `range`. That is a deliberate choice and it is worth pinning, because
 * the behaviour it produces is entirely R2's and nothing in this package would notice it changing.
 */
describe('conditional requests', () => {
  it('answers If-None-Match with the current etag as 304 and no body', async () => {
    await seedPhoto();
    const first = await SELF.fetch(photoUrl());
    const etag = first.headers.get('etag')!;

    const second = await SELF.fetch(photoUrl(), { headers: { 'if-none-match': etag } });

    expect(second.status).toBe(304);
    expect(await bodyBytes(second)).toEqual([]);
    // The cache headers are still set on a 304: that is what refreshes the client's copy for
    // another hour instead of leaving it to expire and re-fetch the same bytes.
    expect(second.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(second.headers.get('etag')).toBe(etag);
  });

  it('serves the bytes when If-None-Match names a different etag', async () => {
    await seedPhoto();

    const response = await SELF.fetch(photoUrl(), {
      headers: { 'if-none-match': '"00000000000000000000000000000000"' },
    });

    expect(response.status).toBe(HIT_STATUS);
    expect(await bodyBytes(response)).toEqual([...PAYLOAD]);
  });
});

describe('range requests', () => {
  it('answers a genuine partial range with 206, those bytes, and correct extents', async () => {
    await seedPhoto();

    const response = await SELF.fetch(photoUrl(), { headers: { range: 'bytes=2-5' } });

    expect(response.status).toBe(206);
    expect(await bodyBytes(response)).toEqual([...PAYLOAD.slice(2, 6)]);
    expect(response.headers.get('content-range')).toBe(`bytes 2-5/${PAYLOAD.length}`);
  });

  it('answers a suffix range with the offsets counted from the end', async () => {
    // R2 resolves `bytes=-4` to `{offset: 6, length: 4}` server side, so this arrives at the
    // Worker through the offset branch. The suffix branch in `resolvedRange` is kept anyway, for a
    // runtime that resolves it differently; nothing on this stack reaches it.
    await seedPhoto();

    const response = await SELF.fetch(photoUrl(), { headers: { range: 'bytes=-4' } });

    expect(response.status).toBe(206);
    expect(await bodyBytes(response)).toEqual([...PAYLOAD.slice(-4)]);
    expect(response.headers.get('content-range')).toBe(`bytes 6-9/${PAYLOAD.length}`);
  });

  it('answers a request with no Range at all as 200 with no Content-Range', async () => {
    // The regression that started all of this. R2 hands back `{offset: 0, length: size}` for an
    // unranged read, so a Worker reading the PRESENCE of `object.range` calls every photo a
    // partial response.
    await seedPhoto();

    const response = await SELF.fetch(photoUrl());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-range')).toBeNull();
    expect(await bodyBytes(response)).toEqual([...PAYLOAD]);
  });

  it('answers a range covering the whole object as 200, not 206', async () => {
    /*
     * `bytes=0-` is the shape a resumed download uses when nothing has been received yet, and it
     * asks for the entire representation. 206 would be defensible; 200 is what this Worker chose,
     * and the choice follows from deciding partiality by comparing the SERVED extents to the object
     * size rather than by looking for a `Range` header.
     *
     * That is not a shortcut. R2 ignores any range it cannot parse or satisfy and serves the whole
     * object, so a header-driven rule would answer 206 with a `Content-Range` for requests the
     * server had declined - and RFC 9110 requires a server that ignores a `Range` to answer 200.
     * One rule gets both cases right; there is no rule that gets 206 here and 200 below.
     *
     * `Accept-Ranges: bytes` is still on the response, so a client that wants to resume still can.
     */
    await seedPhoto();

    const response = await SELF.fetch(photoUrl(), { headers: { range: 'bytes=0-' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-range')).toBeNull();
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(await bodyBytes(response)).toEqual([...PAYLOAD]);
  });

  it('turns R2 own unsatisfiable-range error into a 416', async () => {
    // The catch clause on its own terms, driven by a bucket that throws exactly what
    // miniflare's R2 throws: `node_modules/wrangler/node_modules/miniflare/dist/src/workers/r2/
    // bucket.worker.js` defines INVALID_RANGE: 10039 and throws it from `get`.
    await seedPhoto();
    const disarm = armTripwire('CONTENT', Object.assign(new Error('unsatisfiable'), { code: 10039 }));
    try {
      const response = await SELF.fetch(photoUrl(), { headers: { range: 'bytes=2-5' } });

      expect(response.status).toBe(416);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      disarm();
    }
  });

  it('does not disguise any other R2 failure as a client mistake', async () => {
    /*
     * A real outage must stay loud. If `isUnsatisfiableRange` ever loosened to "anything with a
     * code", an R2 incident would present to every client as a bad Range header and the dashboard
     * would show a clean Worker serving 416s.
     *
     * The rethrow is what makes this test print `uncaught exception; source = Uncaught (in promise)`
     * during the run. That line is the assertion succeeding, not a failure: it is the error
     * reaching the runtime instead of being swallowed, and it is exactly what `observability` in
     * `wrangler.jsonc` exists to surface, since nothing else reports an error from this Worker.
     */
    await seedPhoto();
    const disarm = armTripwire('CONTENT', Object.assign(new Error('internal error'), { code: 10001 }));
    try {
      const outcome = await SELF.fetch(photoUrl()).then(
        (response) => response.status,
        () => 'threw' as const,
      );

      expect(outcome).toBe('threw');
    } finally {
      disarm();
    }
  });
});

/**
 * The ranges R2 declines to apply, which the first version of this Worker could not describe.
 *
 * R2 does not reject a range it cannot use. It ignores it and serves the whole object, handing back
 * `{offset: 0, length: size}` exactly as it does for a request that carried no `Range` at all. That
 * covers a range past the end of the object, a multipart range, and an unrecognised unit, and it is
 * the reason this Worker decides 200 against 206 from the served extents rather than from the
 * presence of a request header: every case below carries a `Range`, and answering 206 for any of
 * them would be describing a partial response that was never sent.
 *
 * RFC 9110 is explicit that a server which ignores a `Range` answers 200, so this is the correct
 * behaviour rather than a tolerated one.
 */
describe('ranges R2 declines to apply', () => {
  const declined: ReadonlyArray<{ name: string; range: string }> = [
    { name: 'starts past the end of the object', range: 'bytes=900-1000' },
    { name: 'asks for two ranges at once', range: 'bytes=0-1,5-6' },
    { name: 'names a unit that does not exist', range: 'kilobytes=1-2' },
    { name: 'is not parseable at all', range: 'bytes=abc' },
    { name: 'is inverted', range: 'bytes=8-2' },
  ];

  for (const { name, range } of declined) {
    it(`serves the whole object with 200 when the range ${name}`, async () => {
      await seedPhoto();

      const response = await SELF.fetch(photoUrl(), { headers: { range } });

      expect(response.status).toBe(200);
      expect(await bodyBytes(response)).toEqual([...PAYLOAD]);
      expect(response.headers.get('content-range')).toBeNull();
    });
  }

  it('does not answer 416 for an unsatisfiable Range header', async () => {
    /*
     * Deliberate, and worth stating as its own assertion rather than leaving implied.
     *
     * A `Range` header cannot reach this Worker's 416 branch, because R2 only THROWS
     * `INVALID_RANGE` for an explicit `{offset, length}` range object; given a `Headers` it parses,
     * shrugs, and serves everything. The branch is kept because it is the only thing between a
     * thrown `R2Error` and an unreported 500 if production R2 throws where the emulator shrugs, and
     * the test above this block proves it converts a thrown `10039` correctly.
     *
     * So this asserts the absence on purpose: 416 is not what an over-long range produces here, and
     * `README.md` says so rather than the code pretending otherwise.
     */
    await seedPhoto();

    const response = await SELF.fetch(photoUrl(), { headers: { range: 'bytes=900-1000' } });

    expect(response.status).not.toBe(416);
    expect(response.status).toBe(200);
  });

  it('still reports the whole size to a HEAD carrying a declined range', async () => {
    // The `Content-Length` follows the served extents like everything else, so a declined range
    // reports the entire object rather than the slice that was asked for and not served.
    await seedPhoto();

    const response = await SELF.fetch(photoUrl(), {
      method: 'HEAD',
      headers: { range: 'bytes=900-1000' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(PAYLOAD.length));
    expect(await bodyBytes(response)).toEqual([]);
  });
});

/**
 * The headers that treat the stored object as hostile, and the one that is thrown away.
 *
 * Every byte and every piece of metadata on an object here was uploaded by a member straight to R2
 * through a presigned PUT, so `writeHttpMetadata` is replaying uploader-controlled input. None of
 * this is reachable today, because the MIME allowlists in `packages/server/src/media/store.ts`
 * contain no `text/html` and no `image/svg+xml`. That is exactly why it is asserted here: the
 * safety currently lives in another package, and whoever widens that allowlist will be editing
 * `packages/server` with no reason to think about the edge. These are the half of the pair that has
 * to already be true when that happens.
 */
describe('the headers a response built from an object carries', () => {
  it('sets nosniff and a locked-down CSP on a byte read', async () => {
    await seedPhoto();

    const response = await SELF.fetch(photoUrl());

    expect(response.status).toBe(HIT_STATUS);
    expect(response.headers.get('x-content-type-options')).toBe(NOSNIFF);
    expect(response.headers.get('content-security-policy')).toBe(OBJECT_CSP);
  });

  it('sets them on a HEAD, which is a response built from an object too', async () => {
    await seedPhoto();

    const response = await SELF.fetch(photoUrl(), { method: 'HEAD' });

    expect(response.status).toBe(HIT_STATUS);
    expect(response.headers.get('x-content-type-options')).toBe(NOSNIFF);
    expect(response.headers.get('content-security-policy')).toBe(OBJECT_CSP);
  });

  it('sets them on a 206, where a partial body is still a body', async () => {
    // A range request is the obvious way to fetch the first bytes of something and have a browser
    // decide what it is, so a partial response needs these at least as much as a whole one.
    await seedPhoto('text/plain');

    const response = await SELF.fetch(photoUrl(), { headers: { range: 'bytes=2-5' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('x-content-type-options')).toBe(NOSNIFF);
    expect(response.headers.get('content-security-policy')).toBe(OBJECT_CSP);
  });

  it('sets them on a 304, which refreshes what a client already holds', async () => {
    await seedPhoto();
    const first = await SELF.fetch(photoUrl());

    const second = await SELF.fetch(photoUrl(), {
      headers: { 'if-none-match': first.headers.get('etag')! },
    });

    expect(second.status).toBe(304);
    expect(second.headers.get('x-content-type-options')).toBe(NOSNIFF);
    expect(second.headers.get('content-security-policy')).toBe(OBJECT_CSP);
  });

  it('strips a Content-Disposition the uploader stored on the object', async () => {
    /*
     * The only one of these three that can regress silently, because it is a DELETION: adding a
     * missing header back is a visible edit, whereas removing the `headers.delete` line restores a
     * pass-through that looks like doing nothing.
     *
     * `writeHttpMetadata` replays whatever was stored, a presigned PUT means the uploader is a
     * member's device, and nothing in this project ever writes one: the api never sets it, and the
     * filename a member sees is built device-side from the `documentName` on the message envelope.
     * So it is uploader-controlled input that nothing consumes and that decides whether a response
     * renders inline or downloads.
     */
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await env.CONTENT.put(PHOTO.objectKey, PAYLOAD, {
      httpMetadata: {
        contentType: 'image/jpeg',
        contentDisposition: 'attachment; filename="not-the-name-the-app-uses.html"',
      },
    });

    const response = await SELF.fetch(photoUrl());

    expect(response.status).toBe(HIT_STATUS);
    expect(response.headers.get('content-disposition')).toBeNull();
    // The stored Content-Type still comes through, so this is a targeted deletion and not
    // `writeHttpMetadata` having been dropped altogether.
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(await bodyBytes(response)).toEqual([...PAYLOAD]);
  });

  it('strips it from a HEAD as well, where a browser still reads it', async () => {
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await env.CONTENT.put(PHOTO.objectKey, PAYLOAD, {
      httpMetadata: { contentType: 'image/jpeg', contentDisposition: 'inline' },
    });

    const response = await SELF.fetch(photoUrl(), { method: 'HEAD' });

    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('does not put them on a refusal, which carries no body to sniff or render', async () => {
    /*
     * Decided rather than left unasserted, and the decision is that a refusal stays bare.
     *
     * `refuse` builds its own response with `cache-control: no-store` and nothing else, and every
     * refusal has a null body. `nosniff` governs how a body is interpreted and the CSP governs what
     * a document may load; with no body there is nothing for either to act on, so adding them would
     * be bytes on every 403 in exchange for nothing.
     *
     * Pinned so the emptiness is a decision somebody made rather than a gap nobody noticed. A 405
     * is included because it is the one refusal that carries an extra header already, so it proves
     * the `extra` argument is not a door the security headers slipped through.
     */
    useSigningKeys(vectors.secret);
    atMoment(VALID_NOW_MS);
    await seedBothBuckets(PHOTO.objectKey, 'image/jpeg');

    const forbidden = await SELF.fetch(`${CDN_ORIGIN}/${PHOTO.objectKey}`);
    const methodNotAllowed = await SELF.fetch(photoUrl(), { method: 'POST' });

    expect([forbidden.status, methodNotAllowed.status]).toEqual([403, 405]);
    for (const response of [forbidden, methodNotAllowed]) {
      expect(response.headers.get('x-content-type-options')).toBeNull();
      expect(response.headers.get('content-security-policy')).toBeNull();
    }
    expect([...forbidden.headers]).toEqual([['cache-control', 'no-store']]);
    expect([...methodNotAllowed.headers].sort()).toEqual([
      ['allow', 'GET, HEAD'],
      ['cache-control', 'no-store'],
    ]);
  });
});
