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
30. **A rename must be hand-written; `drizzle-kit generate` cannot be trusted with one.** Given a
    table that changed name, drizzle cannot tell a rename from a drop-and-create and stops to ask
    - and it asks with an arrow-key prompt, so with no TTY it dies with an error and with a piped
    TTY it simply hangs. **The answer to that prompt is the difference between moving the data and
    destroying it.** For a rename: write the `ALTER ... RENAME` SQL by hand, then hand-write the
    `meta/NNNN_snapshot.json` (copy the previous one, edit the table, set `prevId` to the old
    `id`, give it a new `id`, and record the rename under `_meta.tables`) and append the
    `_journal.json` entry. Generating first and editing the SQL afterwards leaves a snapshot that
    disagrees with what actually ran, which is invisible until the *next* migration diffs against
    it. *(Found on 2026-08-14 renaming `routine_workouts` to `meetups`.)*
31. **A hand-written journal `when` in the future silently swallows the NEXT migration.** The
    migrator applies entries whose `when` is greater than the newest `created_at` already recorded,
    so a fabricated timestamp ahead of the real clock makes the following migration look applied.
    It prints **"migrations applied"** and creates nothing. *(Done on 2026-08-14 by stamping 0027 a
    day after 0026; drizzle then stamped 0028 with the real clock, which was behind it. Confirmed
    by querying the table rather than trusting the success line - which is the actual lesson.)*
32. **`timestamptz + interval` is `STABLE`, not `IMMUTABLE`**, because it reads the session's time
    zone - so it cannot appear in an index expression, and an `EXCLUDE` constraint is an index.
    Postgres refuses with *"functions in index expression must be marked IMMUTABLE"*. Store the
    computed endpoint as its own column and range over two plain columns instead. *(ADR-0030.)*
33. **Drizzle wraps the driver's error, so a Postgres `SQLSTATE` is on `.cause` and not on the
    error you catch.** Checking `error.code` for `23505`/`23P01` silently never matches, and a
    handled conflict surfaces as an unhandled crash. Walk the cause chain.
34. **An open TCP port is not a ready Postgres.** The postmaster listens before `initdb` has
    finished, so a socket connects and the first query is still refused. A warm image closes the
    window to nothing, which is why this only ever appears somewhere cold: the repo's first CI run
    failed on `CREATE SCHEMA IF NOT EXISTS "drizzle"` six seconds after the readiness script had
    printed `postgres ready on :5432`. Wait on the healthcheck - `docker compose up --wait` - and
    treat a port probe as a diagnostic, never as the gate. *(2026-08-14.)*
35. **A `| undefined` return silently defeats switch exhaustiveness.** A switch over a union
    whose function returns `T | undefined` compiles fine with a case missing - control falls out
    of the switch and returns `undefined`, which is a legal value. `notification-href.ts` claimed
    in its own header that a new target kind "becomes a compile error rather than a row that
    silently navigates nowhere", and it did not: Nudge's target was added, no case was written,
    and the notification reached a phone and went nowhere when tapped. Assign the narrowed value
    to `never` after the switch, which is what actually enforces it. *(2026-08-14.)*
36. **An exhaustive switch still says nothing about whether the string it returns is real.** The
    `never` trick proves every case exists; it cannot prove `/clubs/${id}/typo` is a screen. Where
    the returned value is a route, sweep every case in a test as well. *(Same day, same file.)*

37. **A native module you just wrote does not exist in a binary somebody is already holding, and
    `requireNativeModule` throws at import time.** Two things follow, and the first is the one that
    bites. An import-time throw is entry 8's failure exactly - it takes the whole bundle down, so
    one unavailable action becomes a blank screen on every route - and a module written today is
    *guaranteed* to be missing from every build made before today, including the founder's phone.
    **Rule: reach a local native module through `requireOptionalNativeModule`, which answers `null`,
    and give the caller a path that works without it.** Adding the QuickLook viewer on 2026-08-17
    was the first change in this project where a JavaScript reload was not enough, and the founder
    tapped a PDF on his phone before the rebuild reached it: the share-sheet fallback answered, as
    designed, instead of a red screen.

    The second thing follows from the first: **autolinking has no default for
    `expo.autolinking.nativeModulesDir`**. Without that key in the app's `package.json`, `modules/`
    is never scanned, the podspec is never found, and the module is simply absent from the build -
    with no error at `pod install`, no error at compile, and a `null` at runtime that the optional
    require then handles perfectly. Which is to say the safety net above will hide this one, so
    check `Podfile.lock` for the pod by name after adding a module.

### Configuration, and the difference between present and true

38. **A config check that reads the value proves its SHAPE. Only the other end proves the VALUE.**
    On 2026-08-25 production error reporting was found never to have worked: `fly/*.toml` carried a
    Sentry DSN whose key was invented, sharing eight leading characters with the real one and
    fabricated after that. Sentry answered every event `403 with_reason: ProjectId`. **Five layers
    reported success on the way past it** - `loadConfig` accepted it (present, well formed), the
    config-completeness check passed (it feeds each `[env]` block through the real `loadConfig`,
    which cannot know what a valid key is), `Sentry.init` accepted it (the SDK never asks the
    server), the transport delivered the bytes and `Sentry.flush()` returned TRUE (the CONNECTION
    was accepted, the EVENT was refused), and `Monitor.flush` swallows even that flag by design.
    The forced-5xx drill reported `status=500` with correct tags and was a false pass.
    `scripts/drills/sentry-ingest-check.mjs` posts one event and prints the HTTP status, which is
    the only thing that can tell a present credential from a working one. Run it against any
    write-only address - a DSN, an ingest key, a webhook target - before believing a deploy reports.

39. **"It reports success" is not evidence when the reporter is the thing being tested.** The
    same shape three times in one repo now: a `/health` that could not fail, a `flush` that returns
    true for a rejected event, and a drill whose own success line could not mean delivery. Where a
    component's job is to tell you about failure, its own success signal is worthless and the check
    has to come from outside it.

### Clients you have already shipped

40. **Absent is not null to a build that already exists.** Dropping a column usually stops a read
    returning the KEY, not just the value, and a guard written `x === null` passes `undefined`
    straight through to `x.trim()`. On 2026-08-25 that crashed the app on the founder's phone within
    minutes of a deploy, on a meetup screen, while the api answered 200 in 27ms. A second one was
    latent in `directionsUrl` (`point !== null` then `point.lat`) and would have surfaced a week
    later looking like a fresh bug. Keep the key as an always-null compatibility field and write the
    removal condition at the return site: it is a fact about which builds are installed on phones,
    which nothing in this repo can query.

41. **Ask what the column FEEDS before asking what reads it.** The migration named `map_lat` and
    `map_lng`; the client read `mapPoint`, built by `toPoint(row.map_lat, row.map_lng)`, whose name
    appears nowhere in the migration. Grepping shipped builds for the dropped column's name returns
    a confident, correct, useless answer. Derived, renamed and multi-column fields all have this
    shape, and the search that would have found it is the one nobody ran.

### The mobile release path

42. **A local `pod install` edits `node_modules`, and the fingerprint notices.** `runtimeVersion`
    is `{ "policy": "fingerprint" }` ([ADR-0048](../decisions/0048-updates-are-keyed-to-a-fingerprint.md)),
    a hash over everything affecting the native runtime - `node_modules` included. Running the app
    locally rewrites `node_modules/react-native-maps/ios/AirMaps/RNMapsDefines.h` in place: npm
    ships `#define HAVE_GOOGLE_MAPS 1` and a local pod install sets it to `0`. One byte, and the
    fingerprint moves.

    **It fails twice, and only the first time is loud.** `eas build` refuses at the
    `CONFIGURE_EXPO_UPDATES` phase with a runtime-version mismatch and prints the diff naming the
    package, which is how this was found on 2026-08-27 after an 86-second failure. `eas update`
    does not refuse. It publishes against a runtime version no installed build carries, the phone
    finds nothing compatible, and the update never arrives - no error on the laptop, in Sentry, or
    on the device. **A silent no-op is the worse half of this pitfall.**

    Check before every build and every publish, and treat a mismatch as a dirty tree rather than a
    puzzle:

    ```
    npx expo-updates fingerprint:generate --platform ios
    ```

    It must equal the Runtime Version on the build the update is aimed at. `npm ci` restores the
    file. Note that `react-native-maps` is imported nowhere - `apps/mobile/src/meetup-map.tsx`
    keeps it deliberately so the map can come back without a native build - so the cheapest durable
    fix is a decision about that dependency rather than a check somebody has to remember.

43. **A malformed `eas.json` disables every `eas` command, not the one it belongs to.** `eas`
    validates the whole file before doing anything, so an `ascAppId` sitting at
    `submit.production` instead of `submit.production.ios` made `eas build`, `eas update`,
    `eas env:set` and `eas whoami --json` all fail with a schema error. It was added on 2026-08-23
    and found on 2026-08-27, because in between nobody ran an `eas` command - and the documents
    that named `eas env:set` as the next step were naming a command that could not run. **A config
    file nothing has executed since it changed is untested, whatever it looks like.**
