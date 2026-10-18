# Brief for the agent building Clubby

You are building **stage one of Clubby**: a read-only MCP server inside the ClubChat API, so a
member can connect their Claude account and ask about their clubs and direct messages. This file
tells you how to work. The rest of this folder tells you what to build.

Nothing is built yet. The plan was agreed with the founder on 2026-10-18.

---

## 1. Read before you touch anything

In this order. Do not skip the first one: it is not loaded automatically.

1. [`/AGENTS.md`](../../AGENTS.md), all of it. It is the working agreement for this repo, and most of
   the rules below are its rules restated for this task. Where this file and AGENTS.md disagree,
   AGENTS.md wins and this file is the bug.
2. [`/SPEC/README.md`](../../SPEC/README.md), then
   [`SPEC/TECH/05-authorization.md`](../../SPEC/TECH/05-authorization.md), because every tool here is
   an authorization question.
3. This folder, in the order [`README.md`](README.md) lists.
4. **The installed documentation of every new dependency, before writing code against it**
   (non-negotiable 1). better-auth moves from 1.6 to 1.7, and the MCP TypeScript SDK is at version
   2, which split into several packages and changed its imports. Remembered v1 examples are wrong.
   Read the `.d.ts` files and readmes in `node_modules` after installing.

Use the code graph to find files (AGENTS.md section 5.4), then read the files it names.

## 2. Where to work

**In your own worktree, never in the founder's folder.** The founder chose this on 2026-10-18.

```
./scripts/agent-worktree.sh clubby
```

That gives you branch `clubby`, your own install and your own ports (the script prints them).
The founder's stack on 3000 / 3001 / 8081 and his phone are not yours: do not start, stop or point
anything at them. `npm test` is self-sufficient and starts its own containers. Work on the iOS
Simulator against your own ports when a check needs the app.

The graph is not built in a fresh worktree. AGENTS.md 5.4 has the two commands.

## 3. How to work

These are AGENTS.md rules, listed so you cannot miss the ones that bite on this task:

- **Failing test first, then the code, then the full suite and the type check** (standing
  instruction 12). A test that passed the first time it ran has proved nothing.
- **Every authorization claim is proved by attempting the forbidden thing** (non-negotiable 7).
  [`04-security-and-privacy.md`](04-security-and-privacy.md) lists the attempts.
- **Every predicate is defined once.** A tool must call the same function the matching REST route
  calls. If that function is tied to the HTTP request (as `authorizeChannels` is), refactor it to
  take an `AccessContext` and keep the HTTP wrapper calling it. Never copy a query into a tool
  (failure modes 10 and 19).
- **Node runs the server by stripping types**: no enums, no parameter properties, no namespaces,
  and every import carries `.ts` (failure mode 6). `npm run check:runtime` catches it.
- **Migrations**: generate with `--name`, never edit one that has been applied, give every
  better-auth table a database-side `defaultRandom()` id (failure mode 2).
- **No em dash anywhere** (standing instruction 1). `npm run lint:emdash`; new files are invisible
  to it until staged (failure mode 39).
- **Do not touch `apps/mobile/package.json`.** Editing it strands every installed phone from
  over-the-air updates (failure mode 42). Stage one needs no mobile change at all.
- **Commits**: as the repo owner, with no co-author or agent trailer, by pathspec
  (`git commit -F msg.txt -- <paths>`), new files staged by name first. Commit each green step on
  your branch. Never push, merge or rebase onto `main` without the founder saying so.

## 4. Stop and ask the founder before

Each of these reaches outside your worktree or changes what was agreed:

1. **Deploying to Fly, or running a migration against the production database.** Step 3 of the
   build plan needs a deploy. Ask, with the exact commands you intend to run.
2. **Anything in the founder's Claude account**, including adding the connector at claude.ai.
   He does that himself; you give him the URL and the steps.
3. **Anything on his phone or his running stack.**
4. **Adding any tool that writes, sends, votes, marks read or deletes.** That is stage two, and it
   needs its own plan. Stage one is read-only by decision, not by omission.
5. **Changing a decision in [`06-decisions.md`](06-decisions.md).** If the code shows one was
   wrong, stop and say so with evidence; do not route around it.
6. **A dependency that turns out not to do what this plan assumes**, for example the OAuth plugin
   lacking Client ID Metadata Document support. [`07-risks-and-unknowns.md`](07-risks-and-unknowns.md)
   lists the known ones.

**How to ask** (AGENTS.md 0.10 and 0.11): open with a two or three sentence recap, because he has
usually lost the thread. Plain words. One question at a time, as a multiple choice with the
trade-off of each option and your recommendation. Name the project, the branch and the worktree.

## 5. Builder and verifier are two agents

AGENTS.md 2.5 item 10. If you build, end each step by committing on `clubby` and writing a
`HANDOFF: INTENT` paragraph: what changed, why, and what a reviewer should look hardest at. A
fresh, small agent then runs the verification (type check, full suite, `check:runtime`,
`gate:surface` against your own API port, the security proofs) from that paragraph alone. Do not
drive your own verification loop with your whole build transcript behind it.

## 6. Done means

Stage one is done when all of these are true, each one run rather than assumed (standing
instruction 9):

- All 13 tools in [`03-tools.md`](03-tools.md) answer correctly against the seeded Binghamton
  Running Club, through a real MCP client.
- Every proof in [`04-security-and-privacy.md`](04-security-and-privacy.md) is a test, and each
  was seen to fail before its fix.
- `npm run verify` is green, and `gate:surface` covers the new routes in both directions.
- The founder has connected his own Claude account and asked at least one question from the Claude
  phone app. Whether hands-free voice mode works is recorded either way.
- The docs listed in build step 7 are written, and `BUGS.md` has a row for anything that reached a
  running app.
