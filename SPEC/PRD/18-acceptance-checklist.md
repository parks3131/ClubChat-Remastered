# Parity acceptance checklist

A remaster is at parity when every line below passes on **iOS, Android, and web**.

### Accounts

- [ ] Sign up, sign in, session persists across restarts, sign out clears it.
- [ ] Signed-out access to any in-app route lands on sign-in, then continues to the target.
- [ ] Privacy Policy and Terms readable both signed out and signed in.
- [ ] Profile fields save and appear in chat and rosters; nobody can edit another's profile.
- [ ] Account deletion is confirmation-gated, blocks future sign-in, and leaves past messages
      in place, unattributed.
- [ ] A hung auth check falls back to signed-out rather than hanging on a spinner.

### Clubs

- [ ] Create → Owner, working main chat, and an Eboard space with the Owner in it.
- [ ] Open club joins in one tap; request club files a request and shows "Requested".
- [ ] Switching request → open admits everyone pending.
- [ ] The invite link joins instantly even on a request club, and is idempotent.
- [ ] Promote/demote announced in chat; Owner-only admin removal; ownership transfer leaves
      exactly one Owner.
- [ ] Leaving cascades out of every race, car group, and the Eboard space.
- [ ] Deleting a club removes it from every member's list.

### Chat (verify in all three scopes)

- [ ] Realtime delivery without refresh; **and** no message is missing after backgrounding the
      app for 60 seconds and returning.
- [ ] Photos and documents round-trip; documents show filename and size.
- [ ] Reactions toggle; mentions notify and render highlighted; autocomplete lists only people
      who can access that chat.
- [ ] Members cannot pin or announce - **verified by attempting the write directly, not by the
      button being hidden**.
- [ ] Pinned strip appears, dismisses locally, and its notice jumps to the message on the
      **first** tap.
- [ ] Chat opens on the first unread message with no visible scrolling; jump-to-latest appears
      and disappears correctly.
- [ ] Scroll-up paging works and does not fire on open.
- [ ] Soft delete leaves a tombstone; reporting twice is a no-op; reports reach only admins.
- [ ] Poll/event/meeting cards post automatically and disappear when the object is deleted.
- [ ] Gallery contains every photo posted in that chat.

### Races

- [ ] Create with name and date; visible to every club member.
- [ ] A no-access member sees the preview (name, date, Meet Information) and can request.
- [ ] **An admin who is not on the roster cannot open race chat or race polls and cannot be
      assigned to a car group**, but can manage the roster and edit Meet Information.
- [ ] A race member entering the race lands in race chat.
- [ ] Meet Information saves as one form; empty description/location/hotel hidden; empty
      photos/results show the placeholder.
- [ ] Car groups auto-number; one group per person; Incharge limited to that group's members;
      Incharge leaving clears it and notifies admins; a plain member leaving notifies nobody.
- [ ] Race pins affect only the pinner's own hub.

### Eboard

- [ ] Auto-created with the club, Owner inside.
- [ ] Promotion auto-joins; demotion auto-removes; ownership transfer changes nothing.
- [ ] Ordinary members have no visibility and are redirected off its routes.
- [ ] Only existing members approve requests or add admins; only the Owner removes a member.
- [ ] Any member creates meetings and polls; only the creator edits or deletes a meeting.
- [ ] Meetings appear on the calendar of members only.

### Polls

- [ ] 2 options and 10 options both allowed; 1 rejected; an 11th cannot be added.
- [ ] Counts visible on public and private polls; voter list gated by privacy; a voter always
      sees their own vote.
- [ ] Single-choice moves the vote; multi-select adds; tapping the current option withdraws;
      opening the voter list casts nothing.
- [ ] A passed deadline reads as CLOSED everywhere with nobody having closed it; reopening
      preserves votes.
- [ ] Close/reopen/delete offered only to the creator, including to admins who did not create
      it.
- [ ] Closing-soon reminder fires once, 10 minutes out, to everyone **including** the creator.
- [ ] A race poll is invisible to an admin without a roster row, **including by direct URL**.

### Calendar and routines

- [ ] The grid marks exactly the days with an event, race, or meeting, and no filler days.
- [ ] Paging months does not change the grid's height.
- [ ] The list merges events, races, meetings, and polls into Upcoming/Past.
- [ ] An open, deadline-less poll never falls into Past.
- [ ] Eboard meetings are absent from a non-member's calendar; races are visible to everyone.
- [ ] The merged cross-club feed tags each row with its club and offers no create action.
- [ ] The routines week shows Monday-Sunday, hides past days on the current week, and says
      "Rest day" where nothing is scheduled.
- [ ] Any admin can edit any workout; creating one notifies nobody and posts nothing.

### Notifications

- [ ] One feed across every club, merging discrete rows and live chat-unread rows.
- [ ] Opening the inbox clears the badge but **not** chat-unread rows and **not** pending
      join-request rows.
- [ ] Opening the relevant roster clears its join-request rows.
- [ ] Opening a chat clears its unread row and leaves a "caught up on N messages" row.
- [ ] A decided request stays, tagged Approved or Denied.
- [ ] Every row navigates to its target, and fails gracefully if access was lost.
- [ ] Audiences respect access in every scope; creators are excluded from their own creation
      notifications.
- [ ] Pinning notifies nobody; announcing notifies everyone in that chat.

### Cross-cutting

- [ ] No screen fails to a blank page; every load has loading, loaded, and retryable-error.
- [ ] Every destructive action is confirmation-gated on all three platforms **and the data
      actually changed**.
- [ ] Direct URL access to any unauthorized screen redirects rather than exposing data.
- [ ] Every screen reached by deep link or refresh can navigate back out.
- [ ] Private media is never reachable by a public URL.
- [ ] Chat and notifications page rather than loading everything.

---

*End of brief. If something here conflicts with a running implementation, the implementation
is the fact and this document is the bug - fix it here in the same change.*
