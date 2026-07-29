# ADR-0001: Record architecture decisions

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

The v1 build accumulated a set of decisions that were re-litigated repeatedly because the
reasoning lived only in conversation. `PRD/09-races-and-meets.md` records several features that
were *built, then reversed* - auto-joining every admin to every race, club-wide admin race pins,
two separate Meet Information sections - each of which cost real work twice.

The remaster's specs already carry "rejected alternatives" prose, but the documentation contract
in `AGENTS.md` §3 assigns that content to ADRs: the spec answers *what* and *how*, an ADR
answers *why this over that*. Decisions and structure also age at different rates. A spec is
edited whenever the system changes; a decision is immutable once made, and is either superseded
or left alone.

## Decision

We will record every architectural decision that is non-obvious or that closes off an
alternative as a numbered ADR in `SPEC/decisions/`, using
[the template](../templates/adr-template.md), and we will treat an accepted ADR as closed unless
new information appears.

## Consequences

| | |
|---|---|
| Positive | A decision and its rejected alternatives survive in one immutable place. A future reader, human or agent, can see why an option was refused without re-deriving it. Specs stay shorter, since the argument moves out of them. |
| Negative | Two places to look. Mitigated by specs linking to the relevant ADR at the point of the decision. |
| Follow-up needed | None. ADRs 0002-0012 backfill the decisions taken during the initial architecture work. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep rejected-alternatives prose inside the specs | It was already growing past a page in two separate documents, and it mixes immutable history with living description. The spec then cannot be edited freely without disturbing the record. |
| Rely on git history and commit messages | Commit messages record what changed, not the alternatives weighed. Nobody archaeologises a diff to find out why an option was refused. |
| No formal record | This is the v1 failure mode, and it is what caused features to be built and reversed. |
