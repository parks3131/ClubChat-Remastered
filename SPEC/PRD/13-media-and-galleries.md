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
   **A news-post photo is the case that tests this**, and until 2026-08-16 it broke it: news
   photos are uploaded against the club's main channel so that channel's access rules govern
   them, and they were recorded as `owner_type: 'message'`, so they appeared in a gallery of a
   conversation they were never posted in. They carry `owner_type: 'news_post'` now and the
   gallery filters on it. The channel still governs access, which was always the right part.
   See [ADR-0038](../decisions/0038-a-news-post-carries-an-ordered-gallery.md).
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

---

**Built as of 2026-07-30.** Attaching a photo or a document from chat, end to end: the composer's
"+" menu, the pickers, the presigned upload, thumbnail derivation, and photo and document bubbles
that render through the authorized hop. A document bubble shows its filename and size.

**Built 2026-08-01.** The **Gallery grid** and the **full-screen viewer**, which is one component
serving both surfaces. Tapping a photo in chat opens it; the gesture went on the message bubble's
own pressable rather than on the bubble inside it, because a second pressable there is invalid on
web and swallows the outer long press on native.

The viewer carries the sender's face, name and date over the photograph, and a menu: **Reply**
from chat, **Show in chat** from the gallery, then Share Image, Download and Report. Only the
first item differs between the two, and it differs because a photograph reached from the gallery
has been lifted out of the conversation it was said in.

**Saving downloads the `original`, never a derived variant**, and that is a correctness rule
rather than a quality preference: derived variants are WebP, Photos will not accept WebP, and iOS
decides what it is being handed from the file extension alone. Object keys carry no extension, so
the resolve hop returns the object's `mime` alongside its URL and the client names the file from
it. The gallery read carries its sender for the same reason the viewer needs a header at all.

**Saving is iOS and Android only.** There is no photo library on the web, so the action there
says so and points at Share instead. *(Corrected 2026-08-02: the platform module backing it was
imported at the top of the viewer, and because it has no web build, evaluating it took the
**entire web bundle** down - a blank screen on every route rather than one unavailable action.
It is loaded inside the handler now. Same shape as the `expo-sqlite` wasm failure in
[Engineering pitfalls](../TECH/14-engineering-pitfalls.md).)*

**Not built yet.** Nothing in this section.
