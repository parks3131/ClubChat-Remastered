# Calendar and events

Two views over **one merged feed**: a month grid for "what is happening when", and a list for
"what is coming up".

**Behaviour rules**

1. **The month grid marks any day carrying a calendar event, a race, or an Eboard meeting.**
   Tapping a marked day opens a popup listing that day's items; tapping an item opens it.
2. **Polls are excluded from the month grid** but included in the Upcoming/Past list - a poll
   has a closing deadline, not a day it happens on.
3. **Filler days from adjacent months are never marked or tappable**, so a marker always
   belongs to the month on screen.
4. The Upcoming/Past list is one merged, sorted feed across events, races, meetings, and
   polls. Past items are faded, most-recent-first.
5. **A poll is "upcoming" while it is still open**, not by comparing its date - an open-ended
   poll must never fall into Past.
6. **The Calendar shows the active club's feed if the user is inside a club, and a merged
   cross-club feed otherwise.** In merged mode every row is tagged with its club and no
   create action is offered.
7. **Every read respects the viewer's own access.** An Eboard meeting only appears for Eboard
   members; a race poll only for race members.
8. **Every race is visible on the calendar to every club member**, whether or not they have
   race access. Tapping through without access leads to the race preview, not the race.
9. Only an admin can create, edit, or delete an event. Creating one notifies every other club
   member.
10. **A created event posts a card into club chat** with its title, date, and location.
11. An event carries a type, a title, a date and time, an optional location, and an optional
    description.
12. **Creating an event from chat's "+" returns to chat afterwards**, not to the new event's
    detail screen - the chat card already confirms it.

**Edge cases.** A month with nothing renders with no markers and no error. Loading keeps the
grid at a **fixed height** so paging months does not make the page jump. An event deleted
while its detail screen is open returns the user to the list. Direct route access to
create/edit as a non-admin redirects.

**Rejected alternatives.** One screen with grid above list (explicit founder request: the
calendar should be just the grid). Polls on the grid by closing date (cluttered it). A
separate calendar table everything writes into (a second copy would drift; a merged read
cannot go stale). Hiding races the viewer cannot access (members need to know a race exists
in order to ask to join it). A club picker on the global calendar (creation is club-scoped;
a picker adds a step for a rare case).
