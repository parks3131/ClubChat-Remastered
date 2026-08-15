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
- [ ] An **admin's** invite link joins instantly even on a request club, and is idempotent.
- [ ] A **member's** link on the same club files a request instead, and on an open club joins
      instantly - the two tiers are handed different strings and neither can see the other's.
- [ ] Rotating kills both links at once.
- [ ] **Scanning a code inside the app joins the club**, and a scanned code behaves exactly as the
      same link tapped: an admin's admits outright, a member's obeys the join policy, a banned
      person is refused, a rotated one is "no longer valid".
- [ ] The scanner **refuses a code that is not ClubChat's** - a wifi code, a shop's link - without
      leaving the camera, and asks for the camera only when the scanner is opened.
- [ ] **The share screen says what the viewer's own link does**, and says something different to an
      admin and to a member of the same `request` club.
- [ ] The QR code scans to the same link, and a banned person opening either link is told plainly
      that they cannot rejoin.
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
- [ ] **An admin who is not on the roster manages nothing** - cannot approve a request, add or
      remove a member, edit Meet Information, touch a car group, or delete the race, and cannot
      open its chat or polls or be seated in a car. **Attempted directly, not by checking the
      buttons are hidden.**
- [ ] That same admin **can** still create a race, see this one, read its Meet Information, read
      its roster, and ask to join - and **cannot** see who else is waiting to join.
- [ ] The race's **creator is on its roster**, so the person who made it can run it.
- [ ] The **Owner** is refused the same management from outside a race, and can walk onto the
      roster with no request - after which they can run it.
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

### Calendar and weekly meetups

- [ ] The grid marks exactly the days with an event, race, or meeting, and no filler days.
- [ ] Paging months does not change the grid's height.
- [ ] The grid swipes between months, one month per swipe, and the arrows still work.
- [ ] The heading changes as the swipe crosses halfway, and reverts if the swipe is dragged back.
- [ ] A swipe does not steal a day tap, and does not block the page's vertical scroll.
- [ ] Tapping the heading picks any month and year; **This month** returns to today.
- [ ] The list merges events, races and meetings into Upcoming/Past.
- [ ] **No poll appears in either view**, with or without a deadline - grid, day popup, or list.
- [ ] Eboard meetings are absent from a non-member's calendar; races are visible to everyone.
- [ ] The merged cross-club feed tags each row with its club and offers no create action.
- [ ] The meetups week shows Monday-Sunday, hides past days on the current week, and says
      "Nothing planned" on every empty day.
- [ ] Any admin can edit any meetup; creating one notifies nobody and posts nothing.
- [ ] Creating one opens on the day that was tapped and asks **"Where should we meet on ...?"**,
      with the date already filled in.
- [ ] Save stays unavailable until **both** the place and the time are filled in.
- [ ] Two meetups on one day both show, in time order, and the day grows to fit them.
- [ ] **No screen anywhere offers an activity type, category or kind** - not on create, not on
      the detail, not as an icon in the week.
- [ ] A meetup does **not** appear on the month calendar or in the Upcoming/Past list.
- [ ] A member sees no create, edit or delete control anywhere - **including by direct URL**.
- [ ] Nudging a meetup pushes it to every club member **including the admin who sent it**, and
      reaches a real device.
- [ ] Nudging the same meetup again inside the hour is refused, and the refusal names the time.
- [ ] **Nudging a different meetup in the same hour still works** - two meetups on one day carry
      two independent clocks.
- [ ] Two admins nudging the same meetup at the same moment produce **one** push, not two.
- [ ] A meetup on any day but today - **past or future** - has a grey bell and is refused by the
      server, **attempted directly rather than inferred from the control**.
- [ ] The bell is accent-coloured **only** on today's un-nudged meetups.
- [ ] Only the meetup actually cooling down shows a time; the others show a live bell.
- [ ] The bell is accent-coloured before and grey after, and **pressing the grey one says who is
      being waited on and until when** rather than doing nothing.
- [ ] **Tapping the nudge notification opens that club's week** - from the inbox row AND from the
      push banner.
- [ ] Edit and Remove are reached by a long press, and the press buzzes.

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
