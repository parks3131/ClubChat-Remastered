# Surface: content card

## Purpose

The object a poll, an event or a meeting becomes when it has to appear somewhere that is not its
own screen. It carries enough to act on without leaving where you are - which for a poll means
voting, and for the other two means knowing whether the thing is worth opening.

Without it, creating a poll notifies the whole club about a sentence, and answering it is a
round trip out of the conversation and back.

## Where it appears

Chat, in every scope that can hold one, and the top of each object's own detail screen. Six
places, one shell. The list rows on the Polls and Calendar screens are **not** this surface -
they are a bib-and-title row built for scanning a column, and they are deliberately different.

## Anatomy

| Part | What it is |
|---|---|
| `ContentCard` | The surface: card fill, hairline outline, gutter padding. Pressable only where nothing inside it is. |
| `DateChip` | Filled day-over-month block. Events and meetings only - a poll has no day. |
| `CardEyebrow` | The kind, in the accent: EVENT, POLL, MEETING. Plus a state chip that overrides it. |
| `CardTitle` | The headline, in the body-bold face. |
| `CardMeta` | The quiet line: time, place, deadline, who. Built from parts, never a joined string. |
| option row | A poll only: the track, the proportional fill, the label, the count and the eye. |

## Rules that must survive

1. **The eyebrow is what makes a conversation scannable.** A reader knows which of the three kinds
   they are looking at before reading a word of the title, because the one coloured thing at the
   top of the card is its kind. It is the accent; nothing else on the card is.

2. **A state chip mutes the eyebrow rather than joining it.** CLOSED on a poll takes over the
   meaning of the card, so the kind steps back to secondary text and the chip is the thing that
   reads. Two loud labels side by side is two things asking to be read first.

3. **The card is the link, or it holds controls. Never both.** An event and a meeting have nothing
   tappable inside them, so the whole card navigates and there is no button on it. A poll's every
   option is a control, so the card itself presses nowhere - and putting a button on it would nest
   a control inside a control, which is invalid on web and swallows the gesture on native.

   **A card holds only what acts on its own content.** Voting and opening the voter list are about
   the poll; closing, reopening and deleting it are about *managing* it, and those live in the hold
   menu with the other management actions a message has. The test is not permission - it is whether
   the control belongs to the thing being shown or to the person who owns it.

   > **`PRD/07` rule 10 used to require a VIEW EVENT pill** and it was rewritten on 2026-08-13 to
   > match this. A card that is entirely a link does not also need to contain one.

4. **A card is introduced, not signed.** It is drawn full width with no bubble fill, because a poll
   is put to the room rather than said to it - the same reasoning the announcement card already ran
   on. Who posted it is said **once**, by an avatar and a name sitting side by side directly above
   the card, the way a message is attributed. **The card itself never names its creator**, in any
   of the three kinds: that row is the only attribution, and a card repeating it says the same
   thing twice in one glance.

   > Attribution spent part of 2026-08-13 inside the card's meta line, when cards first left the
   > bubble. The founder asked for the author row the same day. The rule that survives both is the
   > one above - said once, in one place - and the detail screens are unaffected, since they have
   > no author row and still carry "Added by".

5. **The meta line is built from parts and joins only what is present.** An event with no location
   must not render a stranded separator. This is a rule rather than a call-site convention because
   every one of the three cards has at least one optional part.

6. **The date chip states a local day.** An event's time is an instant and a race's is a bare date,
   and the two need opposite parsing - see `bibParts`. Getting it wrong puts a confidently wrong
   date in the loudest position on the card, which is worse than showing none.

### The poll option row

7. **The row IS the bar.** One object per option: a track holding a fill sized to that option's
   share of the votes cast, with the label sitting on the fill and the count at the right. Not a
   label line with a thin progress bar beneath it - that is two objects saying one thing, and it
   made a three-option poll six rows tall.

8. **The fill is a share of votes CAST**, which is what the number beside it counts. On a
   multiple-choice poll the shares therefore still total 100 while exceeding the number of people
   who voted, and that is the honest reading of "12 of the 20 votes".

9. **Selection changes a colour and never a height.** The border is always present and
   track-coloured, so gaining the accent ring cannot move every row below it. There is no tick
   glyph beside the label for the same reason: it would shift the text as it appeared, and the ring
   already says it.

10. **The eye is per option, and its gutter is reserved for the whole poll or for none of it.**
    Reserving per row steps the counts in and out as options cross their first vote. The eye is
    absent - not disabled - where the viewer may not see voters at all, which is a different fact
    from nobody having voted.

11. **Opening the voter list must never cast a vote.** The two are sibling targets inside the row,
    never nested, and the eye's gutter is wide enough that a miss lands on nothing rather than on
    the vote it sits beside.

12. **A closed poll mutes but still shows its tally.** The fills grey and the eyebrow steps back,
    while the ring marking your own vote survives in a softer tone. Results are most of what a
    closed poll is for; hiding them would make closing it a deletion.

## Obligations this creates elsewhere

- **The chat row must special-case cards before it builds a bubble.** A full-width card cannot
  come through the bubble path at all, and everything the bubble was carrying for it - long press
  to react or report, the web dots that stand in for that gesture, the pin marker, the jump
  highlight, the reaction row, and now the author row - has to be carried by the card branch
  instead. Recorded in [`TECH/08`](../TECH/08-client-architecture.md) rather than only here.
- **A card that navigates must take the long press itself.** Its own pressable becomes the touch
  responder on native, so a hold aimed at the row around it never lands. See `AGENTS.md` failure
  mode 27 - this was silently broken for the entire life of the event card.
- **Anything drawn over a fill needs an explicit stacking order on web.** An absolutely positioned
  sibling paints above a static one in CSS regardless of source order, so the option label needs
  `zIndex` or it is covered in a browser and nowhere else.

## Rejected alternatives

- **A VIEW POLL / VIEW EVENT pill on every card.** What the cards had. It is a second way to do
  what pressing the card already does, and on the poll card it is a button that cannot legally
  exist among the option buttons.
- **Keeping the cards inside their creator's bubble.** 82% of the column minus an avatar is not
  much width to compare option bars in, and comparing them by length is the whole point of the
  bar.
- **A tick beside the chosen option's label.** See rule 9.
- **Muting a closed poll by hiding its bars.** See rule 12.
