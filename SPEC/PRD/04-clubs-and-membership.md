# Clubs and membership

**Purpose.** One durable home per team with a known roster, known admins, and a controlled
way in.

**Behaviour rules**

1. A club is created with a **name, an optional description, and a join policy**.
   The creator becomes its Owner.

   > **A sport was a fourth, required field until 2026-08-16.** Free text, validated by nothing
   > and read by nothing, and by then it was asking a chess club what sport it plays.
   > [ADR-0029](../decisions/0029-a-meetup-answers-where-when-and-what.md) removed the reason to
   > keep it and named removing it as the follow-up. Nothing replaces it, which is the same
   > argument that decision made: a club-agnostic product is one with no club-specific field, not
   > one with a configurable one.
2. **A new club is provisioned with its main chat and its Eboard space automatically** - no
   separate setup step - and the Owner is a member of both immediately.
3. **`open` policy:** finding the club by name and tapping Join adds the user immediately.
4. **`request` policy:** finding the club by name files a pending request; an admin approves
   or denies.
5. **An admin's join link always joins instantly, regardless of join policy.** It is a private
   side channel, deliberately independent of the public search path. *(Changed 2026-07-28: there
   is no longer a manual invite code to type. Sharing a link is the only invite mechanism. The
   opaque token still exists - it rides in the link - but it is never shown as a code, never
   entered by hand, and there is no code-entry screen.)*
5a. **Every member of a club can share its link; only an admin can rotate it.** A club grows by
    its members bringing people, and an invite path only an admin could walk is one a member
    routes around by asking an admin for the same string. Rotation stays with the admin tier
    because it invalidates every link **other members** have already sent - the same asymmetry as
    banning, one layer over. A non-member gets nothing: the club refuses them, and club search
    never carries the token. See
    [ADR-0024](../decisions/0024-every-member-holds-the-clubs-invite-link.md).
5b. **A member's link does what a member is allowed to do: on a `request` club it files a
    request rather than joining somebody outright.** An admin's link still bypasses approval,
    because sharing it *is* the approval. Without this split a member could hand out the one
    thing a `request` club exists to withhold, and the club would have no way to tell that link
    from an admin's. On an `open` club there is nothing to bypass and the two behave identically.
    Each tier is simply handed its own link and never sees the other. See
    [ADR-0025](../decisions/0025-a-members-invite-link-obeys-the-join-policy.md).
5c. **The link can also be shown as a QR code**, for handing the club to somebody in the room
    rather than in a message. It carries the same link and grants nothing extra. **It opened the
    club only for somebody who already had the app** - a phone without ClubChat got no prompt and
    no page, which is [ADR-0010](../decisions/0010-link-only-invites.md)'s recorded gap, and the
    screen said so plainly rather than letting a member find out at a club fair. Rule 5e closes
    that gap, and the screen's warning goes when the web page is serving.

5d. **A member can also scan somebody else's code, from the same screen** *(added 2026-08-12)*.
    Until then the code could only be shown, which made it useful in a message and useless in the
    room it was designed for - one person could hold up a club and nobody had a way to accept it.

    **Scanning is a way to acquire a link, never a second way to redeem one.** A scanned code
    resolves to the same token a tapped link carries and goes through the same join path, so
    everything that governs a link governs a scan without restating: an admin's code admits
    outright, a member's obeys the join policy, a banned person is refused and told plainly, a
    rotated code is "no longer valid", and opening it twice is a no-op. Nothing about the join
    rules is a property of how the token arrived.

    **The camera is asked for only when somebody opens the scanner**, with the reason stated
    first, and it is used for nothing else - no photo is taken or stored. A code that is not
    ClubChat's is refused without leaving the scanner, since almost everything a camera is pointed
    at belongs to somebody else.
5e. **A link opened by somebody who does not have the app lands on a web page that names the club,
    and names nothing else.** A code taped to a table is scanned by strangers, and "you have been
    invited to a club" is not an invitation - it is a request to install an app on the strength of
    a URL found on a table. So the page says the club's name and how many members it has, offers
    the app, and stops there.

    **The token is what permits that, and it already permits more.** Anybody holding the link can
    redeem it and be inside the club a second later, so naming the club to that same holder
    discloses strictly less than they already have. Nothing follows from it beyond the name and
    the count: **nothing about a member ever appears on that page**, no name, no picture, no
    count of admins, and neither the club's description nor its join policy.

    **A link that does not work produces one page, whatever is wrong with it.** Unknown, revoked,
    expired, and belonging to a club that has since been deleted are the same page, because
    telling them apart would confirm to a stranger that a club with that token once existed. See
    [ADR-0046](../decisions/0046-an-invite-token-names-its-own-club-without-a-session.md).
6. **Switching a club from `request` to `open` auto-approves every currently pending
   request**, rather than stranding them with no approval step left in the product.
7. Join policy is editable after creation.
8. **Approving a request, adding a member, removing a member, and changing a role each post a
   system message into club chat** and notify the people affected.
9. A member can leave any club they are not the Owner of. **Leaving removes them from every
   race roster, car group, and the Eboard space for that club in the same action.**
10. **Deleting a club is permanent and Owner-only.** Chat history, members, races, the Eboard
    space, polls, and posts all go with it. The confirmation names the club and states this.
11. The roster shows every member with their role badge; tapping a member opens their
    read-only profile card.
12. **Adding a member directly is a search over users**, not an invitation the recipient must
    accept.
12a. **An admin can ban somebody from the club, and a ban is what makes removal stick.** Removing
     a member from a club that is open to join does not keep them out - they simply join again,
     and an invite link they already hold keeps working. A ban removes them and bars every way
     back in: joining, the link, and asking. Adding a banned person is **refused** rather than
     silently lifting the ban, so an admin who did not know finds out instead of overriding
     another admin's decision by accident.
12b. **Any admin can ban a Member; only the Owner can ban an Admin; the Owner can never be
     banned. But *any* admin can lift *any* ban.** That asymmetry is deliberate and is the
     safeguard: a wrongful ban must be cheaper to reverse than to impose. A rogue admin can
     only reach Members, so every other admin survives to undo them. Every ban is attributed on
     a list all admins can read, and **club chat says "X was banned by Y"** - the act is
     accountable because it is visible, not because it is rare. See
     [ADR-0021](../decisions/0021-club-bans-are-harder-to-impose-than-to-lift.md).
12c. Lifting a ban says "you may return", not "you are back": the person rejoins by whatever
     route the club's policy offers. A ban applies to **one club** and is never a platform-wide
     judgement, and it does **not** block anybody in direct messages - that is a personal choice
     an admin may not make on a member's behalf.
13. **The club name is tappable from any club screen's header**, leading to the club profile:
    identity (avatar, name, description), join-link actions, and links onward to Members and
    Gallery.
14. **Identity and roster are separate screens.** The club profile carries identity and
    settings; Members is its own screen holding the roster, pending requests, and the
    add-member search. Races and the Eboard space follow the same split.

**Edge cases**

| State | Behaviour |
|---|---|
| No clubs yet | Empty state with Create and Join actions |
| Search returns nothing | "No clubs found" - no suggestion to create one with that name |
| Already a member of a searched club | The result shows membership rather than a Join button |
| Request already pending | Shows "Requested"; the action is disabled |
| Invalid, revoked, or malformed join link | A plain "This invite link is no longer valid" screen, offering club search as the way forward |
| Join link opened while signed out | Routed to sign-in first, then the join completes |
| Join link opened twice | The second attempt is a no-op, not an error |
| Join link opened without the app installed | Falls back to a web page for that club, which both works in the browser and offers the app. It names the club and its member count, and nothing else |
| A dead link opened in a browser rather than the app | One page for unknown, revoked, expired, and a club since deleted. The four are deliberately not told apart |
| Owner tries to leave | The Leave action is not shown at all - transfer is the only path |
| A banned person taps Join, or opens the invite link | Told plainly they cannot rejoin this club. There is deliberately no in-app appeal path: naming a contact would hand a determined harasser a specific person to pursue |
| A banned person has a request still pending | The request is cleared by the ban, so no admin is asked to decide something already decided |
| Somebody is banned who was never a member | Allowed, and the one thing removal cannot express. Nothing is narrated, because nothing happened in the club |
| Deleted club still open on another device | Reads fail and the user is returned to the clubs list |

**Search.** Club search is by name, returns a safe projection (name, member count, and
the caller's own request status) for clubs the caller is **not** a member of, limited to a
handful of results. Non-members must be able to find and join a club without being able to
read anything inside it.

**Acceptance criteria**

- [ ] Creating a club lands the creator on the club hub as Owner, with a working main chat.
- [ ] A newly created club already has an Eboard space with the Owner as a member.
- [ ] An open club can be found by name and joined in one tap, with no admin action.
- [ ] A request club files a pending request and shows "Requested" until decided.
- [ ] An admin can approve and deny; the requester is notified of the outcome either way.
- [ ] Switching a request club to open immediately admits everyone pending.
- [ ] The join link joins a second account instantly, even on a request club.
- [ ] Sharing and copying the join link works on iOS, Android, and web.
- [ ] There is no screen anywhere that asks a user to type an invite code.
- [ ] A join link opened by somebody with no account names the club it belongs to, and the answer
      carries no member name, no club id, no description, and no join policy. **Asserted against
      the whole response, not by checking the two expected fields are there.**
- [ ] A revoked link and a link that never existed are refused identically in the browser.
- [ ] Promote and demote both work and are both announced in chat.
- [ ] An Owner can remove an Admin; a non-Owner Admin cannot.
- [ ] Transferring ownership leaves exactly one Owner, with the previous Owner an Admin.
- [ ] A non-Owner who leaves appears in no race roster, car group, or Eboard roster after.
- [ ] Deleting a club removes it from every member's clubs list.
- [ ] A removed member rejoins an open club immediately; a **banned** one is refused, by the
      Join button, by the invite link, and by an admin trying to add them.
- [ ] An admin cannot ban another admin, and the Owner can. **Attempted directly, not by
      checking the button is hidden.**
- [ ] An admin who did not impose a ban can lift it, and the person can then rejoin.
- [ ] Club chat reads "X was banned by Y", and the ban list names who imposed each one.
