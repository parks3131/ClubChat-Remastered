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

### Asking

9. **A question to the founder is a multiple choice with real trade-offs, not an open one.**
   Restate what you understood back to him first, name the options, and say what each one costs
   - an open question hands the work of framing the decision back to the person who asked for
   the work. Recommend one and say why. Reserve it for decisions that are genuinely his: two
   readings of the request that would produce materially different work, or a resource only he
   can allocate, such as the running stack and the phone in section 2.5. A choice with an
   obvious default is made, mentioned, and moved past.

### Re-entering

10. **Write every user-facing message for cold re-entry.** The founder is juggling several
    projects, each with several concurrent sessions, and has usually lost the thread by the time
    he comes back to any one of them. Every message you write is a cold start for its reader:
    assume he remembers nothing from the scrollback.

    - **Open with a recap.** Before any summary, decision point, or question: two or three plain
      sentences on what was being worked on, why, and where it stands now.
    - **Plain language.** No invented codenames, no abbreviations, and no callbacks like "the
      earlier fix" or "option B from before". Restate the thing in place, every time.
    - **Self-contained questions.** A question must carry everything needed to answer it: the
      background, the options, the trade-offs, and your recommendation. Never require scrolling
      back. This is instruction 9 with the context included rather than assumed.
    - **One question at a time.** When several questions or next steps are open at once, say so up
      front ("three decisions are waiting, here is the first"), then present only the first and
      wait for the answer before raising the next. Never dump them all at once; it is too much
      mental load to hold.
    - **Anchor the work.** Name the project, the branch and the worktree when reporting status.
      Several other sessions look exactly like this one, and section 2.5 means two of them can sit
      in different trees on different branches at the same commit.
    - **End with the next action.** Close a long update with the single thing waiting on him, or
      say explicitly that nothing is.

### Testing

11. **Failing test first, then implement, then verify.** Write the test that states the behaviour
    you want and watch it FAIL, implement the least that turns it green, then run the full suite
    and the type check. A test written after the code and passing on its first run has proved
    nothing: it has never been seen to fail, so it may be asserting something that was already
    true. When fixing a bug, that failing test IS the reproduction instruction 4 asks for.

    **Where a layer has no test harness, the reproduction in the running app is the red step, and
    not an excuse to skip one.** The mobile app is tested as pure functions only; there is
    deliberately no component or hook harness, so a defect that exists only on a device is
    reproduced on the device before the fix and re-run on it afterwards. What is never acceptable
    is neither: no failing test and no reproduction is a guess with a commit message attached.

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
7. **Never run a git command that acts on the whole working tree.** `git add -A`, `git add .`,
   `git commit -a`, `git stash`, `git reset --hard`, `git checkout -- .`, `git clean`,
   `git switch`. Somebody else's unfinished work is usually in this directory, and every one of
   these either destroys it or takes it into your commit without saying so. Name your paths.
   Section 2.5 has the whole procedure.

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
5. **Branch and review policy: direct to main from the founder's own tree, a branch from
   anywhere else.** Recorded from observed practice rather than chosen freshly - the whole
   history is on `main`, and it stayed sound while one agent worked at a time. From 2026-08-15
   several run at once, so an agent with a worktree of its own commits to its branch and pushes
   that; only work done in the founder's tree goes straight to `main`. The gate is still not
   review but section 2.3: type check, full suite, and a live smoke test before anything is
   called done.

---

## 2.5 Working alongside other agents

Several agents work on this repo at the same time. Sometimes they are each in a worktree of their
own and sometimes they share the founder's, and the difference decides everything below.

**The point of all of it: make a collision LOUD.** In a shared tree a collision is silent. On
2026-08-15 two agents edited `apps/mobile/src/api-types.ts` in the same afternoon - one adding a
feed type, one adding DM and report types - and whichever committed first would have carried the
other's unfinished work into its commit with no error, no marker, and nothing in the diff to say
whose it was. On separate branches that identical collision is a merge conflict: it stops you, it
shows you both sides, and you resolve it once. **A conflict is the good outcome here.** Everything
in this section is chosen to convert the silent case into the loud one.

1. **Take a worktree unless you need the running stack.** One command:

   ```
   ./scripts/agent-worktree.sh moderation
   ```

   It creates the tree, branches, installs, and assigns a free port triple. You may then commit
   as often as you like without coordinating with anybody.

   **Never symlink `node_modules` into a worktree** - the script's header explains why at length.
   The workspace links are relative, so `@clubchat/shared` resolves back to the original tree and
   you typecheck against another agent's half-written code. It produced an error in a file nobody
   had touched, which is a bad hour.

   **A tree belongs to a task, not to an agent.** Cut it from the latest base branch when the work
   starts, and once that work is merged, take it down: `git worktree remove <path>`, then delete
   the branch. Never carry an old tree into the next task. Its base moved underneath it while it
   sat there, so the conflicts it produces are against work that merged days ago rather than
   against anything anybody is doing now, and the ports it holds stay allocated to nothing.

2. **The running stack and the phone are exclusive, and they are not yours by default.** One tree
   holds 3000 / 3001 / 8081, the dev database and the iPhone. Everywhere else, `npm test` is
   self-sufficient - the handler tests start their own throwaway containers.

   **Look before you ask, and ask only if nothing is there.** Three agents asking the same
   question about the same one stack is worse than not asking, so the check comes first:

   ```
   lsof -nP -iTCP:3000 -sTCP:LISTEN -t     # API      ) something listening means
   lsof -nP -iTCP:3001 -sTCP:LISTEN -t     # gateway  ) another agent, or the founder,
   lsof -nP -iTCP:8081 -sTCP:LISTEN -t     # Metro    ) already holds it
   lsof -nP -iTCP:8081 | grep ESTABLISHED  # a connection here is the phone, attached
   ```

   - **Something is already running: do not ask, and do not restart it.** Use it as it stands
     if you need it. It belongs to whoever started it, a restart drops the founder's phone
     mid-session, and `node --watch` means it is already picking up your saved files anyway.
     Never `pkill -f` - the command lines are identical across stacks, so a pattern kill takes
     the founder's server down with the one you meant. Kill by the PID owning the port, and
     only a port you started.
   - **Nothing is running: ask, and ask as a multiple choice.** Never start the stack on your
     own initiative and never assume the answer. Offer him the real options with their
     trade-offs - start it here in his tree, start it on your own ports, or carry on without
     it on tests alone - because which one is right depends on whether he wants the phone
     pointed at your work, and only he knows that.

   The same rule covers the iPhone. A device is a single object in somebody's hand: check
   whether Metro already has a connection before proposing to install or relaunch anything on
   it, and see [`SPEC/TECH`](SPEC/TECH/) and section 5.3 for why a successful `devicectl`
   launch over the cable is no evidence the phone can reach the Mac at all.

3. **If you ARE in the shared tree, ask what you own before writing, and make it include the
   shared files.** Directory ownership is not enough here. Nearly every feature touches
   `HISTORY.md`, `SPEC/README.md`, `TODO.md` and `PRD/18`, and `api-types.ts` and `schema.ts` sit
   across feature lines by design. Those have to be assigned by name or they are assigned by
   whoever saves last.

4. **Commit by pathspec, never by staging:**

   ```
   git commit -F /tmp/message.txt -- path/one.ts path/two.tsx SPEC/DESIGN/11-whatever.md
   ```

   The `--` form commits those paths' working-tree content and ignores the index entirely, so
   nothing another agent stages between your check and your commit can be swept in.

   **A file git has never seen has to be staged first, and the rule read as though it did not.**
   A pathspec is matched against tracked files and the index, so `git commit -- new-file.ts`
   fails outright on anything new - a migration, an ADR, a new test file. Stage exactly those:

   ```
   git add SPEC/decisions/0031-whatever.md packages/server/src/db/migrations/0031_x.sql
   git diff --cached --name-only          # nothing but the new files you just named
   git commit -F /tmp/message.txt -- <every path, the new ones included>
   ```

   That staging step is narrow by construction - it names only files that did not exist before,
   so it cannot pick up another agent's edit to an existing one - but confirm the staged set
   anyway, because the index is shared. Found on 2026-08-15 by the agent it stopped, and worth
   recording as written rather than as understood: the rule was obeyed exactly and did not work.

   **The other exception is a file that carries two agents' work**, where pathspec takes all of it.
   There, stage your hunks with `git add -p <file>`, confirm with `git diff --cached --name-only`
   that the staged set is exactly yours, and commit from the index. If a file you do not
   recognise is staged, stop and say so rather than unstaging it - it may belong to a commit
   somebody else is halfway through making.

5. **Commit every green slice immediately.** The exposure is uncommitted work sitting in a shared
   directory, and it grows with every minute. In your own worktree it is safe indefinitely.

6. **Numbers are claimed, not discovered.** Migration numbers and the failure-mode list in 5.3
   are both sequential, and two agents appending at once produce a duplicate rather than a
   conflict - which nothing will catch. Say which number you are taking before you take it, and
   re-read the highest one immediately before you write. `0031` was claimed by one agent while
   another was checking for exactly that.

7. **Pushing:** `git fetch origin && git merge --ff-only origin/main` from a shared tree, or a
   rebase from your own worktree where nobody else's work is at risk. If either refuses, stop and
   report it. Never force, and never rebase or amend a commit that has been pushed.

8. **A syntax error in a shared file takes down somebody else's server.** Everything runs under
   `node --watch`, so a half-saved file restarts the founder's API into a crash - a stray backtick
   inside a `sql` template did exactly that on 2026-08-15. Metro is the same hazard pointed at the
   phone: an unfinished save is a red screen in his hand. Write imports before usage, and prefer
   one whole-file write to a sequence of partial ones.

9. **A builder never drives its own verification.** The agent that just wrote a feature is carrying
   the whole transcript that produced it, routinely 150k to 200k tokens. Verification is the
   opposite shape of work: many turns of watching a run, answering a prompt, and applying a small
   fix. Every one of those turns resends the builder's entire context, so a park, decide and resume
   roundtrip costs around 30k tokens driven by a fresh agent against around 200k driven by the
   builder. The context that made the code good is worth nothing to the check that follows it.

   So split the two:

   - **The builder builds, commits on its branch, and ends its task with a `HANDOFF: INTENT`
     paragraph**: what changed, why, and what a reviewer should look hardest at. That transcript is
     then read once and never resumed to drive a check.
   - **A fresh, small driver agent per worktree runs the verification**, starting from that
     paragraph alone. Here that means section 2.3 in order - type check, full suite, live smoke
     test - plus `npm run gate:surface` where routes changed. `gate:surface` needs a running API,
     so a driver that needs it obeys item 2 above before touching any stack.
   - **The driver's standing rules:** apply anything mechanically fixable, accept anything
     informational, and PARK anything that needs a human judgement - quote the finding verbatim,
     end the task, and let the orchestrator carry it to the founder, then resume the driver with
     his answer. Resume the BUILDER only when a finding needs real code written; that is the one
     thing its context is still worth paying for.
   - **Never end a subagent's turn while a run it started is still going.** Its background
     processes are orphaned the moment the turn ends, and a half-finished verification reports
     nothing while looking exactly like one that passed.

---

## 3. Documentation contract

| Document | Answers | Must not contain |
|---|---|---|
| [`SPEC/PRD/`](SPEC/PRD/) | What the product does and why | File paths, schema, component names |
| [`SPEC/TECH/`](SPEC/TECH/) | How it is built, and what must not break | Product justification (link to the PRD instead) |
| [`SPEC/DESIGN/`](SPEC/DESIGN/) | What a surface looks like, and why | Any measurement the code owns - record the **relationship**, not the value |
| [`SPEC/decisions/`](SPEC/decisions/) | Why we chose this over the alternative | Implementation detail that will drift |
| [`HISTORY.md`](HISTORY.md) | How we got here, bug by bug | Anything needed to work today |
| `AGENTS.md` (this file) | How to work | Anything specific to one feature |

**A design spec is per *surface*, not per screen** - a reusable piece of interface with its own
identity, wherever it appears. Its rules are numbered so they can be cited. And an obligation it
creates for unrelated code (a floating bar obliging every scrolling screen to reserve clearance) is
**promoted into the relevant `TECH/` doc or an ADR**, because a per-surface file is exactly where
somebody building an unrelated screen will never look. See [`SPEC/DESIGN/README.md`](SPEC/DESIGN/README.md).

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

# What the DATABASE thinks it spent its time on, across the api, the worker and the gateway at
# once, with no application instrumentation. The per-request counter on /dev/trace answers "what
# did THIS request cost"; this answers "what is this database spending its life on". Needs the
# extension preloaded, which is a server flag - so a container started before 2026-08-21 records
# nothing, and `npm run db:down && npm run db:up` fixes it WITHOUT losing data (the volume
# survives; only db:nuke destroys it).
npm run db:stats                 # top 20 by total time, and top 20 by call count
npm run db:stats:reset           # start a clean recording before driving the app

# The load test, at ten times projected peak. Starts its own Postgres and takes nothing
# shared, so it never competes with the dev database or the phone. Minutes, and its output
# is numbers rather than a verdict - which is why it is not a test. See SPEC/TECH/18 section 7
# for what it has measured and what is still a laptop.
npm run load:test

# The Phase 3.75a exit gate: every route against a RUNNING server, in both directions.
# Needs dev:api up. Deliberately not a test - see the header of the script for why.
npm run gate:surface
API=http://127.0.0.1:3100 npm run gate:surface

npm run dev:api              # API on :3000
npm run dev:gateway          # WebSocket gateway on :3001
npm run dev:worker           # outbox drain
npm run dev:mobile           # Expo client

# The wire: one page showing every REST call, every socket frame in both directions, and
# every outbox effect the worker ran, joined across all three processes. Needs no flag - it
# mounts itself whenever NODE_ENV is not production. DEV_TRACE=off switches it off.
open http://localhost:3000/dev/trace

# Every event is ALSO appended to .dev-trace/trace.jsonl, which is what makes a session
# longer than the page's 200-event buffer analysable afterwards. It appends across restarts
# on purpose, so delete the file to start a fresh recording. DEV_TRACE_FILE=off, or any path.
rm -f .dev-trace/trace.jsonl                    # start a clean session
curl -s localhost:3000/dev/trace/recording      # is it still recording, and how much

# Read one back. Every line is one whole event, so ordinary line tools work.
jq -r 'select(.kind=="http") | "\(.method) \(.route) \(.status) \(.ms)ms"' .dev-trace/trace.jsonl \
  | sort | uniq -c | sort -rn | head -20        # what got asked, most-asked first

# A worktree, branch, install and free port triple for one agent, so several can work at
# once without sharing a directory. See section 2.5 for why that is the whole game.
./scripts/agent-worktree.sh moderation

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
| `TODO.md` | **The working backlog.** What to fix next, and what is known broken. Read it before
picking work; delete an item when it is done rather than ticking it. Durable decisions graduate
into `SPEC/PRD/17` and `SPEC/TECH/14` - this file is meant to shrink |
| `SPEC/README.md` | Index of everything below. Start here. |
| `SPEC/PRD/` | Product requirements, one file per feature area |
| `SPEC/TECH/` | Technical spec, one file per subsystem |
| `SPEC/DESIGN/` | Design spec, one file per **surface** (tab bar, message bubble, chat row) |
| `SPEC/decisions/` | Accepted ADRs. Immutable; supersede rather than edit |
| `SPEC/templates/` | Feature spec, design spec, authorization / migration / design-review checklists, ADR |
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
| `apps/mobile/modules/` | Local native modules, one directory each, found through `expo.autolinking.nativeModulesDir` in the app's `package.json` - autolinking has no default for that key. **Anything here is newer than some installed binary**, so it is reached with `requireOptionalNativeModule` and always has a path that works without it. See failure mode 37 |
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

22. **A file watcher runs a half-finished edit, so the order of two edits to one file is a runtime
    decision.** Symptom: `ReferenceError: parseModeratorList is not defined` in the API log, from
    code that was correct thirty seconds later. Root cause: the call site was added in one edit and
    its `import` in the next, and `node --watch` restarted the process in between - so a state that
    existed only between two saves actually executed. **Rule: within one file, add the import
    before the usage; across several, write the whole file at once.** This is the known live-reload
    hazard for the Expo client - a half-saved screen is a red screen on the founder's phone - and
    the point of this entry is that it applies identically to the three `--watch` server processes,
    where the evidence is one line in a log nobody is tailing rather than something visible in your
    hand. Note also what `--watch` covers: it restarts on a change to `--env-file` too, which is how
    appending to `.env` reconfigured a running API with no explicit restart - convenient, and the
    reason a "nothing changed" reconcile log can be telling the truth about a database an earlier
    process already changed.

23. **One apostrophe in an SVG attribute makes the whole image un-exportable, and the failure is a
    button that never comes back.** Symptom: Save on the QR screen sat on "Saving" forever, with no
    error anywhere. Root cause: rasterising goes through `data:image/svg+xml`, and
    `react-native-svg`'s `encodeSvg` **replaces every double quote with a single quote** to build
    that URL - so `accessibilityLabel="...this club's join link"` closed its own attribute early,
    the SVG failed to parse, and `img.onerror` fired where the only handler is `onload`. The
    callback simply never ran. **Rules: no apostrophe in any attribute of an SVG that will be
    exported, and never interpolate user data (a club name, a person's name) into one.** Anything
    that has to say a name belongs to the screen drawing around the code, not inside it. Second
    rule, general: **a callback-based API with silent failure paths gets a timeout**, or one
    unhandled case disables a control until the screen is closed. How to recognise the class: the
    thing renders perfectly on screen and only the *export* is broken, so every visual check
    passes. Worth recording that the first diagnosis was wrong - a remote `<image href>` was
    blamed, inlined as a data URI, and the hang survived it, which is what forced the search into
    the serialised string where the apostrophe was. The inlining stands on its own (an export
    should not race a fetch) but it fixed nothing here, and calling it the cause before re-running
    the failure would have left the real one in place.

24. **React Native re-encodes a URL you hand `fetch`, so a pre-encoded one arrives double-encoded -
    and a server that SKIPS what it cannot parse answers `200` forever.** Symptom: none, for
    months. `GET /sync` from the iPhone returned `200` with an empty channel list every single
    time; 609 requests reconciled nothing. Realtime hid it, so the phone stayed current and only a
    message missed while the socket was down was lost - permanently, below the high-water mark.
    Root cause: the client wrote `encodeURIComponent('<uuid>:92')`, iOS encoded the query string
    again, and `%3A` became `%253A`; the route decoded once, found no colon, and `continue`d past
    the entry. **Rules: never hand `fetch` a URL you have already encoded** - a uuid and an integer
    need no escaping, and whatever the platform escapes the server decodes - **and never skip a
    malformed request element, refuse it.** The skip is what made this survivable for months: it is
    indistinguishable from the deliberate omission of a channel the caller may not read. How to
    recognise the class: it cannot be reproduced on web (the browser leaves `%3A` alone) and no
    unit test can see it, because the re-encoding happens below `fetch`. It was found by reading
    the API's own access log and noticing that the phone's URLs and the browser's were different
    strings for the same call - and before that, by a gap repair that ran on every sync forever,
    because the one call that could fill the hole was the one being dropped.

    **A repair that repeats is the tell, and now it says so**: `repairGaps` compares the hole
    before and after writing its page and logs when nothing changed. An operation that silently
    achieves nothing is worse than one that fails.

25. **Normalizing text before a boundary match can destroy the boundaries the match depends on,
    and it fails silently in the direction that matters.** Caught while building the content
    filter on 2026-08-12, before it shipped. The matcher folded leetspeak before testing terms
    at word boundaries, and the fold mapped `!` to `i` - so `you faggot!` normalized to
    `you faggoti`, `\bfaggot\b` no longer matched, and **the clearest possible slur passed the
    filter**. The same held for `@` and `$` at the end of a word. **Rule: a substitution that
    turns a non-word character into a word character must never run before a `\b` match.** A
    digit is safe because a digit is already a word character; punctuation is not. The fix is two
    normalizers rather than a cleverer one: the boundary pass folds digits only, and the
    collapsed pass - which has already thrown its boundaries away - folds everything.

    Two more from the same afternoon, both the same shape of thinking. **A term list matched
    after collapsing text to letters starts matching across word boundaries**, so `hello liam`
    contains `loli` and `is she male` contains `shemale`; the collapsed pass therefore has to be
    opt-in per term, with an innocent-word corpus in the tests proving it rather than a judgement
    in a comment. And **the obvious way to catch `niiiigger` is worse than the miss**: squeezing
    repeated letters hard enough to catch it also collapses `Nigeria` and the country `Niger`
    onto the slur, refusing a member for naming where they are from. Some evasion is correctly
    left uncaught.

    How to recognise the class: a pipeline where one stage rewrites the input another stage's
    correctness depends on. Note it is the inverse of failure mode 9's shape - not a rule copied
    and drifted, but a rule that reads correctly at both ends while the data between them changed
    underneath. Only a test with the punctuation actually attached finds it.

26. **A declaration and its first use go in ONE write, not two.** Failure mode 22 restated, because
    the rule as written there did not cover the case that then happened twice in one afternoon on
    2026-08-12 - both times on the founder's phone, both times minutes after the correct ordering
    had been stated in the same conversation. `ReferenceError: Property 'flat' doesn't exist`, then
    `ReferenceError: Property 'subjectPicture' doesn't exist`; each a red screen in somebody's hand
    for the seconds between two saves. 22 says "within one file, add the import before the usage",
    which is true and is about **imports**: a `const` declared lower in the same file is not one,
    and writing the call site first leaves a state where the name genuinely does not exist.
    **How to recognise the class:** you are about to save a file mentioning a name you intend to
    define in the next edit. Ask whether the file runs *as saved*; if not, it is one write. Note
    that typecheck cannot see this - each individual state is a type error at worst, and the thing
    that actually breaks is a runtime lookup in a process that reloaded in between.

    **Two more on 2026-08-13, both while the rule above was being written**, which is the reason
    this now names the two directions rather than the one case. `ReferenceError: authorName is not
    defined` came from deleting a prop from a signature while a use of it remained lower in the
    file; `ReferenceError: PHOTO_LONG_EDGE is not defined` came from extracting a constant and
    placing it *after* the `StyleSheet.create` that reads it - which runs at module load, so the
    whole screen died rather than one component.

    **The rule, stated as an ordering rather than as a count:**

    | Doing this | Do it in this order |
    |---|---|
    | Adding a name | Declare it, then use it |
    | Removing a name | Remove every use, then remove the declaration |
    | Extracting a constant | Above everything that reads it, module-scope `StyleSheet.create` included |

    Each of those keeps the file runnable at every save, which is what "one write" was really
    asking for. And note which failure is worse: a bad ordering inside a function is a broken
    component, while a bad ordering at module scope is a red screen over the entire app.

28. **A prop that exists on only one platform makes a smoke test on the other platform evidence of
    nothing - including evidence that the prop did no harm.** Symptom:
    `maintainVisibleContentPosition` was added to the chat list to stop it lurching while cards
    and photos settled, verified in a browser, and broke tap-a-reply-to-reach-the-original on the
    device that same afternoon. Root cause: **react-native-web does not implement the prop at
    all.** So the browser could not show the fix working, and could not show the regression
    either - it was a no-op there in both directions, and the check that "nothing else broke" was
    reading a page where the change had not happened. On the device it is real, and it fights
    `scrollToIndex`: the jump lands, the cells around the target settle, and the anchor
    compensates the offset straight back.

    **Rule: before smoke testing a platform-specific prop, confirm the platform you are testing on
    implements it** - `grep` the web runtime for the prop name, which takes one command and either
    validates the test or explains why it cannot exist. Where only one platform implements it, the
    verification has to happen there, and if that is not possible, say so rather than reporting a
    green check that was measuring nothing.

    How to recognise the class: the change is a single prop on a cross-platform component, the
    prop's documentation mentions iOS or Android specifically, and the verification plan is "open
    it in the browser". Compare failure mode 27, which is also a device-only truth - the pattern
    across both is that **web is where this project's fastest feedback lives, and it is exactly
    where a native-only behaviour is invisible.**

27. **A child that handles a press becomes the responder, so a gesture aimed at its ancestor never
    arrives.** Symptom: holding an event card in chat did nothing, on the device, for the entire
    life of the card - reported by the founder on 2026-08-13 with "i couldnt long press the
    event". Root cause: the chat row wraps every card in a `Pressable` to catch the react-and-
    report hold, and that works for a poll card, which is a plain `View` with non-pressable space
    to grab. The event and meeting cards **are** pressables, so on native they take the touch
    responder and the wrapper's `onLongPress` is unreachable everywhere on the card. **Rule: the
    element that owns the tap must own the hold** - pass the handler down to it rather than
    wrapping it in an ancestor that will never see the gesture.

    How to recognise the class, and why it is not entry 17: nothing is nested illegally, nothing
    throws, no warning appears, and the web console is clean because web deliberately does not
    attach the gesture at all. 17 is about a nesting that is *invalid*; this is a nesting that is
    perfectly valid and merely silent. The tell is a gesture handler on a parent whose child has
    any press handler of its own, and the only way to see it is to make the gesture on a device -
    which is why "verify on each platform separately" is section 2.3 rule 6 rather than advice.

29. **iOS presents ONE `Modal` per view controller and refuses the second in silence, so a second
    modal opened from inside a modal does not exist.** Symptom, reported from the phone on
    2026-08-14: a member card whose "..." opened nothing, whose shared-club faces opened nothing,
    and whose only working control was the one that navigated instead of opening something -
    "pretty much not working". Root cause: the menu, the confirmation and the clubs list were
    each a `<Modal>` rendered as a **sibling** of the card's own `<Modal>`. Nothing throws,
    nothing logs, and the state that says the menu is open is perfectly correct.

    **Rule: an overlay raised from inside a modal must be part of that modal, not a new one.**
    `RisingSheet` takes an `overlay` prop for exactly this, and `ContextMenu` and `ConfirmDialog`
    take `hosted`, which swaps their own `Modal` wrapper for an absolute-fill view. Window
    coordinates still line up, because the host modal fills the screen - which is the reason
    `ContextMenu` reached for a modal in the first place, and worth reading its note before
    "simplifying" either.

    **How to recognise the class, and why web is the trap here.** react-native-web renders a
    `Modal` as a plain positioned element and stacks them happily, so every one of these worked
    in a browser and the whole feature looked finished. This is failure mode 28's shape again -
    web is where this project's fastest feedback lives and exactly where a native-only rule is
    invisible - with the twist that here web showed a *working* control rather than a no-op.
    **The iOS Simulator is enough to catch it**: it is the same UIKit, it takes a deep link
    (`clubchat://clubs/<id>/members`), and `cliclick` drives it, but note that clicks only land
    when the Simulator is the frontmost app.

31. **Two statements that must always happen together will eventually be one statement, and the
    half that is missing is the half nobody can see.** Symptom: none, for the life of the project.
    Fourteen call sites wrote a notification row and scheduled no push, so every join request,
    every decision on one, every add, removal and role change filled the inbox and the badge and
    rang nothing - and `PRD/12` rule 4 exists precisely because the founder had lost real join
    requests. Found only by auditing `dispatchPush` call sites against `writeNotifications` call
    sites while answering the question "is push actually finished?".

    **Rule: when an effect must always accompany another, express the pair as one function, not as
    a convention.** `notifyAndPush` writes the rows and schedules the push, and the exceptions
    hand-roll it and say why. How to recognise the class, and why it is worse than a wrong line of
    code: **the code that is present is entirely correct.** `writeNotifications(...)` is a
    complete, well-formed, satisfying call; there is no error to raise, no case to be missing and
    no test to fail, because what is absent was never written down anywhere. Compare entry 19 - a
    rule asserted in three documents and implemented in none - which is the same blindness from
    the other end: there the claim existed without the code, here the code existed without half
    of its job. Both are invisible to any audit that reads what is there rather than asking what
    should be beside it.

    A second, cheaper tell showed up in the same change: **a test fixture that stops being inert.**
    The DM tests built their club with `addMember`, which had always been silent; the moment it
    pushed, the fixture's own notifications landed on a phone registered later and were counted
    against the message under test. A fixture is not neutral - it is a sequence of real commands,
    and it has to settle its own effects before anything asserts on a recorder.

30. **On the way out, the scrim must never lift before the panel it belongs to has gone.** Same
    report, same afternoon: "you can see the glitch there, whenever I click it just stucks in
    between". `RisingSheet`'s exit faded the shade over 140ms on a quadratic and moved the panel
    over 160ms on a **cubic** - and `Easing.in(Easing.cubic)` barely moves for its first half, so
    a third of the way through the exit the panel had travelled a quarter of its distance with
    the dimming already gone. What that looks like is a card frozen halfway up an ordinary list.
    **Rule: the shade is the last thing on screen** - give it the longer duration and the steeper
    curve, and give the panel the gentler one. The entrance is deliberately the other way round.
    How to recognise the class: two animations of the same gesture with different durations AND
    different easings, where only the pairing at the endpoints was ever checked.

32. **Installing a native dependency commits every already-running build to a rebuild, and the
    death is at launch where no `try` can reach it.** Symptom, twice in one afternoon while
    cropping was being built against `expo-image-manipulator`: first every phone on the LAN broke
    the moment Metro served the new JS, because a native import resolves at bundle load and the
    binaries carrying the module were minutes or hours behind; then, once rebuilt, the app died on
    startup with a `Symbol not found`, because the prebuilt framework targeted a newer
    `ExpoModulesCore` than this app ships. Reinstalling cannot fix either. **Rule: adding a native
    module is a rebuild-and-reinstall for every device already running, and it must be said out
    loud before the import is written** - the JS reaching a phone ahead of its binary is not a
    mistake anybody makes, it is the default. How to recognise the class: the package installs, the
    import resolves, typecheck is clean, and the app will not start. **Read the crash report first
    for a launch-time death** - it names the missing symbol, which is the whole diagnosis, and no
    amount of reading the JS will produce it. Entry 8 is the same shape one layer up: a resolution
    failure that our own code never gets to see. The escape used here was to stop needing the
    module - the phone chooses the rectangle and the server, which decodes every upload anyway,
    cuts it.

33. **A touch target outside its parent's bounds is not hit-tested, so a control can be half dead
    while looking entirely correct.** Symptom: the crop frame cut exactly the right pixels and was
    still reported as "so hard... it just runs or adjusts weird". Three causes, none in the
    arithmetic that decides the rectangle. Its four corner handles were **children of the frame**
    hung half outside it on negative offsets, so half of every target was never delivered a touch
    and what remained was a 22-point square on the corner - worst at the frame the crop opens with,
    the whole picture, where all four corners sit against an edge. The resize then **refused the
    entire drag** whenever either side reached the minimum, which stops the frame dead under a
    moving finger, and a corner dragged past its opposite was normalised with `Math.abs`, which
    inverts the rectangle and throws it across the picture. And every frame of the drag re-rendered
    the whole screen, because the live rectangle was the parent's state.

    **Rule: a hit target belongs to the layer that can contain it, not to the thing it decorates**
    - the grips are siblings of the frame, positioned in the picture's coordinates and pushed
    inside it rather than trimmed at it. **A constraint clamps per axis; it never refuses the
    gesture**, because a control that stops responding reads as broken rather than as strict. How
    to recognise the class, and why it survived a review and a device test: **every symptom is
    "feels wrong" and every unit of code is correct.** The rectangle was right, the conversions
    were tested, and the screenshot of a finished crop is indistinguishable from one made easily.
    Nothing was asserting on where a handle could be touched, so nothing could fail. The fix put
    the drag arithmetic and the grip layout into `crop-rect.ts` beside the conversions, where both
    are now properties a test states out loud.

34. **`requestTimeout` on an AWS SDK client aborts nothing. It logs a warning and lets the request
    hang.** Symptom: the outbox drain awaits object storage from inside the transaction that claimed
    its rows, so a store that accepts a connection and then never answers freezes every partition's
    effects behind it - and the obvious fix, `requestTimeout` on the `S3Client`'s `requestHandler`,
    typechecks, reads correctly in review, and leaves that defect fully intact. Root cause: the
    timer fires and then asks a *second* flag what to do with it.
    `node_modules/@smithy/node-http-handler/dist-cjs/index.js` line 83 builds its message as
    `[${throwOnRequestTimeout ? "ERROR" : "WARN"}]`, and when the flag is absent it appends the
    literal `Init client requestHandler with throwOnRequestTimeout=true to turn this into an error.`
    and hands the string to `logger.warn`. The request itself is never touched. **Rule:
    `requestTimeout` is inert without `throwOnRequestTimeout: true`, and the two are one setting.**

    **A second ceiling in the same object, covering the half the first one cannot.**
    `requestTimeout` stops counting the moment response HEADERS arrive, so a store that answers and
    then stalls mid-body streams unbounded under a timeout that has already been cleared.
    `socketTimeout` is what bounds that, **and it must stay under 6000 ms**: below that the handler
    registers the socket's `timeout` listener immediately, at or above it the registration is itself
    deferred behind a 3000 ms timer - which the arriving response cancels along with every other
    pending timer, so the listener meant to catch the stalled body is never installed at all. A
    number picked for comfort ("thirty seconds seems safe") silently buys no protection whatsoever.

    How to recognise the class: **an SDK option named for a behaviour it does not perform on its
    own.** Nothing in the type, the name, or the review makes the omission visible, and the only
    artefact that does is the vendor's own shipped source - which is non-negotiable 1 read one level
    lower than usual: for a dependency this size `node_modules` IS the pinned documentation, and
    reading the fifteen lines that implement the option is cheaper than trusting its name. Compare
    entry 12, where a check against a field the library does not return reads `undefined` forever.
    Both are code that runs, can never fire, and looks correct to everybody. Found on 2026-08-20
    while giving the media store the timeout it had never had.

35. **A connection that dies while no statement is running takes the process down, and the ceiling
    added to prevent a freeze is what makes that routine rather than rare.** Symptom:
    `pool-timeouts.test.ts` reporting four passing assertions and two exceptions escaping the file,
    which is precisely the shape of a fix that looks finished. Root cause: adding
    `idle_in_transaction_session_timeout` as a pool startup parameter means Postgres terminates the
    backend and sends `FATAL 25P03` **while nothing is in flight for it to reject** - and `pg`
    routes an error with no active query to `client.emit('error')`. `pg-pool` attaches its own
    listener to a client while it is IDLE and removes it again on checkout, so a client held open
    inside a transaction, which is exactly the client this timeout exists to kill, has none. An
    `EventEmitter` emitting `error` unheard throws, and the API installs no `uncaughtException`
    handler. The socket close that follows arrives the same way, as a second
    `Connection terminated unexpectedly`. **Rule: `createPool` listens for `error` on the pool AND
    on every client it hands out.** Without both, the timeout trades a silent freeze for a crash
    loop, which is the worse of the two.

    **Those two listeners are not a swallow, and saying so is what stops a later reader deleting
    them.** The authoritative report of the fault still reaches the caller by the ordinary path: the
    drain's next statement rejects, `db.transaction` rolls back, the claimed rows are released, and
    the outbox retries them on its own schedule. What the listeners absorb is the *duplicate*
    notification, which has no caller to reach and no effect except ending the process, and it is
    logged rather than discarded so that "the database dropped our connection" is never invisible.

    How to recognise the class: **a fault you deliberately introduced arrives by a delivery path the
    ordinary faults never use.** Every error this codebase handles comes back as a rejected query,
    so every handler is written for one; a backend terminated between statements has no query to
    reject and reaches an emitter instead. Found on 2026-08-20 in the same change as entry 34, and
    the general form belongs with it: adding a timeout is adding a new failure, and the new failure
    needs its own path traced before the timeout can be called a fix.

36. **A uuid has two spellings, so a `Map` keyed by one of them silently drops the other - and
    Postgres hides it, because SQL matched.** Symptom: none, for the life of `/polls` and
    `/media/urls`. Every batch read fetches its rows in one statement, builds a `Map` keyed by
    `row.id`, then walks the caller's own id list looking each one up. Postgres compares
    `id = 'D7E3...'` as a **uuid** and matches happily, then returns the row with its id rendered
    **lower case** - so the row was fetched, authorized, and then dropped on the floor by a JS
    string comparison. `isUuid` carries `/i` and `z.string().uuid()` accepts either case, so
    nothing upstream refuses one. **Rule: canonicalize a uuid at the boundary it enters, not at
    the place it is compared** - `parseIdList` lower cases every batch id, and the uuid hook in
    `app.ts` lower cases every route param after validating it.

    **The cost was never only the missing row.** `AccessContext` keys `clearedFloors`,
    `channelRoles` and the rest the same way, so an upper case channel id read a cleared channel's
    floor as **zero** and handed back messages the member had cleared. That is a privacy answer
    decided by the case of a string.

    How to recognise the class: **a value with more than one valid representation used as a hash
    key.** SQL comparison and JS comparison disagree about equality, and the layer that disagrees
    is invisible from either side - the query is right, the predicate is right, the answer is
    short. The tell is `new Map()` built from database rows and probed with something a caller
    supplied. Note the shape it shares with entry 1 and entry 12: a comparison that silently never
    matches, producing a `200` with less in it rather than an error. Found on 2026-08-21 by an
    adversarial review of a batching change that would have extended the same bug to `/events` and
    to the gateway's `subscribe` frame - where no HTTP hook could have caught it, and the symptom
    would have been a member's chat quietly ceasing to be live.

37. **A managed platform can DISCARD a connection parameter rather than reject it, and a test that
    asks for a value the server also defaults to will pass without ever sending anything.**
    Symptom: none, anywhere, for the life of the project. `createPool` set `statement_timeout` and
    `idle_in_transaction_session_timeout`, `pool-timeouts.test.ts` asserted the session reported
    `30s` and `2min`, and it did - against the development container. Root cause: on Neon's
    **direct** endpoint (not the pooled one, which at least errors) `pg`'s individual startup
    parameters are silently dropped, and the first real connection reported `0` and `5min`,
    Postgres's default and Neon's compute default. Every ceiling the module exists to impose was
    going to be absent in production, and `statement_timeout = 0` means a runaway query holds a
    connection until the process restarts. **Rule: ask the SERVER what it is running with, over
    the real connection string, before trusting that a connection-level setting arrived.** `SHOW
    <setting>` against production infrastructure is a different question from any test against a
    local container, and it is the only one that counts.

    **The second half is the more general lesson, and it is about the test rather than the
    platform.** The same file's opt-out test passed `0` and asserted `0`, with a comment claiming
    to prove "the escape hatch actually disables them". Postgres defaults both settings to `0`, so
    asking for zero and sending nothing are indistinguishable there - and `pg` was in fact sending
    nothing, because it writes the parameter behind `if (params.statement_timeout)` and `0` is
    falsy. That assertion could never fail. **Rule: an assertion whose expected value equals the
    system's default proves nothing, and instruction 11's "watch it fail" is what catches it.**
    How to recognise the class: the test asserts an absence, a zero, an empty list or a default,
    and the code path that would produce it anyway has never been disabled to check. Found on
    2026-08-21 on the first ever connection to production infrastructure, which is exactly the
    event `SPEC/TECH/21` exists to make routine.
