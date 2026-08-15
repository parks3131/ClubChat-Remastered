# 34. The calendar carries only things that happen on a day

Date: 2026-08-15

## Status

Accepted. Narrows [PRD/07](../PRD/07-calendar-and-events.md) rules 2, 4 and 5, and
[PRD/11](../PRD/11-polls.md) rule 15.

## Context

The month grid and the Upcoming/Past list are two views over one server read. Polls were in half
of it: excluded from the grid since the feature was designed, because a poll has a **closing
deadline** rather than a day it happens on and putting deadlines on a grid cluttered it - but kept
in the list, on the reasoning that a member scanning "what is coming up" wants to be reminded a
vote is about to close.

The founder asked on 2026-08-15 for the list to hold only events and races. Eboard meetings were
raised and kept: a meeting is dated club business, it already marks a day on the grid, and dropping
it from the list would have made the two views disagree about what exists.

**The half-exception was not free, and its cost is the part worth recording.** One kind that had no
day meant every other kind paid for the possibility:

| The feed carried | Only because of polls |
|---|---|
| `at: string \| null` | An open-ended poll has no deadline at all |
| `open?: boolean` | Nothing else on the feed has an open/closed state |
| An `upcoming` rule that branched on kind | A poll is upcoming while **open**; everything else compares its date |
| A sort with an undated tail | Somewhere for a deadline-less poll to land |
| A row with no date chip, and a vote glyph in its place | A day chip would have stated something untrue |
| A skip in `readMonthMarkers` **and** a second skip in the client's `bucketByDay` | The grid never wanted them |

Six defences against a null that only one of four sources could produce. Note the shape: each was
individually correct and locally obvious, and none of them named the others.

The poll rows also turned out to have exactly **one** reader. The grid excluded them server-side,
the client's day bucketing excluded them again, and the day popup renders from that bucketing - so
the Upcoming/Past list was the only surface in the product that ever displayed one. Removing it
from that list left the branch with no consumer at all.

## Decision

**The merged calendar feed carries only events, races and Eboard meetings. Every row on it has a
date, and polls are on neither of its two views.**

Concretely:

1. **The poll branch is removed from the query**, not filtered out downstream. It had no other
   reader, so a display filter would have left the union, the wire shape and four call sites
   defending against a case that could no longer arrive.
2. **`FeedItem.at` is non-null.** `calendar_events.starts_at` and `meetings.starts_at` are NOT
   NULL, and the race branch already selected only rows whose `race_date` is set. That predicate
   is now what keeps the whole feed dated, and it says so where it lives.
3. **`open` and the kind-dependent `upcoming` rule are gone.** Upcoming is one date comparison.
4. **Both grid exclusions are gone**, server and client, because there is nothing left to exclude.
   `readMonthMarkers` now marks the day of every row it reads.
5. **Polls keep every surface they had except this one** - the club, race and Eboard poll lists,
   the votable card in chat, the detail screen, and the closing-soon notification, which is the
   thing that was actually doing the reminding.
6. **PRD/07 rule 5's number is retained as a struck-through note** rather than renumbered, because
   that file's rules are cited by number and rule 10 is cited from two places.

## Consequences

| | |
|---|---|
| Positive | The two views are now the same set of rows rather than one being a subset of the other, so "what is on the calendar" has a single answer. Six special cases went with one branch, and a null date became unrepresentable rather than defended against. Every row gets a date chip, which is what the bib column was for. |
| Negative | A member scanning Upcoming no longer sees that a vote closes tomorrow. The closing-soon notification fires ten minutes before a deadline ([PRD/11](../PRD/11-polls.md) rule 9) and is now the only thing that warns them, where it used to be the second. If that proves too thin, the answer is to widen the notification, not to put deadlines back on a surface about days. |
| Follow-up needed | None. No migration: `polls.closes_at` is untouched and every poll screen reads it as before. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Filter polls out in the events screen only** | One line, and it leaves the exception everywhere it actually costs something: the query still unions polls, the wire still carries a nullable date and an `open` flag, and both grid skips stay. It would also have left the server's own tests asserting a behaviour no surface shows, which is how a rule survives past the reason for it. |
| **Keep polls but give them a "Deadlines" section of their own on the list** | A third view over the feed to hold one kind, on a screen the founder had just asked to contain two. The poll list already is that section, in each scope, with the voting controls beside it. |
| **Drop Eboard meetings too, reading "only Events and Races" literally** | Put to the founder and declined. A meeting has a day, notifies, and already marks the grid - so removing it from the list alone would make the list and the grid disagree, and removing it from both would take a dated thing off the calendar for the people whose calendar it is. |
| **Keep `at` nullable defensively, in case a future source has no date** | The nullability was never a general truth being preserved; it was one branch's leak that four consumers had learned to absorb. A future undated source should be refused entry to a feed about days, which is exactly what the race branch's `IS NOT NULL` predicate already does for the group case. |
