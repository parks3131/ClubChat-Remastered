# ClubChat - Spec Index

A purpose-built replacement for the GroupMe-plus-Excel-screenshot workflow that running clubs use
today: structured club chat, calendar, weekly routines, races-as-mini-clubs, polls, and a private
board channel - as a template any club can adopt.

**Stack:** Expo (iOS / Android / web) · TypeScript on Node 24 · Fly.io · Neon Postgres · Redis ·
Kafka downstream of a transactional outbox · Cloudflare R2 · authorization in an application
server, not in the database.

---

## How to read this

| If you want | Read |
|---|---|
| What the product does and why | [`PRD/`](PRD/) |
| How it is built, and what must not break | [`TECH/`](TECH/) |
| Why a decision was made, and what was rejected | [`decisions/`](decisions/) |
| To add a feature, a migration, or a resource | [`templates/`](templates/) |
| How to work in this repo | [`../AGENTS.md`](../AGENTS.md) |
| How we got here, bug by bug | [`../HISTORY.md`](../HISTORY.md) |

**Start here:** [PRD/00-overview.md](PRD/00-overview.md) →
[TECH/00-overview.md](TECH/00-overview.md) →
[TECH/14-engineering-pitfalls.md](TECH/14-engineering-pitfalls.md).

**Two things to know before changing anything.** This is a *remaster*: v1 shipped and worked, on
a different architecture, and everything in `PRD/` describes behaviour that already ran in
production. **v1 is at [github.com/parks3131/ClubChat](https://github.com/parks3131/ClubChat)** -
read it to settle a question about *what the product does*, since `PRD/` was distilled from it and
was verified against it table by table on 2026-07-30. Do not read it for *how to build* anything:
its architecture is what this rebuild exists to replace. The rebuild exists to move authorization and domain logic out of the database
([ADR-0002](decisions/0002-application-server-not-database-as-backend.md)), not to rethink the
product. And [TECH/14-engineering-pitfalls.md](TECH/14-engineering-pitfalls.md) is not
background reading - every entry there cost at least one long debugging session, and several
shipped as defects more than once.

---

## PRD - what the product does

| # | Document | Covers |
|---|---|---|
| 00 | [Overview](PRD/00-overview.md) | The problem, the product bet, principles, goals, non-goals, platforms |
| 01 | [Domain model](PRD/01-domain-model.md) | Entities, the channel abstraction, and the invariants that must hold in any architecture |
| 02 | [Roles and permissions](PRD/02-roles-and-permissions.md) | Owner / Admin / Member, where authority stops, the full permission matrices |
| 03 | [Accounts and profile](PRD/03-accounts-and-profile.md) | Sign-up, sessions, profile fields, account deletion |
| 04 | [Clubs and membership](PRD/04-clubs-and-membership.md) | Create, join by link or search, join policies, roster, ownership transfer |
| 05 | [Chat](PRD/05-chat.md) | The centre of gravity: messages, reactions, pins, announcements, mentions, moderation |
| 06 | [News and Highlights](PRD/06-news-and-highlights.md) | The club's front-page feed, and how it differs from pinned chat |
| 07 | [Calendar and events](PRD/07-calendar-and-events.md) | Month grid and merged upcoming/past feed, club and cross-club |
| 08 | [Routines](PRD/08-routines.md) | Weekly admin-authored training plans |
| 09 | [Races and Meets](PRD/09-races-and-meets.md) | Races as mini-clubs: roster, chat, meet info, car groups, personal pins |
| 10 | [Eboard and Council](PRD/10-eboard-and-council.md) | The private admins-only space and its meetings |
| 11 | [Polls](PRD/11-polls.md) | Creation, voting, deadlines, voter visibility, scoping |
| 12 | [Notifications](PRD/12-notifications.md) | The catalogue, the unread model, and the clearing rules |
| 13 | [Media and galleries](PRD/13-media-and-galleries.md) | Identity versus content media, per-chat galleries |
| 14 | [Direct messages](PRD/14-direct-messages.md) | The fourth channel scope, blocking, and where a DM report goes |
| 15 | [Screen map](PRD/15-screen-map.md) | Information architecture and the navigation rules that must survive |
| 16 | [Cross-cutting UX](PRD/16-cross-cutting-ux.md) | Loading and empty states, destructive actions, privacy, performance, accessibility |
| 17 | [Roadmap and open questions](PRD/17-roadmap-and-open-questions.md) | Known gaps, architectural debt, and what is deliberately deferred |
| 18 | [Acceptance checklist](PRD/18-acceptance-checklist.md) | Parity, verifiable on iOS, Android and web |

Each feature document gives purpose, numbered behaviour rules, permissions, edge cases and
acceptance criteria. **Behaviour rules are numbered so they can be cited** from tests, ADRs and
other specs.

## TECH - how it is built

| # | Document | Covers |
|---|---|---|
| 00 | [Overview](TECH/00-overview.md) | Why the architecture changed, honest scale, the system diagram |
| 01 | [Connection layer](TECH/01-connection-layer.md) | WebSockets, the connection registry, per-channel fan-out, revocation |
| 02 | [Channel log](TECH/02-channel-log.md) | **The core idea.** Gapless `seq`, read cursors, idempotency, the DM scope |
| 03 | [Message flows](TECH/03-message-flows.md) | Send online, send offline, group fan-out, system messages |
| 04 | [Effects engine](TECH/04-effects-engine.md) | Transactional outbox, Kafka downstream, scheduled and housekeeping jobs |
| 05 | [Authorization](TECH/05-authorization.md) | The policy module, where authority stops, DM report routing, rate limiting |
| 06 | [Notifications and push](TECH/06-notifications-and-push.md) | Discrete rows versus live unread, the push pipeline |
| 07 | [Media pipeline](TECH/07-media-pipeline.md) | Presigned upload, authorized download, the stable-URL scheme |
| 08 | [Client architecture](TECH/08-client-architecture.md) | Local store, send outbox, the sync engine |
| 09 | [Data model](TECH/09-data-model.md) | Every table, with the constraints that carry the invariants |
| 10 | [Protocol](TECH/10-protocol.md) | WebSocket frames and the REST surface |
| 11 | [Failure modes](TECH/11-failure-modes.md) | What each component's death does, and what it costs |
| 12 | [Server event catalogue](TECH/12-server-event-catalogue.md) | Every effect that must happen server-side, regardless of caller |
| 13 | [Design system](TECH/13-design-system.md) | Tokens, typography, signature treatments |
| 14 | [Engineering pitfalls](TECH/14-engineering-pitfalls.md) | **The war stories.** Read before touching lists, navigation, or realtime |
| 15 | [Stack and hosting](TECH/15-stack-and-hosting.md) | Every technology choice, with its rationale |
| 16 | [Build phases](TECH/16-build-phases.md) | The phased plan, and the v1 debt each phase pays off |
| 17 | [Diagrams](TECH/17-diagrams.md) | System overview, message flows, fan-out topology, failure behaviour |

## Decisions

Immutable once accepted. A spec says what and how; an ADR says **why this and not that**.

| # | Decision |
|---|---|
| [0001](decisions/0001-record-architecture-decisions.md) | Record architecture decisions |
| [0002](decisions/0002-application-server-not-database-as-backend.md) | Put authorization in an application server, not in the database |
| [0003](decisions/0003-durable-channel-log-not-store-and-forward.md) | Store messages in a durable channel log, not a per-recipient inbox |
| [0004](decisions/0004-postgres-not-nosql.md) | Use Postgres, not a NoSQL store, for the system of record |
| [0005](decisions/0005-no-end-to-end-encryption.md) | Do not implement end-to-end encryption |
| [0006](decisions/0006-kafka-downstream-of-the-outbox.md) | Put Kafka downstream of a transactional outbox, never in place of it |
| [0007](decisions/0007-per-channel-fanout-topics.md) | Fan out over per-channel topics, not per-user topics |
| [0008](decisions/0008-push-suppression-by-read-cursor.md) | Suppress push by read cursor, never by connection liveness |
| [0009](decisions/0009-direct-messages-as-fourth-channel-scope.md) | Add direct messages as a fourth channel scope |
| [0010](decisions/0010-link-only-invites.md) | Invite by share link only, with no typed invite code |
| [0011](decisions/0011-typescript-node-on-fly-with-self-hosted-auth.md) | TypeScript on Node, hosted on Fly.io, with self-hosted auth |
| [0012](decisions/0012-no-receipts-presence-or-typing-indicators.md) | Ship only a `sent` acknowledgement |
| [0013](decisions/0013-notifications-store-type-and-params.md) | Store notifications as a type plus params, not a rendered body and route |
| [0014](decisions/0014-channels-reference-their-scope-one-way.md) | A channel references its scope, and the scope never references the channel |
| [0015](decisions/0015-a-direct-message-pushes-without-an-inbox-row.md) | A direct message pushes, and writes no inbox row |
| [0016](decisions/0016-thread-writability-is-evaluated-never-stored.md) | A thread's writability is evaluated, never stored |
| [0017](decisions/0017-reactions-travel-on-the-message-envelope.md) | Reactions travel on the message envelope, and updates carry full sets |
| [0018](decisions/0018-decode-uploads-at-the-boundary.md) | Uploads are decoded at the boundary, and undecodable bytes never park an event |
| [0019](decisions/0019-outbound-mail-is-a-port-with-a-deferred-provider.md) | Outbound mail is a port, and the provider behind it is chosen later |
| [0020](decisions/0020-resend-is-the-mail-provider.md) | Resend is the mail provider, called over `fetch` rather than its SDK |

## Templates

| Document | Use when |
|---|---|
| [Feature spec](templates/feature-spec-template.md) | Starting any new feature |
| [Authorization checklist](templates/authorization-checklist.md) | Adding any resource, endpoint or scope. **Every item on it shipped as a bug once.** |
| [Migration checklist](templates/migration-checklist.md) | Writing a new migration |
| [ADR template](templates/adr-template.md) | Recording an architectural decision |

---

## Conventions

- **PRD says what, TECH says how.** No file paths, schema or component names in `PRD/`; no
  product justification in `TECH/`. Link across instead of duplicating.
- **An ADR is immutable.** Change a decision by superseding it with a new ADR, never by editing
  the old one. The rejected alternatives are the point.
- **Keep it compact.** This tree is loaded into context. Long narratives belong in a history
  file, not in a spec.
- **The repo wins.** Where a doc disagrees with the code, the code is right and the doc is the
  bug - fix it in the same change. This is the only rule that keeps a spec from going stale, and
  it works only if applied every time rather than when convenient.

## Where the old documents went

`Old.md` and `ARCHITECTURE.md` were split into this tree on 2026-07-28. Nothing was rewritten;
sections were moved verbatim and their cross-references rewritten into links. The
rejected-alternative prose that lived in `ARCHITECTURE.md` sections 12 and 19 became
[`decisions/`](decisions/).

| Was | Is now |
|---|---|
| `Old.md` sections 1-5, 8, 11, 12 | [`PRD/`](PRD/) |
| `Old.md` sections 6, 7, 9, 10 | [`TECH/`](TECH/) - they describe mechanism, not product |
| `ARCHITECTURE.md` sections 1-11, 13-18 | [`TECH/`](TECH/) |
| `ARCHITECTURE.md` sections 12, 19 | [`decisions/`](decisions/) |
| `ARCHITECTURE-DIAGRAMS.md` | [`TECH/17-diagrams.md`](TECH/17-diagrams.md) |
