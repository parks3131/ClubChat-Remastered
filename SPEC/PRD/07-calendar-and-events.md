# Calendar and events

Two views over **one merged feed**: a month grid for "what is happening when", and a list for
"what is coming up".

**Behaviour rules**

1. **The month grid marks any day carrying a calendar event, a race, an Eboard meeting, or a
   meetup.** Tapping a marked day opens a popup listing that day's items; tapping an item opens
   it.

   > **Meetups joined on 2026-08-15**, reversing [`08`](08-weekly-meetups.md) rule 12, which had
   > kept them off on the grounds that a club meeting three times a week would drown the grid.
   > The club's own month showed five meetup days against eleven event days, so the crowding was
   > not there. A meetup is the one kind whose row does not open a screen about itself - it opens
   > the club's week, which is where a meetup is read and changed. See
   > [ADR-0036](../decisions/0036-a-meetup-is-a-calendar-kind.md).
2. **Polls are not on the calendar at all** - not the grid, and not the Upcoming/Past list. A
   poll has a closing deadline, not a day it happens on, and this surface answers "what is
   happening when". Polls are reached from the poll list in their own scope.

   > **Widened 2026-08-15**, at the founder's request. This rule kept polls off the grid and on
   > the list, and the half-exception was carried by every field of the feed: a nullable date, an
   > "open" flag, an Upcoming rule that read open/closed instead of comparing a date, and a row
   > with no date chip. Removing the half removed all four. Same shape as the DM reversal in
   > [`00`](00-overview.md) and the editing one in [`05`](05-chat.md): a rule that was right about
   > the grid and had been extended to the list by association.
3. **Filler days from adjacent months are never marked or tappable**, so a marker always
   belongs to the month on screen.

   3a. **The grid is swiped between months, and the arrows stay.** A swipe is the gesture people
   arrive expecting; the arrows remain because a swipe cannot be announced to a screen reader or
   performed with a switch, so removing them would take the feature away from whoever needs it
   most. Both do the same thing.

   3b. **The heading changes with the swipe, not after it.** It names the month owning most of
   the screen, so it flips as the finger crosses halfway and reverts if the swipe is dragged back
   without completing. A heading that waits for the animation to settle trails the grid it names
   by about half a second, which reads as lag rather than as a heading.

   3c. **Months are reached one at a time.** A flick cannot cross two, because the grid either
   side of the current one is what a swipe moves to and there is no third to land on. Longer
   journeys are the picker's job, below.

   3d. **The month and year are chosen directly, from the heading.** Tapping it opens a year
   stepper and the twelve months, so reaching next March is one tap rather than seven. The month
   in view is filled and the real current month is ringed, answering "where am I" and "where is
   now" before anything is tapped, and **This month** returns to today from wherever the browsing
   went. Stepping the year alone changes nothing until a month is picked, so a stray tap costs
   nothing. The year is a stepper rather than a list of years because a club calendar is used a
   season either side of today; that is the assumption to revisit first if people jump further.
4. The Upcoming/Past list is one merged, sorted feed across events, races, meetings and meetups.
   Past items are faded, most-recent-first. **Every row is dated**, so Upcoming and Past are
   decided by one date comparison and nothing sorts into an undated tail. **A meetup carries a
   clock as well as a day**, and two on the same day are in time order.
5. ~~**A poll is "upcoming" while it is still open**, not by comparing its date.~~ **Gone
   2026-08-15 with rule 2**, since nothing on this feed is a poll any more. The slot is kept
   rather than renumbered because these rules are cited by number.
6. **The Calendar shows the active club's feed if the user is inside a club, and a merged
   cross-club feed otherwise.** In merged mode every row is tagged with its club and no
   create action is offered.
7. **Every read respects the viewer's own access.** An Eboard meeting only appears for Eboard
   members; a race poll only for race members.
8. **Every race that HAS a date is visible on the calendar to every club member**, whether or
   not they have race access. Tapping through without access leads to the race preview, not the
   race.

   **A race's date is optional** ([Races and meets](09-races-and-meets.md) rule 1), and one
   without a date is simply not a calendar item - it is an ordinary group with a chat and a
   roster. That is the whole meaning of leaving the date blank, so the absence here is the
   feature rather than a gap.
9. Only an admin can create, edit, or delete an event. Creating one notifies every other club
   member.
10. **A created event posts a card into club chat** carrying its date, title, time, location and
    who added it. **The card itself opens the event's detail screen**, and holds no separate
    button - a card that is entirely a link does not also need to contain one. See
    [`DESIGN/05`](../DESIGN/05-content-card.md) rule 3, which is the same rule for all three kinds
    of card.
11. An event carries a type, a title, a date and time, an optional location, and an optional
    description.
12. **Creating an event from chat's "+" returns to chat afterwards**, not to the new event's
    detail screen - the chat card already confirms it.
13. **An event has a detail screen of its own**, and all four routes to it lead there: the
    Upcoming/Past list, the calendar's day popup, the chat card, and the notification. It shows
    the title, when it runs, the location, the description, and **who added it**.
14. **Every club member can open an event; only an admin can delete one.** The read is
    deliberately wider than the write: creating an event notifies the whole club, so a read
    gated at admin would hand every member a notification that opens nothing.
15. **Any admin deletes any event, not only the one who added it** - which is the opposite of a
    poll (`PRD/11`), where only the creator can. The two sit side by side and neither is a
    mistake: a poll is a question somebody asked, and an event is club business on a shared
    calendar. A cancelled practice that only its absent author could remove is the failure rule
    15 avoids, and "Added by <name>" on the screen is what keeps it legible.

**Edge cases.** A month with nothing renders with no markers and no error. Loading keeps the
grid at a **fixed height** so paging months does not make the page jump. An event deleted
while its detail screen is open returns the user to the list. Direct route access to
create/edit as a non-admin redirects.

**Rejected alternatives.** One screen with grid above list (explicit founder request: the
calendar should be just the grid). Polls on the grid by closing date (cluttered it), and then
polls on the list at all (rule 2). Hiding polls in the client while the server kept serving them
- the rows had no other reader, so the exception would have stayed in the query, the wire and
four call sites to no end. A
separate calendar table everything writes into (a second copy would drift; a merged read
cannot go stale). Hiding races the viewer cannot access (members need to know a race exists
in order to ask to join it). A club picker on the global calendar (creation is club-scoped;
a picker adds a step for a rare case).
