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
2. **On the current week, only today and future days are shown.** The week is a plan, not a
   record. Paging back shows all seven days.
3. **A day with nothing on it says "Nothing planned"**, explicitly - never omitted or blank. An
   empty day is otherwise ambiguous between "nothing is happening" and "nobody has posted yet".
4. **A day holds as many meetups as the club needs**, listed in time order. A morning session and
   an evening social are two meetups; the day simply gets taller. Nothing anywhere limits a day to
   one.
5. **A meetup answers three questions, and only these three:**

   | | | |
   |---|---|---|
   | **Where** | A place, in the club's own words - "Memorial Park gate", "Room 204" | Required |
   | **When** | A date and a time of day | Required |
   | **What** | Free text: what they will actually be doing | Optional |

6. **Creating one opens on the day that was tapped and asks it as a question** - *"Where should we
   meet on Friday 14 August?"* - with the place as the first and largest field. The screen is
   phrased as the question a member opens it to answer, not as a form to be filled in.
7. **It cannot be saved until the place and the time are filled in.** A club that has not decided
   yet types "TBC", which tells a member something; a blank tells them nothing, and the whole
   surface exists to answer where and when.
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
12. **Meetups do not appear on the club calendar.** A club meeting three times a week would mark
    almost every square of the month grid, and the race everybody needs to see would stop standing
    out. The calendar keeps the sparse one-off things; the week keeps the dense recurring ones.

### Nudge

**A meetup carries a bell, and only an admin sees it. Tapping it pushes that meetup to the club.**

13. Rule 11 says creating a meetup notifies nobody, and that rule is the whole reason this surface
    is separate from the calendar. **Nudge does not weaken it - it turns the silence from a wall
    into a default.** Seven meetups posted on Sunday still fire zero notifications. A bell tapped
    on Thursday morning fires one, because a person decided that one mattered.
14. **The audience is every other member of the club**, and it reaches their phone: a push, not
    only a row in the inbox. The nudger is excluded, as with every other creation notification -
    nobody is told about something they just did.
15. **One nudge per hour, for the whole club.** Not per meetup, which would let an admin post a
    week of meetups on Sunday and nudge all seven; not per admin, which would let three admins
    take turns. The hour is enforced by a database constraint rather than a check in the handler,
    because two admins tapping in the same second is exactly what a read-then-write loses - see
    [ADR-0030](../decisions/0030-the-nudge-cooldown-is-a-constraint.md).
16. **A refusal says when the bell comes back**, not merely that it is unavailable. "You cannot"
    gets tapped again a minute later; "not until 10:00" does not. The week carries the same time,
    so the control renders **disabled with the hour on it** rather than looking live and failing
    on tap.
17. **A nudge posts nothing to chat.** The point is to reach a phone that is not currently looking
    at the app, and rule 11 keeps meetups out of the conversation. Putting one there would be a
    separate decision.
18. **Deleting a nudged meetup does not return the nudge.** The hour belongs to the club, so the
    record of it outlives the thing it was about.

**Edge case worth stating.** The bell is shared state, so an admin can find it already spent by
somebody else. That is the design rather than a collision to smooth over: the limit protects
members' phones, which is a club-wide quantity, and an admin seeing "Nudge at 10:00" is being told
the truth about the club rather than about themselves.

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
