# Weekly Meetups

**Where the club is meeting this week, when, and what they will be doing.** The feature that
replaces the screenshotted Excel sheet.

Every club has a week - a running club's training, a theatre's rehearsals, a book club's evenings,
a volunteering group's shifts - and this is deliberately **not** the calendar.
[Calendar and events](07-calendar-and-events.md) carries the loud, sparse things that notify
everybody and post a card into chat. This carries the quiet, dense ones that must not: several
entries a week, consulted rather than announced. Rule 11 is where that difference lives, and it is
the reason the two are separate surfaces rather than one.

*Named "Routines" until 2026-08-14, after what a running club put in it rather than after what it
does. It carried an activity type until the same date; see
[ADR-0029](../decisions/0029-a-meetup-answers-where-when-and-what.md) for why there is no such
field and why one should not be added back.*

> **A meetup is not a meet.** A [race or meet](09-races-and-meets.md) is a mini-club with its own
> roster, chat and logistics, and it is a *destination*. A meetup is one dated entry on a week
> nobody joins. The two words are close enough to be worth stating once, here, so a reader does
> not assume a relationship that does not exist.

**Behaviour rules**

1. The screen shows **one real calendar week, Monday through Sunday** - not a repeating
   template.
2. **All seven days are shown, and a day that has gone cannot be added to.** It carries no "Add a
   meetup" row; it is readable and nothing else.

   > **Until 2026-08-15 the current week hid the days that had gone**, on the reasoning that the
   > week is a plan rather than a record. That became untenable the same day meetups reached the
   > calendar (rule 12): the calendar shows every day, so tapping a meetup on a past day opened
   > this screen onto a week that structurally could not show it - and it was the one case paging
   > could not rescue, because the day sits INSIDE the current week, so Previous steps over it.
   > Reported from the phone with a video. The plan-not-a-record intent survives as the missing
   > Add row rather than as a missing day.
3. **A day with nothing on it says "Nothing planned"**, explicitly - never omitted or blank. An
   empty day is otherwise ambiguous between "nothing is happening" and "nobody has posted yet".
4. **A day holds as many meetups as the club needs**, listed in time order. A morning session and
   an evening social are two meetups; the day simply gets taller. Nothing anywhere limits a day to
   one.
5. **A meetup answers these questions and no others:**

   | | | |
   |---|---|---|
   | **What it is called** | A name - "Morning Miles", "morning book reading", "swim practice night" | Optional |
   | **Where** | A place, in the club's own words - "Memorial Park gate", "Room 204" | Required |
   | **When** | A date and a time of day | Required |
   | **What** | Free text: what they will actually be doing | Optional |
   | **How to find us** | Location notes: "the wooden archway; parking is tight" | Optional |
   | **A map link** | A pasted Google or Apple Maps URL. Becomes a Directions button | Optional |

   > **The name and the last two arrived 2026-08-15** ([ADR-0037](../decisions/0037-a-meetup-carries-a-name-and-a-pasted-map-link.md)).
   > The name is what lets this feature belong to a club that is not a running club, which is the
   > same generalisation [ADR-0029](../decisions/0029-a-meetup-answers-where-when-and-what.md)
   > made when it deleted the activity-type catalog. **Without a name the location is the
   > headline**, exactly as this shipped, so a club that only wants a place and a time is
   > unaffected.
   >
   > **Still not a field: distance, difficulty, pace, or anything else describing the session as
   > training.** A mockup carried "5.2 mi" and it was left out - see the non-goals in
   > [`00`](00-overview.md), which rule out training detail in three separate rows.
   >
   > **A map link is a LINK, never a coordinate.** The server reads the point out of it, follows
   > the short link the Google Maps app shares, and refuses to store a URL whose host is not a
   > map - because a stored URL becomes a button that opens it.
   >
   > **A pasted link becomes a Directions button on the meetup's screen, and nothing else.** There
   > is no map picture: one was built on 2026-08-15 and taken back out the same afternoon, because
   > a Google "share a place" link carries no coordinates at any hop, so drawing a pin meant either
   > asking an admin to place one by hand or paying for a Places key - to draw a place the button
   > already opens. **No link means no button**, rather than a button that hands Maps a text search
   > for "Bimini".

6. **Creating one opens on the day that was tapped and asks it as a question** - *"Where should we
   meet on Friday 14 August?"* - with the place as the first and largest field. The screen is
   phrased as the question a member opens it to answer, not as a form to be filled in.
7. **It cannot be saved until the name and the moment are filled in**, and **the moment can only
   be now or later**. The picker offers today onwards, and on today only the hours and minutes
   still ahead - so a meetup cannot be authored into a day that has gone.

   > **The place was the required field until 2026-08-15** and is no longer collected at all; the
   > name took its place, because with no place nothing else identifies a meetup. The
   > no-past-moment rule arrived the same day, in the founder's words: *"just show dates from
   > today and the time after right now so that people don't have a chance to create an old
   > event"*.
   >
   > **Editing an existing meetup still offers its own date**, even a past one, so a meetup last
   > Tuesday stays correctable. What is refused is authoring a new one backwards.
   >
   > **This lives in the picker and not on the server.** `createMeetup` accepts any date, and
   > deliberately so for now: past meetups are a normal thing for the product to hold - every
   > meetup becomes one - and the nudge rules are proved by making one. Worth revisiting if it
   > ever matters.
8. **There is no activity type, category or kind anywhere** - not a dropdown, not a required first
   step, not an icon. What the club is doing is the third field, in their own words. The reasoning
   and the fully-designed alternative that was rejected are in
   [ADR-0029](../decisions/0029-a-meetup-answers-where-when-and-what.md).
9. **Any club admin can create, edit, or delete any meetup**, not only its author.
10. Members see the week and the detail read-only - no create, edit, or delete controls anywhere.
11. **Creating a meetup does not notify anyone and does not post to chat.** It is reference
    material, not an event. A week of meetups would otherwise fire seven notifications.
    *(Settled 2026-08-08, and the reason this surface is separate from the calendar. The one
    deliberate exception is Nudge, below, which is a person choosing to send one - not a meetup
    sending itself.)*
12. **A meetup appears on the club calendar, with the same standing as an event or a race.** It
    marks its day on the month grid, it is listed under a tapped day with its time, and it is in
    the Upcoming/Past list. **Tapping it opens the meetup's own screen**, which carries the name,
    the place, the notes, what the club is doing and a map when one has been pasted.

    > For a few hours on 2026-08-15 it opened this week instead, because a meetup had no screen -
    > see [ADR-0037](../decisions/0037-a-meetup-carries-a-name-and-a-pasted-map-link.md) for what
    > changed. The week is still where a meetup is edited, removed and nudged from, and its rows
    > now open the same screen - so **a member can open a meetup at all**, which they could not
    > before: the row was pressable only for admins, because the only thing behind it was a menu.

    **This reverses what this rule said until 2026-08-15**, which was that meetups stay off the
    calendar because a club meeting three times a week would mark almost every square and drown
    the race everybody needs to see. That was never tested against a real club, and when it was,
    the crowding was not there: five meetup days that month against eleven event days. The cost of
    the old rule was concrete - a member reading the month could not see that the club meets on
    Tuesday. See [ADR-0036](../decisions/0036-a-meetup-is-a-calendar-kind.md), which also records
    why the date and the time reach the calendar separately rather than as one instant.

### Nudge

**A meetup carries a bell, and only an admin sees it. Tapping it pushes that meetup to the club.**

13. Rule 11 says creating a meetup notifies nobody, and that rule is the whole reason this surface
    is separate from the calendar. **Nudge does not weaken it - it turns the silence from a wall
    into a default.** Seven meetups posted on Sunday still fire zero notifications. A bell tapped
    on Thursday morning fires one, because a person decided that one mattered.
14. **The audience is every member of the club, the sender included**, and it reaches their
    phone: a push, not only a row in the inbox. **This is the exception to "nobody is told about
    something they just did"** - it and the poll closing reminder are the only two. An admin who
    rings the bell and receives nothing cannot tell whether it went out at all, and the only
    other evidence available to them is asking a member. *(Reported from the device on
    2026-08-14 in exactly those terms.)*
15. **One nudge per hour, per meetup.** Four meetups in a day are four separate things to tell
    people about and carry four independent clocks: nudging the morning run leaves the evening
    social's bell alone. The hour is enforced by a database constraint rather than a check in the
    handler, because two admins tapping **the same** bell in the same second is exactly what a
    read-then-write loses. *(Was per club until 2026-08-14, which made announcing the second of
    two meetups on one day impossible - see
    [ADR-0031](../decisions/0031-the-nudge-cooldown-is-per-meetup.md), superseding
    [ADR-0030](../decisions/0030-the-nudge-cooldown-is-a-constraint.md).)*
15a. **Only TODAY's meetups can be nudged.** A nudge means "we are meeting, today", so a past day
    has nothing left to say and next Tuesday is premature rather than early. **Compared by date,
    not by moment**: this morning's run is still nudgeable this evening, because a bell that died
    at 06:31 would be the more surprising rule. The server decides this and the week carries the
    answer, so the client never compares dates itself and the two cannot disagree across
    midnight.
16. **A refusal says when the bell comes back**, not merely that it is unavailable. "You cannot"
    gets tapped again a minute later; "not until 10:00" does not.
16a. **The bell is accent-coloured only when it can actually be rung - today's meetup, not yet
    nudged - and grey otherwise.** It is always drawn for an admin and always pressable. Grey has
    two causes and they read differently, so pressing it says which: "only today's meetups can be
    nudged", or "someone already nudged this, you can nudge again at 10:00". A control that
    vanishes on other days appears and disappears down the week, which reads as a rendering fault
    rather than a rule; one that does nothing when pressed is indistinguishable from broken.
16b. **Tapping the notification opens the meetup that was nudged.** A nudge that buzzes a phone
    and goes nowhere when tapped is the failure this rule exists to name; it happened once, on
    2026-08-14, and [Notifications](12-notifications.md) carries the general form.

    > **It opened the club's WEEK until 2026-08-15**, which was the best available answer while a
    > meetup had no screen of its own. It got one that afternoon (rule 12), and a nudge is about
    > one meetup rather than about the week it sits in. The destination is derived from the
    > notification's stored parameters at read time, and the meetup's id has been among them since
    > the nudge shipped - so the nudges already sitting in an inbox point at the meetup too,
    > without anything being rewritten.
17. **A nudge posts nothing to chat.** The point is to reach a phone that is not currently looking
    at the app, and rule 11 keeps meetups out of the conversation. Putting one there would be a
    separate decision.
18. **Deleting a nudged meetup releases nothing and blocks nothing.** The hour belongs to that
    meetup, so once it is gone there is no bell to hold.

**Edge case worth stating.** A meetup's bell is shared between admins, so one can find it already
spent by another. That is the design rather than a collision to smooth over - the limit is about how
often *this meetup* interrupts people, not about who rang it - and only the meetup actually cooling
down shows a time, so the week does not repeat the same sentence down the screen.

**Permissions.** Every club member reads the week. Only an admin creates, edits or deletes a
meetup, or nudges one. Owner and Admin are equivalent here; see
[Roles and permissions](02-roles-and-permissions.md).

**Edge cases.** A week with nothing in it is seven explicit "Nothing planned" days, not an empty
screen. A day with several meetups orders them by time, and two at the same time hold their
creation order rather than reordering under the reader. Deleting the meetup whose detail screen is
open returns to the week.

**Out of scope.** Attendance, RSVP, or who is coming. Completion tracking. Attachments. A
structured builder of any kind - sets, reps, distances, chapters, scenes.

**Rejected alternatives.** A per-club, admin-editable list of activity types seeded from club-type
presets, with emoji icons and per-club wording - designed in full and rejected; see
[ADR-0029](../decisions/0029-a-meetup-answers-where-when-and-what.md), which records it at length
because it is the obvious design. A short title above the place, when the place and the time are
the headline and the free text already says the rest. One meetup per day. Meetups on the month
calendar.

**Open questions.**

- **Should a meetup repeat?** A club that meets daily enters 365 meetups a year by hand, because
  rule 1 says the week is a real week and never a template. Deliberately deferred on 2026-08-14,
  and the largest remaining gap between this feature and "fits any club". It also reopens
  [Overview](00-overview.md)'s non-goal on recurring events, whose stated reason was that this
  surface already covered the weekly case.
- **Should the place be a link as well as a text?** Races carry a location *link* for exactly this
  reason ([Races and meets](09-races-and-meets.md) rule 10), and "Memorial Park gate" is harder to
  find than a dropped pin. Left as text for now because a required field must be trivial to fill.
- Should the week be readable by a prospective member on the club profile, the way Meet Information
  is readable without race access?
