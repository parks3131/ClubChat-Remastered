# Roadmap and open questions

### Blocking a real release today

| Gap | Impact | Note for the remaster |
|---|---|---|
| **Push notifications** | A member learns nothing until they open the app. The single biggest functional gap | Everything a push payload needs already exists: each notification carries a fully rendered body and a target route. What is missing is a device-token registry and a delivery path. **Build this into the notification fan-out from day one.** |
| **Legal review** of Privacy Policy and Terms | The shipped documents are an in-house first draft, explicitly not legal advice | Must happen before any public release |
| **iOS distribution** | Blocked on paid developer-program enrolment | Not a code problem |
| **Error monitoring** | A crash or failed load in real use is **invisible** | Today errors are shown to the user and dropped on the floor. Wire a reporting service in the error path from the start |

### Important, not blocking

| Gap | What "fixed" looks like |
|---|---|
| **Accessibility** | Every interactive control labelled, screen-reader navigable, contrast verified against WCAG AA, dynamic type supported, reduced motion respected. Start with the icon-only controls |
| ~~**Offline**~~ | **Done in Phase 3.** Read-only cached chat plus a send outbox with optimistic messages, which was the "ideally" of this entry rather than the minimum. See [Cross-cutting UX](16-cross-cutting-ux.md) |
| **Test coverage** | Today: date/formatting and calendar-feed logic only. **The permission matrix is verified by hand.** The remaster should have automated permission tests |
| **Muting and notification preferences** | Everything fans out to everyone eligible, with no member control |
| ~~**Block or mute between members**~~ | **No longer deferrable.** Promoted out of this list on 2026-07-28: with direct messages in scope, blocking, conversation mute, and a report destination ship in the same release as DMs. A private one-to-one channel with no admin party to it, no block, and nowhere for a report to go, is a materially different risk class in a product that will include minors. See [Direct messages](14-direct-messages.md) |
| **Over-the-air updates** | Every fix currently needs a full store release |

### Architectural debt worth designing away

These are recorded remediation items in the current build. A remaster gets them for free if
designed in.

1. **Realtime reconciliation on reconnect and foreground** (see lesson 25).
2. **Filtered subscriptions** (lesson 26). Today three subscriptions are project-wide; with
   200 concurrent users, one message insert costs ~200 authorizations, ~200 billed messages,
   and ~200 full refetches.
3. **Message sequence numbers** - a monotonic per-channel ordinal, so ordering, paging, and
   "have I seen everything up to N" do not depend on timestamps.
4. **Client-generated idempotency keys on sends**, so a retry after a flaky network cannot
   double-post.
5. **Denormalized and capped unread counts**, and a collapsed calendar feed. The cross-club
   merged calendar currently reads once per feature **per club the user belongs to**.
6. **Highlights must not silently lose pins past the loaded window.** Today the pinned and
   announcement lists are computed over a bounded slice of history.
7. **Media cost.** Signed URLs are memoized per device, which fixed the repeat-fetch
   multiplier, but two devices still hold different URLs for the same object, so N viewers is
   still N origin downloads. A CDN-friendly scheme (stable URLs plus an authorization gate, or
   a transformation layer) belongs in the design, not bolted on.
8. **Storage cleanup.** Nothing is ever deleted from object storage today.
9. **File size and MIME-type limits.** Currently unset everywhere; a member can upload an
   arbitrarily large "document", and documents are never scanned or type-restricted.
10. **Notification retention.** The table grows unbounded, with no archival path.
11. **Localisation.** Notification bodies are built server-side in English and are
    unlocalizable and untestable from the client.
12. **Rate limiting beyond messages** - reports, reactions, and join requests are still
    unthrottled.
13. **Backups and version parity** between development and production data stores.

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
- Should an admin other than a poll's creator be able to close a poll whose creator has left?
- Do clubs including **minors** need age gating, parental consent, or restricted profile
  fields? Is a **data-retention policy** needed? Should a user be able to **export their own
  data** before deleting?
