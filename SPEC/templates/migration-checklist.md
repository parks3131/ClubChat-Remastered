# Migration checklist

> `AGENTS.md` non-negotiable 2: **never edit a migration that has already been applied.** A
> correction is always a new numbered migration. Migrations are the schema's source of truth and
> must replay cleanly from zero.

## Before writing it

- [ ] **Does this DROP or RENAME anything?** If so, stop and read
      [Deployment](../TECH/21-deployment.md) rule 4 before writing a line. A drop must not ship in
      the same release as the code that stops using it. Fly runs `release_command` **before**
      swapping machines, so between the migration applying and the new image serving, the old
      code is querying a column that no longer exists - and that window covers every read *and
      write* that touched it, not the one endpoint you were thinking about.

      Expand, migrate, contract: the code that stops reading it goes out first, the drop follows in
      a later release. Missed on 2026-08-25 by writing the drop without opening this file; a peer
      session caught it at deploy time. See [`bugs/`](../../bugs/2026-08-25-nudge-said-null.md).

- [ ] **Does anything else deploy alongside it?** The worker and the gateway are separate Fly apps
      with no `release_command` of their own. A change to an outbox payload is written by the api
      and read by the worker, so shipping one without the other means a live event whose reader
      does not understand it.

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
- [ ] **Does this build an index on a table that already has rows in it, and if so, is the
      write freeze it costs acceptable?** A plain `CREATE INDEX` holds `SHARE` on the table
      until the build finishes, which blocks every writer for that long - readers are fine.
      On an empty table that is free, which is why `0016` and `0018` built indexes on
      `messages` without anyone noticing.

      **`CREATE INDEX CONCURRENTLY` is the alternative and it cannot run inside a transaction
      block**, so it is not available from a generated migration: drizzle-kit emits plain
      `CREATE INDEX`, and the migrator wraps every file in a transaction. Getting the
      concurrent build means taking the statement out of the migration and running it by hand
      against each environment, and accepting that it can fail and leave an `INVALID` index
      behind that has to be dropped and rebuilt. That is a real cost, so it is a judgement
      rather than a default.

      State which one you took and why, in the migration's own header. The number that
      decides it is the row count of that table in production, not in development.

## Alongside the migration

- [ ] Type definitions updated in the **same change**.
- [ ] The relevant spec under `SPEC/` updated in the same change.
- [ ] If the decision was architectural and non-obvious, an
      [ADR](adr-template.md) written.

## Proof

- [ ] Replayed from zero against an empty database, cleanly.
- [ ] Attempted to violate each new constraint directly in SQL and watched it be rejected.
- [ ] Ran the [authorization checklist](authorization-checklist.md) if this added a resource.
