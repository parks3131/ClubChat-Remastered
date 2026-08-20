/**
 * What the S3 adapter does when object storage misbehaves.
 *
 * Two classes, and neither is reachable through the fake - which is the point of running these
 * against a real socket rather than against `FakeMediaStore`.
 *
 *  1. **Storage that accepts the connection and never answers.** The SDK's retry never engages,
 *     because nothing throws. `deriveVariants` calls `store.get` from the `media.uploaded`
 *     handler, which the drain awaits INSIDE its transaction while holding `FOR UPDATE` on up to
 *     fifty outbox rows - so a silent endpoint stops every partition's effects indefinitely,
 *     with no error and no parked row to alarm on.
 *  2. **A `head` that cannot tell "not there" from "cannot ask".** A bare catch returning
 *     `{ exists: false }` collapses a real 404, a 403 from a rotated credential, a DNS failure
 *     and a timeout into one value - and `completeUpload` answers all four with `not_uploaded`,
 *     which tells the client to finish the upload and try again. A mistyped secret then looks
 *     exactly like members abandoning uploads.
 *
 * The servers below are deliberately not S3. HEAD carries no body, so the SDK classifies these
 * responses by status alone, which is the whole surface the adapter has to reason about.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaStoreError, S3MediaStore, type S3Config } from './store.ts';

const BUCKET = 'clubchat-private';
const KEY = 'photos/2026/08/a-photo.jpg';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** Start a server on an ephemeral port and hand back its origin. */
async function listening(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * A store pointed at a test endpoint, with the timeouts scaled down.
 *
 * `maxAttempts: 1` because the SDK's retry is not what is being tested here and three passes at
 * a deadline is three times the wall clock for the same assertion.
 */
function storeAt(endpoint: string, overrides: Partial<S3Config> = {}): S3MediaStore {
  return new S3MediaStore({
    endpoint,
    region: 'auto',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    connectionTimeoutMs: 250,
    requestTimeoutMs: 250,
    socketTimeoutMs: 250,
    maxAttempts: 1,
    ...overrides,
  });
}

describe('storage that accepts the connection and never answers', () => {
  it('gives up on get rather than leaving the drain transaction open forever', async () => {
    // The request is accepted and nothing is ever written back, which is what a hung load
    // balancer, a saturated bucket or a half-open connection through a NAT all look like.
    const endpoint = await listening(() => {});
    const store = storeAt(endpoint);

    const startedAt = Date.now();
    await expect(store.get({ bucket: BUCKET, objectKey: KEY })).rejects.toThrow(MediaStoreError);
    // Generous, because the assertion is "it ended", not "it ended in exactly 250ms". Before the
    // request handler was configured this promise never settled at all.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('gives up on head, and does not answer "the object is not there"', async () => {
    // The dangerous shape: a silent endpoint reported as an absent object sends the client back
    // to re-upload bytes that are already sitting in the bucket.
    const endpoint = await listening(() => {});
    const store = storeAt(endpoint);

    await expect(store.head({ bucket: BUCKET, objectKey: KEY })).rejects.toThrow(MediaStoreError);
  });
});

describe('head, and the difference between "not there" and "cannot ask"', () => {
  it('answers exists:false only for a store that says the object is not there', async () => {
    const endpoint = await listening((_request, response) => {
      response.writeHead(404).end();
    });

    await expect(storeAt(endpoint).head({ bucket: BUCKET, objectKey: KEY })).resolves.toEqual({
      exists: false,
      bytes: 0,
      mime: null,
    });
  });

  it('reports the object when the store has it', async () => {
    const endpoint = await listening((_request, response) => {
      response
        .writeHead(200, { 'content-length': '3002684', 'content-type': 'image/jpeg' })
        .end();
    });

    await expect(storeAt(endpoint).head({ bucket: BUCKET, objectKey: KEY })).resolves.toEqual({
      exists: true,
      bytes: 3002684,
      mime: 'image/jpeg',
    });
  });

  it('throws on a refusal, which is a rotated credential and not an absent object', async () => {
    // The scenario this whole test exists for: the R2 secret was rotated and re-typed with one
    // character wrong. Every HEAD is refused, every complete answered `not_uploaded`, and the
    // dashboard shows members apparently abandoning uploads.
    const endpoint = await listening((_request, response) => {
      response.writeHead(403).end();
    });

    const head = storeAt(endpoint).head({ bucket: BUCKET, objectKey: KEY });

    await expect(head).rejects.toThrow(MediaStoreError);
    await expect(head).rejects.toMatchObject({ operation: 'head' });
  });

  it('throws when the store answers with a fault of its own', async () => {
    const endpoint = await listening((_request, response) => {
      response.writeHead(503).end();
    });

    await expect(storeAt(endpoint).head({ bucket: BUCKET, objectKey: KEY })).rejects.toThrow(
      MediaStoreError,
    );
  });

  it('names the object in what it throws, without the credential that reached it', async () => {
    // Non-negotiable 5: this error is logged and captured, so it is built from the operation and
    // the key rather than from anything that would let a reader sign a request.
    const endpoint = await listening((_request, response) => {
      response.writeHead(403).end();
    });

    await storeAt(endpoint)
      .head({ bucket: BUCKET, objectKey: KEY })
      .then(
        () => expect.unreachable('a refused head must not resolve'),
        (error: unknown) => {
          expect(String(error)).toContain(KEY);
          expect(String(error)).not.toContain('test-secret');
        },
      );
  });
});
