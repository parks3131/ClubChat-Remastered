# ADR-0012: Ship only a `sent` acknowledgement - no delivery receipts, read receipts, or presence

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

The reference architecture tracks `sent` → `delivered` → `read` per recipient per device, and
forwards receipts back to the sender. It also runs a presence service publishing online/offline
and "last seen".

[Chat](../PRD/05-chat.md) puts read receipts, delivery receipts, typing indicators and presence
explicitly **out of scope** for ClubChat. None of them was ever built, and none was missed.

Per-recipient receipt tracking is also the largest source of write amplification in the
reference design: for a 300-member club, one message produces up to 600 status writes.

## Decision

We will implement a single acknowledgement, `sent`, returned to the sender when the transaction
commits. We will not track delivery or read state per recipient, and we will not build a
presence service or expose online/offline anywhere in the UI.

## Consequences

| | |
|---|---|
| Positive | Removes an entire subsystem and its write amplification. Read cursors still exist, but as per-user unread bookkeeping rather than receipts - they are never shown to the sender. The connection registry survives as internal routing only, with no user-visible surface to keep consistent. |
| Negative | A sender cannot tell whether anyone has read their message. Accepted: this is a club coordination tool, not a one-to-one messenger, and the product never offered it. |
| Follow-up needed | None. If presence is ever wanted as a feature, the connection registry it would build on already exists. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Full sent/delivered/read per recipient | 600 status writes per message in a 300-member club, to power a feature the product explicitly does not want. |
| Read receipts in direct messages only | Superficially reasonable, since DMs are where receipts feel most natural. Rejected because it forks chat behaviour by scope, which is exactly what the channel abstraction exists to prevent, and it reintroduces per-recipient tracking for the one scope where the social cost of read receipts is highest. |
| Typing indicators | Requires a high-frequency ephemeral event stream for a cosmetic feature, and would be the only reason to keep a presence subsystem alive. |
