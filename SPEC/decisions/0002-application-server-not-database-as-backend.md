# ADR-0002: Put authorization in an application server, not in the database

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

The v1 build had no application server. The client talked to Postgres directly and row-level
security was the only access control that existed. Reading
[Engineering pitfalls](../TECH/14-engineering-pitfalls.md) as a list, one cause appears in
almost every entry:

- A create-and-return needed a read policy covering the row just created. This produced the
  repo's longest debugging session, and creating a club is still only possible because the read
  rule carries an explicit "or I created it" clause.
- A read rule could not call a helper that re-queried its own table, because it recursed into
  its own policy.
- "Admin" checks had to include the Owner. That exact mistake shipped **four** times, plus a
  fifth found later in a helper, because the predicate was copy-pasted per policy rather than
  existing once.
- Row-level rules cannot express column-level authority, so a separate before-write trigger was
  needed to stop a member pinning their own message and retro-flipping it into an announcement.

None of these are exotic. They are what happens when authorization is expressed as row
predicates evaluated inside queries, rather than as functions called before them.

## Decision

We will run an application server that owns every command and query, and we will express the
predicate catalogue as pure functions over an access context loaded once per request. The
database enforces **deny-by-default at the role level only**, with no per-row policies.

## Consequences

| | |
|---|---|
| Positive | `isClubAdmin` exists exactly once, so the owner-inclusion bug becomes structurally impossible. Create-and-read-back is trivially legal. Column-level authority is an `if`. The permission matrix becomes a table-driven test file instead of something verified by hand. |
| Negative | More code than v1, and a server to operate. Accepted deliberately: `AGENTS.md` standing instruction 3 ranks robustness and maintainability above build cost. |
| Follow-up needed | The permission matrix test suite must cover every cell of the three matrices in [Roles and permissions](../PRD/02-roles-and-permissions.md) before the domain breadth phase is called done. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep per-row RLS as defence in depth alongside the policy module | Two definitions of every rule that must be kept in sync. Drift between two definitions of `isClubAdmin` is *literally* how the v1 bugs happened, so a second half-maintained layer is a liability rather than a safety net. |
| Keep RLS as the only enforcement, fix the bugs individually | The bugs are symptoms of the mechanism, not of carelessness. Recursion in read rules and the absence of column-level authority cannot be fixed by being more careful. |
| Move to a different managed backend with the same shape | Would reproduce the same class of problem with different syntax. The issue was never the vendor - managed Postgres, object storage and auth remain in the design. |
