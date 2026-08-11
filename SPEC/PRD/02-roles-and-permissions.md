# Roles and permissions

### Personas

| Persona | Who they are | What they need |
|---|---|---|
| **Club Owner / founder** | Created the club, or had it handed to them | Full control: identity, join policy, who is an admin, delete or hand over |
| **Captain / Admin** | Team captains, board members, coaches | Author workouts, run the calendar, create races, approve joiners, post announcements and news |
| **Member** | A runner/swimmer/climber | Read everything the club shares, chat, react, vote, join races, see who is driving |
| **Prospective member** | Has the link, or found the club by name | Get in: instantly if the club is open, by request otherwise |

### Hierarchy

**Owner > Admin > Member.** Owner is a strict superset of Admin: every admin-gated capability
is automatically available to the Owner.

1. Every club has exactly one Owner at all times.
2. Ownership is transferable to any current member; the outgoing Owner becomes an Admin.
3. The Owner cannot leave their own club and cannot be removed. Transfer first.
4. Roles are per club. Owner of one club, plain member of another, no interaction.

> **Rule (this bug shipped four separate times):** every audience query or authority check
> that filters on the admin tier must match **both** `admin` and `owner`. A check for
> "admin" alone silently excludes a club whose only admin-tier member is the Owner - which
> is every brand-new club.

### Where authority does NOT propagate

This is the most-misunderstood part of the model, and it is deliberate.

| Boundary | Rule |
|---|---|
| **Club admin → race chat** | Club admin status grants **management authority** over every race in the club (approve/add/remove members, edit Meet Information, manage car groups, delete the race) but **not** access to the race's chat, polls, or car-group membership. Those require a real roster row: the admin must request to join or be added like anyone else. |
| **Club admin → race car group** | An admin not on the race roster cannot be assigned to a car group, even though they can manage the groups. |
| **Club admin → race polls** | Creating or even seeing a race poll requires being on the race roster **and** being an admin. |
| **Club admin → Eboard membership** | Admin-tier membership **does** grant Eboard membership - automatically, and it is revoked automatically on demotion. But an admin who chooses to leave the Eboard space must request or be re-added; admin status alone does not re-admit them. |
| **Race roster → parent club** | Race membership is always a subset of club membership. Leaving the club removes every race and Eboard row for that club. |
| **Club admin → a member's DMs** | Nothing. A direct message belongs to no club, so no club role reaches it: not its history, not its gallery, not even confirmation that a conversation exists. A report raised in one goes to platform moderators, never to a club admin. |
| **Platform moderator → anything else** | Nothing. `is_platform_moderator` grants exactly three capabilities, all of them about a **reported direct message**: reading the narrow, logged window around it; removing it; and suspending the account that sent it. It is not a tier above Owner and confers no club, race or Eboard access at all - a moderator cannot read a club's chat, see a roster, or act on a report raised anywhere but a DM. **The capability is held by whoever runs the service and is granted in configuration, never earned inside the product** ([ADR-0022](../decisions/0022-platform-moderators-are-appointed-in-configuration.md)); the two acting powers, and why they do not contradict [Direct messages](14-direct-messages.md)'s matrix, are [ADR-0023](../decisions/0023-a-moderator-may-remove-a-reported-message-and-suspend-an-account.md). |

### Consolidated permission matrix

Four tables here - Club, Club content, Race, Eboard - and **a fifth in
[Direct messages](14-direct-messages.md)**, which lives there because its columns are
participants rather than roles and it would not fit this shape. All five are covered cell by cell,
in both directions, by the permission-matrix test suite.

#### Club

| Action | Owner | Admin | Member | Non-member |
|---|---|---|---|---|
| Read club chat / calendar / routines / news / races list | ✅ | ✅ | ✅ | ❌ |
| Send messages, react, report a message | ✅ | ✅ | ✅ | ❌ |
| Pin / unpin, post an announcement | ✅ | ✅ | ❌ | ❌ |
| Delete any message | ✅ | ✅ | own only | ❌ |
| Edit club name / description / avatar / join policy | ✅ | ✅ | ❌ | ❌ |
| Share or copy the join link | ✅ | ✅ | ❌ | ❌ |
| Add a member directly; approve/deny join requests | ✅ | ✅ | ❌ | ❌ |
| Promote Member → Admin, demote Admin → Member | ✅ | ✅ | ❌ | ❌ |
| Remove a Member | ✅ | ✅ | ❌ | ❌ |
| **Remove an Admin** | ✅ | ❌ | ❌ | ❌ |
| Ban a Member | ✅ | ✅ | ❌ | ❌ |
| **Ban an Admin** | ✅ | ❌ | ❌ | ❌ |
| **Lift any ban** | ✅ | ✅ | ❌ | ❌ |
| Read the ban list | ✅ | ✅ | ❌ | ❌ |
| **Transfer ownership** | ✅ | ❌ | ❌ | ❌ |
| Leave the club | ❌ | ✅ | ✅ | - |
| **Delete the club** | ✅ | ❌ | ❌ | ❌ |

> **The three ban rows are the one deliberate asymmetry in this document.** Everywhere else,
> whoever may do a thing may undo it. Banning follows the removal ladder above and lifting does
> not, because the two directions carry opposite risk: a wrongful ban is the failure worth
> engineering against, so reversing one is cheaper than performing one. What contains a rogue
> admin is that they can reach Members only, so every other admin survives to undo them - and
> every ban is attributed on the list and narrated into club chat.
> See [ADR-0021](../decisions/0021-club-bans-are-harder-to-impose-than-to-lift.md).

#### Club content

| Action | Owner | Admin | Member |
|---|---|---|---|
| Create/edit/delete a calendar event | ✅ | ✅ | ❌ |
| Create/edit/delete a routine workout | ✅ | ✅ | ❌ |
| Create/edit/delete a news post (any admin, any post) | ✅ | ✅ | ❌ |
| React to a news post | ✅ | ✅ | ✅ |
| Create a club poll | ✅ | ✅ | ❌ |
| Vote in a club poll | ✅ | ✅ | ✅ |
| Close / reopen / delete a poll | creator only | creator only | creator only |

#### Race

| Action | Club Owner/Admin (manager) | Race member | Club member, not on roster |
|---|---|---|---|
| Create a race | ✅ | ❌ | ❌ |
| See the race in lists; preview name, date, Meet Information | ✅ | ✅ | ✅ |
| Request to join | ✅ | - | ✅ |
| Approve/deny requests, add or remove roster members | ✅ | ❌ | ❌ |
| Read/post in race chat | only if also on the roster | ✅ | ❌ |
| Pin / announce in race chat | only if also on the roster | ❌ | ❌ |
| Edit Meet Information | ✅ | ❌ | ❌ |
| Create/delete car groups, assign members, set Incharge | ✅ | ❌ (view only) | ❌ |
| Be assigned to a car group | only if also on the roster | ✅ | ❌ |
| Create a race poll | only if also on the roster | ❌ | ❌ |
| See/vote in a race poll | only if also on the roster | ✅ | ❌ |
| Pin the race to their own hub | ✅ | ✅ | ✅ |
| Leave the race | ✅ (own row) | ✅ | - |
| Edit race identity / delete the race | ✅ | ❌ | ❌ |

#### Eboard and Council

| Action | Eboard member | Club admin, not a member | Club member |
|---|---|---|---|
| See that the space exists | ✅ | ✅ | ❌ |
| Read/post in Eboard chat | ✅ | ❌ | ❌ |
| Request to join / be added | - | ✅ | ❌ |
| Approve requests, add members | ✅ | ❌ | ❌ |
| Create a meeting or a poll | ✅ | ❌ | ❌ |
| Edit a meeting | creator only | ❌ | ❌ |
| Cancel a meeting | ✅ any member | ❌ | ❌ |
| Remove another Eboard member | **Club Owner only** | ❌ | ❌ |
| Leave the Eboard space | ✅ | - | - |
| Delete the space | ✅ | ❌ | ❌ |

### Behaviour rules for roles

1. **Promotion to admin-tier auto-joins the Eboard space; demotion auto-removes.** An
   ownership transfer is a no-op for Eboard membership, since both sides stay admin-tier.
2. **Removing someone from a club cascades**: their race rosters, car-group assignments, and
   Eboard membership for that club are cleaned up in the same action.
3. **A role change is announced in club chat** as a system message and notifies the affected
   member.
4. **Role badges are visible** on the club list and the member roster, so authority is never
   guessed.

### Rejected alternatives (do not re-litigate)

| Decision | Rejected | Why |
|---|---|---|
| Three tiers (Owner/Admin/Member) | Two tiers with an implicit non-transferable "creator" | A creator concept cannot be handed over; a founder leaving left the club undeletable |
| Owner cannot self-remove | Auto-pick a successor | An ownerless club has no recovery path |
| Remove-an-Admin is Owner-only, demote-an-Admin is any-admin | Symmetric permissions | Admins policing each other's role is normal; ejecting each other is not |
| No separate "race admin" role | Per-race admin role | Club admins already have full authority; a second role adds UI for no new capability |
| No separate "Eboard admin" role | Mirror club tiers inside Eboard | Every Eboard member is already a club admin, so the role would be constant |
| Club admin gets authority over a race but not its chat | Auto-join every admin to every race (this was built, then reversed) | An admin auto-added to 30 races drowns in chat for races they are not running |
