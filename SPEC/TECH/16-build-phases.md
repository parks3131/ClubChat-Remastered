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
| 7 | Media cost - N viewers = N origin downloads | [Media pipeline](07-media-pipeline.md) hour-aligned signed URLs → one byte-identical URL per window. **Only partly paid off: that collapses the cache KEY but is not a shared edge entry, which needs Workers Caching and is off. See [ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md)** |
| 8 | Storage cleanup | [Effects engine](04-effects-engine.md) nightly GC job driven by `media_objects` ownership |
| 9 | File size and MIME limits | [Media pipeline](07-media-pipeline.md) enforced at intent and re-verified at complete |
| 10 | Notification retention | [Effects engine](04-effects-engine.md) nightly archival job |
| 11 | Localisation of notification bodies | Store `type` + structured `params`; render at read time. *(Design it in now - retrofitting means rewriting every historical row.)* |
| 12 | Rate limiting beyond messages | **Built 2026-08-03.** A default bucket on the authenticated scope plus named buckets on media intent, DM creation, join requests, invite redeem and reports; sign-in and sign-up keyed per IP |
| 13 | Backups and dev/prod parity | Managed Postgres PITR; migrations from one source of truth |

And from [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) "blocking a real release":

| Gap | Resolved by |
|---|---|
| Push notifications | [Notifications and push](06-notifications-and-push.md) - designed into the fan-out from day one, as the brief instructs |
| Error monitoring | **Built 2026-08-03**, server-side only. `monitoring.ts` reports from all three processes. The mobile client is still uncovered |
| Accessibility | Not architectural. Client work, tracked separately, started early rather than retrofitted |
| Legal review | Not architectural. **Note the new obligation from [decisions/](../decisions/): without E2E, the Privacy Policy must state that message content is readable by the service.** |

---

## Where we are

**Last updated 2026-08-12.** Rows 3.75b and 4 were stale for a fortnight, and 4 disagreed with the
root `README.md` about whether the project is release-ready - see the note under Phase 4.

| Phase | State | Note |
|---|---|---|
| 0 - Skeleton and the vertical slice | **Done** | Exit drill passes: nothing lost, nothing twice, identical order |
| 1 - Effects, notifications, push | **Done** | |
| 1.5 - Kafka downstream of the outbox | **Not started** | Skipped over. The worker still drains the outbox directly with `FOR UPDATE SKIP LOCKED`, which works and is correct - see below |
| 2 - Breadth across the domain | **Done** | Schema, 32 command handlers and the permission matrix. Shipped with no routes and no screens; the routes arrived in 3.75a, the screens are 3.75b - see below |
| 3 - Media and offline | **Done** | Closed 2026-07-30; the client can attach and render. Gallery grid and full-screen viewer both landed 2026-08-01 |
| 3.5 - Direct messages and safety tooling | **Done** | |
| 3.75a - The HTTP surface | **Done** | 2026-07-30. 45 routes became **111**; ~20 new query and command functions; one new table; 76 route-level tests; five defects in shipped code fixed on the way. Gate met: 73 checks against a running server, `npm run gate:surface` |
| 3.75b - The screens | **Done** | The tab shell, the shared primitives and ~56 screens; the client data layer covers all 130 routes. Every screen walked by direct URL. The full acceptance run on all three platforms is Phase 4's, not this one's |
| 4 - Hardening | **In progress** | Three of six items done - rate limits, retention and GC, server-side error monitoring. Outstanding: the accessibility audit, a load test, and the parity checklist on all three platforms. See the item-by-item table below |

### The two things this table is really saying

> **Updated 2026-07-30, during Phase 3.75b.** The first point below is now **history rather than
> status**: the domain is reachable, over 111 routes, and most of it now has a screen. It is kept
> because the *reason* it happened is the most useful thing in this document, and because the
> second point is still true.
>
> The client went from six files to roughly thirty-five during 3.75b: a real tab shell over the four
> destinations `PRD/15` names, and screens for clubs, races, polls, meetings, news, meetups, events,
> the calendar, the Eboard space, Highlights, the gallery, profiles and the invite link. What is
> still owed is listed under the phase below.

**1. Phase 2 shipped a domain, not a feature.** Races, polls, calendar, meetups, news and Eboard
meetings all had schema, handlers and tests - 32 exported command handlers across four modules,
47 test cases - and **none of them was reachable over HTTP**. The API registered 45 routes covering
clubs, membership, chat reads, reactions, reports, moderation, mute, media, DMs, notifications,
devices and sync, and nothing else.

**That was server work, not UI work**, and the distinction mattered when planning: a finished
screen would have had nothing to call. Two further gaps were found the same way, both outside
Phase 2:

- **`setPinned` and `softDeleteMessage` had no route either.** Pinning and soft-deleting a message
  are Phase 0 chat features, and the column-level authority trap they exist to solve was carefully
  handled in the domain and unreachable from any client. `msg.update` had published both since
  Phase 3.5, so the realtime half worked with no way to trigger it. *Routed in 3.75a, and the trap
  is now proved the way PRD/18 asks: a member attempts the pin and is refused.*
- **`eboard_join_requests` was not in the schema at all**, though [Data model](09-data-model.md)
  specified it and [Eboard and Council](../PRD/10-eboard-and-council.md) depended on it. An admin
  who left the Eboard space had to be re-added by somebody noticing, with nowhere to record a
  request. A domain gap rather than a delivery one. *Built in 3.75a, shaped exactly like the club
  and race request tables.*

> **It was not the only one.** That sentence read "and it is **the only one**" until 2026-07-30,
> when starting Phase 3.75a found five more: club search, invite-token rotation, account deletion,
> profile editing, and both Highlights queries have no domain function either. Then a second pass
> found that **the read side of almost every screen is missing too** - the 34 handlers are all
> commands. Both are listed under Phase 3.75a below.
>
> Worth recording *why* the first count was wrong, because the method was the bug rather than the
> care taken. The audit compared the **handler list** against the router, so it could only find
> handlers nobody had routed. A capability that was never written at all appears in neither list
> and survives the comparison untouched. The v1 table-by-table check made the same shape of
> mistake safe in one dimension and not the other: it proved the *schema* complete, and four of
> those five gaps sit on columns that already exist. **Audit against the spec, not against the
> code's own inventory** - the code cannot list what it never had. The second pass worked because
> it walked [Screen map](../PRD/15-screen-map.md) asking "what does this screen read?", which is
> a question the codebase has no opinion about.

### Checked against v1, 2026-07-30

The v1 repository was read directly rather than trusted through the PRD's distillation of it.
v1 shipped **77 screens and 83 migrations**; every one of its 29 tables maps onto a remaster table,
under a different name where the remaster chose a better one (`profiles` to `users`,
`channel_reads` to `read_cursors`, `club_posts` to `news_posts`, `eboard_meetings` to `meetings`,
`race_car_groups` to `car_groups`). `rate_limits` is the one deliberate non-mapping: it moved to
Redis at the gateway.

**Exactly one v1 table has no remaster counterpart** - `eboard_channel_join_requests`, the gap
above, found independently before the comparison and confirmed by it.

The remaster additionally carries eleven tables v1 never had: `dm_conversations`, `member_blocks`,
`moderation_reads`, `media_objects`, `devices`, `push_deliveries`, `channel_mutes`, `outbox`, and
the three better-auth tables.

**So the data model is a faithful superset of the shipped product, plus one omission.** The gap
between the two builds is not features or schema. It is the delivery layer - routes and screens -
and the two phases that were never started.

That happened because Phase 2's exit gate was *"the permission-matrix test suite covers every cell
of the three matrices"* - a test suite, which a domain layer can satisfy on its own. Every other
phase gate names something a person can do, and those phases all shipped a surface. **A gate that
can be met without a running surface will be**, which is worth carrying into how Phase 4's gate is
written.

This is the largest outstanding body of work in the project. It became **Phase 3.75** on
2026-07-30, split into **3.75a - the HTTP surface** and **3.75b - the screens**, taken in that
order: the routes are server work, and until they exist the backend can only prove itself inside
its own test suite. See below for both.

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
polls in all three scopes, calendar, meetups, news. Every one reuses the channel abstraction -
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
> document bubble showing its filename and size. The Gallery grid and the full-screen viewer -
> this phase's remaining client surface, against a server endpoint complete since it - **both
> landed on 2026-08-01**; see [Media and galleries](../PRD/13-media-and-galleries.md).

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

**Phase 3.75a - The HTTP surface.** *(Started 2026-07-30.)*
Routes over the 34 unrouted command handlers: the 12 race handlers, the 6 poll handlers, the 12
content handlers (meetings, events, workouts, news), the 2 calendar reads, and `setPinned` and
`softDeleteMessage`.

**The proposal this replaces claimed "nothing here needs new domain logic or new schema", and that
was wrong twice over.** Found by reading [Protocol](10-protocol.md)'s REST sketch and the
[Screen map](../PRD/15-screen-map.md) against the router, rather than the handler list against the
router.

**First: the 34 are all *commands*, and a route needs something to return.** There is no read
function for the club roster or its pending requests, the club or Eboard space itself, the race
list, a race and its Meet Information, the race roster, the car groups, the news feed, the meetings
list, or another member's profile card. Ten or so query functions, none of which exist. The one
place this is *not* true is the calendar and the meetups week, which Phase 2 built as reads
already.

**Second: six specified capabilities have no function of either kind** - only a column, or a spec
line, waiting for one:

| Gap | What exists today | Specified in |
|---|---|---|
| `eboard_join_requests` | Nothing. Not in the schema | [Data model](09-data-model.md), [Eboard and Council](../PRD/10-eboard-and-council.md) |
| Club search | Nothing. No `GET /clubs/search`, no domain function | [Clubs and membership](../PRD/04-clubs-and-membership.md) |
| Invite-token rotation | The `invite_token_rotated_at` column. Nothing writes it | [Roadmap](../PRD/17-roadmap-and-open-questions.md), a requirement since the typed code was removed |
| Account deletion | The `anonymized_at` and `signin_blocked_at` columns, **read** by the auth hook and written by nothing | [Accounts and profile](../PRD/03-accounts-and-profile.md) rules 11-12 |
| Profile editing and the avatar | Nothing. `GET /me` returns club roles only | [Accounts and profile](../PRD/03-accounts-and-profile.md) rules 5-6 |
| Highlights, and jump-to-message | Nothing. No `/pinned`, no `/announcements`, no `?around={seq}` | [Protocol](10-protocol.md), [Chat](../PRD/05-chat.md) rules 7-8 |

The last one is worth its own note: three lines of the
[Acceptance checklist](../PRD/18-acceptance-checklist.md) - the pinned strip jumping to its message
on the **first** tap, and chat opening on the first unread with no visible scrolling - cannot pass
without `?around=`, and the Highlights tabs have no endpoint behind them in any scope. Both
Highlights queries run over the whole channel server-side, never over a loaded window, which is
debt item 6 above.

*Done when: **every route has been called against the running API by hand**, in both directions -
the happy path, and the forbidden path attempted as the unprivileged actor and watched to fail.
Specifically including the direct-URL refusals the checklist names: a race poll requested by an
admin with no roster row, an Eboard route by an ordinary member, another club's roster.*

> **Why the gate is worded that way.** Phase 2's gate was *"the permission-matrix test suite covers
> every cell"*, which a domain layer satisfies with no surface at all - and it did, for two phases.
> A gate that can be met without a running surface will be. This one cannot be met by `npm test`.

**Met on 2026-07-30**, and the gate is checked in as `scripts/surface-gate.sh`
(`npm run gate:surface`) rather than performed once and described: **73 checks over TCP against a
running server and a real Postgres**, all passing, of which roughly half are refusals. It found
what a test-only gate could not - see the note on the stale dev server in AGENTS.md failure mode
15, which reported 46 checks as broken before anything was wrong with the code.

What landed:

| | |
|---|---|
| Routes | 45 → **111** |
| New query functions | Club roster and club detail; race list, race, roster, car groups; meetings list and meeting; news feed and post; the Eboard space and its roster; profile; club search; Highlights (pinned, announcements); jump-to-message |
| New commands | Invite-token rotation, profile editing, account deletion, and the four Eboard membership commands |
| New schema | `eboard_join_requests`, and a check constraint on `news_reactions.emoji` |
| Tests | 76 route-level cases across five files, all through the HTTP stack with real session tokens |
| Constraint proof | 62 → **70** assertions |

Five defects in shipped code, none of them in the phase's own new work, all found because a
client-shaped caller finally existed. Full accounts in [`HISTORY.md`](../../HISTORY.md):

1. **Account revocation had never worked**, in both the API and the gateway, since Phase 0.
2. **An untargeted `ON CONFLICT DO NOTHING`** silently swallowed car-group invariant 5.
3. **A malformed id was a 500** on every id-addressed route, with a stack trace in the log.
4. **`news_reactions.emoji` was unconstrained text**, so PRD/06 rule 4 held only for want of a
   writer - and this phase was about to add the writer.
5. **A two-part authorization check could be satisfied against two different clubs**, had the
   poll routes accepted a `clubId` from the caller. Never exploitable, because no route existed;
   the fix is that the owning club is resolved server-side and no route takes one.

The one product question this phase could not answer for itself is recorded in
[Roadmap](../PRD/17-roadmap-and-open-questions.md): what account deletion should do when the
caller still owns a club. Built as a refusal, which is the only option that keeps both the
one-Owner invariant and the other members' club.

**Phase 3.75b - The screens.** *(Started 2026-07-30.)*
The screens [Screen map](../PRD/15-screen-map.md) already specifies: races and their roster, Meet
Information and car groups; polls in three scopes with inline voting; the calendar and events
list; meetups; news and Highlights; the Eboard space and its meetings. Plus the surfaces every
phase has quietly deferred - the notification inbox, the member roster, profile, and chat's own
Highlights tabs. Phase 3's remaining two, the Gallery grid and the full-screen viewer, closed
on 2026-08-01.

Ordinary client work now, against a surface that is finished and tested. Three things decided up
front, because each is the difference between forty screens and forty *copies*:

1. **The four top-level destinations become a real tab group** - Clubs, Calendar, Notifications,
   Profile - with the unread badge on Notifications. There was no tab bar at all; Messages hung
   off the bottom of the club list as a button, which is not what
   [Screen map](../PRD/15-screen-map.md) describes.
2. **Loading, loaded and retryable-error are one component, used by every screen that reads.**
   [Cross-cutting UX](../PRD/16-cross-cutting-ux.md) rules 1 and 2 are requirements rather than
   polish, and forty hand-written copies of a three-state fetch is how a blank-on-error screen
   gets shipped. Same argument as the policy module, one layer up.
3. **Shared screens, not forked copies**, per [Design system](13-design-system.md) rule 5. Polls,
   Highlights, Members, Gallery and the calendar each have **one** implementation parametrised by
   scope. If any of them forks per scope, the channel abstraction has been broken in the client
   after surviving intact in the server.

*Done when: every screen in [Screen map](../PRD/15-screen-map.md) exists and is reachable, **every
one of them can be navigated back out of when entered by direct URL with no history**, and the
[Acceptance checklist](../PRD/18-acceptance-checklist.md) can be attempted end to end.*

> **Why the back-out clause is in the gate.** It is [Screen map](../PRD/15-screen-map.md) rule 3,
> it has already shipped as a bug twice in this project, and it is invisible to clicking through -
> the navigator renders its own back button only when history exists, so every screen looks fine
> until somebody opens a notification deep link or refreshes the page.

**Progress, 2026-07-30.** The shell and the screens exist, the app runs, and every screen has been
walked by direct URL. What is still owed is listed at the end.

Built: the `(tabs)` group over Clubs, Calendar, Notifications and Profile, with the badge live on
its own destination. A client data layer covering all 111 routes (`src/api.ts`), so no screen
assembles a URL or a header. `useLoad` plus `<DataScreen>`, which is where loading, retryable-error
and empty live once rather than per screen. Roughly twenty-eight screens, with Polls, Highlights and
the Calendar each **one** implementation parametrised by scope.

Three defects found by running it, all fixed:

1. **Every screen entered by direct URL had no back control**, caught on `/clubs/:id/members`. The
   layout declared titles and left `headerLeft` to the navigator, which renders one only when
   history exists - rule 3 again, the third time in this project. Now every screen declares one, and
   the nested ones build it from their own route params so a screen inside a club goes back to *that
   club*.
2. **The invite link pointed at the API origin.** `/join/:token` is a client route, so the link an
   admin copies would have sent whoever tapped it to a server with no such path. Now
   `Linking.createURL`, which is the app's own address on every platform.
3. **The inbox crashed on its first real row.** The hand-written client type for an inbox row was a
   guess - `params`, a nullable body, `readAt` - and the real shape is a discriminated union with a
   `NotificationTarget`. That type is now imported from `@clubchat/shared` instead of restated, so
   the client's routing switch is exhaustive over it the same way the server's is.

Then three more, found by walking the rest of the screens - all of the same family, a hand-written
client type disagreeing with what the server actually returns:

4. **The gallery crashed on load.** Its page type said `{ items, hasMore }`; the server returns
   `{ entries, nextCursor }`. Worth more than the fix: each entry also carries `url` and `thumbUrl`,
   and **a web client cannot use either** - they point at the 302-behind-a-header endpoint that
   Phase 3 already established is unusable as an `<img src>`. The gallery renders from `mediaId`
   through the JSON sibling instead, and the type now says why in the place somebody would reach
   for them.
5. **Every news post read as "edited".** The marker was `updatedAt !== null`, and both timestamp
   columns default to `now()` - so a post was labelled edited from the moment it was created. It is
   `updatedAt !== createdAt`.
6. **A plain member was offered the Reports tab**, which would always have errored: reports reach
   only that space's admins. `readChannelMeta` now returns `canReadReports`, so the client offers
   the tab on the server's own answer rather than guessing from `canPin` - which would have been
   wrong for a DM, where the reader is a platform moderator and not either participant.

Also: chat now reads the `?around=seq` that Highlights and notification deep links hand it, fetching
the window, caching it in the local store, scrolling the target to the middle and marking it - so a
jump is one tap and the reader can see where they landed. News can attach a photo, uploaded against
the club's main channel because that channel's access rules are exactly news's audience.

**Verified by walking it** as three different actors - owner, an admin with no race roster row, and
a plain member - against a real API, gateway, worker and Postgres:

- Every screen renders, and **every one entered by direct URL with no history has a back control**.
- A race member opening `/races/:id` lands in **race chat**, whose back goes to Clubs and never to
  the hub. No bounce.
- The header quick-nav carries exactly its scope's entries.
- A poll card posted itself into race chat on creation.
- Voting **casts, moves and withdraws** on the same gesture, and opening the voter list cast nothing.
- A deadline-less poll sits in Upcoming, sorted last, and never falls into Past.
- The manager with no roster row gets the preview, "You manage this", Meet Information with its
  per-field empty states, and a route into the roster **only**.
- That same admin is refused the race poll **by direct URL**, and the car groups, each landing on a
  retryable "Not found" rather than a blank.
- The Eboard row is **absent** for a plain member, and its URL refuses them.
- A member sees the roster with no role or removal controls at all.
- An invalid invite link says so plainly and offers search, disclosing nothing.

Still owed: the acceptance checklist run end to end on **all three platforms** - everything above is
web only, and the simulator has still never been run.

**Added 2026-08-12: the share sheet and the QR code**, the club's front door as a surface rather
than a button. Two screens (`clubs/:id/share`, `clubs/:id/qr`), the code drawn from a zero-dependency
encoder rather than a wrapper, and every rendered code **decoded back** with a reader instead of
being eyeballed - including the exported PNG. Verified on web and on the iPhone.
See [`DESIGN/04`](../DESIGN/04-share-sheet.md).

Three defects, and the shape of them is the useful part:

1. **A member could hand out instant-join access to a `request` club**, which is
   [ADR-0024](../decisions/0024-every-member-holds-the-clubs-invite-link.md)'s recorded cost and
   was not acceptable. A club now holds two links and the token itself decides
   ([ADR-0025](../decisions/0025-a-members-invite-link-obeys-the-join-policy.md)).
2. **`/sync` had never worked on iOS.** The client pre-encoded its URL, React Native re-encoded it,
   and the server *skipped* what it could not parse - so every sync from the phone answered `200`
   and reconciled nothing, for months, hidden by the socket. `AGENTS.md` failure mode 24, and it is
   the same class as [Engineering pitfalls](14-engineering-pitfalls.md) 25 with the cure in place
   but never running.
3. **A banned person opening a link was told it was "no longer valid"**, which reads as a rotation
   and sends them to ask a member for a fresh one. `PRD/04` had specified plainness since bans
   shipped.

The first was found by the founder using it, the second by a log line that repeated forever, and
the third by writing the test for the first. **None of the three was findable by reading code.**

**Added 2026-08-12: the content filter**, which closes the last of App Review guideline 1.2's four
requirements and was the one item held open for a product decision rather than for engineering.
Hate speech is refused at send; the ambiguous terms post and file an automatic report into the
queue that already existed, filed as the seeded system actor so no new table, reader or screen was
needed. **Profanity is deliberately allowed** - see
[ADR-0026](../decisions/0026-filter-hate-speech-not-profanity.md). ClubChat is now **18+**, which
was settled in the same conversation and is what the store age rating rests on.

Three defects, and all three were in code written that day rather than found in shipped code:

1. **A leetspeak fold ran before a word-boundary match**, mapping `!` to `i`, so `you faggot!`
   did not match `\bfaggot\b`. `AGENTS.md` failure mode 25, and the most transferable thing here.
2. **The obfuscation list contained flag-tier terms**, which the collapsed pass would have
   promoted to refusals - silently removing the human judgement that tier exists for.
3. **The sign-up consent line has never linked to the Terms**, though `legal/terms.tsx` has said
   it does for the life of the project. Found by reading the rendered screen rather than the
   code, which is the only place it was visible.

**Phase 4 - Hardening.**
Rate limits everywhere. Retention and GC jobs. Accessibility pass on every icon-only control.
Sentry dashboards. Load test at 10× projected peak. The [Acceptance checklist](../PRD/18-acceptance-checklist.md) parity checklist, run on
all three platforms.

What that means concretely, as of today:

> **This table was stale in the direction that matters, and was corrected on 2026-08-12.** Three
> rows below said "not started" about work that had shipped on 2026-08-03, while the root
> `README.md` simultaneously marked the whole phase **Done**. Two documents making opposite
> release-readiness claims is worse than either being wrong alone, so both now state it item by
> item.

| Item | State | What is actually left |
|---|---|---|
| **Rate limits everywhere** | **Done** | A default bucket on the authenticated scope - the same structural place as the session hook, so a new route is limited without anybody remembering - plus named buckets on media intent, DM creation, join requests, invite redeem and reports, and per-IP on sign-in and sign-up. Still open: anything finer than a per-user bucket, and the per-conversation dimension |
| **Retention and GC** | **Done** | `runMediaGc` and `runRetentionSweep` run in the worker's hourly housekeeping slot. Read notifications go at 90 days, unread at 180, processed outbox rows at 7. **Parked events are never pruned**, deliberately: an event retried to the limit is the only durable evidence an effect never ran |
| **Error monitoring** | **Done server-side** | `monitoring.ts` reports 5xx, parked outbox events, failed drain ticks, socket frames and the rate limiter failing open, from all three processes, to the logger when `SENTRY_DSN` is absent. **The mobile client was covered 2026-08-12**: same port shape, `Sentry.wrap` at the root, and `capture` on the sync reconcile, the gateway auth rejection and the cache fallback. **Source maps are still owed** and need an auth token, so a production trace is minified until then |
| **Accessibility** | Partial, by habit | Controls carry `accessibilityRole` and `accessibilityLabel` as they are built. Never audited: contrast against WCAG AA, dynamic type, reduced motion, screen-reader navigation order |
| **Load test** | **Not started** | At 10× projected peak. The two numbers to watch first are the per-channel `last_seq` row lock under concurrent sends, and the access-context query now that it carries DM threads and blocks |
| **Parity checklist** | Blocked | Cannot be run until the surface exists |

**Beyond Phase 4 - release readiness.** Not engineering phases, and tracked in
[Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) rather than here: legal
review of the Privacy Policy and Terms (**with the obligation ADR-0005 adds - without E2E, the
policy must state that message content is readable by the service**), paid iOS developer-program
enrolment, and over-the-air updates so a fix does not need a store release - **the last of those is
done as of 2026-08-27**, wired and then proved by publishing an update and watching it arrive on a
phone, which [`TECH/21`](21-deployment.md) records in full.
