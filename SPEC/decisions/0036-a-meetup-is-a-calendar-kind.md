# 36. A meetup is a calendar kind

Date: 2026-08-15

## Status

Accepted, and **partly superseded the same day by
[ADR-0037](0037-a-meetup-carries-a-name-and-a-pasted-map-link.md)**, which gives a meetup a name
and a screen of its own - reversing consequences 2 and 3 below while leaving the calendar decision
itself intact. Supersedes the calendar consequence recorded in
[ADR-0029](0029-a-meetup-answers-where-when-and-what.md) and replaces
[PRD/08](../PRD/08-weekly-meetups.md) rule 12. Extends
[ADR-0034](0034-the-calendar-carries-only-things-that-happen-on-a-day.md) rather than narrowing it.

## Context

Weekly Meetups shipped deliberately off the calendar. `PRD/08` rule 12 said so in as many words:

> **Meetups do not appear on the club calendar.** A club meeting three times a week would mark
> almost every square of the month grid, and the race everybody needs to see would stop standing
> out. The calendar keeps the sparse one-off things; the week keeps the dense recurring ones.

That reasoning was sound and it was never tested against a real club. The founder asked on
2026-08-15 for meetups to be treated like events and races, and the numbers from his own club do
not show the crowding the rule was written to prevent:

| | This month |
|---|---|
| Days carrying a meetup | 5 |
| Days carrying an event | 11 |
| Days carrying a race | 0 |

Five squares out of thirty-one, against eleven the calendar was already marking. The dense
recurring club the rule imagined is not what a meetup turns out to be in practice, and the cost of
the rule was concrete: a member looking at the month had no way to see the club meets on Tuesday,
and no way to get from a day to the thing happening on it.

**It also passes the test ADR-0034 had just set.** That decision drew the line at things that
*happen on a day*: a poll's closing deadline is not one, so polls left. A meetup is a club being
somewhere at a time. It is the most literally-happening thing on the feed.

## Decision

**A meetup is a kind on the merged calendar feed, with the same standing as an event or a race.**
It marks its day on the month grid, it is listed under a tapped day, and it appears in the
Upcoming/Past list.

Three consequences follow from what a meetup already is, rather than from preference:

1. **The day travels in `at` and the clock travels beside it, in a new `timeOfDay`.** `meetups`
   stores a DATE and a TIME rather than one timestamp, because a club's week is local wall-clock
   and no club carries a timezone - combining them would move a Tuesday evening meetup to Monday
   for a member reading from another country. So the feed carries the date verbatim with
   `allDay: true`, and the club's own `HH:MM` alongside it, printed and never parsed.

2. **A meetup's row opens the club's week, on the week that holds it.** It has no detail screen:
   the week is where a meetup is already read, edited, removed and nudged from, so a screen would
   be a second place to read the same three facts.

   > **Superseded the same afternoon by [ADR-0037](0037-a-meetup-carries-a-name-and-a-pasted-map-link.md).**
   > A meetup gained a name, location notes and a map, which a week row cannot hold, so it has a
   > screen of its own after all and the calendar's rows open it. The reasoning above was right
   > about what a meetup was; it stopped being right about what a meetup holds. Left standing
   > rather than rewritten, because what was believed on the way here is the useful part.

   **And the week had to change to receive it.** It hid the days of the current week that had
   gone - `PRD/08` rule 2, "the week is a plan, not a record" - which meant a meetup on a past day
   could be tapped and then not shown. That was worse than it sounds: the day sits inside the
   current week, so paging back steps over it, and no sequence of taps could reach the thing the
   calendar had just offered. The week now returns all seven days with the past ones marked, and
   a past day carries no "Add a meetup" row, which is where the old rule's intent went.

   The tap target was decided twice on the same day. The founder first chose the current week over
   the meetup's own week, then saw what it cost on his phone - a video of tapping a meetup on
   Friday 14 August and arriving at a week showing only the 15th and 16th - and reversed it. Both
   halves of that are in `HISTORY.md`; the reversal is recorded here rather than in a second ADR
   because nothing had shipped in between.

3. **The title is the location.** A meetup has no name - `ADR-0029` settled that it answers where,
   when and what, and "what" is a free-text description rather than a title. The place is what the
   week screen leads with, so it is what the calendar leads with.

   > **Superseded by [ADR-0037](0037-a-meetup-carries-a-name-and-a-pasted-map-link.md)**, which
   > gave a meetup an optional name, so the feed's title is the name and falls back to the place.
   > The fallback is why this paragraph is still true of every meetup that has no name - which is
   > all of them until somebody types one.

## Consequences

**`FeedItem` gains a field, which is the part that deserves scrutiny**, because ADR-0034 had just
finished removing one. `open?` and `timeOfDay` are not the same kind of addition. `open` was a
*state*: the upcoming rule branched on it, the sort had a tail for it, and the row suppressed its
date chip because of it, so all four kinds paid for one kind's shape. Nothing branches on
`timeOfDay`. No predicate reads it, no access check reads it, and the only ordering that consults
it is between two meetups on the same day. It is inert, and an inert field on one kind is not the
thing that decision was about.

**One latent bug was found by adding the kind rather than by testing it.** The Upcoming/Past row
formatted its date with `item.kind === 'race' ? formatDateOnly : formatInstant` - branching on the
kind where `allDay` was the actual question. Those were the same thing for exactly as long as a
race was the only date-only kind. A meetup would have been read as UTC midnight and printed a day
early west of Greenwich, which is the failure `FeedItem.allDay` exists to prevent. The row now
branches on the flag.

**The grid needs no per-kind rule, and must not grow one.** `readMonthMarkers` derives from the
feed, so a meetup on the feed is a marked day with no code saying so. That is the same property
ADR-0034 bought by deleting the poll skips, and re-introducing a skip for any kind would put the
grid and the day list back into disagreement about what the calendar holds.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| **A quieter or second marker for meetup days**, honouring rule 12's intent while still showing them | Put to the founder and declined in favour of full parity. It also asks the grid to draw two kinds of dot to solve a crowding problem the data does not show. |
| **The day popup only, with no dot on the grid** | Put to the founder and declined. It would mean the grid saying a day is empty while tapping that day shows a meetup, and it needs exactly the per-kind skip in the markers query that ADR-0034 removed. |
| **Fold the date and time into one instant**, so a meetup is an ordinary timed row | The schema forbids it for a stated reason, and the reason is a real bug: an instant needs a zone, no club has one, and a member abroad would read Tuesday's meetup as Monday's. |
| **A meetup detail screen**, so every kind's row opens a screen about that row | Put to the founder and declined as the largest piece of new work here. The week already carries every action a meetup has. **Reversed hours later in ADR-0037**, once a meetup carried a name, notes and a map - which the week's row cannot hold. |
| **Keep past meetups off the calendar**, so a tap can never land on a day the week will not show | Put to the founder and declined. It would be a per-kind rule on a feed that had just finished removing its last one, and the Past list would silently omit a kind it displays for every other. |
| **Show past days only when the screen was opened from the calendar** | Declined: the week would behave two different ways depending on how somebody arrived, and nothing on screen would say which. |
