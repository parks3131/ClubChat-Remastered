# Media pipeline

### Two classes, as specified

| Class | Examples | Bucket | Serving |
|---|---|---|---|
| **Identity** | user/club/race/eboard avatars | public | CDN, stable path, `?v=` cache-bust on replace |
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

Four things the server crop owes, each asserted in `media-crop.test.ts`:

- **Rotate before extracting.** A phone photo carries its rotation in EXIF, so cutting first takes
  the region out of sideways pixels - wrong by ninety degrees rather than by a little.
- **Replace the stored object.** The gallery, the thumbnail and the download hop read one key; a
  surviving original under it would leave them disagreeing about which picture they meant.
- **Re-state `bytes` and the dimensions on the row**, which now describe the object that exists.
- **Refuse a rectangle that does not fit** rather than clamping it. Cutting a region nobody chose
  is worse than saying no, and the upload is left untouched so a corrected retry completes against
  the same bytes.

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
    https://cdn.clubchat.app/o/{object_key}?exp={hour_aligned}&sig={hmac}
```

- The signature expiry is **aligned to the top of the hour** (`exp = ceil(now, 1h) + 1h`), so
  every viewer in that window is issued the *byte-identical* URL. One CDN cache entry serves all
  300 members instead of 300 origin fetches.
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
| No image resizing; full-resolution originals served | Worker derives `thumb` (400px) and `display` (1600px) variants; chat renders `display`, gallery grid renders `thumb` |
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

---

## Who signs a download URL

**Added while completing Phase 3, on discovering that the client could not render a photo at all.**

The hour-aligned `exp`/`sig` pair is validated by **the CDN edge**, not by the object store. That
is the production shape and it is what buys the debt-7 fix: one byte-identical URL per window,
therefore one shared cache entry for all 300 members instead of 300 origin fetches.

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
