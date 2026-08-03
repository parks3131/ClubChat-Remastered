# ADR-0018: Uploads are decoded at the boundary, and undecodable bytes never park an event

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-03 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

A 97-byte PNG sat in a development channel for four days with its `media.uploaded` event parked
after five identical failures: `vipspng: libpng read error`.

The bytes were a valid PNG signature over a valid `IHDR` declaring a 4x4 RGBA image, followed by
an `IDAT` chunk announcing 42 bytes of pixel data with only 40 present. Two bytes short of a
file. It was the first upload in the database, and every later image derived fine.

Two things were wrong, and only one of them is about corrupt images.

**Nothing on the upload path could tell.** `/media/:id/complete` exists precisely to verify that
what arrived matches what was declared, and it checked everything a `HEAD` can see: the object
exists, the byte count matches exactly, the content type matches. All three passed. "Is this an
image" is not a fact a `HEAD` carries, so the object went `ready`, a message was attached to it,
and what a member saw in the conversation was a permanently broken photo with no error anywhere.

**The parked row was the wrong alarm.** Parking means *an effect never ran* - a notification
nobody will receive, a card that never appears - and the retention sweep deliberately never
prunes a parked row because it is the only durable evidence of that. But `media.uploaded` is the
one event type that can fail from **bad input** rather than from a bug, and bad input is
user-reachable. Enough corrupt uploads and `parked > 0` is pinned on forever, and a signal that
is rare by construction becomes background noise. Which is how this one went unnoticed for four
days: it was true, permanent, and indistinguishable from an incident.

Reading the header is not sufficient to catch this. `sharp.metadata()` parses `IHDR` and reports
4x4 for the file above without complaint; only walking the pixel stream reaches the truncation.

## Decision

**Decode every image upload at `/media/:id/complete`, and never park an event on bytes that do
not decode.**

Concretely:

- `completeUpload` reads the object and fully decodes it before marking the row `ready`. Failure
  is `422 undecodable`, and the row is left `pending` so nothing can reference it and the GC
  reclaims the bytes on the same path as an upload the client abandoned.
- The decode is `sharp(bytes).stats()`, which walks every pixel with bounded memory. Not
  `.raw().toBuffer()`, which materialises a ~70 MB surface for a 25 MB JPEG, and not
  `resize(1, 1)`, which looks cheaper and is wrong: libvips shrinks a JPEG **on load**, so a
  downscale can satisfy itself from a fraction of the file and never read as far as the damage.
- Strictness is `failOn: 'error'`, defined once in `media/probe.ts` and used by both the gate and
  `deriveVariants`. If the gate were the more permissive of the two it would admit objects that
  later fail to derive, which is the hole this closes.
- `deriveVariants` records a decode failure in `media_objects.derive_error` and returns
  `undecodable`, and the effect logs a warning and completes. The catch is scoped to the decode
  alone; `store.put` stays outside it, because a storage write that fails is transient and must
  keep its retries.
- Documents are not decoded. They are bytes we never open, and an image decoder would refuse
  every one of them.

## Consequences

| | |
|---|---|
| Positive | A member who uploads a corrupt photo gets an immediate, specific error instead of a silently broken image in the conversation. `parked > 0` goes back to meaning exactly one thing, which is the only reason it is worth alerting on. Sharp's `limitInputPixels` default applies at the gate too, so a decompression bomb is refused on upload rather than discovered when the worker tries to derive from it. And the media tests now put real encoded images behind their keys, which they never did - the derivation tests previously could not derive and hand-wrote the variant row instead. |
| Negative | **This is the one place the server touches file bytes**, and `TECH/07` says it does not. The rule is about never proxying an upload - the client PUTs directly and `MediaStore` deliberately has no method taking a buffer - and the exception is narrow, but a reader will notice it and it needed writing down. It costs one object read and one full decode per image upload, on a path that is already a round trip to storage; in production that is R2 egress and CPU on the API process for every photo sent. The API process now loads sharp, lazily and on one route. A JPEG that is slightly truncated but still renders after shrink-on-load is now refused, where before it would have been posted with grey blocks at the bottom; refusing it is the better product behaviour but it is a behaviour change. |
| Follow-up needed | The gate makes HEIC decode support load-bearing for **uploads**, not just for thumbnails: if a production sharp build lacked libheif, iPhone photos would be rejected outright rather than merely failing to derive. Verified present in the current build (sharp 0.35.3 / libvips 8.18.3, `heif` input `true`) and worth an assertion at boot if the base image ever changes. Separately, nothing yet surfaces `derive_error` to a client - a media object in that state still resolves to its original bytes, which for a corrupt object is a broken image. Rare now that the gate exists, but the viewer could render a placeholder instead. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Fix only the effect, and let corrupt bytes through the boundary | Stops the alarm pollution, which is the more serious of the two problems, and leaves the member with a broken photo in the conversation and no error. The upload endpoint exists to verify the upload; "is an image" is the one declaration it was not checking. |
| Fix only the boundary | Does nothing for the object already stored - including the one that prompted this - and nothing for bytes that go bad after upload. It also leaves the parking path still able to fire on input rather than on a fault. |
| Probe the header only (`metadata()`), to avoid a full decode | Cheap, and it does not work. `metadata()` returns 4x4 quite happily for the exact file that caused this. A check that passes the motivating case is not a check. |
| Range-read the first N KB and validate magic bytes | Catches "not an image at all" for a fraction of the cost, and misses truncation entirely, which lives at the tail. Same objection as above. |
| Hand-write a container validator per format (walk PNG chunk CRCs, scan JPEG markers to EOI) | Full-file validation with no pixel decode, so cheaper than sharp. But it means maintaining parsers for six MIME types including HEIC, to reimplement badly what libvips already does correctly. |
| Decode in the worker only, and refuse the message send if derivation failed | Moves the cost off the request path, and the send usually happens before derivation completes - so the check would either block sends on a worker round trip or arrive too late to stop the message. |
| Mark the object `orphaned` on refusal instead of leaving it `pending` | `pending` already has a GC path built for exactly this shape (bytes stored, nothing referencing them, client gone). A second state reaching the same collector would be two ways to say one thing. |
| Delete the object immediately on refusal | Makes the failure unrecoverable and adds a storage write to the error path. The 24-hour GC window costs nothing and leaves the bytes available if somebody wants to see what was actually uploaded. |
| Let the parked row stand and just alert more loudly | The count only ever rises and no operator action can lower it, since the retention sweep will not prune it and the event can never succeed. An alarm nobody can clear gets ignored, which is what happened. |
