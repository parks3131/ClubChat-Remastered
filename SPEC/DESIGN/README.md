# DESIGN - what a surface looks like, and why

One file per **surface**: a reusable piece of interface with its own identity, wherever it appears.
The tab bar is a surface. So are the message bubble, the chat row, the context menu and the card.
A *screen* is not - a screen is a composition of surfaces, and describing the tab bar inside four
screen files is the same drift [Design system](../TECH/13-design-system.md) rule 5 exists to
prevent.

Added 2026-08-09, when [Design system](../TECH/13-design-system.md) started turning into a
catalogue. That file is the **system**: tokens, the type scale, the structural rules, and where
design authority comes from. It changes rarely. What was accumulating inside it was per-surface
detail that changes constantly, and one bullet about the tab bar had grown to five paragraphs.

---

## The one rule

**Record the relationship, not the value.**

| | |
|---|---|
| Wrong | "the bar is inset 24pt" |
| Right | "the bar is inset **further than the content gutter**, so it reads as a separate object rather than another block of the page" |

The first is dead the moment somebody asks for "a bit more", and it duplicates `theme.ts` - which
the repo's own rule says wins anyway, so the spec is guaranteed to lose that argument. The second
survives 24 becoming 28, and it is the thing that would otherwise have to be re-derived by whoever
next wonders why the bar does not line up with the text above it.

Name the token. State the relationship it has to hold. Leave the number in the code.

## What must not be in here

| Not this | Where it goes |
|---|---|
| Token values, the type scale, structural rules | [`TECH/13`](../TECH/13-design-system.md) |
| Why the product does this at all | [`PRD/`](../PRD/) |
| A decision that closes off an alternative system-wide | [`decisions/`](../decisions/) |
| The long story of getting it wrong four times | [`HISTORY.md`](../../HISTORY.md) |
| Any measurement the code already owns | `theme.ts`, and nowhere else |

## Obligations get promoted, always

A visual choice can create a hard contract for code that has nothing to do with the surface.
Floating the tab bar obliges **every scrolling screen in the app** to reserve clearance or keep a
last row nobody can read.

So a design spec's "obligations" section is a **pointer**, never the only home. Anything listed
there is also written into the relevant `TECH/` document or an ADR, because a per-surface design
file is precisely where somebody building an unrelated roster screen will never look. That
discipline is the whole reason this directory is worth having rather than being a folder of
descriptions.

## Rules are numbered so they can be cited

The same reason [`PRD/`](../PRD/) numbers its behaviour rules. A commit message, a code comment, a
review or another spec can say `DESIGN/01-tab-bar` rule 5 rather than restating it and slowly
restating it wrongly.

---

## Surfaces

| # | Surface | Covers |
|---|---|---|
| 01 | [Tab bar](01-tab-bar.md) | The four destinations: the floating bar, the sliding pill, the badge |
| 02 | [Avatar](02-avatar.md) | Every face in the product: the shape that says person or group, the fallback, the tint |
| 03 | [Pinned strip](03-pinned-strip.md) | The notices above a conversation: what makes them appear, and the measurement trap that made a working one invisible |
| 04 | [Share sheet](04-share-sheet.md) | Handing a club to somebody: the preview, the ways the link travels, and the code |
| 05 | [Content card](05-content-card.md) | What a poll, an event or a meeting becomes in a conversation: one shell, three payloads, and the votable bar |
| 06 | [Composer](06-composer.md) | The form you fill in to make a thing: sections separated by air, the action in the header, and the wheel |
| 07 | [Reactions](07-reactions.md) | The pills under a message and the sheet behind them: tap to act, hold to ask who, and a scrim that stays put |
| 08 | [Attachment panel](08-attachment-panel.md) | What the composer's "+" opens, in the keyboard's place: one control with two modes, and a swap with no frame in between |
| 09 | [Chat composer](09-chat-composer.md) | The bar you write in: a wash of the accent, glyphs rather than chips, and a send that only exists when there is something to send |
| 10 | [Member card](10-member-card.md) | Who somebody is, raised over the list that asked: a panel that travels while the shade stays put, and a menu that is the server's answer |
| 11 | [Photo compose](11-photo-compose.md) | The step between choosing a photo and sending it: a look at it, a crop stored as fractions, and a caption that is a real message body |
| 12 | [Meetup detail](12-meetup-detail.md) | One meetup on its own screen: name, place, notes, and the map from a pasted link |
| 13 | [News post](13-news-post.md) | A post as a publication: the gallery, the place, the people, and the composer behind it |
| 14 | [Week row](14-week-row.md) | One day of the club's week: the letter badge, the name, and the time chip |
| 15 | [Document bubble](15-document-bubble.md) | A file somebody sent: the tile that IS the bubble, the type read off the extension, and tap-to-open |

**Written as surfaces are worked on, not backfilled in a pass.** A spec written by reading code
rather than by looking at a device starts out wrong, and a directory of unverified documents is
worse than an empty one.

## Templates

- [Design spec](../templates/design-spec-template.md) - starting a new surface
- [Design review checklist](../templates/design-review-checklist.md) - before calling any visual
  change done. **Every item on it shipped as a defect once.**
