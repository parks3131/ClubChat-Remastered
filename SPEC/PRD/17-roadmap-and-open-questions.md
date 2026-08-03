# Roadmap and open questions

> **Status, 2026-07-30.** Phases 0, 1, 2, 3, 3.5 and 3.75a are built; see
> [Build phases](../TECH/16-build-phases.md) for the phase-by-phase state and what each one still
> owes. Two facts dominate everything below:
>
> 1. **Most of the product has no user interface** - but it does now have a server. Races, polls,
>    calendar, routines, news and Eboard are reachable over 111 HTTP routes as of Phase 3.75a, and
>    the app is still sign-in, a club list, chat and a DM list. The remaining work is screens
>    against a finished surface (Phase 3.75b), which is a different and much smaller problem than
>    the one this entry described before.
> 2. **Phase 1.5 (Kafka) was skipped** and the worker still drains the outbox directly. Correct
>    and ordered, but not the distributed design ADR-0006 specifies.

### Blocking a real release today

| Gap | Impact | Note for the remaster |
|---|---|---|
| ~~**Push notifications**~~ | | **Done in Phase 1.** Device registry, Expo Push, per-device fan-out, and suppression by read cursor rather than by connection liveness (ADR-0008). Phase 3.5 added the DM push (ADR-0015) |
| **A user interface for most of the product** | Races, polls, calendar, routines, news and Eboard are unreachable from the **app**, though no longer from the API | **Half closed 2026-07-30.** Phase 3.75a built the HTTP surface: 45 routes became 111, with the ~20 missing queries and the six capabilities that had no function of any kind. What is left is Phase 3.75b, the screens - and it is now ordinary client work rather than a screen with nothing to call |
| **Legal review** of Privacy Policy and Terms | The shipped documents are an in-house first draft, explicitly not legal advice | Must happen before any public release |
| **iOS distribution** | Blocked on paid developer-program enrolment | Not a code problem |
| ~~**Error monitoring**~~ | | **Done 2026-08-03, server side.** `monitoring.ts` reports from all three processes: 5xx on the API through a `setErrorHandler` that did not previously exist, parked outbox events, failed drain ticks, socket frames, and the rate limiter failing open. Reports to the process logger when `SENTRY_DSN` is absent, so the paths run in development and CI rather than first executing in production. **The mobile client is not covered** - a JS crash on the phone still reaches nobody, and closing that needs `@sentry/react-native` and a native rebuild |

### Important, not blocking

| Gap | What "fixed" looks like |
|---|---|
| **Accessibility** | Every interactive control labelled, screen-reader navigable, contrast verified against WCAG AA, dynamic type supported, reduced motion respected. Start with the icon-only controls |
| ~~**Offline**~~ | **Done in Phase 3.** Read-only cached chat plus a send outbox with optimistic messages, which was the "ideally" of this entry rather than the minimum. See [Cross-cutting UX](16-cross-cutting-ux.md) |
| ~~**Test coverage**~~ | **Substantially done.** 607 tests, five permission matrices asserted cell by cell in both directions, 70 constraint assertions attempted against a live database, 76 route-level cases through the HTTP stack, and a 73-check gate against a running server. The gap that remains is UI tests, which wait on there being a UI |
| ~~**Muting**~~ | **Done in Phase 3.5.** Per-conversation, every scope: no push, unread count still accrues. Per-**type** and per-club preferences are still open, and are now one check inside the audience function rather than something with nowhere to live |
| ~~**Block or mute between members**~~ | **No longer deferrable.** Promoted out of this list on 2026-07-28: with direct messages in scope, blocking, conversation mute, and a report destination ship in the same release as DMs. A private one-to-one channel with no admin party to it, no block, and nowhere for a report to go, is a materially different risk class in a product that will include minors. See [Direct messages](14-direct-messages.md) |
| **Over-the-air updates** | Every fix currently needs a full store release |

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
10. **Notification retention.** The table grows unbounded, with no archival path. **Still true.** Phase 4, along with pruning the outbox after 7 days.
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
14. **A `msg.update` missed while disconnected is never recovered.** Found on 2026-08-01 while
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

### Verification owed

Things that are built and not yet proved on every surface they claim to work on.

| What | Verified on | Still to verify |
|---|---|---|
| **Everything, on iOS and Android** | Web only, via the browser | **The simulator has never been run.** Every smoke test in this project so far has been react-native-web in Chrome. Deferred by agreement, not by oversight, but it means "works" currently means "works on web" |
| **The attachment upload path** | Web (`blob:` URI through `fetch`) | Native reads a `file:` URI through the same `fetch` call - one path rather than an unverified branch, and untested |
| **The pickers** | Web file chooser | Native permission prompts for library and camera, which have no web equivalent |
| **Push** | The Expo transport, with a fake token that was correctly rejected | A real device token reaching a real backgrounded phone |
| **`MEDIA_URL_MODE=cdn`** | Not at all | Only `presign` runs today. The CDN branch is the production one and has never served a byte |

### Deliberately deferred (do not "fix")

Race-specific workout plans (in the original vision, never built; may have been absorbed by
Meet Information - needs a product call). Bidirectional chat paging. Message search. Comments
on news posts. Recurring events. External calendar sync. RSVP or attendance, anywhere.

### Open product questions

- **Hub placement:** Routines, Polls, and the Events list are fully reachable from club chat's
  header quick-nav, and work normally there. Whether they should *also* sit on the club hub is
  unresolved. A stopgap "More" menu on the hub was explicitly rejected.
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
- Do clubs including **minors** need age gating, parental consent, or restricted profile
  fields? Is a **data-retention policy** needed? Should a user be able to **export their own
  data** before deleting?
