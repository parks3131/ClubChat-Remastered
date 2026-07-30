# The channel log

**This is the single most important decision in the document.**

WhatsApp treats the server as a relay: a message is stored only until every recipient device
acknowledges it, then deleted (the transcript's 30-day retention is for *undelivered*
messages). ClubChat's entire product bet is the opposite - durable, revisitable history is the
value ([Overview](../PRD/00-overview.md): "Make a race's logistics survive as durable, revisitable structure instead
of a disposable group chat").

So we invert the storage model:

| | WhatsApp | ClubChat |
|---|---|---|
| Authoritative store | The recipient's device | **The server's channel log** |
| Server role | Relay + temporary inbox | **System of record** |
| Per-recipient copy | Yes - one inbox row per recipient | **No - one row per message, ever** |
| Delivery model | Fan-out on write to N inboxes | **Fan-out on write of a wake signal; fan-out on read from the log** |
| "What did I miss?" | Replay my undelivered inbox | **`SELECT … WHERE seq > my_cursor`** |
| Deletion | On delivery | Soft delete with tombstone, never removed ([Domain model](../PRD/01-domain-model.md) invariant 7) |

### Sequence numbers

Every channel carries `last_seq`. Every message gets `seq = last_seq + 1`, allocated inside the
insert transaction:

```sql
BEGIN;
  UPDATE channels SET last_seq = last_seq + 1
   WHERE id = $channel RETURNING last_seq;      -- row lock, serializes this channel
  INSERT INTO messages (channel_id, seq, …) VALUES ($channel, $seq, …);
  INSERT INTO outbox (…) VALUES (…);            -- same transaction
COMMIT;
```

> **Invariant: the sequence-allocating transaction performs no I/O.**
>
> The `UPDATE channels SET last_seq = last_seq + 1` takes a row lock that is held **until
> commit**, serializing every send to that channel for the duration. No network call, object-
> storage `HEAD`, push dispatch, or external HTTP may appear inside this transaction, ever.
> Media is validated at `/media/:id/complete` ([Media pipeline](07-media-pipeline.md)), *before* the message referencing it is
> sent. Everything else goes through the outbox.
>
> This is stated explicitly because the lock is invisible at the call site, and a well-meaning
> "just verify the attachment exists before we commit" is exactly the change that would
> serialize an entire channel behind a network round trip.

- **Gapless.** A rollback undoes the counter, so `seq` has no holes. (A Postgres `SEQUENCE`
  would leave gaps - it is non-transactional. Do not use one here.)
- **Strictly ordered per channel.** The row lock serializes concurrent sends to one channel.
  At ClubChat's volume (a busy channel sees single-digit messages/sec) this contention is
  irrelevant; across channels there is none.
- **Not global.** `seq` is meaningful only within its channel. Never compare across channels.

This one column is [Roadmap](../PRD/17-roadmap-and-open-questions.md) debt item 3, and it makes the following free:

| Problem in the old build | Solution with `seq` |
|---|---|
| "What did I miss after backgrounding?" ([Engineering pitfalls](14-engineering-pitfalls.md) 25, unfixed, silent message loss) | `GET /channels/:id/sync?since=<seq>` |
| Paging backward without losing scroll position ([Engineering pitfalls](14-engineering-pitfalls.md) 9) | `WHERE seq < $cursor ORDER BY seq DESC LIMIT 40` |
| Open on the first unread message ([Chat](../PRD/05-chat.md) rule 3) | `first_unread = read_cursor + 1`, fetch a window around it |
| Unread count, computed not stored ([Cross-cutting UX](../PRD/16-cross-cutting-ux.md) performance) | `channel.last_seq − cursor.last_read_seq` - O(1), no row scan |
| Jump-to-message window ([Chat](../PRD/05-chat.md) edge case) | `WHERE seq BETWEEN $target−20 AND $target+20` |
| Highlights silently losing pins past the loaded window ([Roadmap](../PRD/17-roadmap-and-open-questions.md) debt 6) | Server-side `WHERE pinned` over the whole channel, not a client slice |
| Ordering by timestamp with clock skew | Order by `seq`. Timestamps are for display only. |

### Read cursors

```
read_cursors(user_id, channel_id) → last_read_seq
```

Opening a chat sets `last_read_seq = channel.last_seq`. That is the only thing that clears an
unread count ([Notifications](../PRD/12-notifications.md) rule 3). The notification badge is
`count(discrete unread) + count(channels where last_seq > last_read_seq)` - one per channel,
never a per-message sum, exactly as the brief requires.

### Idempotency

Every send carries a client-generated `client_msg_id` (UUID v7, generated on device *before*
the first attempt).

```sql
UNIQUE (channel_id, sender_id, client_msg_id)
```

A retry after a flaky network hits the unique index; the handler returns the existing row's
`seq` instead of erroring. This is [Roadmap](../PRD/17-roadmap-and-open-questions.md) debt item 4, and it is what makes the client's send
outbox safe to retry aggressively.

### Acknowledgement protocol - narrowed on purpose

The transcript specifies sent → delivered → read, with per-recipient tracking and receipts
forwarded back to the sender. [Chat](../PRD/05-chat.md) puts **read receipts and delivery receipts out of
scope**. So ClubChat implements exactly one ack:

| State | Meaning | Who tracks it |
|---|---|---|
| **pending** | In the client's outbox, not yet acknowledged | Client only |
| **sent** | Server assigned a `seq` and committed it | Server ack → client replaces optimistic row |
| **failed** | Server rejected, or retries exhausted | Client only, rendered visibly |

No `delivered`, no `read`, no per-recipient status rows. This removes a per-recipient write
amplification of N per message - the largest single cost in the transcript's design - and it
costs the product nothing, because the product never displayed those states.

Read cursors still exist, but they are *per-user unread bookkeeping*, not receipts: they are
never shown to the sender.

### 5.6 The fourth scope: direct messages

[Domain model](../PRD/01-domain-model.md) sets an explicit test for the channel abstraction:

> Adding a fourth scope must cost one membership predicate, one admin predicate, one
> poll-access predicate, one branch per notification audience rule, and a set of thin screen
> wrappers. Nothing shared should change. If a fourth scope would require forking chat, the
> abstraction has been broken.

Direct messages are that fourth scope, and they pass the test. `scope = 'dm'`, a
`dm_conversations` row holding exactly two participants, one new predicate `isDmParticipant`.

**Unchanged, with no DM-specific code at all:** sequence allocation, gap detection, the sync
engine, read cursors and unread counts, the send outbox and idempotency, pins, reactions,
mentions, the gallery, the media pipeline, push fan-out and cursor-based suppression, and every
failure-mode guarantee in [Failure modes](11-failure-modes.md). That is the entire return on the channel abstraction, collected
in one feature.

Three things genuinely change.

**1. `channels.club_id` becomes nullable.** Every other scope belongs to a club. A DM cannot,
because two people who share two clubs would otherwise get two separate threads with the same
person. `notifications.club_id` goes nullable for the same reason, and every audience query has
to tolerate it. Enforced with a check constraint so the nullability cannot be abused by the
other three scopes:

```sql
CHECK ((club_id IS NULL) = (scope = 'dm'))
```

**2. Nobody is an admin in a DM.** `isChannelAdmin` is constant-false for the scope, which
removes announcements (admin-gated), polls (creation is admin-gated), and role system messages.
Pins stay - both participants may pin, and it costs nothing. This is precisely the "one admin
predicate" the abstraction test predicted.

**3. Reporting has no destination.** In club, race and Eboard chat a report surfaces to that
space's admins. A DM has no admins, so a report written the current way goes nowhere and is
silently discarded. This is a defect, not an inconvenience, and [Authorization](05-authorization.md) defines where those reports
go instead.

**Eligibility: participants must share at least one club.** This follows the privacy rule in [Cross-cutting UX](../PRD/16-cross-cutting-ux.md), which
already restricts profile visibility to people who share a club, and it keeps the abuse surface
bounded by club membership rather than by the whole user table. Losing the last shared club does
**not** delete the thread - it becomes read-only, since deleting history would tear holes in a
conversation the same way hard-deleting a message does ([Domain model](../PRD/01-domain-model.md) invariant 7).

> **DMs change the safety requirements of the product, and this is the most important sentence
> in this section.** [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) currently lists "block or mute between members" as *important,
> not blocking*, noting it is "notable for a product that will include minors." That assessment
> was correct while every conversation sat inside a club with admins who could see it and remove
> people from it. A private one-to-one channel, with no admin party to it, no block, and no
> report destination, is a different risk class. **Blocking and a report destination ship in the
> same release as DMs, not after it.**
