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
| Screens / routes | Call the data layer. Never build a raw query inline. |
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
npm run db:generate          # generate a migration from a schema change
npm run db:prove             # attempt to violate every constraint; must exit 0
npm run db:down              # stop the containers
npm run db:nuke              # stop AND destroy the volume. Development data only.

npm run typecheck            # every workspace, strict
npm test                     # every workspace. Handler tests start throwaway containers
npm run lint:emdash          # standing instruction 1, with a detector self-test

npm run dev:api              # API on :3000
npm run dev:gateway          # WebSocket gateway on :3001
npm run dev:worker           # outbox drain
npm run dev:mobile           # Expo client

# re-export the system overview image from SPEC/TECH/17-diagrams.md.
# Run in the same change as any edit to that file's first diagram, or the
# checked-in image silently drifts from its source.
./scripts/render-diagrams.sh
```

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
| `packages/server/src/policy/` | **The** policy module. Every predicate lives here exactly once |
| `packages/server/src/domain/` | Command handlers and query functions |
| `packages/server/src/db/` | Schema, migrations, and `constraint-proof.sql` |
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
