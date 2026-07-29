# Media, galleries, attachments

**Two classes of media, and the split matters.**

| Class | Examples | Visibility | Serving |
|---|---|---|---|
| **Identity** | User, club, race, and Eboard avatars | Public | Served directly from a stable stored URL |
| **Content** | Chat photos, chat documents, news-post photos | **Private** | Served through short-lived signed links, scoped to people who can read that chat/club |

**Rules**

1. **Chat photos and documents are never on public URLs.** A private Eboard channel's photos
   must not be readable by anyone holding a guessable URL. The read check must be the *same*
   membership check that protects the messages themselves.
2. **Avatar paths are stable and upserted** ("one avatar per owner"), so no old-file cleanup
   is needed. The stored URL is cache-busted, since the path never changes.
3. **Every chat has a Gallery**: every photo ever posted in that conversation, newest first,
   as a grid, tap-to-view full screen. It is read-only and adds no new authorization - it
   inherits the chat's own access rules. Club, race, and Eboard each have their own, reached
   from that space's profile screen.
4. **A photo enters a gallery only by being posted in chat.** There is no separate upload.
5. **Signed display URLs must be stable per device**, not minted per fetch. A URL that changes
   on every fetch guarantees a permanent cache miss at every layer (the signature rides in the
   query string, and the query string is part of every cache key). Memoize them, refresh
   ahead of expiry, and clear the memo on sign-out so a second account on a shared device
   cannot inherit URLs for media it may not be allowed to see. Render sites should pass an
   explicit cache key derived from the URL **without** its query string.
6. **Sign in batches, never per row.** One signing call per bucket per page, not one per
   message.
7. A document message shows filename and size; a photo message may carry a caption.

**Known gaps in the current build.** No storage cleanup at all (deleting a message, post,
club, race, or account leaves the object). No file size or MIME-type limits on any bucket. No
image resizing - full-resolution originals are uploaded and displayed. The gallery signs a
channel's entire photo history in one call and is unpaginated by design. Two devices still
hold different signed URLs for the same object, so N viewers is still N origin downloads.
