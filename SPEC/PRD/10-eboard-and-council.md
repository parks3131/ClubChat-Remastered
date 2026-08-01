# Eboard and Council

One private space per club for its admins - the board/captains' side group, made official.

**How this deliberately differs from a Race.** Both are mini-clubs nested under a club, but
their membership models are opposites:

| | Race | Eboard and Council |
|---|---|---|
| Who may be a member | Any club member | Club admins only |
| How a member gets in | Requests, or is added by any club admin | **Automatically, on becoming admin-tier** |
| Does admin status grant membership? | **No** | **Yes** - promotion auto-joins, demotion auto-removes |
| Who approves requests / adds members | Any club admin, from outside | **Existing members only** |
| Who can remove a member | Any club manager | **The club Owner only** |
| How many per club | Many | Exactly one |
| Who can create one | Any club admin | Nobody - created with the club |
| Who can create content inside | Admins only (polls) | **Any member** (meetings and polls) |

The consequence worth stating plainly: **the request-to-join path exists, but in normal
operation nobody uses it.** It matters only for an admin who deliberately left and wants back
in.

**Behaviour rules**

1. Every club has exactly one Eboard space, **created automatically at club creation**, with
   the Owner as its first member.
2. **Promotion to Admin or Owner auto-joins; demotion to Member auto-removes.**
3. **An ownership transfer changes nothing** about Eboard membership - both parties stay
   admin-tier.
4. **Only club admins can see the space exists.** Ordinary members have no visibility of it,
   its chat, its meetings, or its polls.
5. Only current members can read or post in Eboard chat, approve requests, or add other
   admins.
6. **Any Eboard member can create a meeting or a poll** - there is no further role
   distinction inside.
6a. **Eboard chat has no reporting**, and that follows from rule 6 rather than being an
   exception to it. Reporting exists so a member can raise something to an admin; here every
   member already is one, so a report would be filed by the same people who would review it.
   They delete the message directly instead. The Report action is absent from the message menu
   and the Reports tab is absent from Highlights - absent rather than empty, because a scope
   where reporting cannot happen and a queue that lists nothing look identical and are not the
   same claim. Decided 2026-08-01; see [Chat](05-chat.md) rule 10.
7. **Only the meeting's creator can EDIT it.** Everyone else is view-only where editing is
   concerned, and the detail view shows "Added by <name>".
8. **Any member can CANCEL any meeting**, not only its creator - the deliberate asymmetry with
   rule 7. Editing rewrites somebody's record of what they called; cancelling says a thing is
   not happening, which is a fact about the board's week rather than about its author. A
   meeting only its absent author could call off is the failure this avoids.
9. **Cancelling narrates itself into Eboard chat**: the meeting's card is removed and
   "<name> cancelled <title>" takes its place. This is what makes rule 8 accountable rather
   than merely permissive, and the two were decided together - an open delete with no record
   of who did it is a different proposition and is not what rule 8 grants.
10. **Creating a meeting notifies the other Eboard members and posts a card into Eboard chat**,
    carrying its title, its time and whether a joining link is attached. The card opens the
    meeting's own screen.
11. A meeting carries a title, a description, a date and time, and an optional link (video
    call, agenda doc, anything). **It has no end time** - a meeting runs until it is over,
    which is how a board already talks about one.
12. Meetings are listed as Upcoming and Past, and appear on the calendar of **Eboard members
    only**.
13. Any member can leave. **Removing someone else is Owner-only.**
14. Deleting the space is restricted to existing members and takes its chat history,
    meetings, and polls with it.
15. **A member entering the space is taken straight to Eboard chat**, with Meetings and Polls
    reached from the chat header menu.

**Rejected alternatives.** Manual "+ Create" the first time (pure friction; every club wants
one). Keeping the original request-only model (leadership churn meant the space drifted out
of sync with who was actually an admin). Reusing Race's model wholesale (race separates
authority from access; for Eboard the two are the same thing). Letting "any club admin"
approve (an admin outside the space could add themselves in, defeating the privacy boundary).
Mutual removal (highest-trust space in the product). Any-member meeting EDITING (**two
explicit founder follow-ups** after meetings first shipped) - note that any-member
*cancelling* is rule 8 and is not the same thing; the follow-ups were about rewriting somebody
else's meeting, not about calling one off. A card that silently vanishes on cancellation (a
board that planned around the meeting learns nothing about why its calendar changed).
