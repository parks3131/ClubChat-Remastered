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

**Phase 3.5 - Direct messages, with their safety tooling.**
The fourth channel scope: `dm_conversations`, `isDmParticipant`, nullable `club_id`, the
shared-club eligibility predicate. **In the same release, not after it:** member blocking,
conversation mute, and the platform moderation queue for DM reports. Placed after media because
DMs inherit the media pipeline wholesale and would otherwise ship without photo support.
*Done when: a blocked member can neither open a thread nor send into an existing one, in either
direction; a DM report reaches the moderation queue and reaches no club admin; and a muted
conversation produces no push while still incrementing its unread count.*

**Phase 4 - Hardening.**
Rate limits everywhere. Retention and GC jobs. Accessibility pass on every icon-only control.
Sentry dashboards. Load test at 10× projected peak. The [Acceptance checklist](../PRD/18-acceptance-checklist.md) parity checklist, run on
all three platforms.
