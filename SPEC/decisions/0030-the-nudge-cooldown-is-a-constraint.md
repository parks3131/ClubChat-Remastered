# ADR-0030: The Nudge cooldown is an exclusion constraint, not a check in the handler

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-14 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

[Weekly Meetups](../PRD/08-weekly-meetups.md) rule 11 says creating a meetup notifies nobody, and
that silence is the reason it is a separate surface from the calendar rather than a view over it.
**Nudge is the one deliberate exception**: an admin taps a bell and one meetup is pushed to the
whole club. It does not weaken the rule - seven meetups posted on a Sunday still fire zero
notifications - it turns the silence from a wall into a default, because a person chose to send
this one.

That makes the rate limit the whole feature. A bell that can be tapped freely is how members turn
push off, which costs far more than the feature is worth, and the settled rule is **one nudge per
club per hour** - not per meetup, which would let an admin post seven meetups and nudge all seven,
and not per admin, which would let three admins take turns.

The obvious implementation is to read the last nudge and refuse if it is recent. **That loses the
case it exists for.** Two admins tapping the bell in the same second both read an empty cooldown,
both insert, and the club gets two pushes - and a club with two or three active admins reacting to
the same change is exactly when this gets exercised. This repo already has a rule about that,
stated in [ADR-0028](0028-reactions-come-from-a-catalog-table.md): *an invariant belongs in a
constraint rather than a handler, because a handler races and a constraint does not.*

## Decision

**We will store each nudge as a row and enforce the hour with a Postgres `EXCLUDE` constraint.**

```
meetup_nudges   id, club_id, meetup_id, actor_id, created_at, cooldown_until
                EXCLUDE USING gist (
                  club_id WITH =,
                  tstzrange(created_at, cooldown_until) WITH &&
                )
```

Four things about that shape, each of which is a decision rather than a detail:

1. **`cooldown_until` is a stored column, not `created_at + interval '1 hour'`.** An exclusion
   constraint is an index, and an index expression must be `IMMUTABLE`. **`timestamptz + interval`
   is `STABLE`** - it reads the session's time zone - so the arithmetic form is rejected outright
   with *"functions in index expression must be marked IMMUTABLE"*. Two plain columns make
   `tstzrange` immutable and the constraint legal. It also makes the hour **data rather than
   schema**: shortening the cooldown becomes a new default, not a constraint rewrite.
2. **The handler still reads the cooldown first**, and that read is not redundant. It is what lets
   the refusal say *when* the bell returns. "You cannot" gets tapped again a minute later; "not
   until 10:00" does not. The constraint is for correctness, the read is for the sentence.
3. **`meetup_id` is nullable and clears rather than cascades.** The cooldown is a fact about the
   **club**, so deleting the meetup that was nudged must not hand back an early nudge.
4. **This adds `btree_gist`**, the repo's first `CREATE EXTENSION`. It is core Postgres contrib and
   [supported on Neon](https://neon.com/docs/extensions/btree_gist), which is where this runs in
   production ([`TECH/15`](../TECH/15-stack-and-hosting.md)).

## Consequences

| | |
|---|---|
| Positive | **The rate limit is true rather than usually true.** Two admins tapping together produces one push and one `cooling_down`, proved by a test that fires both concurrently rather than by reasoning about the window. The rule is also legible in one place - reading `\d meetup_nudges` tells you the policy, where a handler check would need finding. And because the row survives its meetup, the cooldown cannot be reset by deleting and re-adding. |
| Negative | **A Postgres extension is now a deployment dependency**, and a migration that fails on a provider without `btree_gist` fails at the worst moment. **Drizzle cannot express an exclusion constraint**, so it lives in raw SQL in the migration and the schema file says so in a comment - which means `schema.ts` alone does not describe the table's rules, and somebody reading only that file would conclude there are none. The catch in the handler also has to match the driver's error rather than a type, and drizzle wraps it: the pg code sits on `.cause`, not on the surfaced error. |
| Follow-up needed | If the hour proves wrong in practice, it changes in two places that must agree - the column default and nothing else, since the handler reads the stored value rather than recomputing it. **Nudge writes no chat card on purpose**; if a nudge should also leave a line in club chat, that is a new decision and not an oversight. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Read the last nudge in the handler and refuse if recent | The read-then-write that loses exactly the case the limit exists for. Two admins reacting to the same cancelled session is not an exotic race; it is the normal way a club with three admins behaves, and it would produce double pushes intermittently and unreproducibly. |
| A `last_nudged_at` column on `clubs`, updated in place | Closes the race with a row lock, and throws away who nudged what and when. It also makes "has this club ever been nudged" and "is it cooling down" the same column, so the history that would answer *is this feature being overused* never exists. |
| `UNIQUE (club_id, date_trunc('hour', created_at))` | Needs no extension, and enforces a different rule: nudges at 9:59 and 10:01 both pass because they are in different clock hours. That is not "once an hour" and would read as a bug the first time it happened. |
| Per-meetup cooldown | Rejected at the product level, not the technical one: an admin posting a week of meetups on Sunday could nudge all seven back to back, which is precisely the burst the limit exists to prevent. |
| Per-admin cooldown | Three admins take turns and the club gets three pushes an hour. The limit has to be on the thing being protected - members' phones - and that is a club-wide quantity. |
| No limit, and trust admins | The failure is not an admin being malicious; it is a club with several admins all reacting to the same change within a minute of each other. Nobody does anything wrong and everybody gets four pushes. |

## Note

This needs an ADR because the constraint is easy to mistake for over-engineering: a cooldown looks
like handler logic, and `EXCLUDE USING gist` with a `tstzrange` is unusual enough that a reader may
try to simplify it away. The thing to know before doing that is that the simplification has a name -
read-then-write - and that the two-admin case it fails is the case Nudge was rate-limited for in
the first place.
