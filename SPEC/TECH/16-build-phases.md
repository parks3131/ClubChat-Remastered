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

## Where we are

**Last updated 2026-07-30, after Phase 3.5 and the close of Phase 3.**

| Phase | State | Note |
|---|---|---|
| 0 - Skeleton and the vertical slice | **Done** | Exit drill passes: nothing lost, nothing twice, identical order |
| 1 - Effects, notifications, push | **Done** | |
| 1.5 - Kafka downstream of the outbox | **Not started** | Skipped over. The worker still drains the outbox directly with `FOR UPDATE SKIP LOCKED`, which works and is correct - see below |
| 2 - Breadth across the domain | **Done at the domain layer only** | Schema, 32 command handlers and the permission matrix. **No HTTP routes and no screens** - see below |
| 3 - Media and offline | **Done** | Closed 2026-07-30; the client can attach and render. Gallery grid and full-screen viewer outstanding |
| 3.5 - Direct messages and safety tooling | **Done** | |
| 4 - Hardening | **Not started** | Next, unless the surface gap below is taken first |

### The two things this table is really saying

**1. Phase 2 shipped a domain, not a feature.** Races, polls, calendar, routines, news and Eboard
meetings all have schema, handlers and tests - 32 exported command handlers across four modules,
47 test cases - and **none of them is reachable over HTTP**. The API registers 45 routes covering
clubs, membership, chat reads, reactions, reports, moderation, mute, media, DMs, notifications,
devices and sync, and nothing else. The Expo client has six screens: sign-in, the club list, chat,
the DM list, and two layout files.

**This is server work, not UI work**, and the distinction matters when planning: a finished screen
would have nothing to call. Two further gaps found the same way, both outside Phase 2:

- **`setPinned` and `softDeleteMessage` have no route either.** Pinning and soft-deleting a
  message are Phase 0 chat features, and the column-level authority trap they exist to solve is
  carefully handled in the domain and unreachable from any client. `msg.update` now publishes both,
  so the realtime half works and there is no way to trigger it.
- **`eboard_join_requests` is not in the schema at all**, though [Data model](09-data-model.md)
  specifies it and [Eboard and Council](../PRD/10-eboard-and-council.md) depends on it. An admin
  who leaves the Eboard space must request or be re-added, and there is nowhere to record the
  request. That is a domain gap rather than a delivery one - the only one found so far.

That happened because Phase 2's exit gate was *"the permission-matrix test suite covers every cell
of the three matrices"* - a test suite, which a domain layer can satisfy on its own. Every other
phase gate names something a person can do, and those phases all shipped a surface. **A gate that
can be met without a running surface will be**, which is worth carrying into how Phase 4's gate is
written.

This is the largest outstanding body of work in the project and it does not currently belong to
any phase. It is sketched as "Phase 3.75" below, but numbering it is a product call.

**2. Phase 1.5 was skipped and is still owed.** The outbox is drained directly by the worker,
which is correct, ordered and idempotent - so nothing is broken. What is missing is the
distribution the ADR-0006 design calls for, and the `processed_at` to `published_at` rename that
comes with it. It was slotted *before* Phase 2 deliberately, on the reasoning that the effects
pipeline must be correct before it is distributed. It now has considerably more effects to be
correct about, which cuts both ways: more confidence in the pipeline, more surface to migrate.

---

## Build phases

Each phase ends with something demonstrably working end-to-end. No phase is "backend only".

> *Phase 2 is the exception that proves this rule, and it was not noticed until Phase 3.5 was
> finished. See "Where we are" above.*

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

**Phase 3.75 - The missing surface.** *(Proposed 2026-07-30. Numbering is a product call.)*
Wire the 32 Phase 2 command handlers to HTTP routes, and build the screens
[Screen map](../PRD/15-screen-map.md) already specifies for them: races and their roster, Meet
Information and car groups; polls in three scopes with inline voting; the calendar and events
list; routines; news and Highlights; the Eboard space and its meetings. Plus the surfaces every
phase has quietly deferred - the notification inbox, the member roster, profile, and chat's own
Highlights tabs. And Phase 3's remaining two: the Gallery grid and the full-screen viewer.

Nothing here needs new domain logic or new schema. It is routes and screens over work that is
already written, already authorized and already tested, which is the cheapest this will ever be.
*Done when: every screen in [Screen map](../PRD/15-screen-map.md) exists and is reachable, and the
[Acceptance checklist](../PRD/18-acceptance-checklist.md) can be attempted at all.*

**Phase 4 - Hardening.**
Rate limits everywhere. Retention and GC jobs. Accessibility pass on every icon-only control.
Sentry dashboards. Load test at 10× projected peak. The [Acceptance checklist](../PRD/18-acceptance-checklist.md) parity checklist, run on
all three platforms.

What that means concretely, as of today:

| Item | State | What is actually left |
|---|---|---|
| **Rate limits everywhere** | Messages only | The gateway throttles sends (burst 30, refill 1/sec). Reports, reactions, join requests and presign requests are unthrottled, and DMs need the second dimension [Authorization](05-authorization.md) describes: a per-sender, per-new-conversation limit, because one sender opening many threads stays under any per-sender bucket |
| **Retention and GC** | Media GC exists | `runMediaGc` sweeps stale pending uploads and orphaned objects. Still owed: notification archival, and outbox pruning after 7 days - which the `push_deliveries` ledger is deliberately designed to outlive |
| **Error monitoring** | **Not started** | No Sentry anywhere. [Stack and hosting](15-stack-and-hosting.md) says "in the error path from the first commit" and that has not been true for any commit |
| **Accessibility** | Partial, by habit | Controls carry `accessibilityRole` and `accessibilityLabel` as they are built. Never audited: contrast against WCAG AA, dynamic type, reduced motion, screen-reader navigation order |
| **Load test** | **Not started** | At 10× projected peak. The two numbers to watch first are the per-channel `last_seq` row lock under concurrent sends, and the access-context query now that it carries DM threads and blocks |
| **Parity checklist** | Blocked | Cannot be run until the surface exists |

**Beyond Phase 4 - release readiness.** Not engineering phases, and tracked in
[Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) rather than here: legal
review of the Privacy Policy and Terms (**with the obligation ADR-0005 adds - without E2E, the
policy must state that message content is readable by the service**), paid iOS developer-program
enrolment, and over-the-air updates so a fix does not need a store release.
