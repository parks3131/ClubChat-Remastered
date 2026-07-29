# Engineering pitfalls

Every entry here cost at least one long debugging session. They are ordered by how much time
they cost.

### Data and authorization

1. **A create-and-return needs a read rule that covers the row you just created.** Otherwise
   the write succeeds and the read-back fails with a misleading permission error. Bind the
   check to the row's own columns.
2. **A read rule must never call a helper that re-queries the same table by id** - it
   recurses into its own policy. Write the branch inline.
3. **"Admin" checks must include the Owner.** This exact mistake shipped **four** times after
   the Owner tier was added, and a fifth instance was found later in a helper.
4. **Row-level rules cannot do column-level authority.** Pin and announcement-type changes
   needed a separate before-write check; a policy split would have cost the sender their
   legitimate edit and delete rights.
5. **A membership row is the only proof of access.** "Can read the roster" is not "is a
   member" - the current build must check membership explicitly, because reading the Eboard
   roster is club-admin-wide while being in it is not.
6. **Enum/type literals inside a `DISTINCT`/`UNION` audience query need an explicit cast**
   *(current-stack detail)*, or the whole statement aborts. This broke race announcements
   twice.
7. **Ordering matters in bootstrap triggers.** Create the channel before adding the first
   member, or the first system message is silently swallowed. Demote before promoting on
   ownership transfer, or the one-owner constraint fires.
8. **Storing a route string on a notification means every function that matches on that route
   must be updated together.** Changing one literal left approvals permanently unresolved for
   eight migrations.

### Lists and scrolling

9. **A list's "reached the start" callback fires at mount**, and "content size changed" fires
   far more often than the content actually changes. Treat both as suspect on the first
   render, or chat pages backward the instant it opens.
10. **Landing on a specific message must not visibly scroll.** The user should open chat
    already positioned on their first unread message, not watch it fly there.
11. **A jump target that is only measured after layout lands short on the first tap.** Verify
    the second tap and the first tap behave identically.
12. **A new realtime message must not yank the view** when the user is reading history.

### Navigation

13. **A back control that only renders when history exists is a bug.** Direct URL entry and
    page refresh leave no history on *any* screen, not just stack roots. Every screen declares
    an explicit fallback parent.
14. **Never pop history unguarded** - it throws when there is nothing to pop.
15. **"Pop to a route" only works within the current stack's ancestry**; across sibling
    destinations it silently does nothing. Use a replace instead.
16. **Replacing the top entry does not reduce stack depth**, so a spurious back button remains
    on what looks like a root.
17. **A "hang" with no console errors and no network activity is navigation logic**, not a
    stuck client. That misdiagnosis has been made twice here.
18. **A redirect-on-mount pair can loop.** Chat-as-home means a chat's back-fallback must
    never be its own hub.

### Platform

19. **A brand-new cross-platform API working on one OS is not evidence it works on the
    other.** A file-upload fix confirmed on iOS reproduced the identical crash on Android.
    Prefer the older documented path on any hot path.
20. **A synthetic click is not user activation.** Library web shims that dispatch a synthetic
    click to open a file dialog silently fail under some browser configurations while the
    handler still runs, so nothing looks wrong. Build a real input and call a real click.
21. **A date-only value parsed as an ISO string is UTC midnight**, and renders a day early in
    negative-offset timezones. Build dates from split components.
22. **Confirm dialogs, file pickers, camera, clipboard, and sharing all behave differently per
    platform.** Verify each on each.

### Realtime

23. **A subscription topic derived only from stable ids will collide on remount** and throw,
    because teardown is asynchronous and a same-topic subscribe returns the still-joined
    channel. Include a fresh per-call component in every topic.
24. **Do not diff realtime payloads into local state.** Every subscription callback should
    just say "something changed" and trigger a refetch; merge-by-id refetch is far less
    error-prone than reconciling insert/update/delete events against a paginated list.
25. **Realtime delivery is not guaranteed and has no replay after a disconnect.** A phone that
    backgrounds and resumes can permanently miss messages with no error and no indication.
    **The remaster must reconcile on reconnect and on app foreground**, not just on mount.
26. **Never subscribe to everything.** Unfiltered subscriptions mean every user receives every
    row in the project, and the cost is per-subscriber authorization plus a full refetch each.
    Every subscription must carry a filter, or be replaced by a cheaper signal.

### Process

27. **Reproduce before fixing.** Read-and-reason fixes in this repo's history were repeatedly
    wrong.
28. **Verify a permission by impersonating the unprivileged user and watching the write get
    rejected**, not by reading the rule.
29. **A migration is never edited after being applied.** A correction is always a new one.
