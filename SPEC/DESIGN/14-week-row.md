# Surface: week row

## Purpose

One day of the club's week, on the Weekly Meetups screen: which day it is, what is happening, and
when. Seven of them are the whole week.

It exists because a week is read at a glance and then acted on. Somebody opens this to answer "is
there anything today" and "what time" - two questions - and every other fact about a meetup is
something they want only once they have decided to go.

## Where it appears

Weekly Meetups, and nowhere else. The club calendar shows the same meetups
([ADR-0036](../decisions/0036-a-meetup-is-a-calendar-kind.md)) in the calendar's own row, because
there a meetup sits among events and races and must not look like a different class of thing.

## Anatomy

| Part | What it is |
|---|---|
| `rail` | The hairline running the length of the week behind the badges. Stops at the first and last |
| `station` | The badge's column: the circle, and the rail passing through it |
| `badge` | The circle carrying the day's letter. The only thing that says which day this is |
| `body` | Everything that day holds: one card per meetup, or "Nothing planned" |
| `headline` | The meetup's name, or its place when it has no name |
| `time chip` | The tinted pill on the right |
| `bell` | Nudge, for an admin. A sibling of the tappable area, never inside it |

## Rules that must survive

1. **The badge is the day, so the day is named once.** There was a header over each day *and* a
   circle in the row, and the circle carried the meetup's time. Seven headers plus seven "Nothing
   planned" lines spent most of a screen restating the calendar. The letter moved into the circle
   and the header went.

2. **Two letters where one is ambiguous.** `M T W Th F S Su`, not `M T W T F S S`. A single initial
   collides on Tuesday/Thursday and Saturday/Sunday, and a badge that cannot tell them apart fails
   at exactly the glance it exists for. Asserted in `dates.test.ts` by checking all seven are
   distinct, rather than described here and hoped for.

3. **Three weights, each a fact rather than decoration.** Today is solid accent; a day with
   something on it is accent-soft; an empty day is sunken and grey. So the shape of the week is
   legible before a word is read. **Only one solid circle exists on the screen** - seven would
   point at nothing, which is [`TECH/13`](../TECH/13-design-system.md)'s rule about reserving the
   filled accent.

4. **The badge belongs to the day, not to the meetup.** A day holding a morning and an evening
   meetup is one letter against two stacked rows. Drawing it per meetup would run the same letter
   down the column and quietly imply two days.

4a. **And it sits beside the middle of the stack, not the top of it.** Two meetups put the letter
   between them; three put it beside the second. It was pinned to the top and a second meetup hung
   off nothing, reported as *"you can see how disoriented it is"*. **This is one alignment rule,
   not arithmetic** - centring the row does it for any number of meetups, and anything that counts
   them is a reimplementation of what the layout already knows.

4b. **The rail carries the week, and the card edge carries the meetup.** *(Changed 2026-09-02.)*
   A hairline rail runs the length of the week behind the badge column, so each badge sits on it
   as a station and the seven days read as one continuous run rather than as seven rows. A meetup
   is a bounded card beside it, outlined in the same hairline, so the rail and the cards are one
   material.

   **The rule this replaced said the same thing with two horizontal rules** - a heavier one
   between days, a hairline between meetups within one day, neither running edge to edge, the
   deeper one inset further. What it was protecting is unchanged and is the thing to keep: **the
   nesting has to read before the colour does.** The rail plus the card edge say it in one
   direction rather than two, and nothing became a table, which is what the insets were guarding
   against.

   **The rail is `hairline` and must not be `cardSunken`.** It was, for about ten minutes on
   2026-09-02, and only the running screen showed why that is wrong: `cardSunken` is also the fill
   of an **empty** day's badge, so on the five quiet days of an ordinary week the badge and the
   rail were one grey and the badge stopped reading as a station - it read as a bulge in the line.
   The warm hairline separates them at all three badge weights.

   **The rail stops at the first and last badge**, drawn as two segments meeting at each badge's
   centre rather than as one line per day. A week has ends, and a full-height rail on every row
   runs past both of them.

4d. **Moving between weeks is two bare chevrons, and the week itself is the only thing between
   them.** *(Changed 2026-09-02, founder's pick from five treatments.)* An accent chevron at each
   edge, and the date range set in the display face, centred.

   **What went were two filled PREVIOUS and NEXT buttons**, and their fault was not styling. They
   were the two loudest objects above a week whose whole job is to be scanned, and between them
   they spent most of the row's width saying what an arrow says in twelve points. The week screen
   already has exactly one thing that should be loud, which is today's solid badge.

   **The glyph is small and its target is not.** A bare chevron is the least obviously tappable
   thing on the screen, so it must not also be the smallest: the drawn icon sits inside a target
   half again its size. Same rule the crop grips learned - what can be hit is larger than what can
   be seen.

   **There is deliberately no way back to the current week.** Three of the five treatments carried
   one and this is not one of them, so paging is the only route. Worth revisiting if anyone
   browses far enough to be stranded; it was left out rather than forgotten.

4c. **A week can afford to breathe.** Seven rows is not a long list, and the screen has room the
   old three-line rows did not leave. Reported as *"too narrow and close"* in the same breath as
   the two above, which is the tell that they were one problem: a crushed layout is where a
   misaligned badge becomes disorienting rather than merely wrong.

5. **The row carries the name and the time, and nothing else.** Place and description were under
   the name and made every row three lines deep, so a full week was a wall of prose. Both are one
   tap away on [the meetup's own screen](12-meetup-detail.md), which is where somebody deciding
   whether to go actually reads them. `PRD/08` rule 5 lists what a meetup *has*; it has never
   said what the week row shows.

6. **The time is a chip, and it is tinted rather than filled.** It is what the week is scanned for
   - "what is at six" - and it kept that job when the badge took the day. One loud thing per row,
   and on today's row that is already the badge.

7. **The time reads properly.** It was `430P` because that was what fitted inside a 46pt circle;
   out of the circle it is `4:30 PM` again. A format chosen to survive a container should not
   outlive it.

8. **An empty day is a row, never an omission.** `PRD/08` rules 2 and 3: all seven days are shown
   and a day with nothing on it says so. Dropping empty days would make a quiet week look like a
   loading failure.

9. **Only the outermost element owns the gesture.** The bell is a *sibling* of the tappable area,
   not inside it. It sat inside the row's own pressable for the life of the screen - a button
   within a button, which is invalid on web and on native is the nesting where the child takes the
   responder and the ancestor's gesture never arrives. See `AGENTS.md` failure mode 17.

## States

| State | Treatment |
|---|---|
| Default | Badge, name, time chip |
| Today | The badge is solid accent; nothing else changes |
| Empty | Sunken grey badge, "Nothing planned", no chip and no bell |
| Pressed | Inherited from the shared pressable |
| Disabled | Not a state. The bell has its own grey, which is a rule showing rather than a dead control |
| Loading | None of its own; the week loads as one |
| Error | None of its own |

## Obligations it creates elsewhere

| Obligation | Who owes it | Recorded in |
|---|---|---|
| The week header carries the dates the per-day headers used to | `formatWeekRange` | This file, rule 1 |
| Anything the row stops showing must be reachable in one tap | [Meetup detail](12-meetup-detail.md) | Rule 5 |

## Accessibility

The row's label is the name and the time together with "Hold for options" for an admin, because
the badge's letter is not announced as a day - a screen reader landing on "M" alone learns
nothing. The bell carries the meetup's name for the same reason: "Nudge" in a list of seven days
does not say which one.

## Platform differences

| | Behaviour |
|---|---|
| iOS | Verified on the Simulator 2026-09-02, for the rail: all seven stations, the two segments meeting at each badge, both ends stopping, and the long press still reaching the row through the card. The percentage insets the rail is built from resolve the same in Yoga as in CSS, which was the one thing worth checking on a device rather than in a browser. **Not run on the founder's phone** |
| Android | Never checked |
| Web | Verified 2026-08-17: badge weights, the time chip, title-only rows, row opens the detail, console clean |

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Keep the day headers and add the letter badge | What was asked for first, and it repeats itself: a badge reading "M" directly under a header reading MONDAY, and two identical letters on a day with two meetups |
| Badge stacking the letter over the date number | Keeps the date on every row, at the cost of a busier circle on all seven. The date moved into the week header instead, where it is said once |
| Drop the empty days entirely | Shortest screen, and it breaks `PRD/08` rule 3. A week with nothing on it would render as an empty screen, which reads as broken rather than as free |
| Leave the time in the badge and add the letter beside it | Two things in a 46pt circle, and the time was already abbreviated past reading to fit alone |
| A true black rule between days | Asked for as "a black line", and built from the `border` token instead - the palette is warm and soft throughout, and a black hairline across it reads as a different app's furniture. The token is the app's own strong border, and it is plainly heavier than the hairline beside it, which is what the rule was for |
| Compute which meetup the badge should sit beside | The obvious reading of "three events, near the second", and it is arithmetic standing in for an alignment. Centring is correct for every count including the ones nobody thought to check |
