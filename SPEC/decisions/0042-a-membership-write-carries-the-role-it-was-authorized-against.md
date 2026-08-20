# ADR-0042: A membership write carries the role it was authorized against

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-19 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

Every command in `domain/membership.ts` decides from a role. `changeRole` reads the target's role
to see whether the actor may change it and to refuse the Owner outright; `removeMember` reads it to
apply the removal ladder; `transferOwnership` reads it to confirm the successor is a member;
`leaveClub` reads nothing at all and decides from the access context loaded when the request
arrived. All four then write **unconditionally**.

The read is its own statement on its own snapshot. Postgres runs at READ COMMITTED here and nothing
in `db/` or `domain/` overrides that, so between the read and the write another request can commit
a different role for the same row - and the write applies a decision about a row that no longer
exists in the state that was decided about.

The worst outcome is a club with **no owner**, which has no recovery path: transferring, deleting
and promoting are all Owner-only, so nobody left in the club can put one back. Three interleavings
produce it, all of them ordinary two-admin behaviour rather than exotic timing:

1. The Owner promotes a member to admin and transfers the club to that same member at nearly the
   same moment. Both reads see a plain member. The transfer commits, so the member is Owner and the
   Owner is an admin, and the role change then writes `admin` over the Owner's row.
2. The Owner transfers the club to somebody who is removed, or leaves, in the same window. The
   transfer demotes itself first (which it must - the one-owner index is checked per statement, so
   promoting first would momentarily hold two owners and fail), then promotes a row that is gone.
   Nothing raises, and it reports success.
3. Somebody is handed the club while their own "leave club" request is in flight. `canLeaveClub`
   refuses an owner and cannot see it, and the cascade deletes the Owner's row.

**The unique index does not catch any of them.** `club_memberships_one_owner` is
`uniqueIndex(...).on(clubId).where(role = 'owner')`, so it forbids a **second** owner. Zero owners
satisfies it perfectly. The comment above it in `schema.ts` is the reason this matters and was read
as though it were the enforcement: it says an ownerless club has no recovery path.

The same shape, with a different invariant, is in `domain/races.ts`. The Incharge of a car group
must be a member of that group - a fact spanning two tables that no constraint can state.
`setCarGroupIncharge` checked membership in one statement and wrote in another, so somebody leaving
the car in that window was named in charge of a car they were no longer in. And the departure path
decided whether to clear the Incharge from a `wasIncharge` value read a moment earlier, so an admin
naming a replacement in that window had their choice overwritten with `NULL` and the club was told
the group needed an Incharge it had just been given.

[ADR-0030](0030-the-nudge-cooldown-is-a-constraint.md) already named this class - *read-then-write,
which loses exactly the case it exists for* - and answered it with a constraint. That answer is not
available here, for the reason in the Alternatives table below.

## Decision

**Every write carries the fact it was authorized against, and a write that matches no rows is a
refusal rather than a success.** Which of two forms depends on what has to be true:

**Compare-and-set, where one row moves.** `changeRole` puts the role it read into the `WHERE`
clause of its update:

```
UPDATE club_memberships SET role = <new>
 WHERE club_id = ... AND user_id = ... AND role = <the role this call authorized against>
```

Postgres re-checks that predicate against the committed row version when it unblocks, so a row that
moved matches nothing. `RETURNING` makes the zero-row case visible, and the transaction returns
before it writes anything else - so the Eboard membership and the outbox event do not record a role
change that did not happen.

**Lock and re-read, where more than one row has to move together, or where the question is whether
a row exists at all.** `transferOwnership` locks both rows in one statement and decides from what it
reads there:

```
SELECT user_id, role FROM club_memberships
 WHERE club_id = ... AND user_id IN (actor, successor)
 ORDER BY user_id FOR UPDATE
```

Compare-and-set is the wrong tool for it. Two guarded updates can each match zero rows
independently, which is four outcomes to unpick after the fact, and one of them - demoted the Owner,
promoted nobody - is the ownerless club again. Holding both rows makes the pair one decision: the
roles it reads are the roles the writes apply to. It also lets the actor's authority be **re-asked**
rather than trusted from the access context, which is the module's stated contract ("re-checks the
actor's authority in its own body") and was not being kept. `ORDER BY user_id` gives two concurrent
transfers in a club the same lock order, so they cannot deadlock.

`cascadeOut` takes the same form for the opposite reason: what it needs to know is whether the row
is the Owner's *at the moment it deletes it*, so it locks the row and asks. `removeMember`,
`leaveClub` and `banFromClub` all reach it and all three forbid touching the Owner, each from a read
taken earlier. A membership row that is simply **gone** stays idempotent and is not a conflict: two
removals of the same person, or a retried "leave", must still report done.

`setCarGroupIncharge` locks the car-group membership row it is asserting the existence of, and the
departure path clears the Incharge with `WHERE incharge_user_id = <the departing member>` and emits
its notification from the update's own `RETURNING`, so the event follows from the write instead of
from a value read before it.

**A lost race is `conflict`, a new refusal code in this module**, and it is the only code here that
is not about the caller. The others answer "you may not" or "there is no such thing", which are
stable facts about the request; this one says the request was fine and the world moved, and the
remedy is to re-read and decide again. It must not be reported as `forbidden`, which reads as
permanent and which `refusalStatus` answers 404 - a caller could not tell a lost race from a club
they may not touch. Everything that is not `forbidden` or `not_found` is already a 409, which is
exactly what this is, so the mapping needed no change.

## Consequences

| | |
|---|---|
| Positive | **The ownerless club is unreachable through the domain layer**, proved by five tests that hold a real second transaction open on a second connection and commit it at the exact point between the read and the write - not by reasoning about a window. Two of them fail on the old code with the club at zero owners, one with an Incharge who is not in the car, one with an admin's choice silently discarded. The authority re-check inside `transferOwnership` also closes a smaller hole nobody was looking at: an ex-owner whose access context was loaded before they transferred the club could transfer it again. |
| Negative | **A client can now be refused for something it did nothing wrong to deserve**, and 409 `conflict` is a state the mobile app does not distinguish from any other failure today - it will say the action failed rather than "somebody changed this, pull to refresh". **`SELECT ... FOR UPDATE` introduces real lock waiting** on membership rows, which is bounded and short here but is new. And the guarantee is only as good as its coverage: this is a discipline applied to four commands, not a rule the database enforces, so a fifth command written later can reintroduce the defect and nothing will fail. |
| Follow-up needed | The mobile client should say what a 409 on a role change means, rather than reporting a generic failure. If the discipline turns out not to hold, the schema-level guard in the Alternatives table below is the escalation, and it needs its own decision. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Rely on the unique index, as the schema comment was read to imply | It forbids a second owner and says nothing about the first. Zero owners is a legal state and always was, which is now asserted out loud in `db/constraint-proof.sql` so the next reader finds the boundary rather than inferring the guarantee. |
| A trigger or a deferred constraint enforcing "at least one owner per club" | The genuinely stronger answer, and the one that would make this a property of the data rather than a discipline. It is also a statement about a **set** of rows rather than a row, so it needs a trigger or a deferred constraint over the whole club, it has to stay silent while `deleteClub` empties the table, and the transfer path deliberately passes through a moment with the Owner demoted. Each of those is answerable and none is answerable in passing. Not taken here, and deliberately not smuggled in alongside a defect fix. |
| `SERIALIZABLE` isolation for these transactions | Correct, and it moves the failure from a refusal we can word to a `40001` serialization failure the caller has to retry, on a connection pool shared with everything else. It also fixes the symptom by making every read a decision, which is a much larger claim about the whole server than "this write carries the role it read". |
| Re-read inside the transaction without `FOR UPDATE` | At READ COMMITTED a plain read inside a transaction sees the snapshot from the statement's start, so it does not see the concurrent commit, and the write still lands on the new row version. It looks like a fix, changes nothing, and would be believed. This is the failure mode 1 shape: a check that can never fire. |
| A guarded update on each row of the transfer instead of a lock | Two independent zero-row outcomes, one of which is the ownerless club again - demote the Owner, promote nobody. The two rows have to move as one decision, so the decision has to be taken while both are held. |
| Report the lost race as `forbidden` | Truthful in one of the three interleavings and misleading in the others, and `refusalStatus` maps it to 404, which is reserved for hiding the existence of things the caller may not see. A client cannot retry what it is told it may never do. |
| An advisory lock per club around every membership write | Serializes all of them behind one lock, including the many that touch unrelated rows, and puts the invariant somewhere no reader of the table will look. Row locks already say which rows are being protected. |

## Note

This needs an ADR because the fix looks like noise. `AND role = 'member'` in a `WHERE` clause and an
`ORDER BY` before a `FOR UPDATE` are the kind of thing a later reader tidies away as redundant,
particularly with a unique index sitting in the schema that appears to be holding the invariant
already. The thing to know before removing either is that the redundancy is the point: the guard is
what turns a stale decision into zero rows, and the ordering is what keeps two transfers in one club
from deadlocking. The test file that pins all of it is
`packages/server/src/test/stale-role-reads.test.ts`, and it is written so the interleaving is exact
rather than hopeful - if it ever passes without the guards, it has stopped testing anything.
