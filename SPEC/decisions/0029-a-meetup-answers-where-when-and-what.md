# ADR-0029: A meetup answers where, when and what, and carries no activity type

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-14 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

The product was built for a university running club and is now meant to fit **any** club - a history
society, a chess club, a theatre. Three things stood in the way, and all three lived in the weekly
plan feature, then called Routines:

| What is sport-coded | Where it lives |
|---|---|
| The ten activity types | A `CHECK (activity_type IN (...))` listing `run, trail_run, bike, swim, strength, hybrid_fitness, indoor_climb, bouldering, xc_ski, other` |
| "Rest day" | The rule requiring an empty day to render explicitly, which hardcoded the word a runner would use |
| The feature's name | "Routines" describes what a running club puts in the surface, not what the surface does |

**An answer was designed in full before this one, on the same day, and is worth stating because it
worked.** It generalised the type rather than removing it: a per-club, admin-editable list of
meetup types seeded from club-type presets (Running, Book club, Chess, Theatre, …), each type
carrying an emoji icon from the catalog [ADR-0028](0028-reactions-come-from-a-catalog-table.md)
shipped a day earlier, plus three per-club label columns so a running club read "Training Plan / Add
workout / Rest day" and a book club read "Reading Plan / Add meeting / No reading". It followed
ADR-0028's rule exactly - the `CHECK` becomes a foreign key - and it was specified down to the
composite key that stops one club's meetup claiming another club's type.

Then the screen's question changed. **The thing a member opens this surface to find out is not what
kind of activity Friday is. It is where to turn up, at what time, and what they will be doing.**
Asked that way, the type has nothing to answer: "Run" does not say where, "Discussion" does not say
when, and both are already the first three words of the free text.

## Decision

**We will make a meetup carry a place, a date and a time, and free text. There will be no activity
type, no club type, and no per-club vocabulary. The `CHECK` over ten sports is deleted, not
replaced.**

```
meetups                -- was routine_workouts
  id, club_id, meetup_date DATE, meetup_time TIME, location, description,
  created_by, created_at
  INDEX (club_id, meetup_date, meetup_time)
```

- **`location` and `meetup_time` are `NOT NULL`.** The surface exists to answer where and when; a
  meetup that answers neither is a note on a day. A club that has not decided yet types "TBC",
  which tells a member something a blank does not.
- **`description` is optional** and is the only place the kind of activity is ever recorded, in
  whatever words the club uses.
- **A day holds as many meetups as a club wants**, ordered by time. Nothing enforces one per day:
  a morning run and an evening social are two meetups, not one squashed together.
- **Date and time are stored separately, and neither is an instant.** A club's week is local
  wall-clock: Tuesday 6pm is Tuesday 6pm for everybody on the roster. No club carries a timezone,
  so there is nothing to convert *from*, and storing a `timestamptz` would make a member reading
  from another country see Tuesday's meetup land on Monday. The week grid is grouped by
  `meetup_date` and that grouping must not depend on who is looking.
- **Meetups do not appear on the calendar.** See [Calendar and events](../PRD/07-calendar-and-events.md).

## Consequences

| | |
|---|---|
| Positive | **The sport-coded field disappears with nothing replacing it.** No catalog table, no presets, no per-club rows, no composite foreign key, no emoji picker, no vocabulary layer, and no second set of screenshots - the alternative below needed all of them. The feature becomes club-agnostic by *having no club-specific field at all*, which is a stronger and much cheaper form of "works for any club" than making the field configurable. One wording, one screen, one document, one thing to test. And what the surface now answers - where, when, what - is what a member actually opens it to find out, in three fields instead of a taxonomy. |
| Negative | **The week grid loses its icons.** Every row now reads the same shape, told apart by place and time rather than by a glance, so scanning a week is reading rather than pattern-matching. **Nothing about a meetup can ever be counted, filtered or searched by kind** - "how many runs did we plan in March" is unanswerable, permanently, because the answer only exists inside free text. Both are accepted: the first is a real loss of legibility, and the second is a question this product has already decided it does not answer (activity tracking is a standing non-goal). |
| Follow-up needed | **Nudge** - the admin-only bell that pushes one meetup to the club - is designed and deliberately unbuilt; see [Weekly Meetups](../PRD/08-weekly-meetups.md). **Recurrence** is still deferred, and a club meeting daily still enters every day by hand. **`clubs.sport` is still unvalidated free text that nothing reads**: this decision removed the reason to replace it with a club type, and did not remove the column. It should go. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| **A per-club, admin-editable type list seeded from club-type presets** - designed in full, hours before this decision | It worked, and it answered a question the screen no longer asks. The price was two seed tables, a per-club table, a composite foreign key, an emoji picker, three per-club label columns, and a vocabulary layer that made every screenshot and support answer club-specific. All of that existed so a running club could say "Workout" where a chess club said "Blitz". **Deleting the field says the same thing in no code**, and the free text says it better, because "8 x 400m at the track" was never going to fit in a dropdown. Recorded at length because it is the obvious design and somebody will propose it again. |
| Widen the `CHECK` to cover more sports | ADR-0028's rejected "widen the fixed set" wearing a bigger hat. It answers *more sports*; the ask is *all clubs*. Every future kind of club would cost a migration and a client release before anyone could use the app. |
| Keep a small universal type list - Meeting, Social, Activity, Other | A type that fits every club distinguishes nothing. It would be a required tap on every create that carries no information to the person reading the week, which is the worst of both designs. |
| Store one `timestamptz` instead of a date and a time | A club's week is wall-clock, not an instant, and no club carries a timezone to convert from. A member opening the app abroad would find Tuesday's meetup on Monday - a bug that reproduces only while travelling, which is close to the worst possible way to find one. |
| Keep the title field alongside place and description | Three text fields where two do the work. The seed data makes the case: every row paired a title with a description saying the same thing ("Easy 5k" / "Conversational pace"). The place and the time are the headline now. |
| Put meetups on the month calendar as well | A club meeting three times a week marks almost every square, and the race everyone needs to see stops standing out. The calendar keeps the sparse, one-off, notified things; this keeps the dense, weekly, silent ones. That difference is the reason they are two surfaces. |

## Note

This needs an ADR because the missing field is conspicuous. Anybody who finds `meetups` and sees no
`type`, `category` or `kind` column will assume it was an oversight and add one - and the design
they will reach for is the per-club catalog in the first row of the table above, which was fully
specified and then deliberately thrown away. The reason it went is not that it was unworkable. It is
that a surface answering *where, when and what* has nowhere to put an answer to *what kind*.
