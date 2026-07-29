# AGENTS.md - working agreement

How any agent (or human) should work in this repo. Read this first, then the product doc and
the architecture doc.

Sections 0 through 4 are general engineering discipline and apply to every task, always,
without being restated. Section 5 is the repo-specific part and must be filled in as the
project takes shape.

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

1. **Read the product doc** for the intended behaviour, then **the architecture doc** for how
   that area is built. Behaviour questions are answered by the first; structural questions by
   the second.
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
5. **Branch and review policy:** _fill this in for the project (solo direct-to-main, or
   branch-and-PR)._

---

## 3. Documentation contract

| Document | Answers | Must not contain |
|---|---|---|
| [`SPEC/PRD/`](SPEC/PRD/) | What the product does and why | File paths, schema, component names |
| [`SPEC/TECH/`](SPEC/TECH/) | How it is built, and what must not break | Product justification (link to the PRD instead) |
| [`SPEC/decisions/`](SPEC/decisions/) | Why we chose this over the alternative | Implementation detail that will drift |
| History | How we got here, bug by bug | Anything needed to work today |
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
# install
# dev server
# type check
# test
# database up / migrate

# re-export the system overview image from SPEC/TECH/17-diagrams.md.
# Run in the same change as any edit to that file's first diagram, or the
# checked-in image silently drifts from its source.
./scripts/render-diagrams.sh
```

### 5.2 Repo map

| Path | What it is |
|---|---|
| `SPEC/README.md` | Index of everything below. Start here. |
| `SPEC/PRD/` | Product requirements, one file per feature area |
| `SPEC/TECH/` | Technical spec, one file per subsystem |
| `SPEC/decisions/` | Accepted ADRs. Immutable; supersede rather than edit |
| `SPEC/templates/` | Feature spec, authorization checklist, migration checklist, ADR |
| `SPEC/TECH/assets/` | Generated diagram exports. Do not hand-edit; see `scripts/` |
| `scripts/render-diagrams.sh` | Re-exports the system overview from `SPEC/TECH/17-diagrams.md` |

### 5.3 Failure modes specific to this codebase

_Add an entry every time a bug costs more than an hour. Include the symptom, the root cause,
and the rule that prevents it. An entry that only records the fix is worth half as much as one
that records how to recognise the class._
