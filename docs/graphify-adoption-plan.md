# Adopting graphify in ClubChat-Remastered

**Status: proposal, nothing installed.** Written 2026-09-08 against commit `a4b2b20` on `main`,
in the founder's tree at `/Users/parksrpk/Developer/ClubChat-Remastered`. Nothing in this document
has been run. Every number below came from reading the repo; every claim about how graphify itself
behaves came from the briefing that commissioned this plan, not from executing it.

**Where this file lives, and why here.** This repo has no planning-doc home. The documentation
contract in [`AGENTS.md`](../AGENTS.md) section 3 assigns every document a job: `SPEC/PRD/` is what
the product does, `SPEC/TECH/` is how it is built, `SPEC/decisions/` is why one option beat
another, `TODO.md` is what is broken, `SPEC/TECH/20` is the roadmap. A tooling proposal that has
not been approved fits none of them, and putting it in `SPEC/` would dress an unapproved idea as
settled truth. `docs/` sits outside the spec tree already (it holds the legal pages), so it cannot
be mistaken for either kind of truth. **If this is approved, the durable home is different:** an
ADR in `SPEC/decisions/` recording the choice and the rejected alternatives, plus a short block in
`AGENTS.md` section 5. This file is then deletable.

---

## 1. Findings

### 1.1 Languages and size

Tracked files: **667**. Everything below counts tracked files only, since `git ls-files` is also
what this repo's own em dash gate walks.

| Extension | Files | Lines | Notes |
|---|---|---|---|
| `.ts` | 269 | see below | server, shared, client-core, both Workers, mobile logic |
| `.tsx` | 81 | see below | mobile screens and UI |
| `.mjs` | 13 | 2,179 (with `scripts/*.ts`) | build and drill scripts |
| `.js` | 1 | small | `apps/mobile/metro.config.js` |
| `.sql` | 45 | 6,270 | 42 Drizzle migrations plus a constraint proof and a seed |
| `.md` | 136 | 34,570 | `SPEC/` (116 files), `bugs/` (13), and the root documents |
| `.json` | 61 | mostly generated | 42 are Drizzle migration snapshots, 175,315 lines, 4.5 MB |
| `.swift` | 1 | small | `apps/mobile/modules/quick-look/ios/QuickLookModule.swift` |
| `.jpg` / `.png` / `.svg` | 39 | binary | screenshots, app icons, one exported diagram |
| `.toml` | 3 | small | `fly/api.toml`, `fly/gateway.toml`, `fly/worker.toml` |
| `.jsonc` | 2 | small | the two `wrangler.jsonc` Worker configs |
| `.sh` | 5 | small | `scripts/` and `scripts/drills/` |
| `.html` | 1 | - | `packages/server/src/dev/dashboard.html` |
| `.podspec` | 1 | - | Ruby, for the local Expo module |

Executable source, by area:

- `packages/` - **214 files, 79,138 lines** of TS/TSX/JS/MJS
- `apps/` - **137 files, 46,578 lines**
- `scripts/` - **13 files, 2,179 lines**
- Total: **364 files, roughly 128,000 lines** of code graphify would parse for free.

TypeScript and TSX are core tree-sitter coverage, so **the 128,000 lines that matter need no
optional extra and no API key.** The stragglers:

- **SQL (45 files)** needs the `sql` extra. See 2.1 for why I am not proposing it yet.
- **Swift (1 file)** is core coverage in tree-sitter's usual set, and it is one file either way.
- **TOML, JSONC, shell, HTML, Ruby podspec** are configuration and glue. Whether graphify parses
  them changes nothing about whether the graph is useful here.
- No Terraform, Pascal, OCaml, Common Lisp, Robot, DM, or Chinese-language source exists. **None of
  those extras apply.**

### 1.2 Repo shape

**A monorepo on npm workspaces**, declared in `package.json` as `packages/*` and `apps/*`. Node 24
is pinned by `engines`. Six workspaces:

| Workspace | Package name | What it is |
|---|---|---|
| `packages/server` | `@clubchat/server` | The API, gateway, worker, policy, domain, db. The bulk. |
| `packages/shared` | `@clubchat/shared` | Types and pure helpers shared by every side |
| `packages/client-core` | `@clubchat/client-core` | Chat client and socket handling |
| `packages/cdn-worker` | `@clubchat/cdn-worker` | Cloudflare Worker in front of private media |
| `packages/site-worker` | `@clubchat/site-worker` | Cloudflare Worker for the marketing site |
| `apps/mobile` | `@clubchat/mobile` | Expo iOS / Android / web app |

`packages/server/src` is subdivided by concern: `api/` (with `api/routes/`, 12 route modules),
`domain/` (27 modules), `policy/` (`context.ts`, `predicates.ts`, and their tests), `db/`,
`worker/`, `gateway/`, `bus/`, `media/`, `push/`, `dev/`, `drills/`, `test/`.

**Real source vs generated:**

- Generated and tracked: `packages/server/src/db/migrations/meta/*.json` (42 files, 175,315 lines,
  4.5 MB of Drizzle snapshots, each one restating the whole schema),
  `packages/shared/src/emoji-catalog.generated.ts` (253 KB but only 23 lines, so a handful of very
  long literal lines), `SPEC/TECH/assets/system-overview.png` and `.svg` (exported by
  `scripts/render-diagrams.sh`).
- Vendored: none in the tree. `node_modules/` is 1.6 GB and gitignored.
- Build output present on disk but untracked: `apps/mobile/ios/build` (3.2 GB, 25,754 files),
  `apps/mobile/ios/build-sim` (3.7 GB, 31,438 files), `apps/mobile/ios/Pods` (1.4 GB, 10,429
  files), `apps/mobile/dist` (33 MB), `apps/mobile/.expo` (12 MB).

**Worktrees: three, live right now.**

```
/Users/parksrpk/Developer/ClubChat-Remastered   a4b2b20 [main]
/Users/parksrpk/Developer/ClubChat-deploy       89e417c [deploy]
/Users/parksrpk/Developer/ClubChat-image-cache  4d7daf4 [image-cache]
```

`scripts/agent-worktree.sh` mints more on demand, one per task, each with its own branch, its own
`npm install` and its own port triple. This matters twice below: for `GRAPHIFY_OUT` (2.5) and for
the freshness mechanism (4).

**No submodules.** No `.gitmodules`.

### 1.3 What must be excluded

The worktree holds **149,211 files**. Only 667 are tracked. Almost all of the difference is native
build output and dependencies, and the root `.gitignore` already covers most of it.

`git check-ignore` says these are already ignored: `node_modules/`, `.playwright-mcp/`, `.expo/`,
`learnings/`, `.dev-trace/`, `.env*` (with `.env.example` allowed back), `.wrangler/`, `.dev.vars`,
`dist/`, `build/`, `coverage/`.

**The one that worries me is not in the root file.** `apps/mobile/ios` (8.3 GB across 67,621 files:
Pods, build, build-sim) is excluded by `apps/mobile/.gitignore` line 40 (`/ios`), a **nested**
gitignore. The briefing says graphify honours `.gitignore` and `.git/info/exclude`; it does not say
it walks nested gitignore files the way git does. I could not verify which is true without running
it. **If graphify only reads the root file, a first run crawls 8.3 GB of Xcode intermediates.** The
`.graphifyignore` in 2.4 states it explicitly so the answer stops mattering.

Also not covered by `.gitignore`, and worth naming:

- `packages/server/src/db/migrations/meta/` - tracked, generated, 4.5 MB, 175,315 lines. Should be
  excluded on value grounds, not size: 42 files that each restate the entire schema will produce 42
  near-identical clusters and bury `schema.ts`, which is the file anyone actually edits.
- `fig1.png` through `fig4.png` and `fixed.png` at the repo root - tracked debugging scratch images
  from August, not source.
- `HISTORY.md` - 634 KB, the largest text file in the repo, and narrative rather than structure.
- `.probe/` and `dist-debugid-probe/` - both empty, both untracked, both unignored. Harmless.

**No secrets would be indexed.** `.env`, `.env.bak` and `.env.lanbak` hold real values and are all
caught by the `.env*` rule that AGENTS.md non-negotiable 6 exists to enforce. `.env.example` is
tracked and deliberately allowed back, and its header states every value is a local development
placeholder; I read it and the values are `clubchat` / `dev-only-not-a-secret-regenerate-me` and
localhost URLs, which matches. A scan of every tracked file for live key shapes (`sk_live`,
`sk-ant-`, `AKIA…`, PEM private key headers) returned nothing. `.dev-trace/` does carry real
message bodies and real user ids, and it is gitignored; the `.graphifyignore` repeats it anyway.

### 1.4 Which assistants are in use

Only one, and this is unusually clean:

- `AGENTS.md` - present, **97,656 bytes, 1,319 lines**.
- `.claude/` - present, containing **only** `settings.local.json` (82 KB, gitignored).
- **No `CLAUDE.md`.** **No `.cursor/`. No `.mcp.json`. No `GEMINI.md`. No
  `.github/copilot-instructions.md`.**
- `.github/` contains only `workflows/ci.yml`.

So: **`--platform claude`, one platform, nothing else to merge.** And note the absence of
`CLAUDE.md` is deliberate, not an oversight (see 1.5).

### 1.5 Existing agent instructions, and where graphify would contradict them

I read `AGENTS.md` sections 0 through 3 in full. Four genuine conflicts, all fixable, one of them
important.

**(a) The block's "first run `graphify query`" outranks a rule that already claims first place.**
The always-on block graphify injects opens with *"For codebase questions, first run
`graphify query`"*. `AGENTS.md` section 2.1 opens with *"Read `SPEC/PRD/` for the intended
behaviour, then `SPEC/TECH/` for how that area is built"*, and section 2.2 says *"Find the closest
existing feature and mirror it."* Two documents both saying "first" is how an agent ends up
choosing whichever it read most recently. **Resolution: keep the spec first for behaviour questions
and give graphify the structural ones.** The rewritten block in section 5 does this explicitly.

**(b) Never use an em dash (U+2014).** Standing instruction 1, enforced by
`npm run lint:emdash`, which is a CI step on every push and pull request. I read
`scripts/check-emdash.mjs`: it walks `git ls-files`, skips binaries by git's own NUL heuristic, and
allows exactly one em dash each in `AGENTS.md` and in itself. **This is only a problem if
`graphify-out/` is ever committed.** While it is untracked the gate never sees it. It is one of the
three reasons `graphify-out/` belongs in `.gitignore` (2.6).

**(c) "Where a doc disagrees with the repo, the repo is right and the doc is the bug."** Section 3.
A generated `GRAPH_REPORT.md` or `wiki/index.md` is a document that disagrees with the repo the
moment anyone saves a file, and no one owns fixing it. **Resolution: do not export the wiki, do not
commit the report, and treat `graphify-out/` as a cache rather than a document.** This is also the
strongest single reason for `--code-only` (2.3).

**(d) `AGENTS.md` "must not contain anything specific to one feature."** Section 3's own table. A
tooling block is not a feature, so this is satisfied, but the block belongs in **section 5, project
specifics**, next to the `npm run` command list, not appended to the end of a file whose sections 0
through 4 are declared stack-agnostic.

Two more things that are not conflicts but shape the plan:

- **Non-negotiable 8 bans every whole-tree git command** (`git add -A`, `git stash`,
  `git reset --hard`, `git switch`, and the rest) because several agents share this directory.
  graphify does not run any of them; `graphify update .` reads the tree and writes only inside
  `graphify-out/`. No conflict, but it is why section 4 does not propose anything that touches the
  index.
- **"Commit only when asked"** (section 2.4). This is the single fact that decides the freshness
  mechanism, and it is the reason the obvious answer is the wrong one. See section 4.

### 1.6 Non-code corpus

Substantial, and unusually well maintained:

- `SPEC/PRD/` - 19 files, what the product does
- `SPEC/TECH/` - 24 files, how it is built
- `SPEC/DESIGN/` - 16 files, one per surface
- `SPEC/decisions/` - **49 ADRs**, numbered, with rejected alternatives recorded
- `SPEC/templates/` - 7 files
- `bugs/` - 13 incident write-ups, one per file, named `YYYY-MM-DD-slug.md`
- Root: `AGENTS.md` (1,319 lines), `HISTORY.md` (634 KB), `BUGS.md`, `TODO.md`, `README.md`
- `docs/legal/` - privacy policy and terms
- **No PDFs, no Office documents, no video.** 39 images, all screenshots and icons.

**This corpus is the argument against a semantic pass, not for one.** It already has a hand-written
index (`SPEC/README.md`) with a routing table, a documentation contract that says which file
answers which kind of question, and a rule that a stale doc is a bug to be fixed in the same
change. An LLM-generated wiki over the top of that is a third source of truth that nobody owns and
the contract forbids. The gap graphify fills here is not "find the right document" - that is
solved, and solved better by hand. It is "which 40 of the 364 source files does this change
touch", which is exactly what the free AST pass answers.

### 1.7 CI and hooks

**CI:** one workflow, `.github/workflows/ci.yml`, on push to `main`, on every pull request, and on
dispatch. Two jobs.

- `verify` (30 min budget): `npm ci`, then `npm run typecheck`, `npm run check:runtime`,
  `npm run lint:emdash`, `npm test`, then a `wrangler --dry-run` bundle of the CDN Worker.
- `gate` (20 min budget): `npm ci`, `cp .env.example .env`, `npm run db:up` (Postgres, Redis,
  MinIO), `npm run db:migrate` from zero, `npm run db:prove`, start the API, `npm run gate:surface`.

Its header comment says why it exists: on 2026-08-14 `npm run gate:surface` had been failing for a
fortnight because nothing ran it.

**Hooks: none.** `.git/hooks` contains only the stock `.sample` files. No `.husky/`, no
`.pre-commit-config.yaml`. **Nothing to collide with, and the graphify hook installer's
marker-and-backup behaviour is not needed here.**

**Where a graph refresh does not fit: CI.** The graph is consumed by agents on this machine. A CI
job would prove extraction does not crash and then throw the artifact away, at the cost of minutes
added to a suite that already runs for up to 30. See section 4.

### 1.8 Python and tooling availability

Verified on this machine:

| Tool | Result |
|---|---|
| `python3` | **3.14.6** |
| `uv` | **0.9.21** (Homebrew) |
| `uvx` | present at `/opt/homebrew/bin/uvx` |
| `pipx` | **not installed** |
| `node` | v25.9.0 (CI and `engines` pin 24) |

Two consequences.

1. **The `leiden` extra is unavailable.** It requires Python < 3.13 and the default interpreter here
   is 3.14.6. Default clustering it is. Do not attempt to install `leiden`; it is not a fallback,
   it is a dead end on this interpreter.
2. **Python 3.14 is new enough that binary wheels are a real risk.** graphify's tree-sitter grammar
   dependencies may not publish 3.14 wheels yet, in which case `uv tool install` falls back to
   compiling from source and either takes a long time or fails on a missing toolchain. The fallback
   is in step 1 of section 3: pin the tool's own interpreter with
   `uv tool install --python 3.12 graphifyy`. `uv` will fetch a 3.12 for the tool alone without
   touching the system Python, and as a side effect that would also make `leiden` installable if we
   ever wanted it.

### 1.9 Secrets and compliance

Short, because the recommendation makes it moot. Nothing here is regulated or third-party
confidential; it is a first-party product repo. But three things would be genuinely wrong to ship
to an LLM backend: `.dev-trace/` (session recordings carrying real message bodies and real user
ids), the `.env` family (live values), and `~/.clubchat-secrets/` (outside the repo, so not at
risk). All three are gitignored or out of tree.

**This is not what decides the recommendation.** `--code-only` is recommended in 2.3 because the
doc corpus is better served by its existing hand-written index, not because sending it anywhere
would be unsafe. The secrets position simply means that if we ever revisit that, the exclusions are
already in place.

---

## 2. Recommended configuration

**Verdict up front: adopt it, for the code graph only.** This repo is a 128,000-line TypeScript
monorepo with a 6,404-line chat screen, a policy module imported by 45 files, and a rule
(section 2.2 of AGENTS.md) that every predicate is defined once and reused, which is exactly the
kind of invariant a reverse-traversal query can police and grep cannot. That is real value, it
costs nothing to run, and it needs no API key. **Do not adopt it for the documentation.** The
`SPEC/` tree is hand-indexed, contract-bound and better than anything a generated wiki would
produce, and adding a second unowned index would break the rule that the repo is right and the doc
is the bug.

### 2.1 Install command

```bash
uv tool install graphifyy
```

**No extras.** Reasoning, one line each:

- **`sql`: no, for now.** 45 SQL files, but 42 of them are append-only Drizzle migrations that
  nobody edits (non-negotiable 2: a correction is always a new migration). The schema an agent
  actually reads and changes is `packages/server/src/db/schema.ts`, 2,212 lines of TypeScript,
  parsed for free. Revisit if a real query comes back short; it is one reinstall.
- **`mcp`: no.** See section 6.
- **`leiden`: cannot.** Python 3.14, see 1.8.
- **`pdf`, `office`, `google`, `video`: no.** There are none of those files.
- **`neo4j`, `falkordb`, `postgres`, `svg`: no.** No second graph store is wanted; `graph.json` is
  the consumer surface.
- **`terraform`, `pascal`, `ocaml`, `commonlisp`, `robot`, `dm`, `chinese`: no.** No such source.
- **`openai` / `anthropic` / `gemini` / `ollama` / `bedrock`: no.** No backend, because
  `--code-only`. See 2.3.
- **`all`: emphatically no.**

`pipx` is not installed and `uv` is, so `uv` is the path. If the install fails to build wheels on
Python 3.14, see the fallback in 1.8 and step 1 of section 3.

### 2.2 Install scoping and platform

```bash
graphify install --project --platform claude
```

**`--project`, not the user profile,** because this repo is worked by several agents at once, in
several worktrees (three exist today, and `scripts/agent-worktree.sh` makes more). A project
install writes `.claude/skills/graphify/SKILL.md` plus its `references/` sidecar into the repo,
where git carries it into every worktree and every agent gets the same copy. A profile install
would be one machine's private state that no worktree inherits and no commit records. Note that
`.gitignore` excludes only `.claude/settings.local.json`, not `.claude/`, so those skill files
become tracked files needing a commit; per AGENTS.md 2.4 that commit is asked for, not assumed.

**`--platform claude` alone,** because nothing else is in use: no `.cursor/`, no `.mcp.json`, no
`GEMINI.md`, no `.github/copilot-instructions.md` (1.4).

**Watch the injection step.** The installer injects a marker-delimited block into `CLAUDE.md` /
`AGENTS.md`. There is **no `CLAUDE.md` in this repo and that is deliberate** - `AGENTS.md` is 1,319
lines and is meant to be opened rather than auto-loaded. If the installer creates a `CLAUDE.md`, we
have accidentally introduced a second, auto-loading instructions file, which is precisely the
second-source-of-truth problem the documentation contract exists to prevent. **Step 3 of section 3
inspects the diff before anything is committed, and section 5 gives the block I would actually
want.**

### 2.3 `--code-only`, and what it costs

```bash
graphify extract . --code-only
```

**Cost: zero. No API key, no backend, nothing leaves the machine.** Tree-sitter AST parsing over
364 source files. `graphify update .` is likewise AST-only and free, so the freshness mechanism in
section 4 has no running cost either.

The full semantic pass is not a budget question, it is a correctness one. It would read 34,570
lines of markdown, and 1.6 of those - `SPEC/` and `bugs/` - are already indexed by hand under a
documentation contract that assigns each file a job and forbids overlap. A generated wiki competing
with `SPEC/README.md` is a document nobody owns, going stale by the hour, contradicting a
hand-maintained one. `HISTORY.md` alone is 634 KB of milestone narrative that would dominate any
clustering and answer no structural question.

So: **`--code-only`, no backend extra, no `graphify label`, no `graphify export wiki`.** If a
semantic pass is ever wanted, the honest scope is `SPEC/decisions/` alone - 49 ADRs, each stating a
choice and its rejected alternative, which is the one part of the corpus where "what else relates
to this decision" is not already answered by a link.

### 2.4 The `.graphifyignore`

Drafted, not written. Every line has a reason, and every reason is a number I checked.

```gitignore
# graphify scoping. gitignore syntax: this file can only ever exclude MORE than
# .gitignore already does, never re-include.

# Xcode intermediates and CocoaPods. 8.3 GB across 67,621 files: ios/build is 3.2 GB,
# ios/build-sim is 3.7 GB, ios/Pods is 1.4 GB. These ARE excluded by git, but by
# apps/mobile/.gitignore line 40 (`/ios`), which is a NESTED gitignore. graphify
# promises the root .gitignore and .git/info/exclude; it does not promise nested ones.
# Stated here so the answer stops mattering.
apps/mobile/ios/
apps/mobile/android/

# Expo output. 33 MB of bundled web/native build, plus 12 MB of Expo's own cache.
# Machine-written, and the sources it was built from are already in the graph.
apps/mobile/dist/
apps/mobile/.expo/

# Drizzle migration snapshots: 42 generated JSON files, 175,315 lines, 4.5 MB, and each
# one restates the WHOLE schema. Excluded on value, not size: 42 near-identical clusters
# would bury packages/server/src/db/schema.ts, which is the file anyone actually edits.
packages/server/src/db/migrations/meta/

# Playwright MCP's captured runs. 156 files of session debris.
.playwright-mcp/

# Session recordings. Real message bodies and real user ids (root .gitignore line 31).
# Already excluded by git; repeated because this one must never be indexed even if the
# gitignore handling changes underneath us.
.dev-trace/

# Untracked scratch directories, currently empty, and unignored by git.
.probe/
dist-debugid-probe/

# --- Below here only matters if --code-only is ever dropped. Cheap insurance. ---

# 634 KB of milestone narrative, the largest text file in the repo. History, not
# structure: it would dominate any doc pass and answer no structural question.
HISTORY.md

# Root-level debugging screenshots from August. Tracked, but not source.
fig1.png
fig2.png
fig3.png
fig4.png
fixed.png
```

**One trap worth writing down, because this repo will hit it.** `.graphifyignore` is gitignore
syntax, where `[...]` is a character class. Expo Router fills `apps/mobile/app/` with literal
brackets and parentheses: `chat/[channelId].tsx`, `(tabs)/`, `(tabs)/(main)/`. Any future line
naming one of those must escape the brackets (`chat/\[channelId\].tsx`) or it will silently fail to
match. No line above needs it, and none should be added without it.

### 2.5 `GRAPHIFY_OUT`: not needed

Each worktree is its own directory (`ClubChat-Remastered`, `ClubChat-deploy`,
`ClubChat-image-cache`, plus whatever `agent-worktree.sh` mints), so each already gets its own
`graphify-out/` at its own root with no configuration. That is the correct behaviour: a graph
should describe the branch it sits on, and a shared one across three branches would be wrong for at
least two of them.

The one place it could bite is the git hook, if the installer bakes an absolute path at install
time rather than resolving the repo root at run time. That is checked explicitly in step 6 of
section 3, and `GRAPHIFY_OUT` is the escape hatch if the check fails.

### 2.6 `graphify-out/` goes in `.gitignore`

Three independent reasons, and any one of them is sufficient:

1. **The em dash gate.** `npm run lint:emdash` walks `git ls-files` and runs in CI on every push
   and every pull request. The instant `graphify-out/` is tracked, every generated report and every
   HTML export is scanned for U+2014. I have not run graphify, so I cannot tell you whether its
   generated `GRAPH_REPORT.md` contains one, and that is exactly the point: it would turn a routine
   graph refresh into a red CI run for a reason that has nothing to do with the change.
2. **The documentation contract.** Section 3 of AGENTS.md: where a doc disagrees with the repo, the
   repo is right and the doc is the bug, fixed in the same change. A committed graph disagrees with
   the repo the moment anyone saves a file, and no one is going to regenerate it in the same change.
   Untracked, it is a cache and nobody owes it anything. Tracked, it is a document that is
   permanently a bug.
3. **It is an internal artifact.** `graph.html` and the tree export load d3 and mermaid from a CDN
   with no subresource integrity, and the output encodes the full source structure. This is a repo
   whose `README.md` is `chmod 600`.

The line to add:

```gitignore
# The graphify code graph. A derived, per-worktree cache rebuilt by the post-commit
# hook; never a document. See docs/graphify-adoption-plan.md section 2.6.
graphify-out/
```

Committing it to share one graph across the team would be the wrong trade even without reasons 1
and 3: there is no team here in the git sense, there are worktrees on different branches, and the
graph they would share would be wrong for all but one of them.

---

## 3. Step-by-step rollout

Nine steps. Steps 1 through 5 are reversible with no repo change at all; the first thing that
touches a tracked file is step 7.

**Step 1. Install the tool.**

```bash
uv tool install graphifyy
graphify --version
```

*Expect:* a version string. *If it fails building tree-sitter wheels* (plausible on Python 3.14,
see 1.8): `uv tool uninstall graphifyy && uv tool install --python 3.12 graphifyy`, which gives the
tool its own 3.12 without touching the system interpreter. *Check:* `graphify --help` lists
`extract`, `query`, `path`, `explain`, `affected`, `god-nodes`.

Note for whoever runs this: the package is `graphifyy` with two y's and the command is `graphify`.
`uvx graphify …` fails, because `uv tool run` reads the first word as a package name. If a
throwaway run is wanted instead of an install, it is `uvx --from graphifyy graphify …`.

**Step 2. Write the `.graphifyignore` before the first extraction.**

```bash
# paste the block from section 2.4
$EDITOR .graphifyignore
```

*Check:* `wc -l .graphifyignore` and read it back. Doing this first is the whole point: it is what
stops step 4 walking 8.3 GB of Xcode output.

**Step 3. Extract into a scratch directory first, and look before committing anything.**

```bash
graphify extract . --code-only --out /tmp/graphify-probe
```

*Expect:* a run measured in seconds to a couple of minutes, and `/tmp/graphify-probe/graph.json`.
*Check, and this is the one that decides whether to continue:*

```bash
du -sh /tmp/graphify-probe
python3 -c "import json;g=json.load(open('/tmp/graphify-probe/graph.json'));print(len(g.get('nodes',[])),len(g.get('edges',[])))"
grep -c 'apps/mobile/ios/' /tmp/graphify-probe/graph.json || echo "0 - ios correctly excluded"
```

A non-zero count for `apps/mobile/ios/` means the nested gitignore was not honoured **and** the
`.graphifyignore` did not catch it. Stop and fix the pattern before going further. Using `--out` to
a scratch path means nothing has been written into the repo yet.

**Step 4. Run the resolver check, before trusting anything.** This is the highest-risk unknown in
the whole plan and it is one command:

```bash
graphify explain "packages/server/src/domain/scopes.ts" --out /tmp/graphify-probe 2>/dev/null \
  || GRAPHIFY_OUT=/tmp/graphify-probe graphify explain "packages/server/src/domain/scopes.ts"
```

*Expect:* three importers, named in section 7.1. *If it reports zero importers, stop.* See 7.1 and
8.1 for why, and do not proceed to step 5 until it is resolved.

**Step 5. Extract for real, into the repo.**

```bash
graphify extract . --code-only
```

*Check:* `ls graphify-out/` shows `graph.json`, `cache/`, and the sidecars. `git status --short`
shows `graphify-out/` as the only new untracked path, which it will until step 7 ignores it.

**Step 6. Install the hooks and prove the path is relative.**

```bash
graphify hook install
cat .git/hooks/post-commit
```

*Expect:* a post-commit and a post-checkout hook, appended between markers over the stock samples,
with a rolling backup. *Check, and this is the worktree-specific one:* read the hook body and
confirm it resolves the repo root at run time rather than carrying a baked absolute path to
`/Users/parksrpk/Developer/ClubChat-Remastered`. Linked worktrees share `.git/hooks` with the main
tree, so a baked path means a commit in `ClubChat-deploy` would rewrite `main`'s graph. If it is
baked, do not use the hook: fall back to the manual line in the instruction block and say so.

**Step 7. The `.gitignore` line.** Add the `graphify-out/` block from 2.6 to the root `.gitignore`.
*Check:* `git check-ignore -v graphify-out` names the new line, and `git status --short` no longer
lists it.

**Step 8. The project install, inspected before it is kept.**

```bash
git status --short > /tmp/before.txt
graphify install --project --platform claude
git status --short
git diff -- AGENTS.md
```

*Expect:* new files under `.claude/skills/graphify/`, and a marker-delimited block appended to
`AGENTS.md`. *Check three things:* (a) whether a `CLAUDE.md` was created - if so, decide
deliberately rather than by default, per 2.2; (b) the injected block against section 5 below, and
replace it with the rewritten version; (c) `npm run lint:emdash`, since these files are about to
become tracked and that gate walks `git ls-files`. Use the repo's own checker rather than a hand
grep: standing instruction 1 warns that some grep variants match nothing and report a clean file,
and `scripts/check-emdash.mjs` self-tests its detector before it scans.

**Step 9. Verify, then commit.** Run the five questions in section 7 and compare against the
answers there. Then commit by pathspec, per AGENTS.md 2.5, staging the genuinely new files first:

```bash
git add .graphifyignore .claude/skills/graphify
git diff --cached --name-only     # nothing but the new files you just named
git commit -F /tmp/message.txt -- .graphifyignore .gitignore AGENTS.md \
  .claude/skills/graphify docs/graphify-adoption-plan.md
```

Authored as `parks3131`, no co-author trailer (standing instruction 2), and only when asked.

---

## 4. Keeping the graph fresh

**Chosen: `graphify hook install` (post-commit and post-checkout).** Justified against this repo,
including where it falls short.

**Why not a `watch` process.** This is the option that looks best and is worst here. Agents on this
machine have a documented history of long-lived processes being killed out from under them a few
hours in, and `AGENTS.md` section 2.5 spends a page on why an agent must not assume ownership of a
running process. A dead `watch` fails silently: the graph simply stops updating, and every agent
downstream keeps trusting it. A stale graph that looks fresh is worse than no graph.

**Why not CI.** The graph is consumed locally, by agents, on this machine. A CI job would prove
extraction does not crash and then discard the artifact, at the cost of minutes on a suite that
already budgets 30 of them. The CI file's own header says it exists to run checks nobody runs by
hand; this is not one of those, because the person who needs the graph is the one sitting here.

**Why hooks win.** Three concrete properties of this repo:

1. **There is nothing to collide with.** `.git/hooks` holds only stock samples. No husky, no
   pre-commit framework. The installer's marker-and-backup machinery is insurance we do not even
   need.
2. **`post-checkout` is the one that actually matters here.** Three worktrees exist on three
   branches and `agent-worktree.sh` mints more per task. The worst stale-graph failure is not a
   missing function, it is a graph describing a different branch, quietly. `post-checkout` closes
   exactly that.
3. **It costs nothing.** AST only, no API calls, incremental against the sha256 cache. On 364
   source files this should be seconds.

**The gap, stated plainly.** `AGENTS.md` section 2.4 says *commit only when asked*, so in this repo
a commit is not a reliable "work is done" signal - an agent can go a long session without one, and
the graph is stalest exactly when it is being queried hardest. **The always-on block already ships
the answer** (*"After modifying code, run `graphify update .`"*), and section 5 keeps that line and
puts it where the finishing checklist already lives. That is one mechanism plus the block that
ships by default, not two competing mechanisms. If the hook turns out to bake an absolute path
(step 6), the manual line becomes the whole mechanism and we should say so out loud rather than
assume the hook is working.

---

## 5. Agent instruction changes

The block below replaces whatever `graphify install --project` injects. Same job, but it obeys the
existing rules instead of competing with them: the spec keeps first place for behaviour questions,
the wiki bullet is gone because we are not exporting one, and there are no em dashes.

**Where it goes: `AGENTS.md` section 5, project specifics**, immediately after the 5.1 command list
- not appended at the end of the file, because sections 0 through 4 are declared stack-agnostic and
this is the most stack-specific thing in the repo.

```diff
--- a/AGENTS.md
+++ b/AGENTS.md
@@ section 5.1, after the npm run command list
+### 5.2 The code graph
+
+<!-- graphify:begin -->
+`graphify-out/graph.json` is a tree-sitter parse of every TypeScript, TSX and JavaScript
+file in the repo: what imports what, what calls what, what inherits from what. It is
+built locally, it costs nothing to run and nothing leaves the machine. It is a cache,
+not a document: it is gitignored, it can be wrong, and the repo is always right.
+
+**It does not change what you read first.** Section 2.1 stands: behaviour questions are
+answered by `SPEC/PRD/`, structural questions by `SPEC/TECH/`, settled questions by
+`SPEC/decisions/`. The graph answers a third kind of question that no document does, and
+that grep answers badly:
+
+- **"What breaks if I change this?"** `graphify affected "packages/server/src/policy/predicates.ts"`
+- **"Who else already does this?"** `graphify explain "<path or symbol>"`, which is the
+  fastest way to obey section 2.2's "find the closest existing feature and mirror it".
+- **"How do these two things connect?"** `graphify path "<A>" "<B>"`
+- **"What are the hubs?"** `graphify god-nodes --top 10`
+
+Where to start for the areas that bite most often:
+
+| Question | Start at |
+|---|---|
+| Authorization, and any predicate | `packages/server/src/policy/predicates.ts` and `policy/context.ts` (imported by 45 files) |
+| Owning-scope resolution | `packages/server/src/domain/scopes.ts` |
+| Schema and anything it touches | `packages/server/src/db/schema.ts` (64 importers) |
+| A chat behaviour | `packages/server/src/domain/send-message.ts`, `append-message.ts`, and `apps/mobile/app/chat/[channelId].tsx` (6,404 lines - query it before you read it) |
+| Anything crossing the wire | `packages/client-core/src/chat-client.ts` and `packages/server/src/api/routes/` |
+
+**Two things the graph cannot tell you.** It is built from imports and calls, so the
+mobile app and the server look unconnected: they are joined by HTTP, not by an edge. And
+an edge tagged `INFERRED` or `AMBIGUOUS` is graphify's guess, not the source; for an
+authorization question, non-negotiable 7 still applies - attempt the forbidden action and
+watch it be rejected. Reading a graph edge and concluding it looks right is not
+verification either.
+
+**After changing code, run `graphify update .`** It is AST only and costs nothing. The
+post-commit and post-checkout hooks do this for you, but this repo commits only when
+asked, so a long session goes stale in between. Rebuild from scratch with
+`graphify extract . --code-only --force` if the graph looks wrong.
+<!-- graphify:end -->
```

Also add one line to the section 5.1 command list, where every other command in this repo is
already documented:

```diff
+graphify update .            # rebuild the code graph after changing code. AST only, free,
+                             # writes only inside graphify-out/. See 5.2
```

**No other file changes.** In particular, do not create a `CLAUDE.md` (1.4, 2.2).

---

## 6. MCP integration: against, for now

`graphify` ships an MCP stdio server exposing `query_graph`, `get_node`, `get_neighbors`,
`shortest_path` and the PR triage tools. I recommend not wiring it up, on three grounds specific to
this repo.

1. **The consumer is Claude Code, which already runs shell commands.** There is no capability here
   that `graphify query` through Bash does not already provide. MCP would buy a slightly tidier tool
   surface for a real cost.
2. **It is another long-lived process on a machine where those get killed.** Section 4's argument
   against `watch` applies unchanged. A dead MCP server is a broken tool call at best and a silently
   empty answer at worst.
3. **There is no `.mcp.json` in this repo today.** Adding one means adopting a whole configuration
   surface, and inheriting the HTTP transport's footguns for a benefit we have not yet established.
   If the HTTP transport is ever used it must carry `--api-key` and stay on `127.0.0.1`; the
   shipped Dockerfile binds `0.0.0.0` with no key.

**Revisit if** several agents in several worktrees start querying the graph constantly and the
per-call shell overhead becomes visible. That is a measurable trigger, not a guess, and the change
is additive.

---

## 7. Verification

Five questions whose answers I already know from this investigation. Run them after step 5 and
compare. Answers 1 and 2 are the ones that decide whether the graph is trustworthy at all.

**7.1 Does the resolver understand this repo's import style? (Run this first.)**

```bash
graphify explain "packages/server/src/domain/scopes.ts"
```

*Known answer: exactly three files import it* - `packages/server/src/api/routes/content.ts`,
`packages/server/src/domain/polls.ts`, `packages/server/src/domain/member-candidates.ts`.

Why this one first. `tsconfig.base.json` sets `allowImportingTsExtensions` because Node 24 runs
TypeScript directly by stripping types, so **imports in this repo carry an explicit `.ts`
extension**: `from '../policy/context.ts'`, not `from '../policy/context'`. I counted **1,149
extension-carrying relative imports against 2 without**. A resolver that assumes the normal
TypeScript convention and appends `.ts` will look for `context.ts.ts` and find nothing. **If this
query returns zero importers, the import graph is empty and nothing else in this plan is worth
doing.**

**7.2 Do cross-package edges resolve through the workspace symlinks?**

```bash
graphify affected "packages/shared" --depth 2
```

*Known answer:* `@clubchat/shared` is imported at **84 sites** and should reach `packages/server`,
`packages/client-core`, `packages/cdn-worker` and `apps/mobile`. The distinction that matters:
`packages/cdn-worker` imports **only** the subpath `@clubchat/shared/media-signing` (7 sites) and
never the barrel, and CI has a step whose comment says why - the barrel re-exports a 250 KB emoji
catalogue, so a bundle that grows by two orders of magnitude means somebody imported
`@clubchat/shared` instead. If graphify collapses subpath imports into one package-level edge, that
distinction is lost and `affected` will over-report.

**7.3 Are the architectural hubs the real ones?**

```bash
graphify god-nodes --top 10
```

*Known answer, by import count:* `theme.ts` (65), `schema.ts` (64), `harness.ts` (64), `client.ts`
(60), `api.ts` (55), `ui.tsx` (51), `context.ts` (48), `config.ts` (47), `store.ts` (46),
`monitoring.ts` (46). Exact ranking will differ because graphify weights calls as well as imports.
**The signal to look for: if `harness.ts` is absent, test files were skipped**, which would be
wrong here - there are 117 test files and they are first-class source in a repo whose standing
instruction 12 is failing-test-first.

**7.4 Does it correctly find no path where none exists?**

```bash
graphify path "apps/mobile/app/chat/[channelId].tsx" "packages/server/src/domain/send-message.ts"
```

*Known answer: there is no import or call path.* The mobile app reaches the server over HTTP, not
through a module edge. A short confident path here means graphify inferred an edge that does not
exist, and every `affected` result becomes suspect. The honest answer is either "no path" or a path
routed through shared types in `packages/shared`, which is a type-level relationship rather than a
runtime one.

**7.5 Does the policy module show its real reach?**

```bash
graphify affected "packages/server/src/policy/context.ts"
```

*Known answer: 45 files import it directly.* This is the query that would earn the adoption on its
own: AGENTS.md 2.2 requires every authorization predicate to be defined once and reused, and
general failure mode 4 says the same predicate restated in many places will eventually be restated
wrongly. A reverse traversal from `predicates.ts` is a standing check on that rule which grep
cannot perform.

---

## 8. Risks and rollback

### 8.1 Risks, highest first

| # | Risk | Likelihood | What it looks like | Mitigation |
|---|---|---|---|---|
| 1 | **`.ts`-suffixed imports do not resolve.** `allowImportingTsExtensions` means 1,149 of 1,151 relative imports carry `.ts`. A resolver appending its own extension finds nothing. | Unknown, and the single biggest unknown here | A graph with nodes and almost no `imports` edges | Test 7.1 before anything is committed. If it fails, do not adopt: the code graph is the entire value proposition, and the docs are already indexed by hand. |
| 2 | **Nested gitignore not honoured**, so the first run crawls `apps/mobile/ios` | Moderate | A run that never finishes, or a huge `graph.json` | `.graphifyignore` (2.4) names it explicitly; step 3 extracts to `/tmp` first and greps the output |
| 3 | **Hook bakes an absolute path**, so a commit in one worktree rewrites another's graph | Low, but the tree layout makes it costly | `ClubChat-deploy`'s commit rewrites `main`'s `graph.json` | Step 6 reads the hook body. If baked, drop the hook and rely on the manual line |
| 4 | **A `CLAUDE.md` appears** and becomes a second auto-loading instructions file | Moderate, the installer targets it by name | A new tracked file competing with `AGENTS.md` | Step 8 inspects `git status` before any commit |
| 5 | **Python 3.14 has no wheels** for a tree-sitter dependency | Moderate, 3.14 is new | `uv tool install` compiles from source, slowly or not at all | `uv tool install --python 3.12 graphifyy` (1.8) |
| 6 | **Em dashes reach CI** through `.claude/skills/graphify/` or an injected block | Low but cheap to check | `npm run lint:emdash` red on an unrelated pull request | Step 8c greps before committing; `graphify-out/` stays gitignored (2.6) |
| 7 | **The graph goes stale mid-session** and an agent trusts it | Moderate, given "commit only when asked" | Confident answers about files that changed an hour ago | The instruction block says to run `graphify update .` and says the graph can be wrong |
| 8 | **Agents defer to the graph over the spec** | Low, with the rewritten block | An answer citing an edge where `SPEC/PRD/` had the real answer | Section 5's block keeps 2.1's ordering explicit |

Two caveats from the security review of graphify that **do not apply here**, recorded so nobody
re-derives them: the XML entity-expansion issue needs `.csproj` / `pom.xml` / `.xaml` files, and
this repo has none; and `graphify clone`'s unanchored GitHub check does not matter because we are
running against a local trusted repo we already have.

### 8.2 Rollback

Complete, and it leaves no trace. Nothing in steps 1 through 6 touches a tracked file, so a
rollback before step 7 is just the first two commands.

```bash
graphify uninstall --project          # removes .claude/skills/graphify and the AGENTS.md block
graphify uninstall --project --purge  # the same, and deletes graphify-out/ as well
```

Then, by hand:

```bash
rm -rf graphify-out .graphifyignore
# remove the graphify-out/ block from .gitignore
# remove the 5.2 section and the 5.1 command line from AGENTS.md
rm -f .git/hooks/post-commit .git/hooks/post-checkout   # or restore graphify's rolling backup
uv tool uninstall graphifyy
```

Check it is gone: `git status --short` shows nothing graphify-related, `command -v graphify` is
empty, and `ls .git/hooks | grep -v sample` is empty as it was before (1.7).

---

## 9. What I had not verified when this plan was written

**Superseded by section 10.** Everything below was true at the time of writing and most of it has
since been checked by running the tool. Read section 10 for what actually happened.

Stated plainly, because half of the risk table depends on it.

- **I did not run graphify.** It is not installed. Every claim about its behaviour comes from the
  briefing, not from execution. Specifically unverified: whether it walks nested gitignore files,
  whether it resolves `.ts`-suffixed import specifiers, whether its hook uses a relative path,
  whether it creates a `CLAUDE.md` when none exists, and whether `GRAPH_REPORT.md` contains an em
  dash.
- **I did not check the network** for the `graphifyy` package or its wheel availability on Python
  3.14. The 3.12 fallback is a precaution, not a diagnosis.
- **Line counts include blank lines and comments**, since `wc -l` is what produced them. This
  codebase comments heavily, so the executable share of 128,000 lines is materially lower.
- **I read `AGENTS.md` sections 0 through 3 in full and sampled 5.1.** Sections 4 and 5 were read in
  part. A conflict may exist in the parts I sampled rather than read.


---

## 10. Execution record, 2026-09-08

The plan was approved and run. graphify **0.9.56**. What follows is what actually happened,
including the four places the plan was wrong.

### 10.1 What was verified, and what it proved

| Check | Predicted | Actual | Verdict |
|---|---|---|---|
| Install on Python 3.14 | might need a 3.12 pin | installed clean, wheels for every grammar | **risk 5 did not occur** |
| Nested `.gitignore` | might be ignored, 8.3 GB crawl | honoured. `detect.py` `_load_dir_own_ignore` runs per directory inside the walk | **risk 2 does not exist** |
| Extraction | unknown duration | **7 seconds**, 433 code files, 3,617 nodes, 10,361 edges, 137 communities | pass |
| `.ts`-suffixed imports (7.1) | 3 importers of `domain/scopes.ts` | exactly 3, all `EXTRACTED`, correct line numbers | **risk 1, the one that would have killed adoption, is dead** |
| Cross-package subpath (7.2) | `cdn-worker` reaches media-signing without the barrel | confirmed: `cdn-worker/src/index.ts:L51` imports the file directly | pass |
| god nodes (7.3) | `theme.ts`, `schema.ts`, `harness.ts`, `client.ts` | every one present, expressed as its dominant **symbol**: `color`/`space`, `Db`, `startTestDb()`, `useLoad()` | pass, in a different unit |
| No false path (7.4) | no path from the chat screen to `send-message.ts` | "No directed path found" | pass |
| Policy reach (7.5) | 45 files import `policy/context.ts` | 78 **nodes** at depth 1, because the graph counts symbols too. Grep still says 45 files | pass, unit corrected |

`startTestDb()` ranking as a hub confirms test files were indexed, which was the specific signal
section 7.3 said to look for.

### 10.2 Four places the plan was wrong

1. **`graphify install --project --platform claude` installs far more than the plan said.** It
   wrote `.claude/skills/graphify/` (wanted), **and** a root `CLAUDE.md`, **and** `.claude/CLAUDE.md`,
   **and** `.claude/settings.json` registering **PreToolUse hooks on `Bash|Grep` and `Read|Glob`**.
   That last one intercepts tool calls for every agent in this repo and was in no version of the
   approved plan. It fired during the install session before it was removed. **All four were
   deleted; only the skill directory was kept**, and the guidance was hand-written into `AGENTS.md`
   section 5.4 as section 5 of this plan always intended.
2. **`graphify hook install` also writes a `.gitattributes` and a local merge-driver config**,
   registering `graphify-out/graph.json merge=graphify`. Since `graphify-out/` is gitignored, that
   rule can never fire: it is a merge strategy for a file git never tracks. This repo had no
   `.gitattributes` at all. **Both were removed.**
3. **The hooks do not run in a worktree.** Both `post-commit` and `post-checkout` exit immediately
   when `git rev-parse --git-dir` differs from `--git-common-dir`, which is true in every linked
   worktree. Verified in `ClubChat-deploy`. Section 4 chose hooks partly *because* `post-checkout`
   would cover branch changes across worktrees; **it does not**. It covers the founder's tree only,
   and every tree made by `scripts/agent-worktree.sh` must run `graphify update .` by hand. Section
   5.4 of `AGENTS.md` says so. The rest of section 4's reasoning stands: the rebuild is detached and
   backgrounded to `~/.cache/graphify-rebuild.log`, so it never slows a commit, and risk 3 (a baked
   absolute repo path) does not occur, since the rebuild uses `cwd` and `Path('.')`.
4. **`--code-only` does not mean the SQL was parsed.** All 45 `.sql` files contributed **nothing**,
   because `tree_sitter_sql` is not installed. Section 2.1 declined the `sql` extra on the grounds
   that migrations are low-value, which stands, but the plan implied the files were being read and
   found unhelpful. They were not read at all. This is now stated in `AGENTS.md` 5.4 so nobody asks
   the graph a schema question and trusts the silence.

5. **`graphify query` is not usable on this repo, and the plan recommended it.** Sections 2 and 5
   both listed it as a headline command. It is a keyword-seeded breadth-first walk rather than a
   search. Asked "how does a chat message get authorized before it is stored" it seeded from
   `get()` in a site-worker test harness and returned 559 nodes, truncated to 69, with the policy
   module absent. Asked about "policy predicates authorization" it seeded `policy` from the
   `policy` key in `apps/mobile/app.json`. It does reach the right modules, but as an unranked flat
   list that costs more to read than it saves. **`AGENTS.md` 5.4 now tells agents not to use it**
   and to name a file or symbol to `explain` and `affected` instead, which are precise. This is the
   one finding that changes the shape of the value: the win here is targeted traversal, not natural
   language search.

6. **The refresh command in section 4 was wrong in two ways, both measured after the fact.**
   `graphify update .` **ignores `--code-only`**: its first run added 1,279 markdown nodes from
   `SPEC/` and `docs/`, taking the graph from 3,617 nodes to 4,920. And `graphify extract` **merges
   into an existing graph rather than replacing it**, with `--force` making no difference, so the
   doc nodes survived a forced re-extract and only a `rm -rf graphify-out` cleared them. The
   refresh this repo should use is `rm -rf graphify-out && graphify extract . --code-only`, which
   takes seven seconds, and that is what `AGENTS.md` 5.1 and 5.4 now say. The `.graphifyignore`
   itself held throughout: zero nodes from `migrations/meta`, `apps/mobile/ios`, `.dev-trace` or
   `HISTORY.md` in any run.

7. **`GRAPH_REPORT.md` contains em dashes.** Section 2.6 predicted this as a reason to gitignore
   `graphify-out/` and could not confirm it. `graphify update .` generated the report and it
   carries **2**, in a 62 KB file, alongside a 5.2 MB `graph.html`. Had `graphify-out/` been
   committed, `npm run lint:emdash` would have failed in CI. The gitignore decision is now
   evidence-backed rather than precautionary.

One smaller thing: `packages/site-worker/test/markdown.test.ts` fails to parse (first error at line
175, no symbols extracted). One file out of 433, and it is a test for a markdown renderer, so it is
plausible that its fixtures defeat the TypeScript grammar. Recorded, not chased.

### 10.3 What is still open

The vendored skill files carry **46 em dashes** (19 in `SKILL.md`, 27 across `references/`), and
`npm run lint:emdash` walks `git ls-files`, so committing `.claude/skills/graphify/` would have
turned CI red. **Decided 2026-09-08: gitignore the skill folder.** The alternatives were to carve
an exemption into `scripts/check-emdash.mjs` or to strip the characters out of vendored files that
any upgrade would rewrite; both were rejected for touching something the founder wrote in order to
accommodate somebody else's generated prose. The cost is that a fresh worktree does not inherit the
skill from git, which is one command to fix and is written into `AGENTS.md` 5.4. Nothing is lost in
capability: the skill is a reference, and the always-on guidance lives in 5.4, which IS tracked.
Confirmed after the change that `.claude/skills/graphify/SKILL.md` is still auto-discovered by
Claude Code with no `CLAUDE.md` registration, which is what made deleting those two files safe.

This also settles section 2.2's reasoning, which chose `--project` partly so git would carry the
skill into every worktree. That half of the argument no longer holds. `--project` is still right,
because the alternative writes into the user profile where no worktree sees it either and no commit
records it, but the honest position is that the skill is now per-tree local state in both cases.

**Nothing is open.** The second item, that the post-commit hook uses the `update` path and so puts
doc nodes back into a graph this plan scoped to code, was **settled 2026-09-08 by measuring it: keep
the hooks.** The doc nodes form an isolated subgraph with no edges into code, so a code query is
unchanged by their presence. With 1,226 document nodes in the graph, `explain` on `domain/scopes.ts`
returned the same three importers and `affected` on `policy/context.ts` returned the same 78 nodes
as against a clean code-only graph. The pollution is confined to `god-nodes` and to `query`, and
5.4 already tells agents not to use `query` here. Dropping the hooks to avoid that would trade a
real benefit (the founder's tree stays current without discipline) for a cosmetic one.

### 10.4 Final state on disk

Changed, uncommitted: `.gitignore` (one block, ignoring `graphify-out/`), `AGENTS.md` (section 5.4
plus one line in the 5.1 command list). New, untracked: `.graphifyignore`, `.claude/skills/graphify/`,
`docs/graphify-adoption-plan.md`, and `graphify-out/` (ignored). Installed outside the repo: the
`graphifyy` tool, and `post-commit` / `post-checkout` in `.git/hooks`. Not created, deliberately: any
`CLAUDE.md`, `.claude/settings.json`, `.gitattributes`, `GRAPH_REPORT.md`, or a wiki export.
