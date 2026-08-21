/**
 * The media URL signature, and the only implementation of it.
 *
 * This module exists because the signature is now computed on one runtime and checked on another.
 * The api mints `?exp=&sig=` on a Fly machine running Node; a Cloudflare Worker on `workerd`
 * validates it at the edge before reading R2. Two implementations of one HMAC is the shape of a
 * bug that presents as "every photo is broken" with both sides looking correct in isolation, so
 * there is one implementation and both runtimes import it.
 *
 * **Written against WebCrypto, not `node:crypto`.** `crypto.subtle` is the only hash available on
 * `workerd`, and Node has exposed the same global since 19. That constraint is why this file lives
 * in `packages/shared`, which has no `node:` imports at all, rather than in `packages/server`.
 *
 * The consequence, stated because it is the whole ripple: `crypto.subtle` is async, so signing and
 * verifying are async here where the `node:crypto` originals were not.
 *
 * **Imported by subpath only** (`@clubchat/shared/media-signing`), never re-exported from
 * `index.ts`. `index.ts` pulls in `emoji-catalog.generated.ts`, which is a quarter of a megabyte
 * and has no business inside a Worker bundle.
 */

/**
 * The kinds of media this project stores, and the first path segment of every object key.
 *
 * `uploadIntent` builds a key as `${kind}/${YYYY-MM}/${uuid}`, and a derived variant appends to
 * that key rather than replacing it, so the segment survives derivation. It is therefore the only
 * thing in a signed URL that says which bucket holds the bytes: the signature covers the object
 * key and the expiry, and deliberately not the bucket.
 */
export const MEDIA_KINDS = ['photo', 'document', 'avatar'] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Which bucket a kind lives in, by role rather than by name.
 *
 * By role because the names differ between environments (`S3_BUCKET_PUBLIC` and
 * `S3_BUCKET_PRIVATE` are configuration, and dev's MinIO does not use production's names), so the
 * mapping cannot be expressed as a database constraint. `media_objects.bucket` stores the literal
 * name, which is why a CHECK constraint tying it to the key prefix was considered and is not
 * possible without hardcoding environment-specific strings into a migration.
 *
 * **Exhaustive by type.** A fourth `MediaKind` fails to compile here rather than silently falling
 * through to a default, which matters because the edge's fallback for an unrecognised prefix is a
 * 404 before any bucket is touched. Adding a kind without adding a row here would make every
 * object of that kind unreachable at the CDN while every server test passed.
 */
export const kindToBucketRole: Record<MediaKind, 'identity' | 'content'> = {
  avatar: 'identity',
  photo: 'content',
  document: 'content',
};

/**
 * The bucket role for an object key, or null if its prefix is not one this project issues.
 *
 * Null is a refusal, not a default. The edge answers 404 on it without reading a bucket, which is
 * both cheaper than a miss and closed rather than open: routing an unknown prefix to the private
 * bucket would turn a typo into a probe of private content.
 */
export function bucketRoleForObjectKey(objectKey: string): 'identity' | 'content' | null {
  const kind = objectKey.slice(0, objectKey.indexOf('/'));
  return Object.hasOwn(kindToBucketRole, kind)
    ? kindToBucketRole[kind as MediaKind]
    : null;
}

const HOUR_MS = 3_600_000;

/**
 * The expiry every viewer in one window agrees on, in unix SECONDS.
 *
 * `ceil(now, 1h) + 1h`. The alignment is the point: a signature minted per fetch changes the
 * query string every time, the query string is part of every cache key, and N viewers become N
 * origin fetches. Aligned, all of them are issued the byte-identical URL and share one cache
 * entry. The extra hour is headroom, so a URL issued at 10:59 does not expire sixty seconds later.
 */
export function hourAlignedExpiry(nowMs: number): number {
  const ceilToHour = Math.ceil(nowMs / HOUR_MS) * HOUR_MS;
  return Math.floor((ceilToHour + HOUR_MS) / 1000);
}

/**
 * The same window expressed for a store-signed URL, used by `presign` mode.
 *
 * `signingDate` is the FLOOR of the current hour rather than the expiry, for two reasons: a
 * signature dated in the future is not yet valid, and the floor is the value every caller inside
 * the window agrees on. `expiresIn` carries the distance from that floor to the aligned expiry, so
 * the presigned URL is byte-identical within the window exactly as the CDN one is.
 */
export function hourAlignedSigningWindow(nowMs: number): {
  signingDateMs: number;
  expiresInSeconds: number;
} {
  const floor = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const expiryMs = hourAlignedExpiry(nowMs) * 1000;
  return { signingDateMs: floor, expiresInSeconds: Math.round((expiryMs - floor) / 1000) };
}

/** The signed message. One definition, so the two runtimes cannot disagree about it. */
function message(objectKey: string, exp: number): string {
  return `${objectKey}:${exp}`;
}

const encoder = new TextEncoder();

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

/**
 * base64url of a signature, byte-identical to Node's `.digest('base64url')`.
 *
 * WebCrypto has no base64 of its own, so this is `btoa` plus the two alphabet substitutions and
 * padding stripped. SHA-256 is 32 bytes, which is 44 base64 characters carrying one `=`, so every
 * signature this produces is 43 characters. Verified against `node:crypto` on identical inputs
 * rather than assumed: the padding is the part that silently differs between implementations.
 */
function base64url(mac: ArrayBuffer): string {
  const bytes = new Uint8Array(mac);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(sig: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  try {
    const binary = atob(sig.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** The signature for one object key and expiry. */
export async function signMediaUrl(
  secret: string,
  objectKey: string,
  exp: number,
): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message(objectKey, exp)));
  return base64url(mac);
}

/** Build the signed CDN URL for an object. Deterministic within the hour window. */
export async function signedMediaUrl(
  config: { signingSecret: string; cdnBaseUrl: string },
  objectKey: string,
  nowMs: number,
): Promise<string> {
  const exp = hourAlignedExpiry(nowMs);
  const sig = await signMediaUrl(config.signingSecret, objectKey, exp);
  return `${config.cdnBaseUrl}/${objectKey}?exp=${exp}&sig=${sig}`;
}

/**
 * Verify a signature. For the edge, or for a test standing in for it.
 *
 * `crypto.subtle.verify` rather than a comparison written here: it is constant time by contract on
 * both runtimes, where a byte-by-byte compare that returns early leaks how much of a guessed
 * signature was correct. A signature that is not base64url at all is refused before that, since it
 * cannot be decoded into bytes to compare.
 *
 * **The expiry comparison is `<`, not `<=`**, so a URL is still valid at the exact millisecond it
 * expires. Preserved deliberately from the `node:crypto` original: the boundary is pinned by the
 * shared vectors, and moving it would be invisible for all but one millisecond an hour.
 */
export async function verifyMediaSignature(
  secret: string,
  objectKey: string,
  exp: number,
  sig: string,
  nowMs: number,
): Promise<boolean> {
  if (!Number.isFinite(exp) || exp * 1000 < nowMs) return false;
  const signature = fromBase64url(sig);
  if (signature === null) return false;
  const key = await hmacKey(secret, 'verify');
  return crypto.subtle.verify(
    'HMAC',
    key,
    signature as unknown as BufferSource,
    encoder.encode(message(objectKey, exp)),
  );
}
