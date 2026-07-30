# ADR-0014: A channel references its scope, and the scope never references the channel

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-29 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

[Data model](../TECH/09-data-model.md) originally gave every scope owner a `channel_id`
column: `races.channel_id`, `eboard_channels.channel_id`, and `dm_conversations.channel_id`.
The `channels` table simultaneously carries `scope` and `scope_id`, which point back the other
way.

That is the same relationship stored twice, in opposite directions, with nothing keeping the
two copies honest. `races.channel_id` could name channel A while the row with
`scope_id = <that race>` is channel B, and no constraint would object. Every read then has to
pick a direction, and two readers picking differently is a bug nobody would find quickly
because both answers look plausible.

It also duplicates work the channel abstraction already does. `channels` has
`UNIQUE (scope, scope_id)`, so "the channel for this race" is already exactly one row and
already unambiguous.

This surfaced while building Phase 2, when the race tables were written without the column and
the divergence from the spec had to be either corrected or justified.

## Decision

**A channel references its scope. The scope never references the channel.** `channels.scope`
plus `channels.scope_id` is the only representation of that relationship, and no
`channel_id` column exists on `races`, `eboard_channels`, or `dm_conversations`.

Looking up a scope's channel is
`SELECT id FROM channels WHERE scope = $scope AND scope_id = $id`, served by the existing
unique index.

## Consequences

| | |
|---|---|
| Positive | One representation, so the two directions cannot disagree. Adding a fifth scope needs no new column on the owning table, which is the property [Domain model](../PRD/01-domain-model.md)'s abstraction test is actually measuring - a scope that required a schema change on its owner would be a fork of the channel concept wearing a different name. The `UNIQUE (scope, scope_id)` index that already had to exist now earns its keep as the lookup path rather than only as a constraint. |
| Negative | Finding a scope's channel is an indexed lookup rather than following a foreign key on a row already in hand. At ClubChat's volume that is not measurable, and the query is by unique index. It also means a scope row alone does not tell you its channel id, so handlers that need both fetch both - which is honest about there being two rows involved. |
| Follow-up needed | None. Phase 3.5 must not add `dm_conversations.channel_id` when direct messages arrive; the same lookup applies. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep `channel_id` on each scope owner, as originally specified | Two copies of one relationship with no constraint tying them together. The failure is silent and reads as data corruption rather than as a bug: a race whose chat is one channel by one query and a different channel by another. |
| Keep both, and add a constraint keeping them consistent | Postgres cannot express "this column must equal the id of the row that points back at me" without a trigger or a composite key gymnastics that would be far more machinery than deleting the column. The composite-FK trick used for `car_group_members` and `poll_votes` works because the denormalised value is a discriminator on the parent, not a cross-reference to the child. |
| Drop `scope`/`scope_id` and keep only `channel_id` on the owners | Inverts the problem rather than removing it. The channel is the shared thing that every scope reuses, so it has to be able to say what it belongs to without consulting four tables to find out which one claims it. It would also make "list every channel this user can access" a four-way union over owner tables instead of one predicate on `channels`. |

## Note

This is a normalisation decision, not a performance one, and it is recorded because the
original spec said otherwise. The `channel_id` columns were not an error in the spec so much as
a habit carried over from a schema sketched before `UNIQUE (scope, scope_id)` existed - once the
channel can identify its own scope unambiguously, the reverse pointer has nothing left to do.
