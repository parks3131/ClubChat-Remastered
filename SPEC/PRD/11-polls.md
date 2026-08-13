# Polls

Structured voting, scoped to a club, a race, or the Eboard. Replaces "react with 👍 if you're
coming".

**Behaviour rules**

1. A poll has a question and **between 2 and 10 options**.
2. **Vote counts are always public**, on every poll, including private ones.
3. **Voter identity is gated by the poll's privacy setting**: on a public poll everyone
   eligible can see who voted for what; on a private poll **only the creator** can. **A voter
   always sees their own vote either way.**
4. **Tapping an option votes for it. Tapping it again withdraws the vote.** On a single-choice
   poll, tapping a different option **moves** the vote rather than adding a second.
5. A per-option control reveals that option's voters, shown once the option has at least one
   vote and the viewer is allowed to see voters. **Opening the voter list must not cast a
   vote.**
6. **A poll closes when its creator closes it, or when its deadline passes** - whichever comes
   first. A closed poll cannot be voted in.
7. **Only the creator can close, reopen, or delete a poll** - in every scope, including a club
   poll created by another admin.
8. **A deadline is optional, and is chosen as a moment**: a day, an hour and a minute, picked from
   a wheel that opens in place on the composer. It defaults to tomorrow at the current hour, and
   there is always a way back to no deadline at all.

   **It still crosses the wire as a duration.** The client turns the chosen moment into minutes
   from now and the server computes the instant, so the only clock deciding when a poll shuts is
   the one that writes the row - a handset an hour fast would otherwise create a poll that closed
   an hour early. The cost is that the stored instant sits within 30 seconds of the moment picked,
   which is why nothing about a deadline ever displays seconds.

   > **This replaced relative presets (1 day / 3 days / 1 week / custom) on 2026-08-13.** Those
   > were themselves a founder decision taken before the composer was designed; he sent a
   > reference with an absolute picker and chose it over keeping them. A duration is fewer taps
   > for "about a day"; a moment is the thing a member can actually check a poll against, and it
   > says the same thing the card and the calendar say.
9. **Ten minutes before a poll's deadline, everyone who can access it is reminded - including
   the creator.** This fires **once per poll, ever**.
10. **Creating a poll notifies everyone who can access it except the creator**, and posts a
    votable card into the corresponding chat.
11. **A poll card in chat is fully votable inline**, identical to the full screen for
    multi-select, privacy, deadlines, and closed state. Actions the card cannot hold (the
    voter list, and the creator's close/reopen/delete) are reached via a "View Poll" link.
12. **Scope determines both audience and creation rights:**
    - **Club poll** - any club member votes; any club admin creates.
    - **Race poll** - only race roster members see or vote; creating requires being **both** a
      club admin **and** on the roster.
    - **Eboard poll** - only Eboard members see or vote; any Eboard member creates.
13. The list has an **ALL POLLS** tab and a **MY VOTES** tab (polls the viewer has voted in).
14. An open poll is a live card with a countdown when it has a deadline; a closed poll is
    visually muted and labelled CLOSED.
15. Polls appear in the calendar's events list, bucketed by **open/closed**, never by date.

**Out of scope.** Ranked or weighted voting. Editing a question or options after creation
(would invalidate cast votes). Adding options after creation, or write-ins. Fully anonymous
polls (the creator always sees voters on a private poll - someone must be accountable for
interpreting a sensitive vote). Quorum, thresholds, or automatic outcomes. Results export.

**Edge cases.** A poll with no votes shows zero counts and offers no voter-list control. A
passed deadline is treated as closed **everywhere**, without anyone having closed it.
Reopening preserves existing votes. A member who loses access (leaves the race, is demoted out
of Eboard) loses the poll from their view entirely.
