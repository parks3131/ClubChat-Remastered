# ADR-0044: The CDN is a Worker that validates before it reads

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-21 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

[Media pipeline](../TECH/07-media-pipeline.md) specifies an hour-aligned `exp`/`sig` pair on every
download URL, and [Deployment](../TECH/21-deployment.md) rule 8 gives that scheme a hostname,
`cdn.<domain>`. Neither said what serves it, because until 2026-08-21 the plan was to ship
`MEDIA_URL_MODE=presign` and defer the question. The founder decided otherwise: ClubChat ships
`cdn`, so something at that hostname has to check a signature.

Four facts shape the answer.

- **A bucket has never heard of `exp` or `sig`.** Cloudflare offers an R2 custom domain in two
  clicks, and it would serve on this hostname without reading either. `TECH/21` had literally
  instructed that (`cdn.<domain>` pointed at "The R2 content bucket") until it was corrected the
  same day. Followed once, it publishes every private chat photo, document and Eboard image to
  anyone holding a URL, permanently.
- **Authorization does not move to the edge and never has.** It happens at the `/media/:id` hop, on
  every request, on the same membership predicate that protects the message the object hangs off.
  A signed URL grants *fetchability of bytes whose key is already unguessable*, not access. The
  edge's whole job is to refuse an unsigned or stale URL cheaply.
- **The signature is now minted on one runtime and checked on another.** The api mints it on Node;
  the edge validates on `workerd`. Two implementations of one HMAC is the shape of a bug that
  presents as "every photo is broken" with both sides looking correct in isolation.
- **The alignment exists to produce one cache entry.** A signature minted per fetch changes the
  query string every time, the query string is part of every cache key, and N viewers become N
  origin fetches. Aligned to the hour, every viewer inside the window is issued a byte-identical
  URL. **Whether that URL is then shared by a Cloudflare edge entry is a separate question, and
  the answer turned out to be no. See the consequence on caching below: the alignment collapses
  the cache KEY, which is a precondition for caching and not the same thing as a shared entry.**

## Decision

**`cdn.<domain>` is a Cloudflare Worker that verifies the signature, then routes to a bucket, then
reads, in that order.** It lives at `packages/cdn-worker`, the fourth workspace, and is deployed by
`wrangler` rather than by the image that carries the three server roles.

Six things are decided with it.

1. **The Worker imports `@clubchat/shared/media-signing` and reimplements nothing.** That module is
   written on WebCrypto rather than `node:crypto` precisely so one implementation serves both
   runtimes, which is why it lives in `packages/shared` and why that package must keep compiling
   with no Node types. It is imported by subpath, never from the barrel, which re-exports a 250KB
   emoji catalogue.
2. **An unrecognised key prefix is a 404 that never touches R2.** Bucket routing is exhaustive by
   type: `avatar/` to the identity bucket, `photo/` and `document/` to the content bucket, and
   anything else refused. Falling back to the private bucket is not fail-closed; it turns a typo
   into a probe of private content.
3. **`MEDIA_SIGNING_SECRET_PREVIOUS` is supported in the verifier and configured on the Worker
   alone.** Verification accepts a signature from either key, current first; signing always uses
   the current one. It is deliberately absent from `packages/server/src/config.ts`, because the api
   signs and never verifies, so a previous key on a Fly app would be an environment variable
   nothing reads. Without rotation support at all, changing the secret is a media outage for the
   length of one hour window.
4. **Both sides expose an unauthenticated `/__parity`**, reporting the first 8 characters of an
   HMAC over one constant printed in this repo, plus a build identifier. A mismatched signing
   secret is the likeliest failure in this deployment and it presents as every photo 403ing, which
   looks exactly like a broken Worker rather than a wrong password.
5. **Edge cache lifetime on a hit is `public, max-age=3600`**, and every refusal is `no-store`. The
   first bounds a deleted photo's visibility at about an hour and staggers expiry across the
   window; the second stops a transient 403 pinning a failure for the same hour.
6. **`wrangler deploy` is `--dry-run` in CI and a real deploy by hand for the first cutover.**

The deploy ORDER is part of the decision: the three Fly apps ship on `presign` first, then the
Worker is deployed and verified against the real hostname while nothing depends on it, and only
then does `MEDIA_URL_MODE` flip to `cdn`. One extra deploy buys two independently green production
states and a one-token rollback to a state that has been watched working.

## Alternatives

**An R2 custom domain, public.** Two clicks, no code, no Worker bill, and it serves every private
object to anyone with a URL. Rejected, and recorded here rather than dismissed because it is the
path of least resistance and `TECH/21` had already been written in a way that pointed at it.

**A signed-URL scheme owned by the object store, permanently (`presign`).** This is what
development runs and what the first deploy ships, so it is proven. Rejected as the end state
because the store's URL is not cacheable at an edge in the way the aligned scheme is, and because
it puts R2 in the path of every viewer rather than one origin fetch per window. It is retained as
the rollback lever, which is why it now has tests of its own.

**Cloudflare Workers Free.** Rejected for a specific cliff rather than on features. Free is 100,000
requests per day, and a Worker on a Custom Domain runs on **every** request including edge cache
hits, because the cache sits inside the Worker rather than in front of it. Crossing the limit
returns error 1027 for the remainder of the UTC day: every photo, avatar and document dark at once,
with no fallback and no way to shorten it. Workers Paid is $5/month.

**Verifying the signature after reading the object**, which would let the Worker answer 404 and 403
from one code path. Rejected: it makes an unauthenticated caller's request do work in the private
bucket, and it turns the response into a test of whether an object exists.

## Consequences

**Nothing reports a Worker error.** This is an accepted gap, stated plainly rather than deferred to
a footnote. `TECH/15` routes every server failure through one reporting path to Sentry; the Worker
is outside it, so an exception at the edge is visible only in Cloudflare's own observability. The
Worker is written to convert its known failure modes into status codes rather than throws for
exactly this reason. Closing the gap properly is follow-up work.

**`cdn` mode is unproved until it runs.** Every test in this repo, including the Worker's, exercises
it against an emulated R2 in `workerd`. The first real evidence is the cutover, which is why the
cutover is a separate deploy behind a proven one.

**A fourth workspace exists, and the server image must keep ignoring it.** `Dockerfile`'s deps stage
copies three manifests of four, so `npm ci` never sees `packages/cdn-worker` even though
`package-lock.json` holds an entry for it. Proved by building the stage rather than reasoned about.

**The two signing secrets on the gateway and the worker are throwaways and will look like drift.**
Neither role reads `MEDIA_SIGNING_SECRET`, but the flat config schema requires it, so each gets a
distinct value that matches nothing. `fly secrets list` will therefore show three apps with three
different digests for one variable name, and that is correct.

**`packages/shared` is now load-bearing for a second runtime.** Adding a `node:` import to it, or
Node types to its tsconfig, breaks the Worker bundle rather than failing a test. The typecheck
enforces the constraint today; the reason is recorded here because a typecheck error does not
explain itself.

**There is no shared edge cache entry, and roadmap debt 7 is therefore only partly paid off.**
Raised by the red-team pass on 2026-08-21 and then confirmed against Cloudflare's documentation and
the pinned wrangler, having been asserted in five files before anybody checked.

- Cloudflare's Cache API page redirects Worker-response caching elsewhere: to cache responses from
  a Worker so that Cloudflare returns them without executing it, you use **Workers Caching**.
- **Workers Caching is opt in**, through a top-level `"cache": { "enabled": true }` in
  `wrangler.jsonc`. Wrangler 4.125.0's `config-schema.json` carries that key. **This Worker does
  not set it.**
- The feature WOULD cover a response built here from R2 bytes. Its page scopes it to "HTTP
  invocations of the Worker's fetch handler", which means invocations *of* the Worker, not outgoing
  subrequests. So this is a switch that is off, not an architecture that forbids it.
- The Worker also never calls `caches.default.put()`, and an R2 binding read is not a `fetch()`
  subrequest, so nothing reaches the cache by accident.
- The belief probably came from R2's own public-buckets documentation, which says a **custom domain
  on the bucket** lets you use Cloudflare Cache. That is a different arrangement from a Worker
  reading a binding, and this project must never adopt it: rule 8 forbids pointing `cdn.<domain>`
  at a bucket.

So `public, max-age=3600` reaches browsers and downstream caches only, and N members opening one
photo is N R2 Class B reads. What the hour alignment still buys is real: the cache **key** collapses
to one URL per window instead of fanning out per fetch, which is what makes a per-browser hit
possible at all, bounds a deleted photo's visibility at about an hour, and staggers expiry.

**It is left off deliberately for the first deploy**, and settled after the cutover by one command
rather than by more reading:

```
curl -sI '<a signed media url>' | grep -i cf-cache-status
```

`DYNAMIC` or an absent header confirms the above. Turning it on is then one config key, decided
against evidence. Note it would also promote the red-team's URL-spelling finding from harmless to
relevant: one signed URL has unlimited accepted spellings (leading zeros, exponent form, unknown
query parameters, and four accepted trailing signature characters, since a 43-character base64url
string carries 258 bits and a SHA-256 MAC is 256). That is origin load today and would become cache
pollution the moment a shared cache exists.

**The Worker hardens its own responses rather than relying on the api's MIME allowlist.** Every
response built from an object carries `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; sandbox`, and `Content-Disposition` is stripped rather
than passed through. The reasoning is that the CDN's safety was entirely borrowed: nothing dangerous
is reachable today only because `IMAGE_MIME_ALLOWLIST` and `DOCUMENT_MIME_ALLOWLIST` in
`packages/server/src/media/store.ts` exclude `text/html` and `image/svg+xml`, and that file
explicitly frames widening them as "a product decision" - which somebody will make in
`packages/server`, with no reason to think about the edge. `text/plain` and `text/csv` are already
on the allowlist and already served inline, so no widening is even required for the sniffing case.
`Content-Disposition` goes because it is uploader-controlled, nothing in this project writes one,
and the client builds its filenames device-side from the message envelope. The known cost of
`sandbox` is a browser's inline PDF viewer; the app downloads documents to a file and hands them to
the OS, which is not a browser context, so the exposure is a document opened in a tab on the web
client that is currently out of scope. If that is ever reported broken, `sandbox` is the first token
to drop and `default-src 'none'` keeps most of the value.

**A red-team pass ran against the Worker on 2026-08-21 and could not get bytes out of either
bucket.** 400 hostile requests over paths, expiries, signatures, methods and conditional headers
returned 403, 404 or 405 with empty bodies. Refusal before read was proved directly with R2
bindings rigged to throw. Message collision is impossible for anything the api mints, because
`${objectKey}:${exp}` has exactly one colon when `exp` is a number's string form and no key this
project issues contains one. The signature check is not truncation-tolerant.

It found one real defect, now fixed: **`bucketRoleForObjectKey` routed a SLASHLESS key to a
bucket and read it**, because `indexOf` answers `-1` and `slice(0, -1)` drops the last character,
so `photos` became `photo`. Unreachable from the internet, since the api only mints
`${kind}/${YYYY-MM}/${uuid}` and no signature for such a key can exist, but it falsified the
invariant this ADR and five other places assert. The lesson is in the code: the tests covered
`photos/2026-04/x` and `photo`, and neither is the broken shape.

**`workers_dev` is disabled explicitly, and that is a decision rather than a default.** Wrangler
enables a `*.workers.dev` hostname whenever a config declares no `routes`, and this one deliberately
declares none. Because the signed message covers the object key and the expiry and **not the host**,
every URL the api mints would work verbatim on that second hostname, putting both buckets outside
anything ever attached to the `clubchatapp.com` zone: a WAF rule, a rate limit, bot management, an
Access policy. An earlier note proposed using workers.dev to test before attaching the custom
hostname; that is not needed, because the presign-first deploy order already provides a safer
window in which the Worker is live on its real hostname while nothing depends on it.
