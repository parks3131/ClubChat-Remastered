/**
 * `cdn.clubchatapp.com`: everything that stands between a signed media URL and R2.
 *
 * The api mints `${objectKey}?exp=&sig=` on a Fly machine and hands it to a client. That URL is
 * fetchable by anybody who has it, which is the whole design: authorization already happened, once,
 * at `GET /media/:id` in `packages/server/src/api/routes/media.ts`, against the same membership
 * predicate that protects the message the photo is attached to. What reaches this Worker is a
 * bearer token for one object for one hour, and the only question left is whether it is real.
 *
 * **The order of operations is the security property.** Verify the signature, then route to a
 * bucket, then read, then set cache headers. Every refusal happens before any R2 call, so an
 * unsigned request and a request for a key this project could never have issued are both answered
 * without a bucket ever being touched. Reading first and checking afterwards would turn this
 * endpoint into an oracle for what exists.
 *
 * **The signature is checked over `url.pathname`, which is the SAME string used as the R2 key, and
 * that identity is the whole defence.** `signedMediaUrl` joins the base URL to the object key
 * without encoding it, and every key this project issues is `[a-z]+/\d{4}-\d{2}/<uuid>` with an
 * optional `.<variant>.webp` suffix (`.thumb.webp`, `.bubble.webp`, `.display.webp`), so nothing
 * in one ever needs escaping. **Adding a variant changes nothing here**: the suffix is appended to
 * a key whose first path segment already decided the bucket, and the signature is computed over
 * the whole string either way.
 *
 * Traversal is disposed of by normalisation happening BEFORE the HMAC, on one string used for both
 * purposes. It is emphatically NOT disposed of by the escape failing to match, and an earlier
 * version of this comment claimed exactly that and was wrong. `new URL()` on `workerd` follows the
 * WHATWG URL spec, which resolves dot segments in their percent-encoded spellings too, so all of
 * these arrive at the handler as the identical pathname `/photo/2026-04/<uuid>`:
 *
 *     /x/%2e%2e/photo/2026-04/<uuid>      /x/%2E%2E/photo/2026-04/<uuid>
 *     /x/../photo/2026-04/<uuid>          /./photo/2026-04/<uuid>
 *     \photo\2026-04\<uuid>              (backslashes are slashes for a special scheme)
 *
 * A request for any of them with a valid signature for the plain key is served, and that is
 * correct: it is a request for the plain key, spelled oddly, and the bytes returned are the bytes
 * that key was signed for. Nothing escapes anywhere, because the normalised path is what is hashed
 * AND what is handed to R2. The rule to preserve if this ever moves: derive the R2 key and the
 * signed message from ONE expression. Two derivations that normalise differently is the bug this
 * shape prevents.
 *
 * `%2F` is the genuine exception and is NOT decoded by the URL parser, so an encoded slash stays
 * encoded, reaches the HMAC as those three characters, and simply fails to match.
 *
 * **Nothing reports an error from this Worker.** There is no Sentry DSN at the edge and no alert on
 * a 5xx rate; an exception here becomes a Cloudflare error page that nobody is counting. That is an
 * accepted gap, recorded in the ADR, and it is the reason the two places that can plausibly throw
 * on a well-formed request - a missing secret and an `R2Error` from the read - are turned into
 * honest status codes below rather than left to become an invisible 500.
 */

import {
  bucketRoleForObjectKey,
  parityFingerprint,
  verifyMediaSignature,
} from '@clubchat/shared/media-signing';
import type { Env } from './env.ts';

/**
 * The diagnostic both sides of the signature answer, so a key mismatch is one line of shell.
 *
 * Double underscore because it cannot collide with an object key: every key this project issues
 * starts with a `MediaKind`, and `__parity` is not one. Handled before the media path anyway, so
 * the ordering is what guarantees it rather than the spelling.
 */
const PARITY_PATH = '/__parity';

/**
 * An hour on a hit, and it is the same hour the signature is aligned to.
 *
 * What this genuinely buys: a deleted photo stops being visible in about an hour rather than
 * whenever some cache happens to evict it, expiry staggers across the window rather than dropping
 * every object at once, and a phone that has already fetched an avatar does not fetch it again.
 *
 * ## What it does NOT buy, corrected after a red-team pass
 *
 * This docblock used to claim that N members opening the same photo share ONE edge cache entry.
 * **That is false as this Worker is configured, and the honest statement is that N members are N
 * reads of R2.** `hourAlignedExpiry` does make every viewer in a window request a byte-identical
 * URL, so the cache KEY collapses; there is simply no Cloudflare cache holding anything under it.
 *
 * The evidence, from Cloudflare's own documentation rather than from reasoning about it:
 *
 *  - The Cache API page says "To cache responses from your Worker so that Cloudflare returns them
 *    without executing your Worker, use Workers Caching instead." Not automatic, then.
 *  - Workers Caching is opt in, enabled by `"cache": { "enabled": true }` in `wrangler.jsonc`,
 *    which this Worker deliberately does not set. Its own page scopes it to "HTTP invocations of
 *    the Worker's fetch handler", so it WOULD cover a `Response` built here out of R2 bytes. It is
 *    off, so it covers nothing.
 *  - This Worker never calls `caches.default.put()` and never issues a `fetch()` subrequest.
 *    `bucket.get()` is a binding call, which does not traverse the cache.
 *  - R2's public-buckets page says "Domain access through a custom domain allows you to use
 *    Cloudflare Cache to accelerate access to your R2 bucket." That is an R2 Custom Domain in
 *    front of a bucket, which is a DIFFERENT setup from a Worker reading a binding, and is the
 *    likeliest source of the original mistaken belief.
 *
 * So `public, max-age=3600` reaches the browser and any downstream cache, and Cloudflare stores
 * nothing.
 *
 * ## Measured on 2026-08-23, the day of the first deployment
 *
 *     curl -sI '<a signed url>' | grep -i cf-cache-status
 *
 * **`cf-cache-status` is ABSENT.** Not `DYNAMIC`, which is what the paragraph above predicted: the
 * response off cdn.clubchatapp.com carries `cache-control: public, max-age=3600`, a content-type, a
 * content-length and an etag, and no `cf-cache-status` header at all. The prediction was wrong
 * about the spelling and right about the fact, and the fact is the whole of it - a header
 * Cloudflare does not emit is a request no Cloudflare cache ever considered, which is the same
 * conclusion `DYNAMIC` would have carried. ADR-0044 anticipated both readings in as many words:
 * "`DYNAMIC` or an absent header confirms the above."
 *
 * So the analysis above stands, measured rather than argued: **N members opening one photo is N
 * reads of R2.** `HIT` or `MISS` is what would have falsified it, and that would have meant
 * ADR-0044 needed superseding rather than this docblock needing an edit. Neither happened.
 *
 * Turning Workers Caching on is still a real option with a real trade-off, and it is now a decision
 * rather than a question waiting on evidence: one config key in `wrangler.jsonc`, against the cost
 * ADR-0044 records - a shared cache promotes the red team's URL-spelling finding from harmless to
 * relevant, since one signed URL has unlimited accepted spellings and each is its own cache key.
 */
const HIT_CACHE_CONTROL = 'public, max-age=3600';

/**
 * R2's code for a Range that cannot be satisfied, read out of the vendor's own source rather than
 * remembered: `node_modules/wrangler/node_modules/miniflare/dist/src/workers/r2/bucket.worker.js`
 * defines `INVALID_RANGE: 10039` and throws it as an `R2Error` from `get`.
 *
 * **A `Range` HEADER cannot reach it, and that is worth knowing before trusting the 416.** The same
 * file's `validate.range` only throws for the explicit `{offset, length}` option object, which this
 * Worker never passes. Given a `Headers`, it calls `parseRanges` and returns `undefined` unless it
 * gets exactly one satisfiable range, and `get` then serves the whole object. Observed directly:
 * `bytes=900-1000` past the end of a ten byte object came back as the full object rather than as a
 * throw. So this branch is insurance against a runtime that does throw, not a path a client can
 * currently take, and `README.md` says so rather than publishing a status nothing produces.
 *
 * It is caught by number and everything else is rethrown, so a genuine R2 outage cannot be
 * disguised as a client mistake. See `AGENTS.md` failure mode 34 for why reading the shipped
 * source beats trusting the shape of an SDK error.
 */
const R2_INVALID_RANGE = 10039;

/**
 * A refusal, and no hint about which refusal it is.
 *
 * `no-store` on every one of them because a cached 403 or 404 pins a failure for the whole hour the
 * hit path is cached for, and the failures this endpoint produces are overwhelmingly transient by
 * nature: a URL signed an hour ago, a rotation halfway done, an upload that has not landed yet.
 *
 * The body is empty deliberately. The status already says as much as a caller is owed, and saying
 * more would separate "your signature is wrong" from "your signature is old", which is the
 * difference between an attacker learning nothing and learning where to spend their time.
 */
function refuse(status: 403 | 404 | 405 | 416, extra?: Record<string, string>): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store', ...extra } });
}

/**
 * A secret that is actually configured, or null.
 *
 * The empty string is the case worth naming: `wrangler secret put` handed empty stdin stores one,
 * and it would then be a perfectly valid HMAC key that nothing in the world signs with. Treated as
 * absent so it fails closed and shows up on `/__parity` as "no previous key" rather than as a
 * fingerprint of nothing.
 */
function configuredSecret(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The keys a signature may match, current first.
 *
 * Ordered because `verifyMediaSignature` tries them in order and the overwhelmingly common case is
 * the current one, so the previous key costs an HMAC only during a rotation. An empty list is a
 * refusal rather than an acceptance, which is what makes a Worker deployed with no secret at all
 * answer 403 to everything instead of throwing on `importKey` and becoming a 500.
 */
function signingKeys(env: Env): readonly string[] {
  const keys: string[] = [];
  const current = configuredSecret(env.MEDIA_SIGNING_SECRET);
  if (current !== null) keys.push(current);
  const previous = configuredSecret(env.MEDIA_SIGNING_SECRET_PREVIOUS);
  if (previous !== null) keys.push(previous);
  return keys;
}

/**
 * The canary for the single likeliest failure in this deployment: the api and the Worker holding
 * different `MEDIA_SIGNING_SECRET` values.
 *
 * That fault presents as every photo 403ing, which reads as a broken Worker rather than as a wrong
 * password, and a trailing newline on one side is enough to cause it. So both sides publish eight
 * base64url characters of an HMAC over a constant printed in this repo, and `README.md` shows the
 * one-line comparison. Eight characters is 48 bits over a public message: it says when the secret
 * changed, and recovering the key from it is a full key search.
 *
 * Unauthenticated on both sides, and on this side it could not be otherwise - the Worker has no
 * session to check. `no-store` because a cached answer during a rotation is worse than no answer.
 *
 * `parity` is null only when this Worker has no signing secret at all, which is the fastest
 * possible answer to "why is every photo 403ing" and the reason this route is worth having.
 */
async function parityResponse(env: Env): Promise<Response> {
  const current = configuredSecret(env.MEDIA_SIGNING_SECRET);
  const previous = configuredSecret(env.MEDIA_SIGNING_SECRET_PREVIOUS);
  return Response.json(
    {
      parity: current === null ? null : await parityFingerprint(current),
      previousParity: previous === null ? null : await parityFingerprint(previous),
      // Optional-chained on a binding the type says is always present, because this is the route
      // you reach WHILE something is misconfigured, and a diagnostic that throws when a binding is
      // missing answers the one question it exists to answer with a blank page.
      version: env.CF_VERSION_METADATA?.id ?? 'unknown',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * The shape `R2Object.range` actually has, as opposed to the one `R2Range` claims it has.
 *
 * `R2Range` is declared as three DISJOINT shapes: `{offset, length?}`, `{offset?, length}` and
 * `{suffix}`. The value that arrives is none of them. It is one object carrying all three keys,
 * with the ones that do not apply present and set to `undefined`:
 *
 *     Object.keys(range)   ->  ['offset', 'length', 'suffix']
 *     JSON.stringify(range) ->  {"offset":0,"length":10}
 *
 * That gap is the whole of this Worker's worst bug. The first version discriminated the union with
 * `'suffix' in range`, which is a test for the key being PRESENT, and the key is always present. So
 * the suffix branch was taken on every single read, `Math.min(undefined, size)` was `NaN`, and every
 * response this CDN produced carried `content-range: bytes NaN-NaN/<size>`. It typechecked, it
 * bundled, and it was wrong every time it ran. `JSON.stringify` hides the key, which is why the
 * usual way of looking at a value in a debugger would not have shown it either.
 *
 * **So this type describes the value rather than the contract, and every field below is read by
 * VALUE and never by presence.** An absent key and a present-undefined key then mean the same
 * thing, which is the only property that stops this recurring. `R2Range` is assignable to it, so
 * the call site needs no cast.
 */
type R2RangeFields = {
  readonly offset?: number | undefined;
  readonly length?: number | undefined;
  readonly suffix?: number | undefined;
};

/** A field that is really a number, or null. `Number.isFinite` has no type predicate of its own. */
function finiteNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Where the bytes R2 served actually start, and how many there are.
 *
 * The suffix branch is kept even though nothing on this stack can reach it: miniflare resolves
 * `bytes=-4` to `{offset: 6, length: 4}` server side, and observing production R2 is not something
 * this package can do. Dropping it would mean a `{suffix: 4}` from a future runtime falling through
 * to the offset branch, reading both fields as absent, and reporting the whole object's length for
 * a four byte body - a wrong `Content-Length`, which is worse than an unexercised branch.
 */
function resolvedRange(range: R2RangeFields, size: number): { start: number; length: number } {
  const suffix = finiteNumber(range.suffix);
  if (suffix !== null) {
    // `bytes=-5000` on a 900 byte object is legal and means the whole thing.
    const length = Math.min(suffix, size);
    return { start: size - length, length };
  }
  const start = finiteNumber(range.offset) ?? 0;
  return { start, length: finiteNumber(range.length) ?? size - start };
}

function isUnsatisfiableRange(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === R2_INVALID_RANGE
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Before the router, because it is true of every path this Worker serves and because a 405 is
    // the one refusal that owes the caller a detail: RFC 9110 requires `Allow` on it, and unlike
    // the reason for a 403 it gives away nothing.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return refuse(405, { allow: 'GET, HEAD' });
    }

    const url = new URL(request.url);
    if (url.pathname === PARITY_PATH) return parityResponse(env);

    // Raw, not decoded, and this is the same string the R2 key is read from. See the file header.
    const objectKey = url.pathname.slice(1);
    const exp = url.searchParams.get('exp');
    const sig = url.searchParams.get('sig');

    // Missing, malformed, mismatched and expired all land here as one 403. `verifyMediaSignature`
    // owns every part of that judgement, including the expiry comparison being `<` rather than
    // `<=`, so that this Worker and the api cannot come to different conclusions about the same
    // URL. Nothing about the signing scheme is restated in this package.
    const signed =
      exp !== null &&
      sig !== null &&
      (await verifyMediaSignature(signingKeys(env), objectKey, Number(exp), sig, Date.now()));
    if (!signed) return refuse(403);

    // Routing is by first path segment and exhaustive: a prefix this project does not issue is a
    // 404 that never reads a bucket. Falling back to the content bucket would turn a typo into a
    // probe of private media, and falling back to the identity bucket would answer misses slowly
    // for no benefit.
    const role = bucketRoleForObjectKey(objectKey);
    if (role === null) return refuse(404);
    const bucket = role === 'identity' ? env.IDENTITY : env.CONTENT;

    /*
     * One read, doing conditional and Range evaluation inside R2.
     *
     * `onlyIf` and `range` both take the request's own `Headers`, so `If-None-Match`,
     * `If-Modified-Since` and `Range` are honoured without this Worker parsing an ETag or a byte
     * range itself. Range is not a nicety here: a document or a full-size photo on a phone over a
     * patchy connection is resumed rather than restarted, and a PDF viewer asks for the trailer
     * before it asks for page one.
     *
     * A thrown `INVALID_RANGE` becomes a 416, which is what it means, because an uncaught throw at
     * the edge is a 500 that nothing reports. On this stack a `Range` header cannot produce that
     * throw - R2 ignores a range it cannot satisfy and serves the whole object, which the block
     * above answers 200 - so this is insurance rather than a live path. See `R2_INVALID_RANGE`.
     * Anything else is rethrown so a real outage stays loud.
     */
    let object: R2ObjectBody | R2Object | null;
    try {
      object = await bucket.get(objectKey, { onlyIf: request.headers, range: request.headers });
    } catch (error) {
      if (!isUnsatisfiableRange(error)) throw error;
      return refuse(416);
    }
    if (object === null) return refuse(404);

    const headers = new Headers();
    /*
     * The object's own `Content-Type` matters more here than it looks. Originals carry no file
     * extension, so nothing about the key says whether the bytes are a JPEG, a PNG or a PDF; the
     * only record of that is what the upload stored, and `writeHttpMetadata` is what reads it back.
     * Guessing from the path would mean serving every document as `application/octet-stream`.
     */
    object.writeHttpMetadata(headers);
    // After `writeHttpMetadata`, never before: it writes a `Cache-Control` too if one was stored at
    // upload time, and the edge lifetime is this Worker's decision rather than the uploader's.
    headers.set('cache-control', HIT_CACHE_CONTROL);
    headers.set('etag', object.httpEtag);
    // Said explicitly so a client knows it may range before it has any reason to try.
    headers.set('accept-ranges', 'bytes');

    /*
     * Everything below treats the stored object as hostile, because every byte and every piece of
     * metadata on it was uploaded by a member straight to R2 through a presigned PUT.
     *
     * None of it is reachable today. `IMAGE_MIME_ALLOWLIST` and `DOCUMENT_MIME_ALLOWLIST` in
     * `packages/server/src/media/store.ts` contain no `text/html` and no `image/svg+xml`, and
     * better-auth's session cookie is host-only so it never reaches this hostname anyway. It is
     * done regardless, and the reason is precisely that the safety lives in ANOTHER package:
     * `store.ts` frames widening that allowlist as "a product decision", and whoever makes it will
     * be editing `packages/server` with no reason to think about the edge. This is the half of the
     * pair that has to already be here when that happens.
     *
     * `nosniff` stops a body being rendered as something its declared type is not, which is the
     * case that does not need the allowlist to change at all: `text/plain` and `text/csv` are both
     * allowed and both served inline today.
     *
     * The CSP is what neuters an explicitly `text/html` object if the allowlist ever does widen.
     * `default-src 'none'` blocks every subresource and, because `script-src` falls back to it,
     * every script; `sandbox` additionally drops the document into an opaque origin so it cannot
     * reach anything served from this hostname. Judged worth it here rather than in general: the
     * app downloads a document to a file and hands it to the OS, which is not a browser context and
     * ignores CSP entirely, so the only surface this can affect is a document opened directly in a
     * browser tab on the web client. If inline PDF viewing on web is ever reported broken, the
     * `sandbox` token is the first thing to try removing, and `default-src 'none'` alone keeps most
     * of the value.
     */
    headers.set('x-content-type-options', 'nosniff');
    headers.set('content-security-policy', "default-src 'none'; sandbox");

    /*
     * `Content-Disposition` is dropped rather than passed through, and nothing loses anything.
     *
     * `writeHttpMetadata` replays whatever the uploader stored, and a presigned PUT means the
     * uploader is a member's device. Nothing in this project ever WRITES one: the api never sets
     * it, so the only way an object carries it is a client that decided to. Nor is it load bearing,
     * because the filename a member sees is built on the device from the `documentName` on the
     * message envelope, in `apps/mobile/src/document-name.ts`, not from this header.
     *
     * So it is uploader-controlled input that nothing consumes and that decides whether a response
     * renders inline or downloads. Removing it costs nothing and shrinks the surface by one field.
     */
    headers.delete('content-disposition');

    /*
     * No body means R2 evaluated the preconditions and found the caller's copy current, so this is
     * a 304 and the cache headers above are what refresh its freshness for another hour.
     *
     * The accepted imprecision: `If-Match` and `If-Unmodified-Since` also fail this way and mean
     * 412 rather than 304. Both are write preconditions on a read-only origin, no client of a
     * signed media URL sends either, and telling them apart would mean re-implementing the
     * matching that was just handed to R2 on purpose.
     */
    if (!('body' in object)) return new Response(null, { status: 304, headers });

    /*
     * What R2 actually served. Not what the client asked for, and the difference is the point.
     *
     * R2 returns a resolved range on EVERY read. With no `Range` header at all it is
     * `{offset: 0, length: size}`, so `object.range` being defined says nothing whatsoever about
     * whether this is a partial response. The first version of this Worker treated its presence as
     * the answer, which made every avatar, photo and document a `206 Partial Content`.
     *
     * The `undefined` case is still handled because the type permits it and production R2 is not
     * this emulator, but it is not the case that was observed here.
     */
    const served =
      object.range === undefined
        ? { start: 0, length: object.size }
        : resolvedRange(object.range, object.size);

    /*
     * 206 describes the BYTES, not the request, and this is the only sound source for it.
     *
     * Deciding from the presence of a `Range` request header instead would be wrong, and provably
     * so rather than as a matter of taste. R2 IGNORES any range it cannot parse or satisfy and
     * serves the whole object: `bytes=900-1000` past the end, `bytes=0-1,5-6` asking for two
     * ranges, and outright junk like `kilobytes=1-2` were each observed coming back as the full
     * object with `{offset: 0, length: size}`. Every one of those carries a `Range` header, so
     * header-driven logic would answer 206 with a `Content-Range` for a request the server had
     * declined - and RFC 9110 requires a server that ignores a `Range` to answer 200.
     *
     * Reading it off the served extents gives that answer for free, and it cannot drift from the
     * body the way a second source of truth would.
     *
     * The one consequence worth stating out loud: `Range: bytes=0-` for an entire object is a 200,
     * because the response really is the whole representation. `Accept-Ranges` still tells the
     * client it may range, so a resumed download works exactly as before.
     */
    const partial = served.start !== 0 || served.length !== object.size;
    const status = partial ? 206 : 200;
    if (partial) {
      const last = served.start + served.length - 1;
      headers.set('content-range', `bytes ${served.start}-${last}/${object.size}`);
    }

    // A HEAD is answered with the same headers and no bytes. Built explicitly rather than left to
    // the runtime to strip, and carrying `Content-Length` by hand because there is no body for it
    // to be inferred from - which is the whole reason a client sends a HEAD in the first place.
    if (request.method === 'HEAD') {
      headers.set('content-length', String(served.length));
      return new Response(null, { status, headers });
    }

    return new Response(object.body, { status, headers });
  },
} satisfies ExportedHandler<Env>;
