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
};

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
    } catch {
      return { exists: false, bytes: 0, mime: null };
    }
  }

  async get(input: { bucket: string; objectKey: string }): Promise<Uint8Array> {
    const { client, lib } = await this.sdk();
    const result = await client.send(
      new lib.GetObjectCommand({ Bucket: input.bucket, Key: input.objectKey }),
    );
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) throw new Error(`object ${input.objectKey} had no body`);
    return bytes;
  }

  async put(input: {
    bucket: string;
    objectKey: string;
    body: Uint8Array;
    mime: string;
  }): Promise<void> {
    const { client, lib } = await this.sdk();
    await client.send(
      new lib.PutObjectCommand({
        Bucket: input.bucket,
        Key: input.objectKey,
        Body: input.body,
        ContentType: input.mime,
      }),
    );
  }

  async remove(input: { bucket: string; objectKey: string }): Promise<void> {
    const { client, lib } = await this.sdk();
    await client.send(
      new lib.DeleteObjectCommand({ Bucket: input.bucket, Key: input.objectKey }),
    );
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

  /** Stand in for the client's direct PUT. */
  simulateUpload(bucket: string, objectKey: string, bytes: Uint8Array, mime: string) {
    this.objects.set(this.key(bucket, objectKey), { bytes, mime });
  }

  async head(input: { bucket: string; objectKey: string }): Promise<ObjectHead> {
    const override = this.headOverride?.(input.objectKey);
    if (override) return override;
    const found = this.objects.get(this.key(input.bucket, input.objectKey));
    if (!found) return { exists: false, bytes: 0, mime: null };
    return { exists: true, bytes: found.bytes.byteLength, mime: found.mime };
  }

  async get(input: { bucket: string; objectKey: string }): Promise<Uint8Array> {
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
