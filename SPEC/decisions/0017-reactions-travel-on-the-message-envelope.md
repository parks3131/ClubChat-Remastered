# ADR-0017: Reactions travel on the message envelope, and updates carry full sets

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-30 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

Reactions were specified from the start - [Chat](../PRD/05-chat.md) lists them in scope and
[Data model](../TECH/09-data-model.md) has carried a `message_reactions` table since Phase 0 -
and were never built. Building them raised two questions the specs do not answer, and the answers
interact.

**Where do reactions live on the way to a client?** Either on the `MessageEnvelope` alongside the
message, or behind their own endpoint fetched per channel.

**How does a change reach an open client?** The `msg.update` frame has existed in
[Protocol](../TECH/10-protocol.md) since Phase 0 with `pinned` and `deletedAt` fields, and had
**no producer at all** - nothing ever sent one, and the client's handler was `case 'msg.update':
break;`. Reactions are its first real user, so its payload shape was still open.

The second question has a trap. A reaction delta (`{emoji, userId, added}`) is the small,
obvious payload. Messages can afford a delta-shaped transport because they carry `seq`, and the
gap rule turns a lost or reordered frame into a detected hole and a sync. **A reaction delta has
no sequence of its own.** One dropped frame leaves a client permanently believing the wrong
people reacted, with nothing anywhere able to detect it - the same class of silent divergence
the whole channel-log design exists to prevent, reintroduced through a side door.

## Decision

**Reactions ride on the message envelope, and every update carries the full reaction set for
that message rather than a delta.**

Concretely:

- `MessageEnvelope` gains `reactions: MessageReaction[]`, where a `MessageReaction` is
  `{emoji, userIds}`. Every read that returns messages returns their reactions with them -
  history, sync, and the moderator's context window.
- The local SQLite cache stores them as a JSON column on the message row, so they survive
  airplane mode with the messages they belong to.
- `msg.update` carries `{channelId, seq, pinned?, reactions?, deletedAt?}` - only the fields that
  changed, with the reaction field being the complete set when present.
- The worker's handler **re-reads the set at publish time** rather than trusting the event
  payload, which makes it idempotent for free: a redelivered event republishes current truth.
- `userIds` travels rather than a count, so one viewer-agnostic publish serves every recipient
  and each client derives its own "did I react" locally through `reactionSummary`.

## Consequences

| | |
|---|---|
| Positive | Reactions work offline, which is the whole reason for the envelope choice - Phase 3 made chat readable in airplane mode, and reactions that vanished there would be a half-feature. A lost update is self-healing: the next update, sync or history page carries the truth, so this transport needs no ordering guarantee and no sequence of its own. One publish serves every viewer. And `msg.update` finally has a producer, which also let pins and tombstones start reaching open clients - both were specified from Phase 0 and neither was live. |
| Negative | One extra query per page of history, batched over the page rather than per message. `userIds` is O(reactors) on the wire, so a 300-member club piling onto one message sends 300 ids in each update - acceptable at this scale and by spec, since reactions are public, but it is the number to watch if clubs get much larger. The right fix then is a cap plus a who-reacted fetch, not a delta. |
| Follow-up needed | None. If the emoji set widens to a full picker ([Chat](../PRD/05-chat.md) open question), nothing here changes shape: the emoji is already a string end to end, and only the fixed render order becomes a different rule. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| A separate `/channels/:id/reactions` endpoint | Needs its own sync path, its own cache and its own offline story, all parallel to the ones messages already have. It also creates a window where a client holds messages and not their reactions, which has no correct rendering - either the pills flicker in late or the message waits on a second request. |
| Deltas on `msg.update` | Smaller, and silently wrong. No sequence means a dropped frame is undetectable and permanent. The delta would need its own ordering scheme to be safe, at which point it is more machinery than the full set, for less. |
| A maintained count column, like `poll_options.vote_count` | That column exists because vote *counts* are public while voter *identity* is gated, so the count cannot be derived from rows the viewer may not read. Reactions are public in both respects, so the count is `count(*)` over rows the viewer can already see and a maintained copy would be a second source of truth for nothing. |
| Publishing `{emoji, count}` instead of `userIds` | Cannot answer "did I react", so every client would need a second per-viewer request to render its own pills - turning one publish into N requests, which is the exact shape of the media problem ADR-0007 was written about. |
| Publishing per-recipient payloads with `mine` resolved server-side | Defeats the single fan-out. The gateway forwards one encoded frame to every socket on a channel; making it per-viewer means encoding per socket. |
| Running updates through the gap rule, like `msg.new` | An update names an existing `seq` rather than extending the log, so it can neither create nor reveal a hole - and every reaction on an older message would look like one, triggering a spurious sync per tap. |

## Note

The reason this needs an ADR at all is the delta question. A reader coming to
`MsgUpdate.reactions` will see a full array where a delta would obviously be smaller, and the
reason it is not a delta is a property of the transport rather than of reactions. That reasoning
has to be written down somewhere it will be found before somebody optimises it.
