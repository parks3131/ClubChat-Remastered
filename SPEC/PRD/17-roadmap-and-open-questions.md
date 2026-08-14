# Roadmap and open questions

> **Status, 2026-07-30.** Phases 0, 1, 2, 3, 3.5 and 3.75a are built; see
> [Build phases](../TECH/16-build-phases.md) for the phase-by-phase state and what each one still
> owes. Two facts dominate everything below:
>
> 1. **Most of the product has no user interface** - but it does now have a server. Races, polls,
>    calendar, weekly meetups, news and Eboard are reachable over 111 HTTP routes as of Phase 3.75a, and
>    the app is still sign-in, a club list, chat and a DM list. The remaining work is screens
>    against a finished surface (Phase 3.75b), which is a different and much smaller problem than
>    the one this entry described before.
> 2. **Phase 1.5 (Kafka) was skipped** and the worker still drains the outbox directly. Correct
>    and ordered, but not the distributed design ADR-0006 specifies.

### Blocking a real release today

| Gap | Impact | Note for the remaster |
|---|---|---|
| ~~**Push notifications**~~ | | **Done in Phase 1** on the server; **the device half landed 2026-08-08** and the whole path is now proved on real hardware. Device registry, Expo Push, per-device fan-out, and suppression by read cursor rather than by connection liveness (ADR-0008). Phase 3.5 added the DM push (ADR-0015). Until 2026-08-08 the client had no `expo-notifications` at all - nothing ever asked permission, fetched a token or called `POST /devices` - so "done" described one end of a wire with nothing on the other |
| **A user interface for most of the product** | Races, polls, calendar, weekly meetups, news and Eboard are unreachable from the **app**, though no longer from the API | **Half closed 2026-07-30.** Phase 3.75a built the HTTP surface: 45 routes became 111, with the ~20 missing queries and the six capabilities that had no function of any kind. What is left is Phase 3.75b, the screens - and it is now ordinary client work rather than a screen with nothing to call |
| **An https join page, and universal links** | The invite link is `clubchat://join/<token>`, so it opens the club for somebody who already has the app and does **nothing at all** for somebody who does not - no prompt, no error, no page. [ADR-0010](../decisions/0010-link-only-invites.md) recorded this as the cost of removing the typed code and named "a real web client" as the mitigation; it has never been built | **Promoted from a footnote on 2026-08-12**, when the club QR code shipped. A link in a message is at least *seen* by a person who can be told to install the app first; a code taped to a table is scanned by a stranger who gets a blank camera. What it needs: `clubchatapp.com` serving `/join/:token` with the club's name and a store link, `apple-app-site-association` plus the associated-domains entitlement, Android `assetlinks.json` and intent filters, and a native rebuild. The QR screen itself does not change - only the string it carries |
| **Legal review** of Privacy Policy and Terms | The shipped documents are an in-house first draft, explicitly not legal advice | Must happen before any public release |
| **iOS distribution** | Blocked on paid developer-program enrolment | Not a code problem |
| ~~**App Review guideline 1.2, the filtering bullet**~~ | | **Done 2026-08-12. All four requirements are now met.** Reporting and blocking shipped in Phase 3.5; acting on a report and a published support address landed 2026-08-11; filtering was the last one and needed the product decision this row was waiting on. It refuses hate speech at send and queues the ambiguous cases into the report queue that already existed, and it deliberately does **not** filter profanity - see [ADR-0026](../decisions/0026-filter-hate-speech-not-profanity.md), which records why a swear filter is the wrong target for a university club and what the term list knowingly cannot catch. The related age question was settled at the same time: **ClubChat is 18+**, declared at sign-up and in the Terms, which is also what the store age rating is declared against |
| ~~**Error monitoring**~~ | | **Done 2026-08-03, server side.** `monitoring.ts` reports from all three processes: 5xx on the API through a `setErrorHandler` that did not previously exist, parked outbox events, failed drain ticks, socket frames, and the rate limiter failing open. Reports to the process logger when `SENTRY_DSN` is absent, so the paths run in development and CI rather than first executing in production. **The mobile client was covered on 2026-08-12**, which closes this row entirely. `@sentry/react-native` (pinned by Expo to 7.11, not npm's 8.x), a `monitoring.ts` shaped exactly like the server's, `Sentry.wrap` on the root layout for render crashes, and `capture` on the three client failures that were previously a console line on a device nobody is attached to: the gateway rejecting a session, a foreground reconcile failing, and the SQLite cache falling back to memory. **Source maps are still owed** - they need an org slug, a project slug and an auth token - so a production stack trace is minified until that pass |

### Important, not blocking

| Gap | What "fixed" looks like |
|---|---|
| **Accessibility** | Every interactive control labelled, screen-reader navigable, contrast verified against WCAG AA, dynamic type supported, reduced motion respected. Start with the icon-only controls |
| ~~**Offline**~~ | **Done in Phase 3.** Read-only cached chat plus a send outbox with optimistic messages, which was the "ideally" of this entry rather than the minimum. See [Cross-cutting UX](16-cross-cutting-ux.md) |
| ~~**Test coverage**~~ | **Substantially done.** 607 tests, five permission matrices asserted cell by cell in both directions, 70 constraint assertions attempted against a live database, 76 route-level cases through the HTTP stack, and a 73-check gate against a running server. The gap that remains is UI tests, which wait on there being a UI |
| ~~**Muting**~~ | **Done in Phase 3.5.** Per-conversation, every scope: no push, unread count still accrues. Per-**type** and per-club preferences are still open, and are now one check inside the audience function rather than something with nowhere to live |
| ~~**Block or mute between members**~~ | **No longer deferrable.** Promoted out of this list on 2026-07-28: with direct messages in scope, blocking, conversation mute, and a report destination ship in the same release as DMs. A private one-to-one channel with no admin party to it, no block, and nowhere for a report to go, is a materially different risk class in a product that will include minors. See [Direct messages](14-direct-messages.md) |
| **Over-the-air updates** | Every fix currently needs a full store release |
| **An announcement that also mentions somebody buzzes that person twice** | One phone, one message, two notifications - "Riley: kit order closes Friday" and "Riley mentioned you". Pre-dates per-message push and was made visible by it, since the same rule is now applied correctly one branch over: the ordinary-message audience subtracts the mentioned, and the announcement audience does not. The reason it is not simply the same fix is that an announcement also writes a **row** per recipient, and the mentioned member is entitled to both rows - so the dedupe belongs at the push layer across slots, not in the audience. See [ADR-0032](../decisions/0032-every-chat-message-pushes.md) |
| ~~**Image dimensions are not on the wire**~~ | **Done 2026-08-13.** `media_objects` records the displayed width and height at complete-upload, inside the decode the probe already pays for, and `/media/:id/url` returns them - so a photo is laid out before a byte arrives. Fixing it surfaced a second, visible defect: derivation never applied the camera's EXIF orientation while writing a format that cannot carry one, so portrait photographs shipped sideways. See [Media pipeline](../TECH/07-media-pipeline.md) |
| **Media uploaded before 2026-08-13 was not backfilled** | Those objects keep their variants, so a photo whose camera tagged it portrait is still stored and shown sideways, and still has no recorded dimensions (the client measures it, as it did for everything). Fixed by clearing `variants` for image rows and re-emitting `media.uploaded`, which is a deliberate operation with a real re-encoding cost rather than a migration |

### Architectural debt worth designing away

These are recorded remediation items in the current build. A remaster gets them for free if
designed in.

1. ~~**Realtime reconciliation on reconnect and foreground**~~ **Done** - sync engine plus gapless `seq`, reconciled on connect, foreground and network regained.
2. **Filtered subscriptions** (lesson 26). Today three subscriptions are project-wide; with
   200 concurrent users, one message insert costs ~200 authorizations, ~200 billed messages,
   and ~200 full refetches.
3. **Message sequence numbers** - a monotonic per-channel ordinal, so ordering, paging, and
   "have I seen everything up to N" do not depend on timestamps.
4. **Client-generated idempotency keys on sends**, so a retry after a flaky network cannot
   double-post.
5. **Denormalized and capped unread counts**, and a collapsed calendar feed. The cross-club
   merged calendar currently reads once per feature **per club the user belongs to**.
6. ~~**Highlights must not silently lose pins past the loaded window.**~~ **Done in Phase 3.75a** -
   `readHighlights` queries the whole channel behind the partial indexes that were built for it,
   so a pin sixty messages past the loaded page is still the first row of the Pinned tab.
   Originally: the pinned and announcement lists were computed over a bounded slice of history.
7. ~~**Media cost.**~~ **Done in Phase 3**, and the mechanism turned out to matter more than expected - see [Media pipeline](../TECH/07-media-pipeline.md) on which of the CDN and the object store signs. Originally: Signed URLs are memoized per device, which fixed the repeat-fetch
   multiplier, but two devices still hold different URLs for the same object, so N viewers is
   still N origin downloads. A CDN-friendly scheme (stable URLs plus an authorization gate, or
   a transformation layer) belongs in the design, not bolted on.
8. ~~**Storage cleanup.**~~ **Done** - `runMediaGc` sweeps stale pending uploads and orphaned objects nightly.
9. ~~**File size and MIME-type limits.**~~ **Done** - allowlist and cap enforced at intent and **re-verified against the real object** at complete, because a presigned URL cannot police bytes the client chose to send anyway.
10. ~~**Notification retention.**~~ **Done 2026-08-03.** `runRetentionSweep` runs in the worker's hourly housekeeping slot beside the media GC, in bounded batches. Read notifications go at 90 days and unread at 180 - the longer window because deleting an unread row silently decrements a badge for something the member never saw. Processed outbox rows go at 7 days. **Parked events are never deleted**: an event retried to the limit and never processed is the only durable evidence that an effect never ran, and a timer that removed it would erase the record of an unfixed bug. The sweep reports the parked count every hour, which is the only recurring place that number is spoken. Hard delete rather than an archive table, which would be the same unbounded growth renamed.
11. ~~**Localisation.**~~ **Designed away in Phase 1** - notifications store `type` plus structured `params` and render at read time (ADR-0013), so a second locale is another implementation of one function rather than a migration over every historical row. The English renderer is the only one that exists.
12. ~~**Rate limiting beyond messages**~~ **Done 2026-08-03.** The entry understated it: it was not
    only reports, reactions and join requests, it was every route except message send. A default
    bucket now applies on the authenticated scope - the same structural place as the session hook,
    so a new route is limited without anybody remembering - with tighter named buckets on media
    intent, DM creation, join requests, invite redeem and reports. Sign-in and sign-up are keyed
    per IP, being the routes reachable without an account. The per-new-conversation dimension this
    entry called out is `POST /dm/threads` at 10 burst, refilling at one per twenty seconds.
    **Per-conversation and per-club preferences remain open**, as does anything finer than a
    per-user bucket.
13. **Backups and version parity** between development and production data stores. **Still open** - there is no production yet. Migrations already replay cleanly from zero, which is half of it.
14. ~~**A `msg.update` missed while disconnected is never recovered.**~~ **Done 2026-08-03.** Sync now reconciles on a per-channel REVISION rather than on `seq`: `channels.last_rev` is bumped by an append and by every later mutation, each message carries the revision it last changed at, and the client asks for `rev > <its mark>`. One watermark covers both halves, because an append allocates a revision too. A reaction touches its message row explicitly - it lives in another table, so nothing of the message itself changes while the envelope every reader sees does. A client sending no mark gets the old seq behaviour unchanged, so a mixed fleet degrades rather than breaks. Original text follows.

    **A `msg.update` missed while disconnected is never recovered.** Found on 2026-08-01 while
    verifying replies: `syncChannel` pulls strictly ABOVE the local max, so a row the client has
    already cached is never fetched again - and pins, tombstones and reactions all travel as
    updates against rows below that mark. A client that is offline when somebody deletes a
    message shows that message, with its text, indefinitely. [Protocol](../TECH/10-protocol.md)
    currently claims the loss is self-healing because "the next update, sync or history page
    brings the truth"; sync does not, and the claim is only true for a message the client had
    not yet seen. The fix is a reconciliation bound - sync returning rows *changed* since a
    watermark rather than rows *added* - and it is a design change to the sync contract rather
    than a patch, which is why it is recorded here rather than fixed in passing. Note the shape:
    every automated check passes, because each half is individually correct.
15. **The test suite starts one Postgres container per file**, twenty-seven of them per run, and
    intermittently fails one with `Timed out after 10000ms while waiting for container ports to be
    bound to the host`. **Measured on 2026-08-03:** Docker binds a port in ~4.3s on this machine
    with nothing else running, against a ceiling that is a **hardcoded default parameter** inside
    `inspectContainerUntilPortsExposed` - not reachable through `withStartupTimeout`, which
    configures the wait strategy that runs afterwards. `fileParallelism` is already false, so this
    is not test concurrency. The fix is **one container for the suite** with a database per file,
    which removes twenty-six container starts and the flake with them. Until then a failing run is
    re-run, which is a habit worth being uneasy about - see the 2026-08-03 history entry for two
    confident misdiagnoses of exactly this.

### ~~Known defect: the gateway rejects a session the API accepts~~

**Fixed 2026-08-09.** It never rejected a session. Every one of the 101 unexpired session rows in
the development database was replayed against both surfaces and all 101 agreed, which is what
forced the search somewhere other than the token.

The gateway started handling each frame immediately rather than behind the previous one, and
`auth` is answered only after two database round trips. So a `subscribe` or `msg.read` sent in that
window - which is exactly where a chat screen's mount effect lands on a cold open, whether from a
deep link, a notification tap or a page refresh - was evaluated while `state.userId` was still
null, refused, and the socket closed. The refusal was reported as `invalid_token`, and since
2026-08-08 the client acts on that code by ending the session: a member holding a token the API was
answering `200` for was signed out.

That also explains the two things the original entry could not. **"Signing out and back in clears
it"** - because sign-in lands on the club list, where nothing opens a channel while connecting.
And **`resolveSessionFromToken` accepts a freshly-issued token every time in testing** - because
the token was never the problem.

Fixed at both ends, since each is the other's blast radius: the gateway now handles one socket's
frames at a time and answers `not_authenticated` for a genuinely early frame, and the client holds
subscriptions and read cursors until `auth.ok` rather than treating a non-null socket as a usable
one. See [Connection layer](../TECH/01-connection-layer.md) and [Protocol](../TECH/10-protocol.md).

### ~~Known defect: another member's poll or event card does not appear in chat~~

**Fixed 2026-08-08, hours after being recorded here.** It was never about cards, authorship or
rendering: `openChannel` called `subscribe` before `syncChannel`, and `subscribe` throws when the
socket is down - aborting the function before the HTTP sync it did not need a socket for. Messages
missed during a flap then sat below the local high-water mark, which neither `since_seq` nor
`since_rev` can reach. `syncChannel` now repairs gaps first, and a failed subscribe no longer
cancels the sync. See HISTORY.md 2026-08-08 (last), which is worth reading for the four wrong
diagnoses and why the test suite could not have caught either bug.

The table below is kept because everything in it was verified live and remains true - it is the
list of things that are **not** the cause, and it is what finally forced the search somewhere else.

**Everything below was verified live and is NOT the cause.** Recorded so the next attempt does not
re-walk it:

| Checked | Result |
|---|---|
| The card row is written | Yes - `type` `poll`/`event`, correct `linked_poll_id`/`linked_event_id`, correct `sender_name` |
| `GET /channels/:id/messages` returns it | Yes, every card |
| The poll is readable by a **non-creator** club member | Yes, `200` with full data |
| The gateway relays it live | Yes - a subscribed socket received `msg.new seq=99 type=poll linkedPollId=…` |
| The socket envelope vs the API envelope | **Byte-identical**, field by field |
| An ordinary TEXT message from the same member, same channel, seconds later | **Renders fine** |

That last row is what rules out general message loss, and it is the sharpest clue: text from
another member arrives, a card from the same member does not.

**The one structural difference left unexamined:** an ordinary message is published to Redis by
the **gateway**, on the sender's own socket; a card is published by the **worker**, from its effect
handler. Both call `publishToChannel`, and a subscribed test socket demonstrably receives the
worker's. Whether a real client's `ChatClient` also stores it - rather than receiving and
discarding it - was never established, because the device's local SQLite cannot be inspected from
outside.

Two client-side fixes were made while chasing this and **neither resolved it**, though both stand
on their own: the three chat cards no longer return `null` on a pending or failed read (the chat
screen suppresses the body sentence for any card-carrying message, so returning null rendered an
invisible row), and `applyIncoming` no longer discards a frame at or below the local high-water
mark (a hole beneath the mark was permanent, because sync pulls strictly above it).

**Where to start next:** determine whether the card reaches the device's store at all. Signing out
and back in rebuilds the cache from the API - if the card appears after that and not before, the
defect is in live delivery to `ChatClient`; if it still does not appear with the row certainly
present, it is in the render path.

### Verification owed

Things that are built and not yet proved on every surface they claim to work on.

| What | Verified on | Still to verify |
|---|---|---|
| **Everything, on iOS and Android** | Web, via the browser; **iOS on real hardware** since 2026-08-01 | *(Corrected 2026-08-08 - this row said "the simulator has never been run" and was dated 2026-07-30, by which time it was already going stale.)* A development build has run on a real iPhone since 2026-08-01, and most work since - replies, the long-press menu, the calendar swipe, race notifications - was reported from that device. **Android has still never been run at all**, and no full pass of the acceptance checklist has been done on any native platform |
| **Platform moderation** | **Web and iOS, both on 2026-08-11.** Web: the moderator gate on the Profile entry (present for a moderator, absent for an ordinary account), the queue with its outcome chips and no message bodies, the context screen's state-aware actions, the confirm wording, and a reinstate performed end to end with the database changing. iOS: the same surface walked on the physical iPhone - queue, action block, confirm dialog, and Contact support opening Mail | Android, as everywhere. Also unproved on any platform: what a **suspended** member sees, since the refusal was verified over HTTP rather than by signing in on a device |
| **Sharing a club, and the QR code** | **Web and iOS, both on 2026-08-12.** Web: the share screen, the copy confirmation, the code decoded back with a reader (with and without the club's picture, and the exported PNG too), and the whole two-link rule walked as three accounts - an admin's link joining instantly on a `request` club, a member's filing a request. iOS: the founder scanned the code and joined from it, confirmed both link tiers behave differently on a `request` club and identically on an `open` one, and **saved the code to Photos** - which is the native export path end to end, since it runs `toDataURL` through the platform rasteriser, writes the base64 to a file, and asks for the write-only photo permission, none of which the web branch touches | Android, as everywhere |
| ~~**Reconciliation on iOS**~~ | **Never worked until 2026-08-12**, and nothing said so. The client pre-encoded its `/sync` URL, React Native re-encoded it, and the server skipped the entry it could not parse - so every sync from the phone answered `200` with an empty channel list while the socket kept the app looking current. Now proved on the device: the local cache went from a permanent hole to complete, and the repair loop it had been running on every sync stopped | Android has never run at all, so its sync is unproved for the ordinary reason rather than this one |
| **The attachment upload path** | Web (`blob:` URI through `fetch`) | Native reads a `file:` URI through the same `fetch` call - one path rather than an unverified branch, and untested |
| **The pickers** | Web file chooser | Native permission prompts for library and camera, which have no web equivalent |
| ~~**Push**~~ | **Proved end to end on 2026-08-08**, on the physical iPhone, for both target shapes: a `mentioned` push deep-linking to an exact message (`?around={seq}`) and an `event_created` push landing on the event. Every suppression rule exercised live - read cursor (the 8s deferral), mute on **and** off, sign-out deregistration, and token invalidation | `poll_created` and the other flat targets are **unverified** - `hrefFor` is exhaustive and the event case proves the shape, but no other kind has been tapped. Android has no build and so no push |
| **`MEDIA_URL_MODE=cdn`** | Not at all | Only `presign` runs today. The CDN branch is the production one and has never served a byte |

### Security audit

> **Run 2026-08-08.** All six sections below were worked through. **Two defects were found, both
> proved against a running server and both now fixed**; the rest of the surface came back clean.
> The full narrative is in [`HISTORY.md`](../../HISTORY.md); the recognition rules are AGENTS.md
> failure modes 19 and 20.
>
> | Found | Was | Now |
> |---|---|---|
> | **Every profile readable by every account.** `GET /users/:id` took an access context and never consulted it, so any signed-in caller holding a uuid got any account's name, bio, city, school and avatar - including a caller its owner had just blocked | A rule asserted in ADR-0009, in this document's own rejected alternatives and in `sharesAClub`'s docstring, and enforced nowhere | `canViewProfile`: self, a shared club, or an existing conversation. See [Accounts and profile](03-accounts-and-profile.md) rule 8a |
> | **Revocation stopped at the socket.** `isSessionUsable` was asked on every HTTP request and once per connection, so a shut-off account kept **sending** and a self-deleted account kept **receiving**, indefinitely, while their HTTP requests were correctly 401'd | Two causes: the gateway never re-asked, and `deleteOwnAccount` wrote no outbox event so published no revocation | Asked on every frame that reloads the context, plus an `account.deleted` event carrying the channel ids. See [Authorization](../TECH/05-authorization.md) |
>
> **What came back clean**, which is worth recording because a negative result is only useful if it
> was actually looked for: all 124 routes reach a channel guard, a predicate-bearing domain function
> or an inline predicate (checked mechanically, not sampled); no SQL injection anywhere - the single
> `sql.raw` is `isoUtc` and every call site passes a hardcoded column name; email confined to `/me`
> across twenty read surfaces; the media pipeline's three hops each authorized; and the DM report
> queue carries no message bodies, so the logged context read really is the only door to content.
>
> **The three operational findings were closed the same day**, in a second pass:
>
> - **Security headers**, from one plugin on the whole instance. See
>   [Authorization](../TECH/05-authorization.md) for the three defaults that had to be overridden.
> - **`TRUST_PROXY`**, defaulting to `false`, so the per-IP sign-in bucket keys on a real address
>   once there is a proxy in front. Both directions are wrong in different ways and the config
>   docstring says which.
> - **`.env.bak` untracked**, and `.gitignore` changed from a list of guessed suffixes to `.env*`
>   with `!.env.example`. The pattern was the finding; the file only ever held a placeholder.
>
> **Still open:** the dependency advisories (triaged below, not fixed).
>
> ~~the platform moderation queue having no screen~~ **Closed 2026-08-08**, when the queue and the
> context reader were built. This entry went stale the same day and was still claiming otherwise on
> 2026-08-11, which is worth noting for the reason the `PRD/15` chip rule was: **a spec nobody has
> cause to re-read goes stale silently.** It was found by reading the document for an unrelated
> question, not by an audit.
>
> **Dependency advisories, triaged 2026-08-08.** The entry below said "15 moderate, mostly
> `@expo/config-plugins` transitives". The real number today is **30 - 12 moderate and 18 high** -
> and the useful part is not the count. Exactly **one** of them reaches the deployed server's
> request path: `fast-uri` (GHSA-7p8r-x3mc-p8w7, host confusion via a backslash authority
> introducer), which arrives through `fastify` → `@fastify/ajv-compiler` → `ajv`. Everything else
> - `image-size`, `js-yaml`, `brace-expansion`, `uuid`, `esbuild`, `nanoid` - arrives through Expo,
> `drizzle-kit`, `vitest` or an optional `expo-sqlite` peer, and runs on a developer's machine
> rather than in production.
>
> `fast-uri@3.1.5` patches it and is inside the `^3` range `ajv` already accepts, so this is a
> patch bump rather than a forced upgrade. **An `overrides` entry was attempted and npm 11.12.1
> did not apply it** - the key is read back by `npm pkg get` and does not reach the lockfile, even
> with the lockfile deleted and regenerated. Left unfixed rather than worked around, because the
> next step is either an npm-version question or a real dependency pass, and `npm audit fix
> --force` would move Expo 57 and TypeScript 6, both of which are pinned deliberately
> (`AGENTS.md` 5.1). Note also there are two `fast-uri` copies at different majors, so any
> override has to name both.

The plan, as written on 2026-08-03, follows. It is deliberately a **reading** exercise before it is
a fixing one, and three of the findings were turned up while writing it rather than by running it -
they are recorded because a plan that hides what it already knows is worse than no plan.

**The scope is bounded by one thing worth stating up front:** this product will include minors, and
it has private one-to-one conversations in it. That raises the stakes on the authorization and
safety sections below relative to everything else, and it is the reason the audit is worth doing
before a public release rather than after one.

#### Already known, before the audit runs

| Finding | Severity | Note |
|---|---|---|
| ~~**`.env.bak` is tracked in git and not covered by `.gitignore`**~~ | **Fixed 2026-08-08** | It held one placeholder (`dev-only-not-a-secret-regenerate-me`) so nothing real leaked. The finding was the *pattern*: `.gitignore` listed `.env`, `.env.local` and `.env.*.local`, and `.env.bak` matched none of them. Now `.env*` with `!.env.example` - deny everything and allow back the one template, rather than listing the spellings somebody thought of |
| **Every secret in `.env` is still its development placeholder** | Blocking for production | `BETTER_AUTH_SECRET`, `MEDIA_SIGNING_SECRET` and the S3 credentials are all dev values. They must be generated fresh and held by the platform, never in a file, before anything is deployed |
| ~~**No security headers on the API**~~ | **Fixed 2026-08-08** | There were none: no HSTS, frame options, content-type-options or CSP, zero occurrences anywhere. One plugin on the whole instance, as this entry asked for. Three of its defaults had to be overridden - see [Authorization](../TECH/05-authorization.md) |
| ~~**`trustProxy` is not configured**~~ | **Fixed 2026-08-08** | Behind a proxy without it, `request.ip` was the proxy's, so the per-IP sign-in bucket was one shared bucket for the whole internet - failing closed rather than open, and useless as credential-stuffing protection either way. Now `TRUST_PROXY`, defaulting to `false`, because the opposite mistake is worse: trusting the header on a directly reachable process removes the limit rather than loosening it |
| **30 dependency advisories** (12 moderate, 18 high, production tree) | Medium, and **triaged 2026-08-08** | Exactly one reaches the deployed server's request path - `fast-uri`, through `fastify` to `ajv`. The rest arrive through Expo and build tooling. See the triage note above for why the one-line fix was attempted and left in place unapplied |
| **`MEDIA_URL_MODE=cdn` has never served a byte** | Unverified, not a finding | The production media path is the one nobody has run. Listed under "verification owed" above |

#### What the audit itself has to cover

1. **Authorization, which is the one that matters most.** The permission matrix is asserted cell by
   cell and that is genuinely strong - but a matrix proves the predicates, not that every route
   *calls* them. The questions: does any of the 123 routes reach a domain read without passing
   `authorizeChannel`; does every read that can return other people's rows go through
   `visibleToViewer`; is the `404 rather than 403` discipline complete, since one route answering
   403 confirms a resource exists to somebody who should not know it. **Column-level authority is
   the specific v1 defect this architecture exists to fix**, and it is proved today for pin and
   soft delete - the audit is whether it is proved for every mutable column.
2. **Object storage.** Can a presigned upload be redirected at another channel's bucket path; can a
   member attach an object somebody else uploaded (there is a check, and the audit is whether it is
   complete); does a download signature actually bind to the viewer's access rather than only to
   the object.
3. **Raw SQL.** 207 `sql` template literals in non-test server code. Drizzle parameterises
   interpolations, so the expected finding is none - but that is a claim to verify by reading for
   any string concatenation into a query, not to assume from the library's docs.
4. **Data exposure.** Email is asserted to live only on `/me`; the audit extends that to every
   envelope, roster and search result. Blocking deliberately leaves history readable to both
   parties (`PRD/14` rule 6) - the audit confirms that is what the code does everywhere rather
   than what it does in the one place it was written.
5. **The socket.** Auth arrives in the first frame with a five-second window. Channel access is
   checked at subscribe and deliberately not re-checked per message, which is why revocation has to
   force-unsubscribe - the audit is whether every path that removes access actually publishes that
   revocation.
6. **Safety surfaces, given minors are in scope.** Report reaches a queue, blocking works, DM
   reports are metadata-only for platform moderators. *(This read "the known gap is that the
   platform moderation queue has no screen at all - `hrefFor` returns `undefined` for it on
   purpose" until 2026-08-11. Both halves were already false: the screens landed on 2026-08-08 and
   `hrefFor` returns `/moderation`. Corrected per the standing rule that the repo is right and the
   doc is the bug.)*

   **What was actually missing was everything after reading.** Closed 2026-08-11: a moderator can
   now be appointed from configuration ([ADR-0022](../decisions/0022-platform-moderators-are-appointed-in-configuration.md)),
   remove a reported message, and suspend the account that sent it
   ([ADR-0023](../decisions/0023-a-moderator-may-remove-a-reported-message-and-suspend-an-account.md)).
   Before that the flag was set by hand in SQL and the only verb in the queue was "dismiss".

#### Explicitly not in scope

Penetration testing, threat modelling of the infrastructure, and anything about Fly.io or Neon's
own posture. This is an audit of code that has been written, by reading it.

### Deliberately deferred (do not "fix")

Race-specific workout plans (in the original vision, never built; may have been absorbed by
Meet Information - needs a product call). Bidirectional chat paging. Message search. Comments
on news posts. External calendar sync. RSVP or attendance, anywhere. *("Recurring events" left
this list on 2026-08-14 - it is an open question below, not a settled no.)*

### Open product questions

- ~~**Should a meetup notify anybody?**~~ **Settled 2026-08-08: no**, and unchanged by the
  2026-08-14 rename. Raised when the founder expected to tap through to one from a notification and
  found the catalogue has no type for it. He confirmed the silence is intended - it is reference
  material somebody consults, not an announcement - so the asymmetry with events, polls, news and
  meetings stands on purpose. Recorded so it is not re-raised as an omission. **This is now the
  load-bearing reason Weekly Meetups and the calendar are separate surfaces rather than one**, so it
  is cited by [Weekly Meetups](08-weekly-meetups.md) rule 9 rather than merely recorded here.
- ~~**Should a mention require an exact name match?**~~ **The over-matching half was fixed
  2026-08-08**; what is left is one narrow case, described below. This entry originally read that
  `body.includes` has no word boundary, so `@Parks RPK` also satisfied a member called `Parks`, and
  that any divergence from `users.name` - a rename mid-compose, trimming, punctuation - dropped the
  mention silently.

  **Over-matching: fixed, and not by a word boundary.** A boundary would not have helped, because
  the character after `@Parks` is a space and that is a perfectly good boundary. What separates the
  two is that a *longer* candidate also matches at that exact index, so `resolveMentions` now sorts
  candidates longest-name-first and lets each claim the indexes it matches, skipping any index a
  longer name already took. A name survives only where it is the longest match at some position.
  Asserted in both directions, since a rule that only ever excludes is the easy half: the prefix is
  not dragged in, and the short name is still mentioned when it is the one actually written. The
  client applies the same rule in `splitMentions`, so what is highlighted cannot disagree with who
  was notified.

  **Two of the three under-matching causes were never real.** Trimming and punctuation do not break
  it: the check is a substring test, so `@Parks,` still contains `@Parks`. And `applyMention`
  appends a trailing space on insert *specifically* so the next character cannot extend the name and
  stop it matching on send - the composer was already defending this.

  **What remains is a rename between picking the name and sending.** The client filters against the
  name captured at pick time and the server checks `users.name` as of send, so a rename in that
  window has the client claim a mention the server then drops. It is still silent: the ack is `ok`,
  the envelope carries `mentions: []`, and nothing compares what was claimed against what came back.
  The open question is whether that is worth a signal to the sender at all, given the window is one
  person renaming themselves while another is mid-message.
- **Hub placement:** Weekly Meetups, Polls, and the Events list are fully reachable from club chat's
  header quick-nav, and work normally there. Whether they should *also* sit on the club hub is
  unresolved. A stopgap "More" menu on the hub was explicitly rejected.
- **Should a meetup repeat?** Deferred with the 2026-08-14 rename and the largest remaining gap
  between the feature and "fits any club": a club that meets daily hand-enters 365 meetups a year,
  because [Weekly Meetups](08-weekly-meetups.md) rule 1 says the week is a real week and never a
  template. Answering yes also reopens [Overview](00-overview.md)'s recurring-events non-goal,
  whose stated reason was that this surface already covered the weekly case.
- **Should a club still have a `sport`?** It is a required field on create, free text, validated by
  nothing and read by nothing - a leftover of the founding case that now asks a chess club what
  sport it plays. [ADR-0029](../decisions/0029-a-meetup-answers-where-when-and-what.md) removed the
  reason to replace it with a club type and did not remove the column. Deleting it is the obvious
  move; what stops it being obvious is that the club profile currently shows it.
- **Nudge**, the admin-only bell that pushes one meetup to the club, is designed and unbuilt - see
  [Weekly Meetups](08-weekly-meetups.md). Three things decide whether it works rather than becoming
  the reason members turn push off: who the audience is, what stops it being tapped repeatedly by
  several admins, and which notification type carries it.
- **Is "Races and Meets" the next name to generalise?** The abstraction under it - a mini-club with
  its own roster, chat and logistics - already fits a theatre production, a debate tournament and a
  field trip; only the word is sport-coded. It is now also one letter from "meetup", which
  [Weekly Meetups](08-weekly-meetups.md) disambiguates in prose because the data model cannot.
- Should a club (or a finished race) be **archivable** - read-only history preserved - rather
  than only deletable?
- Should the calendar's `race` event **type be removed**, given it has no relationship to a
  real Race and reads as if it does?
- Is **"Eboard & Council"** the right default name for every club, or should it be
  configurable?
- Should **"News & Highlights"** be renamed, given chat's own "Highlights" is easy to confuse
  with it?
- **The join link should be revocable or rotatable** - promoted from an open question to a
  requirement on 2026-07-28, when the typed invite code was removed. The link is now the *only*
  invite mechanism, so a leaked one has no alternative to fall back on, and rotating the token
  is the sole remedy. Rotation invalidates every outstanding link at once, which is the correct
  and expected behaviour.
- Should ownership transfer **require the recipient to accept**?
- ~~**What should deleting an account do when the caller still owns a club?**~~ **Settled
  2026-07-30: deletion refuses with `owns_clubs` until the Owner transfers or deletes each club.**
  Three rules collided - deletion is unconditional and self-service
  ([Accounts](03-accounts-and-profile.md) rule 11), an Owner cannot leave and transfer is their
  only path out ([Clubs](04-clubs-and-membership.md)), and exactly one Owner must exist per club
  because an ownerless club has no recovery path ([Domain model](01-domain-model.md) invariant 1).
  The refusal is the only outcome that keeps both the invariant and the other members' club, and it
  stays self-service because the client can offer transfer-or-delete per club. Rejected:
  auto-promoting the longest-serving admin (hands a club to somebody who never asked for it), and
  deleting the owned clubs (destroys other people's club to close one account).
- Should an admin other than a poll's creator be able to close a poll whose creator has left?
- ~~Do clubs including **minors** need age gating, parental consent, or restricted profile
  fields?~~ **Settled 2026-08-12: ClubChat is 18+.** Declared at sign-up and stated in the Terms,
  and it is what the store age rating rests on. The founding case is a university club, so the
  minimum costs the product almost nothing and it keeps a one-to-one messaging surface out of the
  children's-privacy regimes it would otherwise fall into. Declared rather than verified by a
  date of birth, deliberately: collecting every member's birthday to check something almost none
  of them would misstate is the wrong trade for a club app. See
  [ADR-0026](../decisions/0026-filter-hate-speech-not-profanity.md). **Note what this does not
  settle** - every earlier document that reasons from "the product will include minors" (this
  file, `TECH/02`, `TECH/05`) now overstates the risk, and those sentences are true of the
  *intent* rather than the *population*. Is a **data-retention policy** needed? Should a user be
  able to **export their own data** before deleting?
