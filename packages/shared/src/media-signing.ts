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
 *
 * Two things in here are about operating the deployment rather than about the signature itself,
 * and both are documented at their definitions below because that is where somebody will be
 * standing when they need them: `verifyMediaSignature` explains key rotation and why the previous
 * key exists only on the Worker, and `parityFingerprint` explains how to tell in one command
 * whether the two sides actually hold the same secret.
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
  /*
   * The slash is found and CHECKED, rather than fed straight to `slice`.
   *
   * > This read `objectKey.slice(0, objectKey.indexOf('/'))` until 2026-08-21, and a red-team
   * > pass drove ten bytes out of the PRIVATE bucket through it. `indexOf` answers `-1` when
   * > there is no slash, and `slice(0, -1)` drops the last character instead of returning the
   * > empty string. So `photos` became `photo`, `avatars` became `avatar`, `documents` became
   * > `document`, and each one routed and then read. Requested through the Worker with a valid
   * > signature over the key `photos`, it answered 200 with the object.
   *
   * Nothing could reach it: the api only ever mints `${kind}/${YYYY-MM}/${uuid}`, so no
   * signature for a slashless key has ever existed. What was actually broken is the sentence
   * above this function, which promises the opposite of what it did, and five other places in
   * the Worker and its README that restate it. A documented security property that is false is
   * worse than one that was never claimed, because the next person builds on it.
   *
   * It also explains why the tests missed it, which is the part worth keeping. The routing
   * suite covered `photos/2026-04/x`, which HAS a slash and so genuinely has the prefix
   * `photos`, and `photo`, which loses a real character and becomes `phot`. Neither is the
   * broken shape. The gap was exactly "a slashless key whose last character removal lands on a
   * real kind", and it is now a vector.
   */
  const slash = objectKey.indexOf('/');
  if (slash < 0) return null;

  /*
   * An empty first segment is refused explicitly rather than left to `Object.hasOwn`.
   *
   * A leading slash (`//photo/...` in a URL) yields the key `/photo/...`, whose first segment is
   * `''`. That already refuses, because the empty string is not a kind, but it refuses by
   * accident of the lookup rather than by intent. Stated here so that adding a kind can never
   * make the empty string meaningful.
   */
  const kind = objectKey.slice(0, slash);
  if (kind === '') return null;

  return Object.hasOwn(kindToBucketRole, kind) ? kindToBucketRole[kind as MediaKind] : null;
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
 * signature was correct. That reasoning is unchanged by there being more than one key: each
 * candidate gets its own `crypto.subtle.verify`, and what leaks from trying two keys instead of
 * one is which key matched, which is not a secret. A signature that is not base64url at all is
 * refused before any of that, since it cannot be decoded into bytes to compare.
 *
 * **The expiry comparison is `<`, not `<=`**, so a URL is still valid at the exact millisecond it
 * expires. Preserved deliberately from the `node:crypto` original: the boundary is pinned by the
 * shared vectors, and moving it would be invisible for all but one millisecond an hour.
 *
 * **The expiry is checked once, before any HMAC.** Not once per key. An expired URL is the most
 * common refusal this function will ever issue, and it is also the cheapest, so multiplying it by
 * the number of configured keys would be paying for nothing.
 *
 * ## Rotating the signing secret
 *
 * `secret` takes either one string or an ORDERED list, current key first, and the signature is
 * accepted when any of them matches. An empty list is `false`, never `true`: a rotation that
 * accidentally supplies no keys has to fail closed, because the alternative is a deploy that
 * silently opens every object in both buckets to anybody who can type a URL.
 *
 * **The previous key exists on the Worker and nowhere else, and that is a decision rather than an
 * omission.** There is deliberately no `MEDIA_SIGNING_SECRET_PREVIOUS` in
 * `packages/server/src/config.ts`, so anybody who came looking for that knob and could not find it
 * is in the right place. The api signs and never verifies, so a previous key on the Fly app would
 * be an environment variable nothing reads, and an unread secret is worse than absent: it shows up
 * in `fly secrets list` looking like configuration, so the next person to audit the app finds
 * drift they cannot explain and either trusts a value nothing consumes or removes one they are not
 * sure is dead. Signing always uses the current key. There is no such thing as signing with the
 * previous one.
 *
 * The rotation that follows from that is three steps and takes no coordination:
 *
 *  1. Set the Worker's PREVIOUS key to the secret currently in use, and its CURRENT key to the new
 *     one. The Worker now accepts both. Nothing has changed for anybody.
 *  2. Flip the api's single key to the new one. From here on every URL it mints is signed with the
 *     new key, which the Worker already accepts.
 *  3. Once the old URLs have aged out, clear the Worker's previous key.
 *
 * The window in step 3 is exactly one hour, and it is one hour because of `hourAlignedExpiry`: the
 * longest-lived URL signed with the old key expires two hours after the top of the hour it was
 * minted in. URLs already in flight keep resolving for the rest of their hour, so no photo goes
 * dark during the change and there is no moment when the two sides have to be updated together.
 */
export async function verifyMediaSignature(
  secret: string | readonly string[],
  objectKey: string,
  exp: number,
  sig: string,
  nowMs: number,
): Promise<boolean> {
  if (!Number.isFinite(exp) || exp * 1000 < nowMs) return false;
  const signature = fromBase64url(sig);
  if (signature === null) return false;
  const candidates = typeof secret === 'string' ? [secret] : secret;
  const signed = encoder.encode(message(objectKey, exp));
  for (const candidate of candidates) {
    const key = await hmacKey(candidate, 'verify');
    const matched = await crypto.subtle.verify(
      'HMAC',
      key,
      signature as unknown as BufferSource,
      signed,
    );
    if (matched) return true;
  }
  return false;
}

/**
 * The constant both sides sign to prove they hold the same secret. Printed here on purpose.
 *
 * It carries a version suffix because the fingerprint is only comparable between two sides that
 * signed the same thing: changing this string changes every fingerprint, so it changes with a new
 * name rather than in place.
 */
export const PARITY_MESSAGE = 'clubchat-media-signing-parity-v1';

/**
 * How many characters of the signature get published. See `parityFingerprint`.
 *
 * Eight, and the number is load-bearing rather than a formatting choice, so the two sides publish
 * comparable values. It lives in the shared vectors as well, which is what stops it drifting.
 */
const PARITY_FINGERPRINT_LENGTH = 8;

/**
 * The first 8 characters of the signature over `PARITY_MESSAGE`. Not a secret.
 *
 * ## What it is for
 *
 * The single likeliest failure in this deployment is the api and the Worker holding different
 * values of `MEDIA_SIGNING_SECRET`. A trailing newline picked up by `wrangler secret put` is
 * enough to cause it, and so is pasting the wrong one of two similar-looking strings at midnight.
 *
 * The reason it deserves its own diagnostic is how it presents: every photo 403s. Every single
 * one, immediately, with the api healthy and the Worker healthy and both sets of logs saying
 * exactly what they should. That looks like a broken Worker, or a broken R2 binding, or a bad
 * route, and those are the three things somebody will spend an evening on. It does not look like a
 * wrong password, because a wrong password usually announces itself at the moment it is used.
 *
 * So both sides expose this over `GET /__parity`, and comparing them is one line of shell rather
 * than an evening. Two matching fingerprints eliminate the whole class in one command, which is
 * worth far more than it costs, and the Worker additionally reports the fingerprint of its
 * previous key so that mid-rotation you can see it still accepts what the api was signing with an
 * hour ago.
 *
 * ## Why publishing it unauthenticated is safe
 *
 * It is 8 characters of base64url, so 48 bits, of an HMAC-SHA256 over a constant that is printed
 * in this file and in this repository. There is no shortcut from those 48 bits back to the key:
 * recovering it means a full key search, guessing candidate secrets and hashing each one, exactly
 * as if the fingerprint had not been published at all. What it does reveal is precisely the fact
 * you want revealed, and nothing else: WHETHER the secret changed. It cannot be used to sign
 * anything, and it says nothing about the secret's length or content.
 *
 * That property is what allows the api's route to sit unauthenticated beside `/health`, which it
 * has to: the Worker's copy cannot be authenticated at all, so an authenticated api side would
 * mean obtaining a session token against a brand-new production database at exactly the moment you
 * are debugging a 403 on every photo.
 */
export async function parityFingerprint(secret: string): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(PARITY_MESSAGE));
  return base64url(mac).slice(0, PARITY_FINGERPRINT_LENGTH);
}
