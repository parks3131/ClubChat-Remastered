# Surface: the news post

## Purpose

The card a club publication becomes in the feed, and the form that produces one. Built 2026-08-16
from two mockups the founder sent: a composer's photo row, and a finished post.

Before it, a post was a paragraph and at most one square photo. It could not say what it was
called, where it happened, who was there, or show more than one picture of it - so a recap of a
run with four photographs was four posts or one.

## Where it appears

The card is the feed's row on the club's News screen, and the whole of a post's own screen. There
is no compact variant: a post is the same object in both places, because the feed is the post's
home rather than an index of it.

The composer replaces the feed in place, as it already did.

## Anatomy

### The card

| Part | What it is |
|---|---|
| Author row | Avatar, name, post time, and the overflow that holds edit and delete. Admins only see the overflow. |
| `PostTitle` | The headline, body-bold. Absent when there is none, and then the body is the headline. |
| Carousel | The photos, one box, all the same shape. A `n / total` counter top right and page dots beneath. |
| Location row | Pin glyph and the place. Opens the link when there is one, inert text when there is not. |
| Body | The text, with hashtags drawn as part of the sentence rather than lifted out of it. |
| People line | "With Molly Chen and 2 others", quiet. Opens a sheet of faces. |
| Tag chips | The post's hashtags, each a search. |
| Reaction row | Chat's pills, chat's `+` picker, chat's hold-to-see-who. See [Reactions](07-reactions.md). |

### The composer's photo row

| Part | What it is |
|---|---|
| `Add` tile | Dashed outline, a `+` and the word. First in the row, always. Disappears at six. |
| Thumbnail | The picked photo at the post's chosen shape, with a filled `x` at its top right. |
| Shape control | `1:1` `4:5` `16:9`, above the row. Changing it re-crops every photo already picked. |

## Rules that must survive

1. **The carousel is one box and swiping never changes the card's height.** This is the whole
   reason the shape belongs to the post rather than to the picture, and it is why the composer
   asks for the shape before it asks for the photos. See
   [ADR-0038](../decisions/0038-a-news-post-carries-an-ordered-gallery.md).

2. **The counter and the dots say the same thing and both stay.** The dots are the glanceable
   version and stop being countable past about six, which is exactly where the cap sits; the
   counter is the exact one. At one photo neither is drawn, because there is nothing to page.

3. **`Add` is first, not last.** It is the only control in the row that is always in the same
   place, and a trailing one moves every time a photo is added or removed. It leaves the row
   entirely at six rather than sitting there disabled, because a dashed tile that refuses is a
   worse answer than a row that is plainly full.

4. **The remove `x` is a sibling of the thumbnail, never a child.** The same rule the crop grips
   learned on 2026-08-15 (`11-photo-compose` rule 11): a control inside a pressable is swallowed
   on native and invalid on web.

5. **Changing the shape re-crops rather than refuses.** Somebody who picks four photos and then
   decides the post is landscape must not have to start again. Each photo keeps its own crop
   rectangle, re-fitted into the new ratio, so the choice is reversible until it is posted.

6. **The location row is only a link when it has one.** With a name and no link it is text beside
   a pin, and it must not look pressable - a row that invites a tap and does nothing is the
   failure `07-reactions` rule 7 names for the reaction sheet.

7. **Hashtags stay inside the sentence.** They are typed in the body and they are drawn there, in
   the accent, as part of the text. The chips beneath repeat them as controls. Lifting them out of
   the paragraph would edit somebody's writing.

   **The chips are in the order they were written**, which is why `news_post_tags` carries an
   ordinal at all. This shipped wrong: the extractor kept written order and the read threw it away
   with `ORDER BY tag`, so a body reading "#longRun #bingRC" drew `#bingrc #longrun`. Both
   orderings are deterministic and only one of them is the one somebody typed, which is exactly
   why no test caught it and a glance at a phone did. See `0036_news_tag_order.sql`.

8. **The people line is a line, not a chip row.** The card already has one chip row and it is the
   tags. Two rows of chips saying unrelated things is the "two loud labels" problem
   [`05-content-card`](05-content-card.md) rule 2 describes, one surface over.

9. **The card is a link and the overflow is a control, so the overflow is a sibling.** Same
   structure as the content card's rule 3: the card navigates to the post, and the one thing on it
   that is not a navigation lives outside its pressable.

10. **A post with one photo is not a degenerate carousel.** No dots, no counter, no swipe - one
    picture in the post's shape. The carousel appears when there is something to page through.

## States

| State | Treatment |
|---|---|
| Default | As drawn. |
| No title | The body takes the headline's position and weight is unchanged; nothing collapses. |
| No photos | Author row straight into the body. The card is a text post, which is what it always was. |
| Uploading | The thumbnail draws the local file at once with a progress veil; `Add` stays live so a slow upload does not block the next pick. |
| One photo failed | That thumbnail carries a retry, and the other five are untouched. Post stays available - a failed sixth photo must not cost the five that worked. |
| Full | `Add` is gone. A line says six is the limit, once, rather than a disabled tile saying it forever. |
| Deleted mid-read | The post's own screen backs out to the feed rather than showing an empty card. |

11. **This surface is three screens wearing one url, so it owns its own back control.** The feed,
    the composer and the people picker are states of one route, and
    [`(main)/_layout.tsx`](../PRD/15-screen-map.md) builds `headerLeft` per ROUTE - so the
    layout's arrow unwinds the whole thing from any depth.

    > Reported from the phone on 2026-08-16: *"if I go and select people to tag ... and I just
    > click back button, it just take me outside instead of the previous page."* It was worse than
    > reported - the arrow left for Chats from the composer too.

    Each step installs its own `headerLeft` and turns the swipe-back gesture off, **and the feed
    installs one too**. That last part is the half that is easy to miss: `Stack.Screen` options
    are `setOptions` underneath, so the composer's control outlives the composer, and returning to
    the feed left an arrow that silently did nothing. A back control that does nothing is worse
    than one that goes to the wrong place, because nothing about it looks broken.

## Obligations this creates elsewhere

- **The Gallery must filter on `owner_type`.** Six photos a post makes a leak that one photo hid.
  Recorded in [PRD/13](../PRD/13-media-and-galleries.md) rule 4.
- **The crop sheet takes a locked ratio.** It opens free-form for chat and must open constrained
  here, which is a parameter rather than a second sheet - `11-photo-compose` rule 7 explains why
  it is free-form by default, and this is the fixed-frame case that rule already anticipates.
- **The reaction surface loses its news exception**, so the pills, picker and sheet must not
  assume a message id. See [Reactions](07-reactions.md).
- **`searchMemberCandidates` gains a fourth target**, and the picker it feeds is the roster's, not
  a copy of it.

## Accessibility

The carousel announces position ("photo 2 of 4") and is pageable without a swipe, because a swipe
is not a gesture every reader can perform. Each thumbnail's remove is labelled with what it
removes ("Remove photo 2"), never "close". The shape control is a radio group, not three buttons.
The people line announces the full list rather than the truncation, since "and 2 others" is a
layout decision and not information.

## Platform differences

| | Behaviour |
|---|---|
| iOS | As described. |
| Android | Unverified - no build exists. |
| Web | No OS picker and no haptic. The carousel pages with arrows as well as a drag. |

## Rejected alternatives

- **Per-photo captions.** The mockup's thumbnails carried "Stop 1", "Stop 2", "Stop 3". Asked what
  the text was, the founder's answer was *"ignore that its unnecessary"*, so the thumbnails carry
  only their remove.
- **A category chip on the card.** The mockup drew a "Run" pill above the title. It is the
  per-club activity catalog that `018e4fe` deleted this morning, one table over, and the hashtags
  underneath already say it. See that commit for the argument.
- **Letting each photo keep its own crop.** Drawn for the founder as two cards and declined; the
  card would change height mid-swipe.
- **A separate tags field in the composer.** Asks the author to type the tag twice when they have
  already written it in the sentence.
