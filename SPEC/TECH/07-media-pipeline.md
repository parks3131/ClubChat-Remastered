# Media pipeline

### Two classes, as specified

| Class | Examples | Bucket | Serving |
|---|---|---|---|
| **Identity** | user/club/race/eboard avatars | public | CDN, stable path, `?v=` cache-bust on replace |
| **Content** | chat photos, documents, news photos | **private** | authorized redirect → CDN (below) |

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
  → status='ready'; enqueue outbox('media.uploaded') → worker derives thumbnails
```

The chat server never touches file bytes. This is the transcript's point and it stands.

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
