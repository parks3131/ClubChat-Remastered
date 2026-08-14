# ADR-0031: The Nudge cooldown is per meetup, and a past day cannot be nudged

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-14 |
| Deciders | parks3131 |
| Supersedes | [ADR-0030](0030-the-nudge-cooldown-is-a-constraint.md) |

## Context

[ADR-0030](0030-the-nudge-cooldown-is-a-constraint.md) made the Nudge cooldown **one per club per
hour**, and gave two reasons: per meetup would let an admin post a week of meetups and nudge all
seven, and per admin would let three admins take turns. The first reason is still true. It was
weighed against a cost nobody had felt yet, and a day of real use produced the counter-example:

> Four meetups in a day are four separate things to tell people about. Nudging the morning run
> silenced the evening social, and there was no way to say the second thing at all.

That is the shape of the mistake rather than a preference. A club-wide clock treats "how often may
this club interrupt its members" as the only question, and the founder's use surfaced a second one -
"has *this* meetup been announced" - which the same clock cannot answer.

Two further facts arrived with it, and the second is new rather than a reversal:

- **A meetup whose day has been should not be nudgeable at all.** There is nothing left to tell
  anybody about a run that has run, so the bell on a past day is noise at best.
- The per-club rule made `meetup_id`'s nullability load-bearing in a way that inverts here. Under
  ADR-0030 a nudge had to keep blocking after its meetup was deleted, or deleting the meetup handed
  back an early nudge. Under this one, a nudge whose meetup is gone should block nothing.

## Decision

**We will move the cooldown's first operand from the club to the meetup, and refuse to nudge a
meetup whose date is in the past.**

```
meetup_nudges
  EXCLUDE USING gist (
    meetup_id  WITH =,          -- was club_id
    tstzrange(created_at, cooldown_until) WITH &&
  )
```

**Everything ADR-0030 decided about the mechanism stands and is not re-opened**: still an
exclusion constraint rather than a read-then-write, because two admins tapping *the same* bell in
the same second is still the case a read loses; still `cooldown_until` stored rather than computed,
because `timestamptz + interval` is `STABLE` and an index expression must be `IMMUTABLE`; still
`btree_gist`. Only the operand moves.

Three consequences follow from that one change, and each is a decision:

1. **`meetup_id` is nullable, and a NULL operand takes a row out of an exclusion constraint.** That
   is now the behaviour we want rather than a hole to close: a nudge whose meetup was deleted
   blocks nothing, because there is no meetup left to nudge.
2. **"Not a past day" is a handler check, not a constraint** - deliberately, and it is the one
   place in this feature where that is the right answer. Whether a date is in the past changes with
   the clock, so it is not immutable and cannot live in an index. There is also no race to lose:
   two admins nudging a past meetup are both simply wrong, where two admins nudging a live one are
   competing for one slot.
3. **The comparison is by DATE, not by instant.** This morning's run is still nudgeable this
   evening. A bell that died at 06:31 because the meetup was at 06:30 would be the more surprising
   of the two rules, and "the day has been" is what a person means by it.

## Consequences

| | |
|---|---|
| Positive | **The feature can now say the thing it exists to say.** A club with a morning session and an evening social can announce both, which the previous rule made impossible rather than merely awkward. Each bell also reports its own state, so an admin looking at a row learns about that row instead of about the club. And the week read carries the answer per meetup, so the client cannot reach a different one by comparing dates itself. |
| Negative | **ADR-0030's first rejected alternative is now the decision, and its objection is unanswered**: an admin who posts four meetups can fire four pushes back to back. Nothing prevents it. The judgement is that the club-wide clock prevented a legitimate act in order to prevent a hypothetical one, and that the hypothetical stays hypothetical - but if members start turning push off, this is the entry to re-read, and the answer is probably a per-club ceiling *in addition to* the per-meetup one rather than instead of it. **The week read also gained a lateral join** where it previously did none. |
| Follow-up needed | If a club-wide ceiling becomes necessary, it is a second constraint and not a replacement - the two rules answer different questions and both would be true. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep the per-club hour | It is what this supersedes. It prevented a real act - announcing the second of two meetups on one day - to prevent a burst nobody has yet produced. |
| Per meetup, plus a club-wide ceiling | Offered when Nudge was designed and declined then; declined again here for the same reason, which is that a greyed bell would have two possible causes and the screen would have to say which. Worth building the moment there is evidence of the burst, and not before. |
| Per meetup per admin | Three admins take turns on one meetup and the club gets three pushes about the same thing, which is the worst of both rules. |
| Refuse by instant rather than by date | A 06:30 meetup would stop being nudgeable at 06:31, so an admin who wanted to say "we are still on for this morning" at 06:00 could, and at 07:00 could not, with nothing on screen explaining the difference. |
| Hide the bell on a past day and rely on that | The client would be the only thing enforcing it, which `AGENTS.md` non-negotiable 6 exists to prevent. The server refuses, and the client hides the control because the server told it to. |

## Note

The reason this is a supersession rather than an edit is that ADR-0030's reasoning was not wrong -
it was reasoning about one question when there were two. Anybody reconsidering the burst problem
should read both: 0030 for why the limit is a constraint and not a handler check, which still
holds, and this one for why the thing being limited is a meetup rather than a club.
