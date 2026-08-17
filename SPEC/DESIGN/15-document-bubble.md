# Surface: document bubble

## Purpose

A file somebody sent, said in the fewest things that identify it: what it is called, what kind it
is, and how big.

A photograph shows itself. A document cannot, so the bubble's whole job is to be recognisable at a
glance while scrolling past, and to be obviously openable.

## Where it appears

In a conversation, in every scope, for a message of type `document`. Nowhere else - a document does
not enter a gallery ([Media](../PRD/13-media-and-galleries.md) rule 3 is photos only) and there is
no other screen that lists one.

## Anatomy

| Part | What it is |
|---|---|
| `document` | The tile. It **is** the bubble - see rule 1. |
| `documentIcon` | An accent square with a page glyph, the only saturated thing in the tile. |
| `documentName` | The filename, at headline weight, two lines at most. |
| `documentDetail` | `PDF · 1.2 MB`. The type, then the size. |

## Rules that must survive

1. **The tile is the bubble.** It carries the bubble's own fill - `bubbleSent` on your own message,
   `bubbleReceived` on somebody else's - and the message bubble goes `bare` behind it. It was a
   white card with a hairline *inside* the tinted bubble until 2026-08-17, which drew two
   rectangles around one filename: the same "boundary shades" the photo bubble lost its grey matte
   for. The rule generalises the one already in the chat screen - **an attachment sent with nothing
   said alongside it wears no bubble** - and a document is the case where it matters most, because
   a document tile is already a rounded filled rectangle of its own.

2. **The timestamp sits under the tile, not inside it**, which follows from rule 1 rather than
   being a second decision: a bare bubble has no padding for it to sit in. This is the one place a
   document differs from a text message, which keeps its time in the bubble's bottom-right corner.

3. **The type comes from the filename's extension, never from a mime type.** The envelope carries a
   name and a byte count and no content type at all, so the extension is the only source there is -
   and it is also the part the sender saw. A name with no extension shows the size alone rather
   than inventing a type.

4. **The icon square is proportioned against the tile's padding, not sized in isolation.** The
   frame around the icon is about a quarter of the icon, and the gap from the icon to the words
   matches that frame, which is what makes the tile read as one object rather than as an icon with
   a caption beside it. Taken from the founder's mockup of 2026-08-17 by proportion, so it survives
   the icon changing size.

5. **A long name breaks in the middle and keeps its extension.** `ellipsizeMode="middle"`, because
   the extension is the most informative part of a filename and truncating from the right is
   exactly what removes it.

6. **The tile has no width of its own.** The message row already caps a bubble at a proportion of
   the screen, and the text column shrinks rather than flexing - so a short filename gets a small
   tile and the bubble stays close to the size of what it contains. A fixed maximum here was the
   tile disagreeing with the conversation about how wide a message may be.

7. **Tap opens, hold reacts.** The same split every message bubble uses. Both gestures live on the
   message bubble's own `Pressable`; this surface declares neither, because a second pressable
   inside that one is a `<button>` in a `<button>` on web and swallows the outer long press on
   native.

8. **The tile says it is busy, and says it where it was touched.** The spinner takes the icon's
   place rather than sitting beside it, so nothing moves while a file is on its way. A banner at
   the top of the conversation would be reporting the wait somewhere nobody is looking after
   tapping a tile.

## States

| State | Treatment |
|---|---|
| Default | Icon, name, detail line |
| Opening | The icon square holds a spinner; layout is unchanged |
| Pending | The whole bubble at reduced opacity, with `Sending` beneath it where the time will go |
| Failed | `Failed. Tap to retry` in place of `Sending` |
| Empty | Not possible. A document message always has a name to fall back on (`Attachment`) |
| Loading | None. The name and size ride on the envelope, so the tile is complete before any network call |
| Error | None of its own. A failed open is the conversation's notice |

## Obligations it creates elsewhere

| Obligation | Who owes it | Recorded in |
|---|---|---|
| Tapping a document previews it in the platform's own viewer | `open-document.ts` and `modules/quick-look` | [ADR-0041](../decisions/0041-a-document-opens-in-the-platforms-own-viewer.md) |
| The bubble goes `bare` for an attachment with no caption | The chat screen, both the acked and the pending row | This file, rule 1 |
| A native module is required optionally, never required | Anything reaching `modules/` | [Engineering pitfalls](../TECH/14-engineering-pitfalls.md) |

## Accessibility

The bubble announces what the tap does and names the file - "Open Route_map_Saturday.pdf. Press and
hold to react" - because on a document the tap is the point and the hold is secondary. Every other
message bubble announces the hold alone, since that is the only gesture it has.

## Platform differences

| | Behaviour |
|---|---|
| iOS | As described. Tapping opens iOS's own document viewer. |
| Android | Unverified - no build exists. The viewer is iOS-only, so a tap would reach the share sheet. |
| Web | The tile is identical. A tap downloads the file, which is what "open this" means in a browser. |

## Rejected alternatives

**A white card inside the tinted bubble.** What shipped from 2026-07-30 to 2026-08-17. See rule 1.

**A solid accent slab on your own message.** What came before the card, and it was right while the
sent bubble was an orange gradient carrying white text. Against `bubbleSent` it became the loudest
thing in the conversation, for an attachment.

**Showing the mime type rather than the extension.** More precise and unavailable: the envelope
does not carry one, and adding it would put a second, differently-derived answer to "what kind of
file is this" on the wire next to the name that already answers it.
