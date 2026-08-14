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
23. **Anything that moves with the keyboard animates the rise and NEVER the fall.** The
    keyboard is drawn on top of the app, so on the way down it hides the space it is vacating:
    setting the new layout immediately means the keys leave and reveal a finished screen, while
    animating it means the content crawls down behind them and arrives after they have gone.
    React Native's own `KeyboardAvoidingView` encodes this by omission - its hide path returns
    before configuring an animation - which is easy to copy the mechanism from and miss. Reported
    twice from the device as "the message is dropping so slow", the second time by reintroducing
    it while fixing something else.
24. **A `KeyboardAvoidingView` adds `keyboardVerticalOffset` to its padding, it does not
    subtract it.** A positive value opens a band of background between the bar and the keys.
    Whichever direction you assume, read the arithmetic - it is four lines in the RN source.

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

> **Entry 25's fix can itself be silently dead, which the remaster proved on 2026-08-12.** The
> reconciliation this list demands was built in Phase 0, tested, and **never once ran on iOS**: the
> client pre-encoded its `/sync` URL, React Native re-encoded it, and the server skipped the
> unparseable entry and answered `200`. Realtime hid it exactly as this section describes, so the
> loss was again "a phone that backgrounds and resumes misses messages with no error". Two rules
> came out of it and both are in `AGENTS.md` failure mode 24: never hand `fetch` a URL you have
> already encoded, and never *skip* a malformed request element - refuse it, because a skip is
> indistinguishable from a legitimate omission. **A cure with no failure path of its own is a
> cure nobody checks.**

### The outbox and the effects that read it

30. **A producer with no consumer parks in silence.** `dispatch` throws on an unknown event
    type, which is correct - it routes the event through retry and parking where it is visible -
    but the drain absorbs a handler failure into the `attempts` column rather than rethrowing,
    which is also correct for a queue. Together they mean an event type nobody handles produces
    no notification, no error anybody sees, and no failing test. Three Eboard event types lived
    that way for the whole life of the space. **Every event type a producer writes needs a test
    that it is claimed** - `effect-coverage.test.ts` scans the source for `eventType` literals,
    because a runtime test only reaches the flows some test already triggers, and the gap is
    always in the flows nothing triggers.
31. **One event, two messages, two identities.** A system message's idempotency key is derived
    from `(scope, eventId)`, so a handler that posts into two channels from one event must give
    the second an explicit `scope` or the two collide and the second is silently dropped as a
    redelivery.

### Access that has to end

32. **Losing access has two halves, and the second one is invisible.** The row goes, and the
    live subscription has to be force-unsubscribed - access is checked at subscribe time and
    never rechecked per message (ADR-0007). Club departure, race departure and both deletions
    all did this; **neither Eboard path did**, so a demoted admin kept receiving the board's
    private chat until they happened to reconnect. Anywhere membership can end, ask what happens
    to the socket. A test fake for the bus that discards publishes makes this half untestable by
    construction - record them.

### Unread, and other facts about a moment

33. **"Unread" is a fact about a moment, not a property of a message.** The read cursor is
    captured on arrival and then frozen, so comparing the live list against it forever means
    every message sent afterwards - including the reader's own - counts as unread. Decide the
    anchor once and hold the decision; null must mean "none this visit", not "none yet".
34. **List arithmetic belongs outside the screen.** Both bugs in the chat's marker placement
    shipped because the logic sat in a memo inside a 3,400 line component, where the only way to
    exercise it was to open a chat on a phone and look. A pure function over a list has no
    business being unreachable from a test.

### Process

27. **Reproduce before fixing.** Read-and-reason fixes in this repo's history were repeatedly
    wrong.
28. **Verify a permission by impersonating the unprivileged user and watching the write get
    rejected**, not by reading the rule.
29. **A migration is never edited after being applied.** A correction is always a new one.
