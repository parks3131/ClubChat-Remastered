# ADR-0016: A thread's writability is evaluated, never stored

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-30 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

[Direct messages](../PRD/14-direct-messages.md) makes a conversation stop being writable in two
ways, and both leave it fully readable:

- **Rule 3.** Losing the last shared club makes the thread read-only. It does not delete it -
  history stays readable, consistent with a message never being hard-deleted.
- **Rule 6.** Either participant can block the other. A block prevents new messages in both
  directions; existing history remains visible to both.

The tempting schema is a column: `dm_conversations.read_only_at`, set when the pair's last shared
club goes away. It reads well and it is wrong for the same reason `polls.is_closed` was wrong.

**Nothing in the system owns the moment a pair stops sharing a club.** It happens when either
person leaves any club, is removed from any club, or has a club deleted under them - and it
un-happens when either of them joins a club the other is already in. Every one of those paths
would have to know about DMs and recompute the flag for every thread the departing member holds.
The membership cascade currently knows about race rosters, car groups and Eboard membership; a
fourth thing to remember, in a code path that already exists to clean up after somebody leaving,
is a fourth thing to forget.

And a stored flag is wrong between maintenance runs by construction. A member re-joins a club at
09:00 and the thread reads read-only until something recomputes it. There is no job that would,
and adding one means the correct answer is only ever eventually correct.

Blocking has the same shape and a smaller radius: the fact lives in `member_blocks`, and copying
"is this thread blocked" onto the conversation would give one fact two homes.

## Decision

**`dm_conversations` stores the pair and the creation time, and nothing about whether the thread
can be written to.** There is no `read_only_at`, no `blocked_at`, and no `last_shared_club_at`.

Writability is resolved when the access context loads, per thread:

```sql
EXISTS (SELECT 1 FROM club_memberships mine
          JOIN club_memberships theirs ON theirs.club_id = mine.club_id
         WHERE mine.user_id = $me AND theirs.user_id = $them)
```

and blocking is read from `member_blocks` in the same load, symmetrically. `canPostInDm` is then a
pure function over both. Read access requires neither, which is what keeps history visible in
both of the refusing cases.

`EXISTS` rather than a count: whether they share three clubs or one makes no difference to the
answer.

## Consequences

| | |
|---|---|
| Positive | Correct at every instant, including the instant after somebody re-joins a club, with no job and nothing to backfill. The membership cascade needs no DM branch at all - leaving a club changes the answer without touching a DM row. One fact, one home: a block lives in `member_blocks` and a shared club lives in `club_memberships`. Asserted directly in the Phase 3.5 suite, which leaves a club, watches the thread go read-only for both parties, re-joins, and watches it become writable again. |
| Negative | Two joins per context load rather than reading a column. It is one indexed `EXISTS` per thread the viewer holds, bounded by how many people they talk to, and the context already loads in one round trip. If a member ever holds hundreds of threads this is the query to look at first - but a stored column would still be the wrong fix, and a materialised view keyed on the pair would be the right one. |
| Follow-up needed | None. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| A `read_only_at` column maintained by the membership cascade | Four write paths (leave, remove, club delete, join) would each have to recompute it for every thread the member holds, and the join path has to *clear* it, which is the one people forget. Wrong between runs, and it makes a DM concern leak into a cascade that has nothing to do with DMs. |
| A `read_only_at` column maintained by a nightly job | Then the answer is only eventually right, and a member who re-joins a club is told they cannot message their teammate until tomorrow. The same objection that removed `polls.is_closed`: a state that must read correctly *everywhere* cannot depend on something having run. |
| A generated column on `dm_conversations` | Postgres generated columns may only reference columns in their own row. Whether two people share a club is a fact about two other tables. |
| Delete the conversation when the last shared club goes | Contradicts rule 3 explicitly, and would destroy history the participants are entitled to keep. It also makes re-joining a club unable to restore anything. |
| Evaluate it in every handler instead of in the context | The predicate would be restated per call site, which is the single most reliable source of authorization bugs in this repo's history. Resolving it once at context load is what lets `canPostInDm` stay a pure function. |

## Note

This is the third instance of the same decision in this codebase - `polls` has no `is_closed`,
unread counts are never stored, and now a thread's writability is never stored. The shared rule
is worth naming: **a fact derived from rows that change independently should be computed, not
copied.** A copy needs an owner for every path that could invalidate it, and the paths are always
more numerous than they look.
