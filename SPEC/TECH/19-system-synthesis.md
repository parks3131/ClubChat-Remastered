# The system, in one read

The whole-system picture in a few pages. Every section here says **what a thing is and where its
truth lives**, and then points into the [`TECH/`](.) file that owns the detail. Nothing here says
how anything works.

That rule has a concrete reason, not a stylistic one. The backend review of 2026-08-19 found four
places where a document had restated a mechanism and then silently diverged from the code while
both stayed individually plausible: the push-retry claim in
[Failure modes](11-failure-modes.md), the reconnect behaviour in [Diagrams](17-diagrams.md), the
heartbeat in [Connection layer](01-connection-layer.md), and the effect ordering in
[Effects engine](04-effects-engine.md). A restated detail is a second authority, and a second
authority drifts. So: **a number, an interval, a limit, a frame name or a line of SQL appearing in
this file is a defect in this file.** If a sentence here starts explaining how something works
rather than what it is and where it lives, cut it and link instead.

This is also not `ARCHITECTURE.md` returned. That file was deliberately split into this tree on
2026-07-28 and deleted (see [the spec index](../README.md), "Where the old documents went"),
because one big document restating everything is exactly where the divergence class above breeds.
This file exists to be the missing *map*, which the deletion left nowhere.

---

## What it is

A purpose-built replacement for the GroupMe-plus-spreadsheet workflow clubs run on today:
structured chat, calendar, weekly meetups, races as mini-clubs, polls, a private board space - as
a template any club can adopt with nothing to configure. Product truth is
[`PRD/`](../PRD/00-overview.md), distilled from the shipped v1 and verified against it. This
build is a *remaster*: v1 worked, on an architecture where the database was the application
server, and the rebuild exists to end specifically that -
[ADR-0002](../decisions/0002-application-server-not-database-as-backend.md).

## The shape

One Expo client (iOS, Android, web). One TypeScript server codebase with **three roles** - API,
gateway, worker - which are roles, not deployables. Postgres is the source of truth for
everything, the channel log included. Redis is a connection registry, a pub/sub bus and a rate
limiter, and **never** a source of truth: flushing it must degrade the system, not corrupt it.
Media lives in object storage behind a CDN; push goes through Expo to APNs and FCM.

[Overview](00-overview.md) owns the why - the v1 defect table, the honest scale reckoning, which
transcript-scale components were deliberately skipped, and the system diagram
([Diagrams](17-diagrams.md) renders it). The seams for everything skipped are named ports in the
code, so growing into them is a new implementation, not a rewrite.

## The one idea: the channel log

Everything conversational is a **channel** - club chat, race chat, the Eboard space, and direct
messages, the fourth scope
([ADR-0009](../decisions/0009-direct-messages-as-fourth-channel-scope.md)); a channel references
its scope one-way ([ADR-0014](../decisions/0014-channels-reference-their-scope-one-way.md)). A
message is a durable row with a gapless per-channel sequence number, so "what did I miss" is an
integer comparison, duplicates die on a client-generated id, and read state is a cursor.
[Channel log](02-channel-log.md) owns all of it; it is the core of the design and the thing most
worth protecting.

The journeys a message takes - online, offline, group fan-out, system messages - are
[Message flows](03-message-flows.md). The wire itself - WebSocket frames and the REST surface -
is [Protocol](10-protocol.md), with the shapes defined once in `packages/shared` and imported by
both ends, parsed rather than cast, so neither can drift from the other.

## Writes: one transaction, then effects

Every mutation is a command handler with one shape: load an access context, ask the policy
module, write domain rows **and outbox events in the same transaction**. Everything that must
then happen server-side - system messages, cards, notification fan-out, push, cascades, media
derivation - is performed by the worker and catalogued, one entry per effect, in the
[Server event catalogue](12-server-event-catalogue.md). The
[Effects engine](04-effects-engine.md) owns the guarantees (at-least-once, idempotent, ordered
per partition) and their mechanics; [Failure modes](11-failure-modes.md) owns what each
component's death does and costs.

Kafka sits downstream of the outbox in the design and deliberately does not exist yet -
[ADR-0006](../decisions/0006-kafka-downstream-of-the-outbox.md), and Phase 1.5 in
[Build phases](16-build-phases.md).

## Authority

One policy module, every predicate defined exactly once, asked by the API per request and by the
gateway per frame. No handler re-derives a rule inline, a named capability gets a named predicate
even when the body is one word, and a refusal is proved by attempting it rather than by reading
the rule. [Authorization](05-authorization.md) owns the module, where authority stops, DM report
routing and rate limiting; the permission matrices themselves are product truth in
[`PRD/02`](../PRD/02-roles-and-permissions.md).

## Being told

Discrete notification rows for things that happened; live arithmetic over cursors for unread
counts; push suppressed by read cursor and never by connection liveness
([ADR-0008](../decisions/0008-push-suppression-by-read-cursor.md)); chat and DM pushes write no
inbox row ([ADR-0015](../decisions/0015-a-direct-message-pushes-without-an-inbox-row.md),
[ADR-0032](../decisions/0032-every-chat-message-pushes.md)). The pipeline, the clearing rules and
retention are [Notifications and push](06-notifications-and-push.md).

## Media

Presigned upload with limits enforced at intent and re-verified against the actual bytes; every
upload decoded at the boundary ([ADR-0018](../decisions/0018-decode-uploads-at-the-boundary.md));
authorized download through an hour-aligned signed-URL scheme built for a CDN, with the
development-mode and header-holding fallbacks that scheme forces.
[Media pipeline](07-media-pipeline.md) owns it.

## The client

A local SQLite message store, a send outbox, and a sync engine keyed on sequence numbers, all in
`packages/client-core` - shared by the Expo app and the exit drill, so the drill tests what
ships. [Client architecture](08-client-architecture.md) owns it. What the screens are is
[`PRD/15`](../PRD/15-screen-map.md); what surfaces look like is [`DESIGN/`](../DESIGN/) over the
token system in [Design system](13-design-system.md).

## What must not break

The load-bearing properties, each with the file that states it and keeps it true. These are the
claims to re-verify when anything nearby changes.

| Property | Owned by |
|---|---|
| A gateway can be killed at any time with zero data loss | [00](00-overview.md), [01](01-connection-layer.md) |
| The channel log has no holes, no duplicates, and one order | [02](02-channel-log.md) |
| Domain rows and their outbox events commit together or not at all | [04](04-effects-engine.md) |
| Every effect is idempotent under redelivery | [04](04-effects-engine.md), [12](12-server-event-catalogue.md) |
| Effects within one partition happen in order | [04](04-effects-engine.md) |
| Redis can be flushed without corrupting anything | [00](00-overview.md) |
| Every rule is one predicate, asked through one module | [05](05-authorization.md) |
| Push is suppressed by cursor, never by liveness | [06](06-notifications-and-push.md), [ADR-0008](../decisions/0008-push-suppression-by-read-cursor.md) |
| Private media is unreachable without membership | [07](07-media-pipeline.md) |
| The wire contract is parsed from one shared definition, never restated | [10](10-protocol.md) |

Schema-level invariants live twice by design: as constraints in the schema and as violation
attempts in the constraint proof - see [Data model](09-data-model.md) and the note in
[`AGENTS.md`](../../AGENTS.md) section 5.2.

## How it is watched

Development has the wire-level trace and the per-request database round-trip counter, and the
request-economy rules they produced -
[Mission: backend cleaning](18-mission-backend-cleaning.md), which also carries the checklist of
routes nobody has watched yet. Server-side error monitoring reports from all three processes.
Production measurement does not exist yet; it is milestone 3 of
[Road to the first club](20-road-to-the-first-club.md).

## Where it runs, and what is left

Every technology choice with its rationale is [Stack and hosting](15-stack-and-hosting.md). How
the build got here, phase by phase with each phase's gate, is
[Build phases](16-build-phases.md). What remains between here and a real club using it daily is
[Road to the first club](20-road-to-the-first-club.md). The war stories that should be read
before touching lists, navigation or realtime are
[Engineering pitfalls](14-engineering-pitfalls.md) and `AGENTS.md` section 5.3.

---

## Keeping this file true

This file changes when a subsystem is added, removed, or changes owner - never when a subsystem
changes internally. If editing another `TECH/` file makes a sentence here wrong, that sentence
was restating rather than pointing, and the fix is to cut it, not to update it.
