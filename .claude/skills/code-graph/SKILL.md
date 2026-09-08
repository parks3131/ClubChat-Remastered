---
name: code-graph
description: "ClubChat's own code map. Use at the START of any task that touches code, to find which files carry a thing and what breaks if you change them, before opening anything. Covers setup in a fresh worktree, the four commands worth using, and the traps. Read AGENTS.md section 5.4 for the full contract."
---

# The ClubChat code graph

This repo keeps a tree-sitter map of itself in `graphify-out/`: roughly 3,600 nodes over 433
files, built in about seven seconds, no API key, nothing leaves the machine. It is gitignored,
so it is per-tree and it can be absent or stale.

**[`AGENTS.md`](../../../AGENTS.md) section 5.4 is the contract.** Open it. This file exists only
because it loads automatically and `AGENTS.md` does not, so it is a pointer, not a copy.

## Is there a graph in this tree?

```
ls graphify-out/graph.json 2>/dev/null || echo "no graph here"
```

If there is none, build it. Seven seconds:

```
rm -rf graphify-out && graphify extract . --code-only
```

The `rm` is not optional. `extract` MERGES into an existing graph rather than replacing it, and
`--force` does not change that.

If the `graphify` command itself is missing (a fresh machine): `uv tool install graphifyy`. Note
the double y in the package name, and that `uvx graphify` does not work.

## The order to work in

1. **`SPEC/PRD/` or `SPEC/TECH/` first** for what the product does and what must not break. The
   graph holds no intent and no rules.
2. **Then the graph, to locate.** Which files carry this, what calls them, what breaks.
3. **Then read those files, before changing any of them.**

Step 3 is not optional. The graph stores names and relationships and no logic: it knows
`send-message.ts` imports `policy/context.ts` and not what either one does. An answer built from
edges alone is a confident guess, and two features that look alike in this repo routinely have
deliberately different permission rules.

## The four commands

```
graphify affected "packages/server/src/policy/predicates.ts"   # what breaks if I change this
graphify explain  "packages/server/src/domain/scopes.ts"       # one file, its callers and callees
graphify path     "<A>" "<B>"                                  # how two things connect
graphify god-nodes --top 12                                    # the hubs
```

**Do not use `graphify query "<question in words>"` here.** It is a keyword-seeded walk, not a
search. Asked about "policy predicates" it matched the word `policy` to a key in
`apps/mobile/app.json`. Name a file or a symbol to `explain` or `affected` instead.

## Traps, each one measured

- **Name a file or a symbol, never a directory or a package.** `affected "packages/shared"`
  answers "no unique node match".
- **Counts are nodes, not files.** `affected` on `policy/context.ts` reports 78 where 45 files
  import it; the rest are symbols.
- **The 45 `.sql` files contribute nothing**, because the SQL grammar is not installed. Schema
  questions go to `packages/server/src/db/schema.ts` and to the migration directory by hand.
- **Mobile and server look unconnected, and that is correct.** They are joined by HTTP, not by an
  import, so `path` between them answers "no directed path found".
- **An `INFERRED` or `AMBIGUOUS` edge is a guess.** For authorization, non-negotiable 7 stands:
  attempt the forbidden action and watch it be rejected.
- **The refresh hooks run in the founder's tree only.** They exit immediately in a linked
  worktree, so in a tree from `scripts/agent-worktree.sh` the rebuild above is yours to run.

## Do not run `graphify install`

It re-adds four things this repo deliberately does not have: a root `CLAUDE.md`, a
`.claude/CLAUDE.md`, a `.claude/settings.json` registering PreToolUse hooks over every Bash,
Grep, Read and Glob call, and a `.gitattributes` for a file that is gitignored. If you need the
vendored graphify skill, install it and then delete those four. See `AGENTS.md` 5.4.
