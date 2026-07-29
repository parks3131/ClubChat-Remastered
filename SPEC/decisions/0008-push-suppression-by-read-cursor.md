# ADR-0008: Suppress push notifications by read cursor, never by connection liveness

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

The reference architecture decides whether to send a push by checking whether the recipient has
a live connection in the registry cache. That registry is TTL-based and refreshed by heartbeat.

Applied here, the arithmetic is fatal. With a 300s TTL, a 30s heartbeat and a 90s reaper
window, a phone that dies, loses signal, or is force-quit leaves a registry entry alive for up
to 210 seconds *after the socket is already gone*. Every message in that window sees a "live
session" and sends no push.

That is silent missed-notification behaviour, in the subsystem
[Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) calls the single biggest
functional gap in v1.

## Decision

We will decide push suppression by the recipient's `read_cursors.last_read_seq`, re-read after a
short deferral, and we will never consult connection liveness for this purpose. The connection
registry routes publishes and does nothing else.

## Consequences

| | |
|---|---|
| Positive | `last_read_seq >= N` is a fact committed to Postgres: this member demonstrably saw the message. It degrades correctly under failure - wipe Redis and push still works, because push never consulted Redis. Reading on a laptop correctly silences the phone, because the cursor is per member. |
| Negative | A short delay before push evaluation, so a genuinely offline recipient is notified seconds later than the theoretical minimum. Far below the threshold at which anyone notices a notification being late. |
| Follow-up needed | Push audience must be enumerated per device rather than per user, so a member with a laptop open and a phone in a pocket still gets the phone notification. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Suppress on connection liveness, as in the reference design | A live socket is not proof of receipt. The TTL race silently swallows notifications, which is the worst possible failure mode: no error, no log, and the user simply never learns something happened. |
| Suppress on liveness with a much shorter TTL | Shrinks the window without closing it, and trades it for registry churn and false negatives when a heartbeat is merely late. The cursor is a fact; liveness is a guess with a shorter fuse. |
| No deferral, evaluate the cursor immediately | Loses a race against the recipient's own read acknowledgement, pushing to someone actively looking at the message. |
| No suppression at all, always push | Notifies people for messages they just read on another device. The mechanism to avoid it already exists and is nearly free. |
