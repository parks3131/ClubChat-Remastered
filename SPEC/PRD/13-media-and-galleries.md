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
   as a grid, tap-to-view full screen and swipe between them. It is read-only and adds no new authorization - it
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
7. A document message shows its filename, its type and its size; a photo message may carry a
   caption. **Tapping it opens it full screen inside ClubChat**, in the platform's own document
   viewer - the same component Files and Mail use, so it renders every accepted type and arrives
   with a page count, text search and a share control already in it. The bytes are staged in the
   cache under the document's real filename first, because the platform decides what it is holding
   from the extension alone. Where there is no viewer - a browser, or an app build older than the
   module - it falls back to the share sheet, which reaches the same place in one more tap. See
   [ADR-0041](../decisions/0041-a-document-opens-in-the-platforms-own-viewer.md).

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

**A photograph is opened into a RUN of photographs, not on its own, and you move between them by
swiping** *(2026-08-29)*. Every caller already had a list in its hand and was keeping one entry:
the gallery pages through its grid, and chat through the conversation it has loaded. The direction
follows the list you came from, so a swipe forwards is the next tile in the gallery and the next
photograph down the conversation in chat. **Everything in the chrome belongs to the photograph you
are on** - the face, the name, the date, and whether Report is offered at all, which changes the
moment you swipe from somebody else's picture onto your own.

Two deliberate absences. **Highlights does not swipe**: the pinned strip mixes photographs,
documents and text, so paging it would either skip the things that are not pictures or stop dead at
them. And **there is no counter**: one was built and taken straight back out the day it shipped, at
the founder's request. A running total is a fact about the list, and this header is about the
photograph.

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
