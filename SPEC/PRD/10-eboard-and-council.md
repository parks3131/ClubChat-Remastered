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
7. **Only the meeting's creator can edit or delete it.** Everyone else is view-only, and the
   detail view shows "Added by <name>".
8. **Creating a meeting notifies the other Eboard members and posts a card into Eboard chat.**
9. A meeting carries a title, a description, a date and time, and an optional link (video
   call, agenda doc, anything).
10. Meetings are listed as Upcoming and Past, and appear on the calendar of **Eboard members
    only**.
11. Any member can leave. **Removing someone else is Owner-only.**
12. Deleting the space is restricted to existing members and takes its chat history,
    meetings, and polls with it.
13. **A member entering the space is taken straight to Eboard chat**, with Meetings and Polls
    reached from the chat header menu.

**Rejected alternatives.** Manual "+ Create" the first time (pure friction; every club wants
one). Keeping the original request-only model (leadership churn meant the space drifted out
of sync with who was actually an admin). Reusing Race's model wholesale (race separates
authority from access; for Eboard the two are the same thing). Letting "any club admin"
approve (an admin outside the space could add themselves in, defeating the privacy boundary).
Mutual removal (highest-trust space in the product). Any-member meeting editing (**two
explicit founder follow-ups** after meetings first shipped).
