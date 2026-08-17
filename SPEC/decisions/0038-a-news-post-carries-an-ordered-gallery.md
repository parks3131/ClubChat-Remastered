# 38. A news post carries an ordered gallery, not a photo

Date: 2026-08-16

## Status

Accepted. Supersedes the single `news_posts.media_id` column that shipped in Phase 0, rewrites
[PRD/06](../PRD/06-news-and-highlights.md) rules 1 and 7, and corrects
[PRD/13](../PRD/13-media-and-galleries.md) rule 4, which the news photo has been quietly breaking
since it was built.

## Context

The founder sent two mockups: a composer with a dashed **Add** tile followed by thumbnails, and a
post card whose picture area carries a `1 / 4` counter and four page dots. A news post today holds
**one** optional photo, cropped square by the OS editor, drawn at `aspectRatio: 1`.

Asked how the composer should behave, his answer set the constraint that decides most of this:
*"first either you can select a bunch of pic or you can add pics trough add photos you can have
crop option too"*. Batch selection **and** a crop, on the same surface. Then, separately: *"limit
i 6 pics per post"*.

Those two sentences are in tension with the picker this app uses, and resolving that tension is
the substance of the decision rather than a detail of it.

## Decision

### Six photos, ordered, in a join table

`news_post_media(post_id, media_id, ordinal)`, with the cap asserted as a constraint rather than
trusted to the route that writes it.

**A join table rather than an array column** because the ordinal is real data that the carousel
reads, and because each row is a foreign key into `media_objects` that a `uuid[]` could not be.
An array of ids is a list of strings the database cannot check; six rows are six references it
can. The same argument `ADR-0028` made for reactions coming from a catalog table.

**Six is the founder's number and it is enforced in three places**, which is one more than it
sounds: the composer stops offering **Add**, the route refuses a seventh, and a constraint refuses
it regardless of who is asking. The third exists because the first two are both code paths and
this one is a data shape.

### One aspect ratio for the whole post, chosen once

The author picks the shape before cropping: `1:1`, `4:5` or `16:9`. Every photo in the post is
cropped into it.

**This follows from a rule already written down.** `upload.ts` says *"the crop frame and the
display frame have to be the same frame"*, or the card silently crops a second time and the
picture that posts is not the one that was chosen. A carousel has exactly **one** display frame,
because every slide is drawn in the same box. So there is exactly one crop frame, and it belongs
to the post rather than to the picture.

The alternative was put to the founder as a picture rather than a paragraph, showing a card whose
height changes mid-swipe, and he chose the single ratio. What that buys is the thing the mockup
already draws: a carousel you can swipe without the page moving under your thumb.

### The crop is the app's own frame, and that is forced

**`allowsMultipleSelection` and `allowsEditing` are mutually exclusive in `expo-image-picker`** -
the OS editor crops one image, so asking for a batch turns it off. This is already written in
`upload.ts:162`, where it was a note explaining why `pickSquarePhoto` sets both, and it is now the
hinge of a design.

Batch selection was asked for and the crop was asked for in the same sentence, so the OS editor
cannot be what does the cropping. It does not need to be: the app **already has a crop frame**,
built for chat photos on 2026-08-15, with the rectangle stored as fractions and applied by the
server at `completeUpload` (`pipeline.ts`). It imports no native module, which
[`11-photo-compose`](../DESIGN/11-photo-compose.md) rule 3 makes a rule rather than a convenience.

So the sheet that already exists is reused, once per photo, with its free-form frame locked to the
post's chosen ratio. Nothing new is built to crop; the frame is constrained and the call site
moves.

> **This retires `pickSquarePhoto` for news and keeps it for avatars.** The rule
> `upload.ts` states - *crop where the frame is fixed, do not crop where the picture sets its own
> proportions* - still holds and still puts news on the cropping side. What changes is that the
> fixed frame is no longer always a square.

### News media owns itself

New `owner_type: 'news_post'` on `media_objects`, and the Gallery read filters on it.

**This is a correction, not a feature.** A news photo is uploaded against the club's main channel
so the channel's access rules govern it, which the existing code documents at length and which is
still right. But it is recorded as `owner_type: 'message'`, and the Gallery is *"every photo ever
posted in that conversation"* - so a photo that was never posted in any conversation has been
appearing there. PRD/13 rule 4 says *"a photo enters a gallery only by being posted in chat"*, and
the build has disagreed with that sentence for as long as news has had photos.

One photo per post made this a curiosity. Six makes it the loudest thing on the Gallery grid.

**The channel still governs access**, which is the part worth keeping: news is readable by every
club member and so is the main channel, so the audience is identical and no news-shaped branch is
needed in the media pipeline. Only the label changes, and the label is what the Gallery reads.

## Consequences

- **One migration, and it backfills before it drops.** Every existing post with a `media_id`
  becomes one row at `ordinal` 0 with the post's ratio recorded as `1:1`, which is what those
  photos actually are. The column drops afterwards, in the same migration, so no deploy exists in
  which the data lives in two places.
- **A partly uploaded post is now possible and must not be a post.** Five photos land and the
  sixth fails, and the composer has to be able to say so without discarding the other five or
  posting without them. The upload happens before the post exists, exactly as it does today, so
  the failure is a composer state rather than a half-written row.
- **The orphan problem is multiplied by six.** PRD/13 already lists *"no storage cleanup at all"*
  as a known gap; a cancelled six-photo post now leaves six objects rather than one. The nightly
  sweep for stale `pending` rows exists and this does not change it, but the gap is worth
  restating where the multiplier changed.
- **`aspect` is stored on the post**, not derived from the first photo. Deriving it would make the
  card's shape depend on which picture happened to be first, and reordering would resize the card.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| **A `uuid[]` column on `news_posts`** | No foreign keys, no per-row cap, and the ordinal becomes array position - which reorders correctly right up until one element is removed by a concurrent edit. |
| **Per-photo free-form crop** | Put to the founder as two drawn cards. Either the carousel changes height mid-swipe, or every slide letterboxes inside the tallest one, which puts grey bars on most photos. |
| **Keeping the square** | Costs nothing and matches the current card exactly. The mockup's media box is plainly landscape, and the whole point of choosing a ratio once is that the founder gets to pick which one. |
| **Deriving the ratio from the first photo** | No control to build. The card then resizes when photos are reordered, and the author never chose the shape their post is drawn in. |
| **Uploading on post rather than on pick** | Would make a partly uploaded post impossible. It also makes the Post button a six-photo upload with a spinner and no way to see what failed, which is a worse failure than the one it prevents. |
| **A news-shaped branch in the media pipeline** | Considered when fixing the Gallery leak, and rejected for the reason the original code gives: the club's main channel is already the correct governor, and a second answer to a settled question is how a pipeline grows a fork. |
