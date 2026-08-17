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
| `badge` | The circle carrying the day's letter. The only thing that says which day this is |
| `body` | Everything that day holds: one row per meetup, or "Nothing planned" |
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

4b. **Two rules, at two weights, at two insets.** A heavier rule between days, a hairline between
   meetups within one day, and **neither runs edge to edge**. The one dividing the deeper thing is
   inset further, so the indentation says which level you are looking at before the colour does.
   Full-width rules would make the week a table, and a table is what this stopped being when the
   day headers went.

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
| iOS | Unverified as of 2026-08-17 |
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
