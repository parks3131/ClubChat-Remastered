# Surface: avatar

## Purpose

The face of whoever or whatever a row, header or profile is about: their picture, or a fallback
when there is none. It carries one piece of information beyond identity, and that is the reason
this file exists rather than the component being self-explanatory:

> **Its shape says whether you are looking at a person or at a group**, before a single word is
> read.

Without that, a list of clubs and a list of members are the same column of discs, and the reader
has to get the answer from the text every time.

## Where it appears

Effectively everywhere a name appears: the Chats list, the space header on every club, race and
Eboard screen, chat message rows, the chat header, rosters and member pickers, car groups, poll
voters, news post authors, the moderation queue, DM profiles, and the four editable profile
screens.

**Deliberately absent** from the tab bar, the calendar and notification rows. Those are about
events rather than about a person or a space, and a face on them would imply an author the row
does not have.

## Anatomy

| Part | What it is |
|---|---|
| `well` | The container. Owns the size and the shape. |
| `picture` | The uploaded image, resized to cover the well. |
| `fallback` | What is drawn when there is no picture. Two kinds - see rule 4. |
| `tint` | The fallback's colour, derived from an id rather than a name. |
| `ring` | An optional hairline outline instead of a filled disc. Opt-in, currently the Chats list only. |

## Rules that must survive

1. **A picture is the exception, not the norm.** Most people and most spaces have no picture, so
   the fallback is the ordinary case. Both live in one component for that reason; four screens had
   each written the conditional by hand before it did.

2. **Circles are people. Rounded squares are things.** A club, a race, and Eboard & Council are
   things. So are News & Highlights and a club's main chat - **every space is a group**, including
   the ones drawn as a destination icon rather than a picture, and including any space added later.
   A direct message is a person, because that is who is on the other end of it.

   **This rule has been broken four separate times**, each time by a surface that drew its own
   face instead of using this one. It is the reason for rule 3.

3. **Roundness is derived, never passed alongside the kind.** `shape` defaults from `kind`, so
   naming the kind has already named the shape. They were independent props until 2026-08-11 and
   they drifted in both directions: the Chats list said `group` and got a circle, while the chat
   header said `square` and got a person's lettered fallback inside it. Two props for one fact is
   two chances to state it inconsistently.

   An explicit `shape` override is still allowed, because an override is legible at the call site
   and the disagreement was not.

4. **The fallback for a group is a glyph, never an initial.** An initial is meaningless for a
   group - "B" says nothing about Binghamton Running Club that the name beside it does not already
   say, and a list of clubs becomes a column of unrelated letters. A person gets their initial.

5. **The tint comes from an id, not from a name.** A club that is renamed must keep its colour;
   colour is how a member finds it in a list before reading anything. Where a scope id is not
   available, the channel id is used, because it is the one id that exists for every conversation.

6. **The fallback scales with the well.** Both the initial and the glyph are a ratio of the size,
   not a fixed measurement - the same placeholder has to read correctly in a 28pt stack avatar and
   a 140pt profile. A fixed size reads as a full-height letter in the first and a speck adrift in
   the second.

7. **One implementation.** Any surface drawing a face uses this component. The rule cannot hold in
   a copy that never reads it, which is exactly how the space header stayed round while the chat
   header two taps away was square.

## States

| State | Treatment |
|---|---|
| Default | Picture if there is one, otherwise the tinted fallback |
| Active / selected | None. An avatar is never a selected thing; the row around it carries that |
| Pressed | None of its own. The row or header that contains it owns press feedback |
| Disabled | None. A face does not become unavailable |
| Empty | Not a state. No picture **is** the fallback, and the fallback is not an error |
| Loading | The well is drawn at once and the picture fades in behind it, so no layout shifts |
| Error | A picture that fails to load falls back to the well's background rather than a broken-image icon |

## Obligations it creates elsewhere

| Obligation | Who owes it | Recorded in |
|---|---|---|
| A picture destined for an avatar must be **cropped to 1:1 before upload**, because the well is square and `cover` would otherwise choose the crop | Every avatar upload path | [Media pipeline](../TECH/07-media-pipeline.md); `pickSquarePhoto` in `apps/mobile/src/upload.ts` |
| Any surface adding a face for a **new kind of space** must pass `kind="group"` and inherit the shape rather than styling its own well | Whoever adds the surface | Rule 3 above, and the component's own docstring |
| A list that renders both people and spaces must derive `kind` **per row**, not per list | Chats list, search results, any merged feed | Rule 2 above |

## Accessibility

The avatar is **decorative in every current use**: it always sits beside the name it depicts, so a
screen reader announcing it would repeat what the adjacent text already says. It is therefore
hidden from the accessibility tree, and the containing row carries the label.

That holds only while the name is present. **A face that ever appears without its name beside it
stops being decorative** and owes its own label at that moment.

Shape is a second channel alongside colour for the person-versus-group distinction, which is what
keeps rule 2 useful to somebody who cannot separate the tints - and is the reason the tint alone
was never considered sufficient.

## Platform differences

| | Behaviour |
|---|---|
| iOS | The crop editor from `expo-image-picker` is **always square**; `aspect` is ignored. This is the ratio wanted, so it is not a limitation here - but it is the reason no avatar anywhere is drawn at another ratio |
| Android | `aspect: [1, 1]` must be passed explicitly to get the same square editor |
| Web | No crop editor at all. A picked file uploads uncropped and `cover` chooses the crop, which is the pre-2026-08-11 behaviour and is why the phone is where this is verified |

## Rejected alternatives

**One shape everywhere, with colour or a badge carrying the distinction.** Colour alone fails
`PRD/16` for anybody who cannot separate the tints, and a badge is a second object to place on a
28pt well. Shape costs nothing and is legible at every size.

**A word-boundary-style fix at each call site** - passing `shape` correctly wherever it was wrong.
Tried first, on the Chats list. It fixes the instances and leaves the trap: two props encoding one
fact, still able to disagree the next time somebody adds a club avatar. Deriving the shape closes
the class rather than the instances, which is the same reasoning as the policy module having one
copy of each predicate.

**Keeping the club hub's wells round** as a deliberate exception, on the argument that the round
filled well is what gives that panel its group-list feel. Rejected on 2026-08-11: what carries
that feel is the flat row, the divider and the filled tint. The roundness was incidental to it and
was putting three spaces into the shape reserved for people, on the one screen where they sit
directly above a list of races drawn as squares.
