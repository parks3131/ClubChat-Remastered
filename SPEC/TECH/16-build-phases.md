# Build phases and debt paid off

## Debt paid off by this design

Mapping [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) "architectural debt worth designing away" to where it is handled:

| # | Debt | Resolved by |
|---|---|---|
| 1 | Realtime reconciliation on reconnect and foreground | [Client architecture](08-client-architecture.md) sync engine + [Channel log](02-channel-log.md) sequence numbers |
| 2 | Filtered subscriptions | [Connection layer](01-connection-layer.md) per-channel topics, authorized once at subscribe |
| 3 | Message sequence numbers | [Channel log](02-channel-log.md) - the core of the design |
| 4 | Client-generated idempotency keys | [Channel log](02-channel-log.md) `client_msg_id` unique index |
| 5 | Denormalized/capped unread counts; collapsed calendar feed | [Channel log](02-channel-log.md) O(1) cursor arithmetic; a single merged calendar endpoint replaces per-club-per-feature reads |
| 6 | Highlights losing pins past the loaded window | [Data model](09-data-model.md) partial indexes; server-side query over the whole channel |
| 7 | Media cost - N viewers = N origin downloads | [Media pipeline](07-media-pipeline.md) hour-aligned signed URLs → one shared CDN cache entry |
| 8 | Storage cleanup | [Effects engine](04-effects-engine.md) nightly GC job driven by `media_objects` ownership |
| 9 | File size and MIME limits | [Media pipeline](07-media-pipeline.md) enforced at intent and re-verified at complete |
| 10 | Notification retention | [Effects engine](04-effects-engine.md) nightly archival job |
| 11 | Localisation of notification bodies | Store `type` + structured `params`; render at read time. *(Design it in now - retrofitting means rewriting every historical row.)* |
| 12 | Rate limiting beyond messages | [Authorization](05-authorization.md) extended to reports, reactions, join requests, presign |
| 13 | Backups and dev/prod parity | Managed Postgres PITR; migrations from one source of truth |

And from [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) "blocking a real release":

| Gap | Resolved by |
|---|---|
| Push notifications | [Notifications and push](06-notifications-and-push.md) - designed into the fan-out from day one, as the brief instructs |
| Error monitoring | [Stack and hosting](15-stack-and-hosting.md) - Sentry in the error path from the first commit |
| Accessibility | Not architectural. Client work, tracked separately, started early rather than retrofitted |
| Legal review | Not architectural. **Note the new obligation from [decisions/](../decisions/): without E2E, the Privacy Policy must state that message content is readable by the service.** |

---

## Build phases

Each phase ends with something demonstrably working end-to-end. No phase is "backend only".

**Phase 0 - Skeleton and the vertical slice.**
Auth, users. Clubs + memberships + the one-owner constraint. Channels. The channel log with
sequence numbers, idempotency, and cursors. Gateway with subscribe/send/ack/sync. The policy
module with `isClubMember` / `isClubAdmin` / `isClubOwner` and their tests. Outbox + worker with
one effect (club bootstrap). Expo client: sign in, club list, club chat with optimistic send,
offline outbox, reconnect sync.
*Done when, with the gateway killed **mid-send** (not merely mid-conversation) and both clients
forced to reconnect:*

- ***Nothing lost.** Every message either appears on every device or was never acked.*
- ***Nothing twice.** No message appears more than once on any device, including retried sends
  and replayed outbox events. Verified by asserting the message count, not by eyeballing the
  transcript.*
- ***Identical order.** Both devices render the same `seq` sequence, with no holes.*

The second and third conditions are the point. Sequence numbers and `client_msg_id` exist to
prevent duplicates and misordering, and a gate that only proves delivery would pass a build with
both the system-message duplication bug ([Message flows](03-message-flows.md)) and the `msg.ack` gap bug ([Client architecture](08-client-architecture.md)) still in it. A
delivery-only gate is half a test.

**Phase 1 - Effects, notifications, push.**
The [Server event catalogue](12-server-event-catalogue.md) in the worker, for every event whose
triggering feature exists. Notification rows, the inbox, the badge, and the clearing rules
including the two exceptions. Device registry and Expo Push.

> **Ordering correction, found while building Phase 1.** This phase originally also listed
> "the scheduled job", meaning poll closing-soon - but polls do not exist until Phase 2, so
> the job has nothing to select. The same applies to most of the 18 notification types: a
> race-created notification needs races. Phase 1 therefore delivers the *mechanism* (the
> audience function, the notification rows, the inbox and its clearing rules, the device
> registry and the push pipeline) plus the events Phase 0's surface can raise - announcements
> and mentions. Each remaining type becomes one call into machinery that already exists, and
> the scheduled job arrives with the polls it is for.
*Done when: an announcement in club chat reaches a backgrounded phone as a push that deep-links
to the right message.*

**Phase 1.5 - Kafka downstream of the outbox.**
Split the worker into relay plus consumer. Topics, partitioning by `partition_key`, consumer
group, offset management, DLQ, and a deliberate replay drill. Slotted here rather than in
Phase 0 because the effects pipeline must be *correct* before it is *distributed* - debugging
an ordering bug and a rebalance at the same time is how a learning goal turns into a week lost.
*Done when: a consumer is stopped for ten minutes, restarted, and every effect lands exactly
once, in order, with nothing lost - and when rewinding the offset by an hour replays cleanly
without duplicating a single notification or system message.*

**Phase 2 - Breadth across the domain.**
Races (roster, Meet Information, car groups, pins), Eboard (auto-membership sync, meetings),
polls in all three scopes, calendar, routines, news. Every one reuses the channel abstraction -
if any of them forks chat, the abstraction has been broken ([Domain model](../PRD/01-domain-model.md) rule).
*Done when: the permission-matrix test suite covers every cell of the three matrices in
[Roles and permissions](../PRD/02-roles-and-permissions.md).*

**Phase 3 - Media and offline.**
Upload intent, presigned PUT, thumbnail derivation, the `/media/:id` authorized-redirect path,
galleries. Local SQLite cache for offline chat reads.
*Done when: a private Eboard photo is provably unreachable without membership, and chat is
readable in airplane mode.*

> **Both gate conditions were met on 2026-07-30, and the phase was not finished.** The server
> pipeline was complete and tested; the client could neither attach a photo nor render one. Closed
> on 2026-07-30 after Phase 3.5, and what was missing turned out to be more than a picker:
>
> 1. **The message envelope carried no media at all.** Phase 3 added `media_id`, `document_name`
>    and `document_size` to `messages` and never put them on the wire, so a client receiving a
>    photo knew only that its `type` was `'photo'` - with no id, and therefore no way to fetch the
>    bytes. The upload half and the render half were each unreachable from the other.
> 2. **The signed URL scheme only works behind a CDN.** The hour-aligned `exp`/`sig` pair is
>    validated at the CDN edge; pointed straight at a bucket it is an unauthenticated GET on
>    private content, refused with 403. Development has no CDN, so every photo was unreachable
>    while every server test passed - the tests exercise the signing function, not a fetch of the
>    bytes. Now an explicit `MEDIA_URL_MODE`, with the hour alignment preserved in both modes by
>    pinning the presigned URL's signing date to the floor of the hour. See
>    [Media pipeline](07-media-pipeline.md).
> 3. **A 302 behind an `Authorization` header cannot be an image source on the web.** Hence a JSON
>    sibling at `/media/:id/url`, same function and same predicate, for clients that hold a
>    header rather than being an `<img>`.
>
> Verified end to end in the running app against MinIO: pick, presigned PUT, complete, real
> `sharp` derivation to thumb and display webp, and the photo rendering in the bubble - plus a
> document bubble showing its filename and size. **Still not built:** the Gallery grid and the
> full-screen viewer, which are [Media and galleries](../PRD/13-media-and-galleries.md)'s
> remaining client surface; the server's gallery endpoint has been complete since this phase.

**Phase 3.5 - Direct messages, with their safety tooling.**
The fourth channel scope: `dm_conversations`, `isDmParticipant`, nullable `club_id`, the
shared-club eligibility predicate. **In the same release, not after it:** member blocking,
conversation mute, and the platform moderation queue for DM reports. Placed after media because
DMs inherit the media pipeline wholesale and would otherwise ship without photo support.
*Done when: a blocked member can neither open a thread nor send into an existing one, in either
direction; a DM report reaches the moderation queue and reaches no club admin; and a muted
conversation produces no push while still incrementing its unread count.*

> **Two corrections found while building this phase, both in code shipped earlier.**
>
> 1. **The race scope was never wired into four of the five places it belongs.** Phase 2 created
>    race channels and left `listAccessibleChannels`, the chat-unread rows, the badge count and
>    the notification audience each carrying their own hand-written copy of the membership join,
>    updating none of them. A race member's chat appeared in no channel list, produced no unread
>    count and no badge, and an announcement in race chat notified nobody. Four self-consistent
>    copies, one missing branch each. There is now one definition of "which channels can this
>    person reach" and one of its inverse, and adding the `dm` branch touched them once.
> 2. **Notification idempotency keys could collide across handlers.** Most events produced one
>    notification and keyed on the raw outbox id; the message handler produced two and keyed the
>    second on `id * 2 + 1`. Those sequences overlap, and both `notifications_idempotency` and
>    the `push_deliveries` ledger key on `(outbox_event_id, recipient/device)` - so a collision
>    reads as "already handled" and silently drops a real notification and a real push. Every key
>    is now `eventId * 4 + slot`.
>
> Neither was a DM bug. Both were found because this phase had to add a fourth scope to the same
> four places and a third notification kind to the same key space, which is the only reason
> anybody looked.
>
> **Also corrected, in the spec rather than the code:** the abstraction test in
> [Domain model](../PRD/01-domain-model.md) predicted two predicates and the real cost was five.
> The two it missed - posting and pinning - were both **aliases** of other predicates, which is
> invisible until a scope needs the two sides to differ. See
> [Authorization](05-authorization.md).
>
> **Message reactions were built immediately after, in the same phase.** They had been specified
> since Phase 0 - in scope in [Chat](../PRD/05-chat.md), a table in
> [Data model](09-data-model.md) - and never implemented, which made
> [Direct messages](../PRD/14-direct-messages.md) rule 5's promise that reactions work identically
> in a DM true only vacuously. Building them closed three further gaps that had nothing to do with
> reactions:
>
> - **`msg.update` had no producer.** The frame was declared in [Protocol](10-protocol.md) from
>   Phase 0 with `pinned` and `deleted_at`, nothing ever sent one, and the client's handler was a
>   bare `break`. So a pin and a soft delete never reached an open client at all - both were
>   visible only after a refresh, despite [Chat](../PRD/05-chat.md) rules 7 and 9 describing them
>   as things every other member sees. All three now travel on it.
> - **Nothing cleared reactions on delete**, which [Chat](../PRD/05-chat.md) rule 9 has required
>   since Phase 0. Vacuously satisfied while reactions did not exist, and a real defect the moment
>   they did.
> - **The local SQLite cache had no migration path.** `CREATE TABLE IF NOT EXISTS` does nothing to
>   a table that already exists, so any device with an earlier build would have failed every write
>   the moment a new column was referenced. The client now migrates additively, driven by
>   `PRAGMA table_info` rather than a stored version, so a database in any prior state converges.
>
> **Deferred out of this phase, deliberately:** the per-sender, per-new-conversation rate limit
> [Authorization](05-authorization.md) calls for, which belongs to Phase 4 with every other rate
> limit. And the Expo client still cannot attach a photo to any message, in any scope - the
> server pipeline and the gallery endpoint are complete and tested since Phase 3, and the picker
> UI is unbuilt, so DMs inherit exactly as much photo support as club chat has.
>
> **Requested and not built:** a full emoji picker rather than the fixed six, recorded as a costed
> open question in [Chat](../PRD/05-chat.md) rather than a comment. The fixed set is enforced by a
> check constraint, so widening it starts with dropping that constraint - which is the right place
> to be forced to think about validating arbitrary Unicode.

**Phase 4 - Hardening.**
Rate limits everywhere. Retention and GC jobs. Accessibility pass on every icon-only control.
Sentry dashboards. Load test at 10× projected peak. The [Acceptance checklist](../PRD/18-acceptance-checklist.md) parity checklist, run on
all three platforms.
