# ADR-0009: Add direct messages as a fourth channel scope, restricted to shared clubs

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

Direct messages were an explicit **non-goal** in v1, on the reasoning that every conversation is
scoped to a club, a race, or an Eboard. That position was reversed on 2026-07-28.

[Domain model](../PRD/01-domain-model.md) sets a test for exactly this situation: adding a
fourth scope must cost one membership predicate, one admin predicate, one poll-access predicate,
one branch per notification audience rule, and thin screen wrappers - and if it would require
forking chat, the abstraction has been broken.

## Decision

We will add direct messages as `scope = 'dm'` on the existing channel abstraction, restricted to
members who share at least one club, with exactly one thread per pair of people regardless of
how many clubs they share. **Group chat remains the primary feature; DMs are additive.**

## Consequences

| | |
|---|---|
| Positive | The abstraction test held. Sequencing, sync, cursors, unread counts, pins, reactions, gallery, media and push fan-out all carry over untouched. `isChannelAdmin` returning false for the scope removes announcements and polls automatically, because both were already gated on that one predicate. |
| Negative | `channels.club_id` becomes nullable, and every audience query must tolerate it. A DM has no admin, so a report has nowhere to go by the existing mechanism. |
| Follow-up needed | **Member blocking, conversation mute, and a platform moderation queue ship in the same release**, not after it. A private one-to-one channel with no admin party to it, no block, and nowhere for a report to go is a materially different risk class in a product that will include minors. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Global DMs, any user to any user | Contradicts the existing privacy rule that profiles are visible only to people who share a club, and opens the abuse surface to the entire user table rather than to club membership. |
| One DM thread per shared club | Two people in three clubs would hold three separate conversations with each other, which is not how anyone thinks about talking to a person. |
| Keep DMs a non-goal | A legitimate position, and the v1 one. Reversed because the small coordination exchanges DMs serve currently leave the app entirely for SMS, taking their context with them. |
| Ship DMs first, add blocking later | Rejected on safety grounds. The window between the two is precisely when the risk exists, and there is no way to know in advance how long that window lasts. |
