# AGENTS.md - working agreement

How any agent (or human) should work in this repo. Read this first, then
[`SPEC/README.md`](SPEC/README.md), which indexes the product spec, the technical spec and the
decisions.

Sections 0 through 4 are general engineering discipline and apply to every task, always,
without being restated. Section 5 is the repo-specific part.

---

## 0. Standing instructions

### Writing

1. **Never use an em dash (U+2014).** Use a plain hyphen (`-`) instead. This applies to code,
   comments, docs, commit messages, and anything shown to a user. Grep for it with
   `grep -rn $'—' .` rather than pasting the character into a doc. **Verify your grep variant
   actually matches** against a file you know contains one before trusting a zero result;
   some variants (notably `-P` on macOS's BSD grep) silently match nothing and report a clean
   file full of them.
2. **Every commit is authored by the repo owner, with no co-author line.** The identity is
   `parks3131 <178941891+parks3131@users.noreply.github.com>`, already set in git config.
   Never override it with `--author`, and never append a `Co-Authored-By` trailer for an
   agent, model, or tool - not even when the agent's own defaults call for one. Commit
   messages carry the author's intent, not the tool's byline.

### Deciding

3. **Do not weight development cost heavily when making a technical decision.** Prefer, in
   this order: quality, simplicity, robustness, scalability, long-term maintainability.
   "It's faster to build" is close to worthless as an argument; "it's simpler to reason about
   in a year" is decisive. Record the reasoning in an ADR, including the rejected alternative
   and why, so it does not get re-litigated later.

### Fixing bugs

4. **Reproduce the bug end-to-end before fixing it.** Start by reproducing it the way an end
   user would actually hit it: through the running app, on the relevant platform, with
   realistic data. Not by reading code and reasoning about what might be wrong. A fix that
   was never preceded by a reproduction is a guess. Once fixed, re-run the same reproduction
   to prove it.

### Verifying

5. **Be picky about the UI. Pixel perfection is the standard.** When testing end to end,
   treat anything that looks off as a defect worth fixing, including things unrelated to the
   current task: misaligned rows, inconsistent spacing, a header that jumps, a colour that
   does not match the token, a control a few pixels from where it belongs. Fix it along the
   way rather than filing it.
6. **Hold engineering hygiene to the same bar.** A failing test, a flaky test, or a type error
   gets fixed when you see it, whether or not you caused it. Never work around a flake by
   re-running until it passes, and never leave the suite in a state where a red result is
   normal.

### Reporting

7. **Report outcomes faithfully.** If tests fail, say so and show the output. If a step was
   skipped or a part of the scope was left out, say that explicitly rather than letting a
   summary imply completeness. When something is done and verified, say so plainly without
   hedging.
8. **Never claim something works without having run it.** "Should work" is not a result.

---

## 1. Non-negotiables

1. **Read the pinned, versioned documentation for any fast-moving dependency before writing
   code against it.** Training-data memory of an older major version is actively wrong, and
   it fails in the worst possible way: plausible code that a reviewer will not question. This
   applies to the framework, the runtime, the ORM, and the platform SDKs.
2. **Never edit a migration that has already been applied.** A correction is always a new
   numbered migration. Migrations are the schema's source of truth and must replay cleanly
   from zero.
3. **Never run a destructive database command against a database you have not confirmed is
   disposable.** A development database accumulates real usage data between sessions. It is
   not fixtures.
4. **Type check and the full test suite must pass before any change is "done."** No
   exceptions, no "I'll fix it in the next commit."
5. **No secrets in the repo.** Only keys that are safe to ship in a client. Any key that
   bypasses authorization must never appear in code, docs, logs, or a commit message.
6. **Every authorization change is proved, not reasoned about.** Attempt the forbidden action
   as the unprivileged actor and watch it be rejected. Reading the rule and concluding it
   looks right is not verification.

---

## 2. Workflow

### 2.1 Before writing code

1. **Read [`SPEC/PRD/`](SPEC/PRD/)** for the intended behaviour, then
   **[`SPEC/TECH/`](SPEC/TECH/)** for how that area is built. Behaviour questions are answered
   by the first; structural questions by the second. Check
   [`SPEC/decisions/`](SPEC/decisions/) before reopening anything that looks settled.
2. **Find the closest existing feature and mirror it.** This codebase is deliberately
   pattern-heavy. Almost nothing should be genuinely novel, and something that looks novel is
   usually a sign the existing abstraction was not understood.
3. **If the request is ambiguous about who is allowed to do what, ask.** Permission models are
   not derivable by analogy. Two features that look alike routinely have deliberately
   different rules, and guessing produces a security defect rather than a wrong screen.

### 2.2 Writing code

| Layer | Rule |
|---|---|
| Screens / routes | Call the data layer. Never build a raw query inline. **Never accept a `clubId` (or any owning-scope id) from the caller alongside the id it belongs to** - resolve it with `domain/scopes.ts`. A two-part authorization check cannot tell whether its two arguments describe the same thing. |
| Shared UI | Parametrize by scope rather than forking a copy. A fix must land everywhere at once. |
| Data access | Plain exported typed functions, one concern per module. Return app-shaped types, never raw database rows. |
| Authorization | One policy module. Every predicate defined exactly once and reused. No handler re-derives one inline, ever. |
| Errors | Route through one reporting path, wired to real error monitoring. |
| Styling | Tokens only. Never hardcode a colour, radius, spacing, or font size that a token covers. |
| Schema | A new migration, plus the type definitions updated in the same change. |

### 2.3 Verifying

Order matters. Each step catches a class the previous one cannot.

1. **Type check.** Strict mode. A hand-maintained type can silently degrade rather than error,
   so a type failure here is often a docs bug rather than a code bug.
2. **Test suite.** Zero failures, zero flakes. See standing instruction 6.
3. **Live smoke test in the running app.** This catches what code review does not.
4. **For anything touching navigation, test direct URL entry and page refresh**, not just
   clicking through. A back control that only renders when history exists will never surface
   any other way.
5. **For anything destructive, confirm the underlying data actually changed.** A confirmation
   dialog can report success, log nothing, and do nothing, particularly where a platform
   stubs out the dialog API.
6. **For anything cross-platform, verify on each platform separately.** A brand-new
   cross-platform API working on one OS is not evidence it works on the other. Prefer the
   older, documented path for anything on a hot path.

### 2.4 Finishing

1. **Update the relevant product and architecture docs in the same change.** A feature whose
   spec was not updated is not done.
2. **Append the full narrative** (bugs hit, root causes, scope changes) to the history file
   under that task's heading. Keep the specs summary-level; they load into context every
   session and detail there is expensive.
3. **If a decision was architectural and non-obvious, write an ADR**, with the rejected
   alternative recorded.
4. **Commit only when asked.** No agent co-author line.
5. **Branch and review policy: solo, direct to main.** Recorded from observed practice rather
   than chosen freshly - every commit in this repo's history is on `main`. The gate is therefore
   not review but section 2.3: type check, full suite, and a live smoke test before anything is
   called done. Revisit if a second person starts committing.

---

## 3. Documentation contract

| Document | Answers | Must not contain |
|---|---|---|
| [`SPEC/PRD/`](SPEC/PRD/) | What the product does and why | File paths, schema, component names |
| [`SPEC/TECH/`](SPEC/TECH/) | How it is built, and what must not break | Product justification (link to the PRD instead) |
| [`SPEC/decisions/`](SPEC/decisions/) | Why we chose this over the alternative | Implementation detail that will drift |
| [`HISTORY.md`](HISTORY.md) | How we got here, bug by bug | Anything needed to work today |
| `AGENTS.md` (this file) | How to work | Anything specific to one feature |

Start at [`SPEC/README.md`](SPEC/README.md), which indexes all of it.

**Where a doc disagrees with the repo, the repo is right and the doc is the bug.** Fix it in
the same change. This is the only rule that keeps a spec from going stale, and it only works
if it is applied every time rather than when convenient.

Keep the specs compact. If a story is long, it belongs in the history file.

---

## 4. General failure modes

Short list of things that are true across projects and have each cost a long debugging session
somewhere. Project-specific war stories go in section 5.

- **A "hang" with no console errors and no network activity is usually navigation or state
  logic**, not a stuck client. Check the routing before you check the network.
- **A callback named for an event fires more often than the event actually happens.** List
  callbacks like "reached the start" or "content size changed" commonly fire at mount. Treat
  both as suspect on first render.
- **Never pop navigation history unguarded.** It throws when there is nothing to pop, which is
  every screen reached by a direct link or a refresh.
- **The same predicate restated in many places will eventually be restated wrongly.** Define
  it once. This is the single most reliable source of authorization bugs.
- **At-least-once delivery means every effect must be idempotent**, and idempotency enforced
  by a unique constraint must account for NULLs, which most databases treat as distinct.
- **A timestamp is not an ordering.** Clock skew is real. Order by an explicit sequence.
- **A date-only value parsed as an ISO string is UTC midnight**, and renders a day early in
  negative-offset timezones. Build dates from split components.

---

## 5. Project specifics

_Fill these in as the project takes shape. Everything above is stack-agnostic; everything
below is not._

### 5.1 Commands

```bash
npm install                  # install (npm workspaces; no pnpm/yarn)

npm run db:up                # start Postgres 17 + Redis 8 in Docker, and WAIT for them
npm run db:migrate           # apply pending migrations
npm run db:generate -- --name=message_replies   # generate a migration from a schema change
npm run db:prove             # attempt to violate every constraint; must exit 0
npm run db:down              # stop the containers
npm run db:nuke              # stop AND destroy the volume. Development data only.

npm run typecheck            # every workspace, strict
npm test                     # every workspace. Handler tests start throwaway containers
npm run lint:emdash          # standing instruction 1, with a detector self-test
npm run check:runtime        # imports every module the way Node runs it. See failure mode 5

# The Phase 3.75a exit gate: every route against a RUNNING server, in both directions.
# Needs dev:api up. Deliberately not a test - see the header of the script for why.
npm run gate:surface
API=http://127.0.0.1:3100 npm run gate:surface

npm run dev:api              # API on :3000
npm run dev:gateway          # WebSocket gateway on :3001
npm run dev:worker           # outbox drain
npm run dev:mobile           # Expo client

# re-export the system overview image from SPEC/TECH/17-diagrams.md.
# Run in the same change as any edit to that file's first diagram, or the
# checked-in image silently drifts from its source.
./scripts/render-diagrams.sh
```

**Always pass `--name` to `db:generate`.** Without it drizzle-kit invents a random codename and
you get `0015_hard_zarda.sql`, which says nothing about what it does to anybody reading the
directory later. Migrations 0012 to 0015 shipped that way and were renamed on 2026-08-01; the
rename was safe because `__drizzle_migrations` records a hash of the SQL and the journal's `when`,
never the filename - so renaming the file **and** its `tag` in `meta/_journal.json` together
changes nothing about what has been applied. That is a rename, not an edit, and non-negotiable 2
still stands: the SQL inside an applied migration is never touched.

**Node 24 or newer.** There is no build step and no bundler for the server: Node runs `.ts`
directly by stripping types. That is why every import carries an explicit `.ts` extension.

**TypeScript is pinned to 6.0.3, not 7.** TS 7 is npm `latest` and is the native compiler, but
Expo 57's own TypeScript template pins `~6.0.3` and the client is half the deliverable. TS 6 is
also the release designed to get a codebase ready for 7, so adopting it now makes the eventual
move a version bump rather than a migration. Do not "upgrade" this without checking Expo first.

### 5.2 Repo map

| Path | What it is |
|---|---|
| `SPEC/README.md` | Index of everything below. Start here. |
| `SPEC/PRD/` | Product requirements, one file per feature area |
| `SPEC/TECH/` | Technical spec, one file per subsystem |
| `SPEC/decisions/` | Accepted ADRs. Immutable; supersede rather than edit |
| `SPEC/templates/` | Feature spec, authorization checklist, migration checklist, ADR |
| `SPEC/TECH/assets/` | Generated diagram exports. Do not hand-edit; see `scripts/` |
| `packages/shared/` | Wire contract and domain vocabulary. Imported by client AND server, so neither can drift from the other |
| `packages/client-core/` | Local store, send outbox, sync engine. Shared by the Expo app and the exit drill, so the drill tests what ships |
| `packages/server/` | Three roles, one codebase: `src/api`, `src/gateway`, `src/worker` |
| `packages/server/src/api/app.ts` | Composition only. Registers route groups inside the authenticated scope, so an unauthenticated route cannot be added by forgetting a hook |
| `packages/server/src/api/routes/` | One file per **path** group, not per domain module. `/channels/:id/reports` sits with the moderation queue |
| `packages/server/src/api/plumbing.ts` | What every route group shares: `AppDeps`, `authorizeChannel`, `refusalStatus`, `isUuid` |
| `packages/server/src/policy/` | **The** policy module. Every predicate lives here exactly once |
| `packages/server/src/domain/` | Command handlers and query functions |
| `packages/server/src/db/` | Schema, migrations, `constraint-proof.sql`, and the raw-read helpers |
| `apps/mobile/` | Expo client (iOS / Android / web) |
| `scripts/` | Diagram export, service readiness, em-dash check |

**Where the invariants actually live.** `packages/server/src/db/schema.ts` carries them as
constraints, and `constraint-proof.sql` proves each one by attempting to violate it. If you add
an invariant, it belongs in both, not in a handler - a handler races, a constraint does not.

### 5.3 Failure modes specific to this codebase

_Add an entry every time a bug costs more than an hour. Include the symptom, the root cause,
and the rule that prevents it. An entry that only records the fix is worth half as much as one
that records how to recognise the class._

1. **Drizzle wraps driver errors, so a pg error code is on `.cause` and not on the thrown
   object.** Symptom: the idempotent-retry path in `appendMessage` never fired, and a concurrent
   double-send surfaced as an unhandled unique-violation instead of returning the original
   `seq`. Root cause: `error.code === '23505'` checked only the top level and silently matched
   nothing. **Rule: when catching a driver error through an ORM, walk the cause chain.** A
   never-matching check looks correct and is invisible until the exact concurrency it exists to
   absorb actually happens - reading the function did not reveal it; the test did.

2. **better-auth's Drizzle adapter emits `default` for `id` columns and expects the database to
   supply one.** Symptom: sign-up died on `null value in column "id"`. Root cause:
   `advanced.database.generateId: 'uuid'` does not make the adapter generate ids for these
   tables. **Rule: give every better-auth-owned table (`users`, `sessions`, `accounts`,
   `verifications`) a database-side `defaultRandom()`.** That works regardless of which id
   strategy the library is using, which is the point.

3. **Client-side gap detection is a read-then-write of the local max, and concurrent frame
   application corrupts it.** Symptom: two in-order messages delivered together caused a
   spurious sync, because both read the local max before either wrote. Root cause: no
   serialization in `applyIncoming`. **Rule: apply frames one at a time per channel.** A gap
   signal has to *mean* a gap; a racy one is worse than none, because it trains you to ignore it.

4. **TypeScript 6 stopped inferring `rootDir` and stopped auto-discovering `@types`.** Symptom:
   `TS6059 not under rootDir` for a config file at a package root, and missing Node globals.
   **Rule: state `rootDir` and `types` explicitly in every package's tsconfig.** Also: `baseUrl`
   is deprecated and `moduleResolution: node` is gone - do not reintroduce either.

5. **Vitest and Node accept different TypeScript, so a green suite is not evidence the server
   boots.** Symptom: every test passed, typecheck passed, and all three server processes
   died at startup with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Root cause: a **parameter
   property** (`constructor(readonly x: T)`). Vitest transforms with esbuild, which supports
   the full grammar; Node runs `.ts` by *stripping* types, which supports strictly less.
   **Rule: no parameter properties, enums or namespaces anywhere in server code, and
   `npm run check:runtime` imports every module the way production does.** That check exists
   precisely because no other gate in the pipeline can see this class.

6. **An unbound global passed around as a method fails only in a browser.** Symptom: sync
   silently failed on web with "Failed to execute 'fetch' on 'Window': Illegal invocation",
   while the test suite and the whole exit drill passed. Root cause: a getter returning the
   bare global `fetch`, then called as `this.fetch(...)`, which invokes it with `this` set to
   the instance. Node's fetch does not check its receiver; a browser does. **Rule: bind
   globals when storing or returning them (`globalThis.fetch.bind(globalThis)`), and smoke
   test the real app in a real browser** - this was invisible to every automated check, and
   doubly so because the caller logs and continues on the principle that realtime is an
   enhancement.

7. **`db.execute` does not apply Drizzle's column type coercion.** Symptom:
   `row.created_at.toISOString is not a function`, from code that typechecked cleanly. Root
   cause: a typed `select()` hands back a `Date` for a timestamptz, but raw `execute()`
   hands back the driver's value, which is a **string**. The hand-written row type said
   `Date`, TypeScript believed it, and the lie surfaced at the call site rather than at the
   declaration. **Rule: row types for `db.execute` must say `string` for timestamps.** More
   generally, a hand-maintained type over a raw query is an assertion, not a check - which
   is why section 2.3 puts "a type failure here is often a docs bug" first: the type passing
   proves only that you and the compiler agree, not that either of you is right.

8. **A bundle-time resolution failure cannot be caught by a runtime `try`/`catch`.** Symptom:
   the web app hung forever on a spinner after sign-up. Root cause: `expo-sqlite`'s web build
   imports a `.wasm` binary that Metro does not resolve by default, so the *whole bundle*
   failed - and the graceful in-memory fallback inside `openMessageStore` never ran, because
   a static import fails before any of our code does. **Rule: `wasm` belongs in
   `metro.config.js` `assetExts`, and a fallback around a static import is not a safety net.**
   Note the shape of the symptom: a screen that spins forever, which is exactly the failure
   `SPEC/PRD/03` warns about and which reads as a crash to whoever is holding the phone.

   **It recurred on 2026-08-02 with `expo-media-library`**, and the second instance earns its
   place because the trigger differs: not a missing bundler config but a **platform-only native
   module imported at module scope**. It has no web implementation, so evaluating it throws
   `Cannot find native module` - at bundle load, which meant one unavailable action blanked every
   route including sign-in. The web client had been dead for a day and nothing reported it,
   because the feature it belongs to was verified on a device. **Rule: a native module that only
   exists on some platforms is imported inside the handler that uses it, behind a platform check,
   never at the top of the file.** How to recognise the class: the package is in `package.json`,
   the import resolves, typecheck is clean, and the app renders nothing at all.

9. **A hand-copied SQL predicate does not diverge loudly. It diverges silently, and every copy
   stays individually correct.** Symptom: none, for a whole phase. Race chat existed, had
   messages in it, and was invisible in the channel list, the unread counts, the badge and the
   notification audience - because "which channels can this user reach" had been written out four
   times and Phase 2 added races to none of them. Each copy was self-consistent, so no type error
   and no failing test existed to find. **Rule: the second time you write a `WHERE` clause,
   extract it before you add a case to it.** How to recognise the class: a new domain concept
   ships, and the question "what else asks this same question?" has more than one answer. Grep for
   the join, not for the feature - the copies will not mention the feature they are missing.

10. **A predicate exported as an alias of another is invisible to any audit that counts
    predicates.** Symptom: none yet - caught while adding a fourth channel scope, one step before
    it would have silently removed a documented capability. `canPostInChannel` was
    `isChannelMember` and `canPinInChannel` was `isChannelAdmin`, so a scope where posting and
    reading differ, or where pinning is not an admin power, has nowhere to put the difference.
    Reading the policy module counts five distinct capabilities and finds three definitions.
    **Rule: when a capability has its own name in the spec, give it its own predicate, even if the
    body is one word.** An alias is a claim that two things will never diverge, and the cost of
    being wrong is a permission that silently changes for a scope nobody re-read.

11. **A subsystem can be complete on both sides and still be unreachable, because nothing joins
    them.** Symptom: the media pipeline passed every server test - presigned upload, size
    re-verification, thumbnail derivation, an authorization hop proved four ways - and no photo
    could be sent or displayed by the app. Two joins were missing: the message envelope never
    carried `media_id`, so a client receiving a photo had no way to find the bytes; and the signed
    URL is validated by a CDN that development does not have, so fetching it returned 403. **Rule:
    a feature is not verified until the bytes make the whole trip in the running app.** How to
    recognise the class: the tests exercise each end against a fixture, and no test crosses the
    middle. A green suite over a pipeline is evidence about the pieces, not about the pipe.

12. **A check against a field the library does not return reads `undefined` forever.** Symptom:
    none, for four phases. Account revocation was checked at both entry points -
    `session.user.signinBlockedAt` in the HTTP hook and again in the gateway's `auth` frame -
    and neither ever fired, so a blocked or deleted account kept working until its session
    expired. Root cause: better-auth returns only the columns declared in
    `user.additionalFields`, and the two lifecycle columns are not declared, so the property
    was absent rather than false. **Rule: never authorize against a field on a third-party
    object you did not put there.** The answer lived in our own `users` row the whole time;
    it is now loaded into the access context and asked through one predicate. How to
    recognise the class: the check is a truthiness test on an optional property of a foreign
    type, so TypeScript is content, the code reads correctly, and nothing can fail. Note the
    shape it shares with entry 1 - a condition that silently never matches - and that this
    one guarded a security boundary, which is why "prove the refusal, do not read the rule"
    is a non-negotiable and not a preference.

13. **An untargeted `ON CONFLICT DO NOTHING` absorbs every unique violation on the table, not
    the one you meant.** Symptom: assigning a member to a second car group answered
    `{ assigned: true }` and did nothing, so the UI reported a move that never happened. Root
    cause: the insert carried a bare `onConflictDoNothing()`, which swallowed
    `car_group_members_one_per_race` - the very invariant the surrounding `catch` existed to
    turn into a refusal. The catch was unreachable because nothing threw. **Rule: always name
    the conflict target.** An untargeted clause is a claim that every current and future
    unique constraint on the table means "ignore this write", which is almost never true, and
    is least true on a table whose whole purpose is holding a domain invariant.

14. **`::text` on a `timestamptz` is not ISO 8601.** Symptom: a paging cursor this API emitted
    was rejected by the same API's own `before` parameter. Root cause: `db.execute` does no
    coercion (entry 7), so a timestamp has to be cast in SQL - and `::text` renders Postgres's
    own format, `2026-07-30 08:42:41.123+00`, with a space and a two-digit offset. A browser's
    `new Date()` parses it, so the mistake survives eyeballing a response; a strict validator
    refuses it. **Rule: use `isoUtc()` from `db/sql-helpers.ts` for a timestamp, and plain
    `::text` only for a `date`.** How to recognise the class: every timestamp the ORM returns
    goes through `.toISOString()`, so a raw read is the only place a second format can enter,
    and it enters looking almost right.

15. **A dev server that failed to start leaves the OLD one answering.** Symptom: 46 of 73 gate
    checks failed with "route not found" for code that was definitely present, while the routes
    from two phases ago answered fine. Root cause: `npm run dev:api` exited with `EADDRINUSE`
    because a server from an earlier session still owned the port, and every request went to
    that stale process. **Rule: before believing a live-test result, confirm the process you are
    talking to is the one you just started** - grep the log for `EADDRINUSE`, or start on a
    different port. Note which way this fails: it reports your new work as broken, which is the
    direction that wastes an hour rather than shipping a bug. The inverse - a stale process
    reporting a fixed bug as fixed - is the one to actually fear.

16. **A hand-written client type over an API response is an assertion, and it fails at the screen
    rather than at the declaration.** Symptom: four separate crashes and wrong renders in one
    phase - an inbox row reading `params.approved` off `undefined`, a gallery reading `.length` off
    `undefined`, every news post labelled "edited", and a Reports tab offered to somebody who could
    never read it. Root cause: `apps/mobile/src/api-types.ts` restates the server's response shapes,
    because the server's own types live in modules the client cannot import. Every one of those was a
    plausible guess that typechecked cleanly. **Rules: import from `@clubchat/shared` anything that
    exists there** - `NotificationTarget` was being restated, and importing it made the client's
    routing switch exhaustive over the same union the server derives from - **and read the server's
    type before writing the client's, rather than inferring it from the screen you are building.**
    The generalisation of entry 7, one layer up: the type passing proves you and the compiler agree,
    not that either of you is right.

    **Closed for the WebSocket surface on 2026-08-01**, after entry 18 below showed what it costs:
    both ends now parse frames against the shared schemas rather than casting to them, so a field
    a producer omits is filled from the contract's own default instead of reaching the database as
    `undefined`. The REST surface is not closed - `apps/mobile/src/api-types.ts` still restates
    response shapes by hand.

17. **A nested pressable is invalid HTML on web and swallows the outer gesture on native.**
    Symptom: React reporting `<button> cannot contain a nested <button>` and warning of a
    hydration error, from a photo bubble rendered inside the message bubble's own long-press
    target. **Rule: only the outermost element in a row owns the gesture** - inner content is a
    `View`, and any tap behaviour it wants belongs to the enclosing pressable. Caught by reading
    the browser console during a smoke test, which is the only place it surfaces: it typechecks,
    it renders, and it looks right.

18. **`JSON.stringify(undefined)` returns `undefined`, so an absent field binds SQL NULL and takes
    the whole row with it.** Symptom: creating a poll or an event appeared to do nothing - the card
    never showed up in chat - with an unrelated-looking `Uncaught (in promise)` toast elsewhere on
    screen. Root cause: the local cache wrote `JSON.stringify(message.mentions)` into a `NOT NULL`
    column, and the arriving envelope had no `mentions` at all, so the insert died on `NOT NULL
    constraint failed`. **Rule: never bind a bare `JSON.stringify` to a NOT NULL column - coerce
    the absent case to the default the contract declares** (`JSON.stringify(value ?? [])`). How to
    recognise the class: a field the *type* says is required, arriving from a producer that
    predates it. TypeScript is no help - the payload was cast, not parsed - and neither is the
    happy path, because every other producer sets the field.

    Two things made it hard to place, and both are worth remembering. **Only cards broke**, because
    cards are the one message published by the *worker* and everything else is published by the
    gateway - so "creating a poll is broken" was really "one publisher is old". And **a reload fixed
    it**, because the same message then arrived through `/sync`, which builds its envelopes
    somewhere else entirely - which makes it read as a realtime bug rather than a missing field.

19. **A rule asserted in three documents and implemented in none is invisible to an audit that
    counts predicates.** Symptom: none, for the life of the project. `GET /users/:id` returned any
    account's name, bio, city, school and avatar to **any** signed-in caller holding a uuid -
    including one who had just been blocked by its owner. Root cause: `readProfile` took an
    `AccessContext` and never read it. ADR-0009 rejected global DMs partly *because* "profiles are
    visible only to people who share a club"; `sharesAClub`'s own docstring restated it; PRD/03
    listed public profiles as a rejected alternative. All three described a rule with no predicate
    behind it. **Rule: audit the spec's *claims* against the code, not the code's predicates against
    its routes.** Note this is the exact inverse of entry 10 and the pair is worth holding together:
    an alias hides a capability behind another one's name, so counting predicates finds too few
    definitions; this had no name at all, so counting finds nothing wrong. The tell is a rule stated
    in prose in more than one document, which is what people do when something feels settled - and a
    rule nobody doubts is a rule nobody greps for. Two existing tests had quietly encoded the hole
    by asserting a stranger *could* read a card.

20. **A per-request check is not a per-connection check, and a socket is neither.** Symptom: an
    account shut off by an operator kept posting into club chat, and an account that deleted itself
    kept receiving club chat in real time - both indefinitely, while the same accounts' HTTP
    requests were correctly refused with 401. Root cause: `isSessionUsable` was asked on every HTTP
    request and exactly **once** per socket, at the `auth` frame; a client holds a socket open for
    hours with heartbeat pings. The receiving half had a second cause - `deleteOwnAccount` dropped
    every membership in one transaction and wrote **no outbox event**, so unlike all five other
    removal paths it published no revocation. **Rules: ask a revocation on every frame that already
    reloads the context, and make account lifecycle publish a revocation like every other way of
    losing access.** How to recognise the class: a guarantee that holds on one transport and is
    merely *assumed* on the other, because the two were written months apart and only one of them
    has a natural place to re-ask. Compare entry 12 - there the revocation check never fired at all;
    here it fires correctly and not often enough, which is harder to see because every test of it
    passes.

21. **A handler that awaits does not hold the next message back, so the order a client sends in is
    not the order the server observes.** Symptom: a socket answering `auth failed: invalid_token`
    against a session the API was answering `200` for, intermittently, cured by signing out and in.
    Root cause: `handleAuth` awaits two queries and the gateway started the next frame immediately,
    so a `subscribe` sent *after* `auth` was evaluated while the socket was still unauthenticated,
    refused, and closed. **Rule: frames from one connection are handled one at a time, in arrival
    order.** This is entry 3 one layer out - there it was frames per channel on the client, here it
    is frames per socket on the server - and the recognition rule is the same: *any check that reads
    state an earlier message writes is meaningless until that message has finished.* Grep for a
    handler that both `await`s and reads mutable per-connection state.

    **Two riders, each of which cost as much as the race itself.** First: **the refusal reported
    `invalid_token`, which is a different fact from "you were early"** - and a client had just been
    taught to end the session on that code, so a member with a good token was signed out. A refusal
    code is an API; giving two causes one name means a caller cannot act correctly on either. Second:
    **the regression test passed with the server bug still present.** It drove the real client, and
    the client fix stopped it sending the offending frame at all, so nothing reached the server's
    half. A test for a server contract has to put the bytes on the wire itself. Both halves were
    verified to fail without their own fix, which is the only reason this was noticed.
