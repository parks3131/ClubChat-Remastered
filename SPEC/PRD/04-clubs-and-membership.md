# Clubs and membership

**Purpose.** One durable home per team with a known roster, known admins, and a controlled
way in.

**Behaviour rules**

1. A club is created with a **name, a sport, an optional description, and a join policy**.
   The creator becomes its Owner.
2. **A new club is provisioned with its main chat and its Eboard space automatically** - no
   separate setup step - and the Owner is a member of both immediately.
3. **`open` policy:** finding the club by name and tapping Join adds the user immediately.
4. **`request` policy:** finding the club by name files a pending request; an admin approves
   or denies.
5. **The join link always joins instantly, regardless of join policy.** It is a private side
   channel, deliberately independent of the public search path. *(Changed 2026-07-28: there is
   no longer a manual invite code to type. Sharing a link is the only invite mechanism. The
   opaque token still exists - it rides in the link - but it is never shown as a code, never
   entered by hand, and there is no code-entry screen.)*
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
| Join link opened without the app installed | Falls back to a web page for that club, which both works in the browser and offers the app |
| Owner tries to leave | The Leave action is not shown at all - transfer is the only path |
| Deleted club still open on another device | Reads fail and the user is returned to the clubs list |

**Search.** Club search is by name, returns a safe projection (name, sport, member count, and
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
- [ ] Promote and demote both work and are both announced in chat.
- [ ] An Owner can remove an Admin; a non-Owner Admin cannot.
- [ ] Transferring ownership leaves exactly one Owner, with the previous Owner an Admin.
- [ ] A non-Owner who leaves appears in no race roster, car group, or Eboard roster after.
- [ ] Deleting a club removes it from every member's clubs list.
