# Races and Meets

**A race is a mini-club nested inside a club** - its own roster, its own chat, its own
logistics - replacing the throwaway group chat spun up per race.

#### Creation and access

1. **A race is created with a name and a date only**, by a club admin, from the club's Races
   & Meets list.
2. **Every club member can see every race exists** - in the races list, on the calendar, and
   in the club hub preview.
3. **Access is always by request.** There is no "open" race policy. A club member requests;
   any club admin approves, denies, or adds them directly. An admin may not add *themselves* -
   adding yourself is joining, and joining is by request.

   3a. **The Owner, and only the Owner, may join a race outright**, with no request and nobody
   to approve it. It exists for the roster with no admin left on it: a race join request goes
   to the admins on that roster, so once the last one leaves the request notifies nobody, and
   the way back in must not itself need an approver. Not the admin tier, because an admin who
   could walk onto any roster would make rule 4 true only until they chose otherwise. Once on
   the roster the Owner is an ordinary race member who also manages the club.
4. **A club admin is a "manager" of every race in their club** - full management authority -
   but **management authority is not access**. Chat, polls, and car-group assignment all
   require a real roster row, for admins too.
5. **A manager not on the roster** sees a request-to-join screen plus a way into the roster to
   manage others, not the race itself.
6. **A club member with no access who taps a race gets a preview**: name, date, Meet
   Information, and the request action. Nothing member-only is exposed.
7. **A race member is redirected straight into race chat** on entering the race. Chat is the
   race's home screen; everything else is reached from its header menu.
8. Any race member can leave the race, which also removes them from their car group.

   8a. **Race chat narrates its own roster**, the way club chat does (rule 8 of
   [Clubs and membership](04-clubs-and-membership.md)): "Mike joined the race", "Mike was
   added by Sarah", "Mike left the race", "Mike was removed by Sarah". A denial is never
   announced - it is addressed to the person refused, and announcing it to the room they were
   kept out of is a different and worse act. **This is also how the roster hears about it at
   all**: an ordinary chat message is what gives a channel its unread count, so before these
   lines existed a race could gain and lose members with no sign of it anywhere.
9. Leaving the parent club removes the user from every race in it.

#### Meet Information

10. **Five fields, edited together as one form**: description, race/event location link,
    hotel link, photos link, results link.
11. **Any manager can edit all five** - not restricted to whoever created the race.
12. **Empty-state behaviour differs per field, deliberately:** description, location, and
    hotel are **hidden entirely** when empty; photos and results **always show a "stay tuned"
    placeholder**. (Photos and results are expected later; a missing hotel link usually means
    there is no hotel.)
13. **Meet Information is readable by any club member**, including those without race access -
    it is exactly the information they need to decide whether to go.

#### Car Assignments and Groups

14. **Groups are auto-numbered on creation** - "Group 1", "Group 2" - with no naming prompt.
15. **A person can be in at most one car group per race.**
16. **Only people with real race access can be added to a group**, and the add-member search
    excludes anyone already in any group for that race.
17. **Each group can have one designated Incharge**, who must be a current member of that
    group.
18. **If the Incharge leaves or is removed, the group's Incharge is cleared automatically and
    every club admin is notified that the group needs a new one.** The rest of the group is
    untouched, and the group is not dissolved.
    *Exception, added 2026-07-29: when the Incharge leaves **the whole club**, the Incharge is
    still cleared but no notification fires. Leaving a club is a larger event than vacating a
    car seat, and one "needs a new Incharge" notification per affected group on top of "X left
    the club" would bury the thing admins actually need to see. The groups show as having no
    Incharge, which the car-groups screen states plainly.*
19. **A plain member leaving a group is a non-event** - no notification. Any member can leave
    their own car group without leaving the race.
20. Every race member can view the groups, including Incharge tags, read-only. Only managers
    can create, delete, assign, or remove.

20a. **Deleting a group empties the car and changes nothing else about the people in it.** They
    keep their roster row, their race access and their chat - a car is travel logistics, not
    membership - and can be put in another group. It notifies nobody, which is the contrast with
    rule 18 worth stating: an Incharge *walking away* leaves a group that needs a new one, and a
    deleted group needs nothing. **The remaining groups keep their numbers**: deleting Group 2 of
    three leaves 1 and 3, because a number is what people say out loud in a car park and closing
    the gap would move somebody between labels without touching their row.

20b. **Adding somebody is a search over the people with no car**, not a list of everyone
    eligible. The pool is rule 16's exactly, and who is left over sits behind a "Remaining"
    control that only managers see - a manager filling cars needs the leftovers, and a member
    wanting to know which car they are in does not.

#### Pins

21. **Pinning a race is personal.** Each member pins for themselves; it affects only their own
    club-hub preview, never anyone else's.
22. **Any member can pin any race they can see** - pinning is not admin-gated.

**Edge cases.** A pending request shows "Requested - waiting on an admin to approve" on both
the row and the preview. A denied request can be re-filed. A group whose Incharge just left
persists with no Incharge. Deleting a race takes its chat history, roster, car groups, Meet
Information, and polls with it, and the confirmation says so. Back from race chat lands on
the races list, **never** on a screen that bounces back into chat.

**Rejected alternatives.** Spawning races from a "race"-type calendar event (matched an
earlier sketch, but the detailed scoping produced standalone races; the calendar link was
designed and never built). A bespoke "event with attendees" screen (reusing membership + chat
gave race chat full feature parity for free). An open join policy (race rosters are travel
logistics). A race admin role. Auto-joining every admin to every race (**built, then
reversed**). Two separate Meet Info sections (**shipped, then merged** on founder follow-up).
Prompting for car group names (naming eight cars is friction). Club-wide admin race pins
(**built, then corrected**: anyone pins for themselves). Structured results (results already
live in a timing provider's site).

**Open questions.** Should a race carry a start/end time? Should car groups have capacity?
Should a finished race be archivable? Should a race be delegable to a non-admin race captain?
