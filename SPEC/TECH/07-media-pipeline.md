# Media pipeline

### Two classes, as specified

| Class | Examples | Bucket | Serving |
|---|---|---|---|
| **Identity** | user/club/race/eboard avatars | public | The same authorized, signed hop as content |
| **Content** | chat photos, documents, news photos | **private** | authorized redirect → CDN (below) |

### Cropping: fixed-frame media on the client, a chat photo on the server

Two different jobs that used to be one rule. The first is an obligation promoted here from
[`DESIGN/02-avatar`](../DESIGN/02-avatar.md), because a per-surface design file is not where
somebody adding an upload path will look.

> **A picture destined for a FIXED frame is cropped to that frame before it is uploaded.** Every
> avatar - user, club, race, Eboard - and a news photo. The crop frame and the display frame must
> be the same frame, or the renderer's `cover` crops a second time and what gets stored is not
> what the person chose. That crop produces a new file, so the byte count declared at intent must
> be measured from the cropped copy: declaring the original's length is a guaranteed `mismatch`.

**A chat photo is the other case, and it is cropped at `complete`, by the server.** It has no fixed
frame - it is displayed at its own proportions - so there is nothing to crop it *to*, and it is
cropped only when the sender chooses to. The phone sends a rectangle and never cuts pixels.

This reverses a line that stood here until 2026-08-15: *"the server has no part in it and must not
grow one ... cropping server-side would mean decoding and re-encoding an image in a request
path."* The objection was aimed at a server that crops **on its own initiative**, which is still
refused - a resize nobody asked for is choosing a crop the person did not. It does not apply to
executing a rectangle the sender drew. And the cost it warns about is already being paid:
`completeUpload` has decoded every uploaded image since Phase 0, to prove it is one. The extract
adds a re-encode to a read that was already happening.

What made the choice rather than merely allowing it: cropping on the device needs a native image
module, and adding one **took the app down twice in an hour**. A native import resolves at bundle
load, so JS importing it reaches every phone the moment Metro serves it while the binaries are
hours behind; and the prebuilt framework targeted a newer `ExpoModulesCore` than the app ships,
which is a launch-time `Symbol not found` no JavaScript can catch. See
[`AGENTS.md`](../../AGENTS.md) failure modes 8 and 32.

Five things the server crop owes, each asserted in `media-crop.test.ts`:

- **Rotate before extracting.** A phone photo carries its rotation in EXIF, so cutting first takes
  the region out of sideways pixels - wrong by ninety degrees rather than by a little.
- **Replace the stored object.** The gallery, the thumbnail and the download hop read one key; a
  surviving original under it would leave them disagreeing about which picture they meant.
- **Re-state `bytes` and the dimensions on the row**, which now describe the object that exists.
- **Refuse a rectangle that does not fit** rather than clamping it. Cutting a region nobody chose
  is worse than saying no, and the upload is left untouched so a corrected retry completes against
  the same bytes.
- **Decode under the same options the gate used, and refuse as a value.** The crop takes
  `probe.ts`'s `DECODE_OPTIONS` rather than sharp's defaults, whose `failOn` is the *stricter*
  `'warning'` - a crop given no options would refuse a photograph the probe had just admitted. The
  same constant carries the pixel ceiling, so the crop is bounded by its own decode rather than by
  running after the probe. A decode that does fail comes back as a value and becomes `bad_crop`,
  never `undecodable`: the probe has already proved the bytes are a picture.

An uncropped upload is not decoded-and-re-encoded at all: the member's own file is stored, rather
than a recompressed copy of itself.

### Upload - pre-signed, as the transcript describes

```
POST /media/upload-intent { kind, mime, size, scope }
  → authorize the scope (same predicate that protects the messages)
  → validate mime allowlist + size cap        ← fixes Roadmap debt 9
  → insert media_objects (status='pending')
  → 200 { media_id, upload_url (presigned PUT, 5 min), max_bytes }

client PUTs directly to object storage

POST /media/:id/complete
  → HEAD the object, verify size/type actually match what was declared
  → a HEAD that fails for any reason other than 404 is 503 storage_unavailable
  → for an image, decode it: bytes that are not an image are refused 422 undecodable
  → status='ready'; enqueue outbox('media.uploaded') → worker derives thumbnails
```

The chat server never proxies an upload. The client PUTs directly to object storage and the
`MediaStore` interface deliberately has no method taking a buffer, which is the transcript's
point and it stands. The one exception is the decode above, and it is the same job this endpoint
already exists to do: verify afterwards that what arrived matches what was declared.

**An image is decoded, not merely measured.** Size and type are claims a HEAD can check; "is an
image" is not. A file can satisfy every declared fact and still be undecodable, so it is decoded
here and refused with `422 undecodable` if it is not - see
[ADR-0018](../decisions/0018-decode-uploads-at-the-boundary.md) for the cost and the rejected
alternatives. A refused object is left `pending`, so nothing can reference it and the GC reclaims
the bytes on the same path as an upload the client abandoned.

**An object that does not decode never parks its outbox row.** `media.uploaded` is the one event
type that can fail from bad input rather than from a bug, and parking is the alarm for "an effect
never ran". So `deriveVariants` records the reason in `media_objects.derive_error` and completes
the event. See [effects engine](04-effects-engine.md) for why the distinction matters.

**A send referencing an incomplete upload is refused with its own code.** `msg.err` carries
`media_not_ready`, deliberately distinct from `forbidden`: the client's correct response is to
finish the upload and retry the same `client_msg_id`, not to give up. Collapsing it into a
generic failure would turn a recoverable state into a lost message.

**"The object is not there" and "we could not ask" are different answers, and `404 not_uploaded`
means only the first.** `not_uploaded` is an instruction to the client: finish the upload and try
again. That is right for a member who backgrounded the app mid-PUT and wrong for every other way a
HEAD can fail, so the store returns `{ exists: false }` for a genuine 404 and throws for anything
else - a 403 from a rotated credential, a DNS failure, a 5xx, a timeout. Those answer `503
storage_unavailable` and are reported to the monitor under `api.media.complete`.

> The version this replaces caught everything and returned `{ exists: false }`, so an R2 secret
> rotated and re-typed with one character wrong looked exactly like members abandoning uploads:
> every complete answered `not_uploaded`, every client dutifully re-uploaded bytes that were
> already in the bucket, and nothing was captured anywhere. The only evidence was a graph of
> uploads that started and never finished, which is also what a normal Tuesday looks like.

**Every storage call has a deadline, and the deadline has to be asked for twice.** The S3 client
sets `connectionTimeout`, `requestTimeout` and `socketTimeout` on its request handler, because all
three default to zero - meaning no timeout at all - so storage that accepts the TCP connection and
never answers leaves the call neither resolved nor rejected, and the SDK's retry never engages
because nothing throws. `requestTimeout` alone does **not** abort: `@smithy/node-http-handler` only
logs a warning unless `throwOnRequestTimeout` is also set. See `media/store.ts` for the three
values and why `socketTimeout` must stay under six seconds.

**The object must belong to the sending member and to that channel.** Otherwise a member could
attach somebody else's private upload, or move a photo out of a channel they can read into one
they cannot - laundering it past the download authorization entirely.

**Media is validated before the send, never inside it.** The sequence-allocating transaction
holds a row lock until commit, so a `HEAD` in there would serialize the whole channel behind an
object-storage round trip. `/media/:id/complete` is where verification happens; the send does a
cheap indexed read of the resulting `status`.

### Download - the stable-URL problem, solved

[Media and galleries](../PRD/13-media-and-galleries.md) rule 5 and debt item 7 describe a real, specific failure: a signed URL minted per
fetch changes its query string every time, and the query string is part of every cache key -
so every layer misses, and N viewers means N origin downloads.

**Design:**

```
GET /media/:id                     ← authenticated, authorized (same membership predicate)
  → 302 to
    https://cdn.clubchatapp.com/{object_key}?exp={hour_aligned}&sig={hmac}
```

- The signature expiry is **aligned to the top of the hour** (`exp = ceil(now, 1h) + 1h`), so
  every viewer in that window is issued the *byte-identical* URL. That is what makes the URL
  cacheable at all. It is **not** served from one shared edge entry: that needs Workers Caching,
  which is opt in and deliberately off. See the caching note in
  [ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md).
- Authorization happens at the `/media/:id` hop, on every request, using the same predicate that
  protects the message - so a private Eboard photo is never reachable by a guessable URL
  ([Media and galleries](../PRD/13-media-and-galleries.md) rule 1).
- The redirect itself is `Cache-Control: private, max-age=600` so a client re-uses it briefly
  without re-authorizing on every render.
- Clients render from `/media/:id` - a **stable, permanent** URL. Image cache keys are stable by
  construction; the memoization gymnastics [Media and galleries](../PRD/13-media-and-galleries.md) rule 5 describes are no longer needed
  anywhere in the client.
- Sign-out clears the redirect cache, so a second account on a shared device cannot inherit
  access.

### Also fixed here

| v1 gap | Fix |
|---|---|
| Debt 8 - nothing ever deleted from storage | `media_objects` has an owner reference; deleting the owner enqueues `media.orphaned`; nightly GC job |
| Debt 9 - no size or MIME limits | Enforced at upload-intent *and* re-verified at complete |
| No image resizing; full-resolution originals served | Worker derives `thumb` (400px), `bubble` (800px) and `display` (1600px) variants; the gallery grid renders `thumb`, the chat bubble renders `bubble` as of 2026-08-27, and the full-screen viewer renders `display`. See "Three sizes" below |
| Gallery signs an entire photo history in one unpaginated call | Gallery pages like anything else; URLs are stable so there is nothing to "sign in batches" |

### Which way up, and how big

A camera does not rotate pixels. It writes them in sensor order and adds an EXIF orientation tag,
so a portrait photograph arrives as landscape pixels plus "turn this". Two consequences, both of
which shipped wrong until 2026-08-13:

1. **Derivation applies the orientation before resizing.** The derived variants are WebP, which
   carries no orientation tag, so a derive that does not rotate flattens a portrait photo into
   landscape pixels *permanently* - and the tag that would have explained them is gone. `width`
   in `VARIANTS` means the width of the picture as somebody sees it, which is why the rotation
   has to happen first.
2. **`media_objects.width` and `.height` are the DISPLAYED size**, swapped for the quarter-turn
   orientations. They are measured at complete-upload, inside the decode the probe already pays
   for, and handed to the client on the same authorized hop that returns the URL - so a photo can
   be laid out before a byte of it arrives. Null for a document, and null for every row uploaded
   before the columns existed; a client reads null as "measure it yourself", which is what every
   client did until then.

**These are one fact, not two.** A stored dimension that disagrees with the derived pixels is
worse than no dimension at all, so the rotation and the measurement are asserted together.

**Every kind of image, on every surface.** Neither `completeUpload` nor `deriveVariants` branches
on kind, owner type or bucket - both ask only whether the mime is an image - so a chat photo, a
news post image and an avatar are corrected identically, despite an avatar taking a different
upload branch into the public bucket. And **every render site draws a derived variant**: `display`
for chat, news, the viewers and the club, race, Eboard and member profiles; `thumb` for the avatar
component, the gallery grid and the reply-quote thumbnail. Nothing on screen renders the original,
which is the reason correcting derivation corrects the product. The one caller that asks for
`original` is the viewer's save-to-Photos, where the untouched bytes carry their EXIF tag and the
operating system turns the picture, as it does for any camera file.

An avatar is the hardest case to *see* wrong and so has its own assertion: the well is square, so
a sideways face is the only symptom and there is no wrong-shaped box to notice.

**Existing objects were not backfilled.** Anything already derived keeps its variants, so a photo
uploaded before this stays as it was - sideways if its camera said so - rather than silently
changing under people. Re-deriving is a decision with a cost, not a migration.

### Three sizes, and what happens to a photo that predates one

`VARIANTS` in `media/derive.ts` is the whole vocabulary: `thumb` at 400px, `bubble` at 800px,
`display` at 1600px, plus `original`, which is not derived at all.

**`bubble` was added on 2026-08-27 because `display` is about five times bigger than a chat bubble
can show.** A photo in a conversation is drawn at most 240pt wide and 320pt tall, so the most a
bubble can ever use on a 3x screen is 720x960 device pixels - against the 1600x2105 a `display`
variant carries, which is roughly 13MB of memory once decoded where 800px is roughly 3.4MB. That
is the size iOS was evicting between visits and fetching again. 800 rather than the 720 strictly
needed, because a width is baked into stored objects and re-deriving is a decision with a cost;
the headroom covers a wider bubble later without a second backfill. `thumb` cannot serve the slot
instead - it is visibly soft at 720 - and **`display` stays at 1600 and must**, because the
full-screen viewer is the surface where those pixels are the point rather than waste.

**Derivation happens once, at upload, so adding a size leaves every photo already stored without
it - permanently, until it is backfilled.** That is a different fact from "the worker has not run
yet", which lasts seconds, and it is why the read path never assumes a key is there.
`VARIANT_FALLBACKS` says what to serve instead, and every chain ends at the original, which always
exists:

| Asked for | Served, in order |
|---|---|
| `original` | the uploaded bytes |
| `thumb` | `thumb`, else the original |
| `bubble` | `bubble`, else `display`, else the original |
| `display` | `display`, else the original |

`bubble` prefers `display` over the original for the same reason `bubble` exists: an original is a
multi-megabyte camera file, where a 1600px WebP is merely larger than it needs to be. So a photo
uploaded before `bubble` existed degrades to exactly what it rendered as the day before, rather
than to something worse. The mime travels with the URL down the same branch the key came from, so
a fallback can never describe bytes it did not choose.

**The backfill is a script, not a migration**: `scripts/backfill-media-variants.mjs`. It calls
`deriveVariants` - the same function the worker calls, unchanged - once per photo missing the
size, and it deliberately does not enqueue `media.uploaded` events, which would queue in the
outbox in front of somebody's notifications. It names its target like the drills do, it is safe to
re-run (a completed row is not selected and would be skipped anyway), and it resumes rather than
repeats when interrupted.

```
node --env-file=.env scripts/backfill-media-variants.mjs --target local --dry-run
node --env-file=.env scripts/backfill-media-variants.mjs --target production
```

**Adding a variant does not touch signing or bucket routing, and that is a property worth stating
rather than rediscovering.** A derived key is the original key with `.<variant>.webp` appended, so
its first path segment - the thing [ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md)'s
Worker routes on - is unchanged, and the signature is an HMAC over the whole key string either
way. The Worker needs no new configuration and no redeploy for a new size.

**The client asks for `bubble` as of 2026-08-27** (commit `cc6ed2a`). `PhotoBubble` requests it
instead of `display`, which for a 240pt slot on a 3x screen is roughly a fifth of the pixels and
about 3.4MB of decoded memory against 13MB - the reason iOS was evicting chat photos between visits.
`VARIANT_FALLBACKS` degrades a photo uploaded before the size existed to `display` rather than
breaking, and the 19 already in production were backfilled. **It shipped server-first on purpose**:
had a phone asked for a name the route's validator did not know, every chat photo would have read
"Photo unavailable". See [`TECH/21`](21-deployment.md) rule 1.

---

## Who signs a download URL

**Added while completing Phase 3, on discovering that the client could not render a photo at all.**

The hour-aligned `exp`/`sig` pair is validated by **the CDN edge**, not by the object store. That
is the production shape, and it produces one byte-identical URL per window for all 300 members
rather than 300 different ones.

**Debt 7 is only partly paid off, and this was asserted in five files before anybody checked.**
A byte-identical URL is a prerequisite for caching; it is not by itself a shared edge entry.
Caching a Worker's response requires **Workers Caching**, which is opt in through a top-level
`"cache": {"enabled": true}` in `wrangler.jsonc` and is deliberately not set. So the position
today is one cache entry per browser rather than one for everybody, and every viewer's first fetch
of a photo is a live R2 read.

What the alignment does buy is still real: the cache **key** collapses to one URL per window
instead of fanning out per fetch, a deleted photo goes dark within the hour, and expiries stagger.
Found by a red-team pass on 2026-08-21 and confirmed against Cloudflare's documentation and the
pinned wrangler's config schema.
[ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md) carries the
citations and the one command that re-confirms it after the cutover.

Point that same URL straight at a bucket with no CDN in front of it and the store has never heard
of `exp` or `sig`, so it is simply an unauthenticated GET on private content - correctly refused
with 403. Development has no CDN, so every photo in the app was unreachable while every server
test passed, because the tests exercise the signing function rather than fetching the bytes.

So the signing mode is explicit configuration, `MEDIA_URL_MODE`:

| Mode | Who validates | Where |
|---|---|---|
| `cdn` (default) | A signature-checking CDN at the edge, against `exp`/`sig` | Production |
| `presign` | The object store itself, against its own presigned GET | Development, and any deployment with no CDN |

**The hour alignment survives both.** A store-presigned URL embeds its signing timestamp, so
signing with "now" would produce a different URL per request and destroy the cache-sharing
property. The signing date is therefore pinned to the **floor of the current hour** and the expiry
carried as the distance from that floor to the aligned expiry - which makes the presigned URL
byte-identical within the window exactly as the CDN one is. Asserted by resolving twice and
comparing the strings.

`cdn` is the default so that a missing value in production cannot silently start handing out
store-signed URLs.

### What "the CDN edge" actually is

A **Cloudflare Worker**, at `packages/cdn-worker`, decided in
[ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md). Not a CDN
configuration and never a bucket: see [Deployment](21-deployment.md) rule 8 for why pointing this
hostname at R2 directly publishes every private object.

It does four things in a fixed order, and the order is the design:

1. **Verify** the `exp`/`sig` pair. Anything wrong is 403.
2. **Route** by the key's first path segment. `avatar/` is identity, `photo/` and `document/` are
   content, and anything else is 404 **before R2 is touched at all**.
3. **Read** the object.
4. **Answer**, with `public, max-age=3600` on a hit and `no-store` on every refusal.

Refusing before reading is what stops an unauthenticated caller doing work in the private bucket,
and it is what stops the response distinguishing "this object does not exist" from "your signature
is wrong".

**One implementation of the signature, not two.** The api mints on Node and the Worker verifies on
`workerd`, so `signMediaUrl` and `verifyMediaSignature` live in `@clubchat/shared/media-signing`,
written on WebCrypto because `crypto.subtle` is the only hash `workerd` has. Both runtimes import
it. That is the whole reason signing is asynchronous here.

**The secret can rotate without a media outage.** The Worker accepts a signature from either the
current key or a previous one, current first, while the api always signs with the current key. The
previous key is configured on the Worker alone. Without that, changing the secret darkens every
outstanding URL for the remainder of its hour window.

**Both sides answer `GET /__parity`** with the first 8 characters of an HMAC over one public
constant, so "do these two hold the same secret" is a `diff` of two `curl`s. A mismatch presents as
every photo 403ing and looks exactly like a broken Worker rather than a wrong key, which is why the
diagnostic exists at all rather than being reasoned out each time.

## Reaching media from a client

Two routes, one authorization:

| Route | Answers | For |
|---|---|---|
| `GET /media/:id` | `302` to the signed URL, `private, max-age=600` | An `<img src>`, which sends no custom headers and follows the redirect itself |
| `GET /media/:id/url` | `200` with `{url, expiresAt}`, `no-store` | A client that holds an `Authorization` header |

Both call the same function and re-evaluate the same membership predicate on every request. The
JSON sibling exists because **a 302 behind an `Authorization` header is unusable as an image
source on the web**: `<img src>` cannot carry the header, and react-native-web renders every
`Image` as an `<img>`, so the native path (`Image` with `{uri, headers}`) has no web equivalent.

The cache headers differ deliberately. The redirect is hit on every render, so caching it
privately is what stops a re-render re-authorizing. The JSON route is consumed by a client that
already memoizes the resolved URL for the life of its window, so an HTTP cache in front of it
saves nothing and costs something: a member who lost access would keep resolving successfully for
up to ten more minutes.

**A token in the query string is not an option** for either. Credentials never go in a URL, and
the signature deliberately grants fetchability of an already-unguessable key rather than access.
