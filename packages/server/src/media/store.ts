/**
 * The MediaStore port.
 *
 * A named interface with a thin adapter behind it, per "build the seams, not the scale" - the
 * production store is Cloudflare R2 and the development one is MinIO, and both are the same
 * S3-compatible implementation pointed at a different endpoint. A fake exists for unit tests.
 *
 * **The chat server never touches file bytes.** The client PUTs directly to object storage
 * against a presigned URL, and this module's job is issuing that URL and verifying afterwards
 * that what arrived matches what was declared. That is the whole reason the interface has no
 * `upload` method taking a buffer.
 */

export type PresignedUpload = {
  url: string;
  /** Headers the client must send with the PUT, if the signature covers any. */
  headers: Record<string, string>;
  expiresInSeconds: number;
};

export type ObjectHead = {
  exists: boolean;
  bytes: number;
  mime: string | null;
};

export interface MediaStore {
  /** A URL the client can PUT to directly, valid for a short window. */
  presignUpload(input: {
    bucket: string;
    objectKey: string;
    mime: string;
    maxBytes: number;
  }): Promise<PresignedUpload>;

  /**
   * What actually landed.
   *
   * Used to verify the upload rather than to trust it. A client that declared 1 MB and
   * uploaded 900 MB must be caught here, because the presigned URL alone cannot enforce a
   * size the client chose to ignore.
   */
  head(input: { bucket: string; objectKey: string }): Promise<ObjectHead>;

  /** Read an object's bytes. Only the worker needs this, for deriving thumbnails. */
  get(input: { bucket: string; objectKey: string }): Promise<Uint8Array>;

  /** Write derived bytes. Thumbnails, nothing else. */
  put(input: {
    bucket: string;
    objectKey: string;
    body: Uint8Array;
    mime: string;
  }): Promise<void>;

  /**
   * A URL that reads an object directly from the store, for environments with no CDN.
   *
   * > **This exists because the custom `exp`/`sig` scheme is validated by the CDN edge, not by
   * > the object store.** Production puts a signature-checking CDN in front of the bucket, and
   * > the hour-aligned HMAC is what gives every viewer a byte-identical URL and therefore one
   * > shared cache entry. Point that same URL straight at the bucket and it is just an
   * > unauthenticated GET on private content, which is correctly refused with 403 - so
   * > development, which has no CDN, needs the store to do the signing instead.
   *
   * `signingDateMs` is pinned by the caller rather than defaulted to now, and that is the whole
   * reason this takes a date at all: a presigned URL embeds its signing timestamp, so signing
   * with "now" produces a different URL on every request and destroys the cache-sharing property
   * the alignment was designed for. Pinned to the hour, the URL is deterministic within the
   * window exactly as the CDN scheme is.
   */
  presignDownload(input: {
    bucket: string;
    objectKey: string;
    signingDateMs: number;
    expiresInSeconds: number;
  }): Promise<string>;

  /** Remove an object. Used by the nightly GC and nothing else. */
  remove(input: { bucket: string; objectKey: string }): Promise<void>;

  /** Create the buckets if they do not exist. Development convenience only. */
  ensureBuckets(buckets: readonly string[]): Promise<void>;
}

/** How long a presigned upload URL stays valid. */
export const UPLOAD_URL_TTL_SECONDS = 300;

// ---------------------------------------------------------------------------
// Limits, which v1 did not have at all
// ---------------------------------------------------------------------------

/**
 * Accepted image types.
 *
 * An allowlist rather than a blocklist. Roadmap debt 9 records that v1 had **no size or MIME
 * limits on any bucket**, so a member could upload an arbitrarily large "document" and
 * documents were never type-restricted. Enforced at intent AND re-verified at complete,
 * because a presigned URL cannot police what the client actually sends.
 */
export const IMAGE_MIME_ALLOWLIST: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
];

/**
 * Document types.
 *
 * Deliberately narrow. "Any file type" is what the product says a member may attach, but
 * accepting genuinely anything means accepting executables, and documents are not scanned.
 * This is the conservative reading; widening it is a product decision rather than a config
 * tweak, which is why the list is here and not in an environment variable.
 */
export const DOCUMENT_MIME_ALLOWLIST: readonly string[] = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
];

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The S3-compatible implementation
// ---------------------------------------------------------------------------

export type S3Config = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * The three deadlines below, and the retry ceiling, overridable for tests only.
   *
   * Production and development both take the defaults - a timeout that differs between the two
   * is a timeout that has never been exercised where it matters. `store.test.ts` scales them
   * down so an assertion about giving up does not cost ten seconds of wall clock each time.
   */
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  socketTimeoutMs?: number;
  maxAttempts?: number;
};

/**
 * How long establishing the TCP connection may take.
 *
 * A connect to an object store that has not completed in three seconds is a broken network path,
 * not a slow one. Both MinIO on the same host and R2 from a Fly machine answer in milliseconds.
 */
export const STORE_CONNECTION_TIMEOUT_MS = 3_000;

/**
 * How long the store has to produce a response - meaning its HEADERS, not its whole body.
 *
 * The distinction is load-bearing and is easy to get backwards. `@smithy/node-http-handler`
 * clears this timer the moment the response callback fires, which is when the status line and
 * headers have arrived; the body then streams under `socketTimeout` below. So ten seconds here
 * is not a ceiling on downloading a 25 MB photo, which would be far too tight. It is a ceiling
 * on the store saying anything at all.
 */
export const STORE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long the socket may go completely silent before the request is destroyed.
 *
 * This is the half `requestTimeout` cannot cover: a store that sends headers and then stalls
 * mid-body leaves `transformToByteArray()` waiting forever, because the request-level timer has
 * already been cleared. Five seconds of *no bytes at all* is a dead connection on any transfer
 * that is still making progress.
 *
 * **It must stay under six seconds.** The handler registers the socket listener immediately for
 * values below 6000 ms and defers registration by a second above it - and that deferred
 * registration is cancelled when the response arrives. A larger value would therefore silently
 * never arm on exactly the fast-headers-then-stall case it exists for.
 */
export const STORE_SOCKET_TIMEOUT_MS = 5_000;

/**
 * How many times one call may be attempted.
 *
 * Pinned rather than inherited, because it is a multiplier on every deadline above and the
 * arithmetic matters: three attempts bounds a single storage call at roughly forty seconds, and
 * `db/client.ts` sizes `idle_in_transaction_session_timeout` against that number. Leaving it to
 * the SDK's default would let a dependency bump move a ceiling this codebase reasons about.
 */
export const STORE_MAX_ATTEMPTS = 3;

/**
 * A storage operation that did not produce a usable answer.
 *
 * > **The one thing this exists to prevent: "not there" and "cannot ask" being the same value.**
 * > `head` used to catch everything and return `{ exists: false }`, so a real 404, a 403 from a
 * > rotated credential, a DNS failure and a timeout were indistinguishable - and `completeUpload`
 * > answered all four with `not_uploaded`, which tells the client to finish the upload and retry.
 * > A mistyped R2 secret therefore looked exactly like members abandoning uploads, in a system
 * > where nothing was reported to the monitor either.
 *
 * Every path through the S3 adapter that fails now throws this, carrying the operation and the
 * object so the report says which call against which key went wrong. The original SDK error is
 * on `cause`, per the rule in AGENTS.md 5.3 entry 1 about not losing the layer underneath.
 *
 * The credential is deliberately not in here. This error is logged and captured, and
 * non-negotiable 5 says a key that bypasses authorization never appears in a log.
 */
export type MediaStoreOperation = 'head' | 'get' | 'put' | 'remove';

export class MediaStoreError extends Error {
  readonly operation: MediaStoreOperation;
  readonly bucket: string;
  readonly objectKey: string;

  constructor(
    operation: MediaStoreOperation,
    target: { bucket: string; objectKey: string },
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    super(`media store ${operation} of ${target.bucket}/${target.objectKey} failed - ${detail}`, {
      cause,
    });
    this.name = 'MediaStoreError';
    this.operation = operation;
    this.bucket = target.bucket;
    this.objectKey = target.objectKey;
  }
}

/**
 * Did the store answer, definitively, that this object is not there?
 *
 * The only negative answer `head` is allowed to return without throwing. A HEAD carries no body,
 * so the status code is the whole of what the SDK has to classify by - which is also why nothing
 * subtler than this is possible or wanted. Anything else, including a 403 and a 5xx, is the
 * store failing to answer the question rather than answering it "no".
 */
function isDefinitelyAbsent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status !== undefined) return status === 404;
  const name = (error as { name?: string }).name;
  return name === 'NotFound' || name === 'NoSuchKey';
}

/**
 * S3-compatible storage. MinIO in development, Cloudflare R2 in production.
 *
 * `forcePathStyle` is required for MinIO, which serves buckets as path prefixes rather than as
 * subdomains. R2 tolerates it too, so one setting covers both rather than branching on
 * environment - a branch there would mean the development path is not the production path,
 * which defeats the point of running real storage locally.
 */
export class S3MediaStore implements MediaStore {
  private clientPromise: Promise<{
    client: import('@aws-sdk/client-s3').S3Client;
    lib: typeof import('@aws-sdk/client-s3');
    presign: typeof import('@aws-sdk/s3-request-presigner');
  }> | null = null;

  private readonly config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
  }

  /**
   * Loaded lazily.
   *
   * The AWS SDK is a large dependency and the gateway never touches media, so importing it at
   * module load would cost every process for the benefit of one. Cached after the first call.
   */
  private async sdk() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const lib = await import('@aws-sdk/client-s3');
        const presign = await import('@aws-sdk/s3-request-presigner');
        const client = new lib.S3Client({
          endpoint: this.config.endpoint,
          region: this.config.region,
          credentials: {
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey,
          },
          forcePathStyle: true,
          /*
           * **`WHEN_REQUIRED`, because the SDK's default silently corrupts a presigned upload.**
           *
           * The default is `WHEN_SUPPORTED`, which adds a flexible checksum to a PUT. On a
           * presigned URL that goes wrong twice over: the checksum is computed when the URL is
           * SIGNED, over a body that does not exist yet - the signature carried
           * `x-amz-checksum-crc32=AAAAAA==`, the CRC32 of nothing - and it puts the transfer into
           * `aws-chunked` framing. The uploader is a plain `fetch` that knows none of this, so the
           * chunk header and trailing checksum land in the object as data.
           *
           * The effect: a 3,002,684-byte photo was stored as 3,002,780. Exactly 96 bytes of
           * framing, on every attachment sent from a phone. `completeUpload` compares the declared
           * count against the object's real length with no tolerance, so all of them were refused
           * as `mismatch` - "the upload did not arrive intact" - and the bytes really had been
           * altered, just by us rather than by the network.
           *
           * Turning it off does not weaken anything. Integrity here is `completeUpload` HEADing
           * the object and re-checking size and type against what was declared, which is a
           * stronger guarantee than a checksum the client computes about itself.
           */
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
          /*
           * **Without this block a storage call has no deadline of any kind, and the SDK's retry
           * never engages - because nothing throws.**
           *
           * Every default here is 0, meaning no timeout. Storage that accepts the TCP connection
           * and then never answers therefore leaves `store.get()` neither resolved nor rejected,
           * forever. That is not a hypothetical shape: it is what a hung load balancer, a
           * saturated bucket and a half-open connection through a NAT all look like from here.
           *
           * Where it lands worst: the `media.uploaded` handler awaits `store.get` through
           * `deriveVariants`, and `worker/drain.ts` awaits that handler INSIDE its transaction,
           * holding `FOR UPDATE` on up to fifty claimed outbox rows. One silent endpoint stops
           * every partition's effects indefinitely - no notifications, no cards, no system
           * messages - with no error, no retry, no parked row and nothing in the log. The
           * request path has the same shape one layer up: `/media/:id/complete` HEADs and GETs
           * the object while the caller holds a connection.
           *
           * **`throwOnRequestTimeout` is the load-bearing line and reads like boilerplate.**
           * `requestTimeout` on its own does NOT abort anything: `@smithy/node-http-handler`
           * only logs a warning when it lapses, and says so in its own source - the flag is
           * required to turn that warning into a `TimeoutError`. Setting the timeout without
           * the flag is a fix that typechecks, reads correctly, and leaves the bug exactly
           * where it was.
           */
          requestHandler: {
            connectionTimeout: this.config.connectionTimeoutMs ?? STORE_CONNECTION_TIMEOUT_MS,
            requestTimeout: this.config.requestTimeoutMs ?? STORE_REQUEST_TIMEOUT_MS,
            throwOnRequestTimeout: true,
            socketTimeout: this.config.socketTimeoutMs ?? STORE_SOCKET_TIMEOUT_MS,
          },
          maxAttempts: this.config.maxAttempts ?? STORE_MAX_ATTEMPTS,
        });
        return { client, lib, presign };
      })();
    }
    return this.clientPromise;
  }

  async ensureBuckets(buckets: readonly string[]): Promise<void> {
    const { client, lib } = await this.sdk();
    for (const bucket of buckets) {
      try {
        await client.send(new lib.HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new lib.CreateBucketCommand({ Bucket: bucket }));
      }
    }
  }

  async presignUpload(input: {
    bucket: string;
    objectKey: string;
    mime: string;
    maxBytes: number;
  }): Promise<PresignedUpload> {
    const { client, lib, presign } = await this.sdk();
    const command = new lib.PutObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
      ContentType: input.mime,
    });
    const url = await presign.getSignedUrl(client, command, {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    });
    return {
      url,
      // The signature covers Content-Type, so the client must send the same value it
      // declared. That does not stop it sending different BYTES, which is why complete
      // re-verifies rather than trusting this.
      headers: { 'content-type': input.mime },
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  async presignDownload(input: {
    bucket: string;
    objectKey: string;
    signingDateMs: number;
    expiresInSeconds: number;
  }): Promise<string> {
    const { client, lib, presign } = await this.sdk();
    const command = new lib.GetObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
    });
    return presign.getSignedUrl(client, command, {
      expiresIn: input.expiresInSeconds,
      // The pinned date. Without it the SDK stamps `new Date()` into `X-Amz-Date` and every
      // caller gets a different URL for the same bytes.
      signingDate: new Date(input.signingDateMs),
    });
  }

  async head(input: { bucket: string; objectKey: string }): Promise<ObjectHead> {
    const { client, lib } = await this.sdk();
    try {
      const result = await client.send(
        new lib.HeadObjectCommand({ Bucket: input.bucket, Key: input.objectKey }),
      );
      return {
        exists: true,
        bytes: Number(result.ContentLength ?? 0),
        mime: result.ContentType ?? null,
      };
    } catch (error) {
      // The ONE non-throwing negative answer this port has, and it is now narrow: the store
      // said 404. Everything else means the question was not answered, and answering it "no"
      // anyway is what made a rotated credential indistinguishable from an abandoned upload.
      if (isDefinitelyAbsent(error)) return { exists: false, bytes: 0, mime: null };
      throw new MediaStoreError('head', input, error);
    }
  }

  async get(input: { bucket: string; objectKey: string }): Promise<Uint8Array> {
    const { client, lib } = await this.sdk();
    try {
      const result = await client.send(
        new lib.GetObjectCommand({ Bucket: input.bucket, Key: input.objectKey }),
      );
      // Inside the try on purpose: the body streams AFTER the response resolves, so a store
      // that sends headers and then stalls fails here rather than at the send above.
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) throw new Error('the response carried no body');
      return bytes;
    } catch (error) {
      throw new MediaStoreError('get', input, error);
    }
  }

  async put(input: {
    bucket: string;
    objectKey: string;
    body: Uint8Array;
    mime: string;
  }): Promise<void> {
    const { client, lib } = await this.sdk();
    try {
      await client.send(
        new lib.PutObjectCommand({
          Bucket: input.bucket,
          Key: input.objectKey,
          Body: input.body,
          ContentType: input.mime,
        }),
      );
    } catch (error) {
      throw new MediaStoreError('put', input, error);
    }
  }

  async remove(input: { bucket: string; objectKey: string }): Promise<void> {
    const { client, lib } = await this.sdk();
    try {
      await client.send(
        new lib.DeleteObjectCommand({ Bucket: input.bucket, Key: input.objectKey }),
      );
    } catch (error) {
      throw new MediaStoreError('remove', input, error);
    }
  }
}

// ---------------------------------------------------------------------------
// The fake, for unit tests
// ---------------------------------------------------------------------------

/**
 * An in-memory store.
 *
 * Used where the test is about authorization or bookkeeping rather than about storage. The
 * integration path runs against MinIO, because a fake would happily accept the presigned-PUT
 * flow and the HEAD verification while a real bucket rejected them - which is exactly the class
 * of bug that only shows up in production.
 */
export class FakeMediaStore implements MediaStore {
  readonly objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  readonly removed: string[] = [];
  /** Set to simulate a client that uploaded something other than what it declared. */
  headOverride: ((key: string) => ObjectHead | null) | null = null;
  /**
   * Set to simulate storage that cannot be reached, as distinct from an object that is not there.
   *
   * The two used to be the same value and that was the bug - see `MediaStoreError`. A fake with
   * no way to express "the store did not answer" cannot test the difference.
   */
  failWith: MediaStoreError | null = null;

  private key(bucket: string, objectKey: string) {
    return `${bucket}/${objectKey}`;
  }

  async ensureBuckets(): Promise<void> {}

  async presignUpload(input: {
    bucket: string;
    objectKey: string;
    mime: string;
  }): Promise<PresignedUpload> {
    return {
      url: `https://fake.invalid/${input.bucket}/${input.objectKey}?signed=1`,
      headers: { 'content-type': input.mime },
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  async presignDownload(input: {
    bucket: string;
    objectKey: string;
    signingDateMs: number;
    expiresInSeconds: number;
  }): Promise<string> {
    // Deterministic within a window, like the real one, so a test can assert two resolves in
    // the same hour produce the identical string.
    return `https://fake.invalid/${input.bucket}/${input.objectKey}?d=${input.signingDateMs}&e=${input.expiresInSeconds}`;
  }

  /** Stand in for the client's direct PUT. */
  simulateUpload(bucket: string, objectKey: string, bytes: Uint8Array, mime: string) {
    this.objects.set(this.key(bucket, objectKey), { bytes, mime });
  }

  async head(input: { bucket: string; objectKey: string }): Promise<ObjectHead> {
    if (this.failWith) throw this.failWith;
    const override = this.headOverride?.(input.objectKey);
    if (override) return override;
    const found = this.objects.get(this.key(input.bucket, input.objectKey));
    if (!found) return { exists: false, bytes: 0, mime: null };
    return { exists: true, bytes: found.bytes.byteLength, mime: found.mime };
  }

  async get(input: { bucket: string; objectKey: string }): Promise<Uint8Array> {
    if (this.failWith) throw this.failWith;
    const found = this.objects.get(this.key(input.bucket, input.objectKey));
    if (!found) throw new Error('not found');
    return found.bytes;
  }

  async put(input: {
    bucket: string;
    objectKey: string;
    body: Uint8Array;
    mime: string;
  }): Promise<void> {
    this.objects.set(this.key(input.bucket, input.objectKey), {
      bytes: input.body,
      mime: input.mime,
    });
  }

  async remove(input: { bucket: string; objectKey: string }): Promise<void> {
    this.objects.delete(this.key(input.bucket, input.objectKey));
    this.removed.push(this.key(input.bucket, input.objectKey));
  }
}
