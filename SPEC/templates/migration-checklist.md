# Migration checklist

> `AGENTS.md` non-negotiable 2: **never edit a migration that has already been applied.** A
> correction is always a new numbered migration. Migrations are the schema's source of truth and
> must replay cleanly from zero.

## Before writing it

- [ ] Does an existing table already model this? The domain is deliberately pattern-heavy;
      something that looks novel is usually a sign an existing abstraction was not understood.
- [ ] Which **invariant** does this data carry? Every invariant in
      [Domain model](../PRD/01-domain-model.md) is enforced at the data layer, not in the UI.

## Constraints - the part that is usually skipped

- [ ] Is every invariant expressed as a constraint rather than as application code?
      The existing patterns:
      - exactly one of something per parent → `UNIQUE (parent_id) WHERE <predicate>`
      - one row per unordered pair → canonical ordering `CHECK (a < b)` plus `UNIQUE (a, b)`
      - one membership per person per scope → denormalised scope id plus a **composite foreign
        key** back to the parent, so the denormalised value cannot drift
      - idempotency → `UNIQUE (scope, actor, client_supplied_id)`
- [ ] **Are all columns in a unique index `NOT NULL`?** Postgres treats `NULL`s as distinct, so
      one nullable column silently defeats the whole constraint. This is the system-message
      idempotency trap: use a sentinel row, never `NULL`.
- [ ] Does a nullable column need a `CHECK` tying its nullability to a discriminator, so only
      the intended case can exploit it? (`club_id` nullable only when `scope = 'dm'`.)
- [ ] Are cascade deletes declared, and do they reach *every* child - chat history, rosters,
      polls, notifications, media rows?

## Ordering and locks

- [ ] Does this run inside the sequence-allocating transaction? If so, **no I/O**: the channel
      row lock is held until commit.
- [ ] If two rows must change in a fixed order to satisfy a constraint, is that order explicit
      and commented? (Ownership transfer demotes before promoting, because the one-owner
      constraint is checked per statement.)

## Alongside the migration

- [ ] Type definitions updated in the **same change**.
- [ ] The relevant spec under `SPEC/` updated in the same change.
- [ ] If the decision was architectural and non-obvious, an
      [ADR](adr-template.md) written.

## Proof

- [ ] Replayed from zero against an empty database, cleanly.
- [ ] Attempted to violate each new constraint directly in SQL and watched it be rejected.
- [ ] Ran the [authorization checklist](authorization-checklist.md) if this added a resource.
