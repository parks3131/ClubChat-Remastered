# Working backlog

The running list of what to fix next, kept so a session can pick up and go rather than
rediscovering the same three things.

**This is the tactical list, and it is not the roadmap.** Anything that turns out to be a real
product decision graduates into [`SPEC/PRD/17`](SPEC/PRD/17-roadmap-and-open-questions.md), and
anything that cost a debugging session graduates into
[`SPEC/TECH/14`](SPEC/TECH/14-engineering-pitfalls.md). Both of those are permanent; this file is
meant to shrink. **Delete an item when it is done - do not tick it and leave it.**

---

## Next up

- [ ] **Something is escaping the pinned strip's notice cards.** An accent-tinted rounded shape
      sits below the front card, offset right, cut off where the next card overlaps it. Found on
      the Simulator on 2026-08-14 and **reproducible**: it travels with the cards when the strip is
      scrolled horizontally, so it belongs to a card rather than to the background. Not the
      horizontal scroll indicator (disabled) and not a shadow (none declared on those styles).
      Localised to the strip, not diagnosed further. Suspect the `BlurView` + `borderRadius` +
      `overflow: hidden` combination on `pinnedCard`, which is where iOS clips children unreliably.

- [ ] **A plain member sees a padlock on every roster row.** The lock renders when
      `actions.length === 0`, which reads as deliberate for an admin who has actions on most rows
      and as a wall of locks for everybody else - and the same glyph already means "you cannot
      reach this race" on the club hub. Decide whether "nothing to do here" deserves a glyph at all
      for a viewer who has nothing to do on ANY row.

- [ ] **The group header's quick-nav dropdown is now the only overlay in chat with no scrim, and
      its twin sits one glyph away.** The message long-press menu blurs, the member card dims, and
      the DM header's "..." started blurring and dimming too on 2026-08-17 when it became a
      `ContextMenu`. The group dropdown still has a transparent `gridScrim` with no
      `backgroundColor` - so the *same header* now raises two menus that treat the background
      differently depending on whether the conversation is a DM. Nothing is broken and the lighter
      treatment may still be right for a six-item navigation list, which is a different animal from
      a two-item action menu; **the decision just is not written down anywhere**, and it is now
      visible rather than theoretical. Either dim it, or make it a `ContextMenu` as well, or record
      in [`DESIGN/09`](SPEC/DESIGN/09-chat-composer.md) why it stays lighter than the other three.

- [ ] **Every chat header reads "ClubChat" under the conversation name.** It is hardcoded, and
      swaps to "Reconnecting" when the socket drops - so a status line shows the app's own name
      whenever nothing is wrong. Decide what it should say when healthy, or drop it.

- [ ] **The app asks for more than it needs, and the open half of that lives in
      [`TECH/18`](SPEC/TECH/18-mission-backend-cleaning.md).** Fourteen defects found and fixed by
      watching the wire, ten on 2026-08-18 and four on 08-19, and **the batching family is closed**
      - `/sync`, the cards, and pictures all take lists.

      **The wire has now been read out, and the layer below it too.** 2.15 built a per-request
      database round-trip counter; 2.16 used it the same day to find and fix N+1s in both batch
      routes. `GET /polls?ids=` went from `3 + 5n` statements to a flat 7, and `/media/urls?ids=`
      from `3 + 2n` to a flat 5 - both now guarded by tests that fail if the per-id loop returns. Largest open item: one
      request per picture, the same shape as the three batching defects already fixed. Largest
      unknown: what the server does to answer one request, which has never been measured at all.
      And **most of 145 routes have never been watched by anything** - that document carries the
      checklist, grouped so a session can pick a surface and go.

      **The two 08-19 ones are worth reading as method notes rather than fixes.** The club hub
      had already been through this mission twice and was still sending 23 rows to draw 5, because
      nobody had asked what was *inside* a response that was fast and correct. And leaving the
      inbox announced to the whole app to refresh a number that the write it had just made had
      already returned. Watching the wire finds request counts; both of these needed somebody to
      open the payload.

      **The largest single item is now closed**: pictures were one request each, 45% of all
      traffic in a measured window. `GET /media/urls?ids=` took it from 1.15 requests per picture
      to 0.42, verified by scrolling a picture-heavy chat on the phone.

- [ ] **Turn on Sentry performance tracing, and add `pg_stat_statements`.** The query counter
      built on 2026-08-19 measures **development only**, and every number in
      [`TECH/18`](SPEC/TECH/18-mission-backend-cleaning.md) is a laptop against a database on the
      same machine - the 133-statement poll read cost 12ms there and would cost far more across a
      network on Fly. **Nothing measures production at all.** `@sentry/node` is already a
      dependency and already catching errors; its performance half is a config change rather than
      a build. `TECH/18` section 6 surveys the eight techniques and recommends an order: Sentry
      first, `pg_stat_statements` second, a large seeded fixture third.

- [ ] **No test has ever built a realistic amount of data, and that is why both N+1s survived.**
      Every fixture in this repo creates one or two rows; the trace found the defects because a
      real account had 26 poll cards in one conversation. A seeded "large" club - hundreds of
      members, dozens of cards in a chat, fifty photos in a gallery - is the thing that would
      have caught them automatically. See `TECH/18` 6.5.

- [ ] **Recurrence** is the next real feature, and is deferred rather than pending - see below.
      Nothing else in Weekly Meetups is outstanding: Nudge shipped and was verified on a device on
      2026-08-14, notification included.

- [ ] **The member card's three new actions want one pass on iOS.** Mute, Clear chat and Report
      shipped 2026-08-15 and are verified on web and against the database, but **not on the
      Simulator** - and this is the surface where that gap has bitten twice
      ([`AGENTS.md`](AGENTS.md) failure modes 29 and 30). The two new confirmations sit in the same
      `overlay` slot with the same `hosted` prop as the ban confirmation that *was* verified there,
      so the risk is low and it is not zero. Do it in the same pass as the item below.

      Two decisions came out of building it and neither is outstanding: **the DM entry point is
      declined** - `dm/[channelId]/profile` is about the conversation and keeps its gallery, see
      `DESIGN/10` - and **person reports go to platform moderators only**
      ([ADR-0035](SPEC/decisions/0035-a-person-is-reported-to-platform-moderators.md)).
- [ ] **The repaired card has not been back on the physical phone.** The first build reached it and
      was broken there ([`AGENTS.md`](AGENTS.md) failure modes 29 and 30); the fixes are proved on
      the iOS Simulator, which is the same UIKit and was enough to catch both. One pass on the
      device closes it - open a roster, tap somebody, use the "..." and the club faces - and then
      the surface spec's table can say so.

- [ ] **Per-message push wants a second pair of eyes on volume, not on correctness.** Shipped
      2026-08-14 ([ADR-0032](SPEC/decisions/0032-every-chat-message-pushes.md)) and proved on the
      device. The open question is lived rather than technical: a genuinely busy club buzzes once
      per message, and the agreed answer if that stings is **coalescing**, never going back to
      silence. Point anybody who complains at per-conversation mute first - it is the control that
      exists for this and it is now load-bearing rather than decorative.

## Known broken, or quietly wrong

- [ ] **`BadgedIcon` renders twice, and nobody knows why.** Found 2026-08-18 on the dev trace:
      `GET /notifications/badge` arrived in pairs 20 to 30ms apart, repeating at exactly 60.000s
      on an idle app - two timers, not one firing twice. There is one call site
      (`app/(tabs)/_layout.tsx`, the `tabBarIcon` slot) and no StrictMode in this build, so
      something renders that icon twice. **The cost is gone**: `use-badge.ts` now holds the count,
      the timer and the request at module scope, so any number of copies share one of each. The
      duplicate itself is not explained, and it is worth explaining rather than leaving - whatever
      renders that icon twice is presumably rendering its siblings twice too, and the next
      component to own a timer will not have been written defensively.
- [ ] **The README's weekly-meetups screenshot predates the rename.** `docs/screenshots/
      ios-weekly-routine.jpg` shows the activity-type UI. The caption says so, which is honest but
      not a fix - it wants a new capture once the screen has been run on a device.

## Debt worth a decision, not just a fix

- [ ] **`classifyContent` runs in exactly one place: message send.** Club names, descriptions,
      event titles, race names, and now a meetup's `location` and `description` are all
      admin-authored free text that renders into every client, unfiltered. That may well be
      correct - [ADR-0026](SPEC/decisions/0026-filter-hate-speech-not-profanity.md) is about
      member speech in chat, not about a club naming itself - but it is currently true by omission
      rather than by decision, which is the part to fix.
- [ ] **"Races and Meets" is the next sport-coded name.** The abstraction underneath - a mini-club
      with its own roster, chat and logistics - already fits a theatre production, a debate
      tournament and a field trip. Only the word does not, and it is now one letter from "meetup",
      which [`PRD/08`](SPEC/PRD/08-weekly-meetups.md) has to disambiguate in prose because the data
      model cannot.

## Deferred on purpose - do not "fix" these

- **Recurrence on a meetup.** A club meeting daily enters 365 by hand. Deliberately deferred
  2026-08-14; it is the largest gap between Weekly Meetups and "fits any club", and answering yes
  reopens the recurring-events non-goal in [`PRD/00`](SPEC/PRD/00-overview.md).
- Everything under **Non-goals** in [`PRD/00`](SPEC/PRD/00-overview.md) and **Deliberately
  deferred** in [`PRD/17`](SPEC/PRD/17-roadmap-and-open-questions.md). Those lists are decisions,
  not backlog.
