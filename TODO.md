# Working backlog

The running list of what to fix next, kept so a session can pick up and go rather than
rediscovering the same three things.

**This is the tactical list, and it is not the roadmap.** Anything that turns out to be a real
product decision graduates into [`SPEC/PRD/17`](SPEC/PRD/17-roadmap-and-open-questions.md), and
anything that cost a debugging session graduates into
[`SPEC/TECH/14`](SPEC/TECH/14-engineering-pitfalls.md). Both of those are permanent; this file is
meant to shrink. **Delete an item when it is done - do not tick it and leave it.**

**The roadmap is [`SPEC/TECH/20`](SPEC/TECH/20-road-to-the-first-club.md)**, which owns the
milestones and, since 2026-08-23, an ordered plan of what to do next with the reason for each
position. Read that one if the question is "what should I work on"; read this one if the question
is "what is broken".

---

## Next up

- [ ] **DMARC reports start arriving now, and want reading in about two weeks.**
      `_dmarc` is `v=DMARC1; p=none; rua=mailto:dmarc@clubchatapp.com; fo=1` as of 2026-08-25, and
      `dmarc@` genuinely receives - proved by an SMTP `RCPT TO` returning `250`, not by a test
      message. **Before that day there was no `rua` at all**, so no receiver had ever generated a
      report and the path to `p=quarantine` was blocked without anybody knowing. Read a fortnight
      of them, look for a legitimate sender a strict policy would break, then tighten.
      `scripts/drills/dmarc-drill.sh` walks it.

- [ ] **The `d=` alignment check, which is ten minutes and has never been done.** Trigger a real
      password reset to a Gmail address, open the message, three-dot menu, "Show original", and
      read the three lines at the top. SPF, DKIM and DMARC should all say PASS, and **DKIM's `d=`
      must be `clubchatapp.com`** rather than the provider's. If it is the provider's, alignment is
      riding on SPF alone and breaks silently the day the envelope path changes.

- [ ] **Two always-null compatibility keys are load-bearing, and nothing can tell you when they
      stop being.** `readMeetup` returns `location: null` and `mapPoint: null` for builds shipped
      before ADR-0049, because their `DetailLine` and `directionsUrl` guard with `=== null` and
      then dereference: absent throws where null is handled. It crashed the founder's phone on
      2026-08-25 minutes after the deploy, and the second one was latent.

      **The removal condition is a fact about which builds are installed on phones**, which is not
      queryable from this repo and is why it is written at the return site rather than remembered.
      **The trigger this item named has fired**: the first over-the-air update shipped and arrived
      on 2026-08-27, so the installed base is now something EAS reports on rather than something
      nobody can see. Nothing has been asked of it yet - that is the next step here, not the
      removal. Both keys stay until somebody reads what EAS says about which builds are requesting
      updates, and only builds shipped after ADR-0049 are left.

- [ ] **A deliberately parked outbox event has still never reached a human.** The 5xx half of this
      is DONE and proved on 2026-08-25: a real error raised inside the production api reached
      Sentry, matched the `production` alert rule, and arrived on the founder's phone by itself.
      Issue id `021d94c07bb3425e8e0855d42390de21`. The outbox half needs
      `scripts/drills/outbox-park.mjs` run against production, and note the alert rule fires on
      "a new issue is created" - a repeat of an existing drill message adds an event to the
      existing issue and sends no mail, which reads as a failure and is not one.

- [ ] **Tracing is live on two of four surfaces, and the configuration reads as done on all four.**
      The mobile app produces no traces because nothing starts a root span: it needs
      `Sentry.reactNavigationIntegration()` wired to the expo-router container ref, which can only
      be verified on a device. The worker produces none for the same reason, and there the right
      unit of work is a real decision rather than a wiring job - a span per drain tick on a poll
      loop is a bill for mostly-empty spans. Both were left deliberately rather than guessed at.

- [ ] **The rollback drill is runnable now, and has still never been run.** The item this replaces
      said there was nothing to roll back to, which was true when it was written on 2026-08-25 and
      stopped being true the same evening. `fly releases` on 2026-08-27 shows **four distinct
      image references** on every one of the three apps, not one: `9f9e58a2` from the 08-23
      cutover, then `7979ea67`, `e316267b`, and the current one. Note the precision - that is
      three `sha256:` digests plus one mutable tag whose digest `fly` does not print, so four
      distinct *images* is an inference rather than a proof. Either way each app has a previous
      one, which is all the drill needs. Run `scripts/drills/rollback-drill.sh` for real.

      **One thing to look at while running it.** The 08-23 releases name their image by
      `sha256:` digest, which is what the cutover procedure in
      [`TECH/21`](SPEC/TECH/21-deployment.md) specifies. The most recent one on all three apps
      names it `registry.fly.io/clubchat-api:deployment-01M0XA7STTQZNY018R2V70YY7P` instead: a
      **tag**, which is mutable, where a digest is not. The build-once property still held - all
      three apps took the same ref - but a rollback target addressed by a tag is a weaker
      guarantee than one addressed by a digest, and it is worth deciding whether that is
      acceptable or whether the deploy path should go back to digests.

- [ ] **`eas submit` may need an App Store Connect API key.** The `production` submit profile
      carries `ios.ascAppId` and nothing else - no `appleId`, no `ascApiKeyPath` - so a
      `--non-interactive` submit fails unless a key is already stored on EAS. Fine interactively;
      it matters the first time this runs from CI.

- [ ] **Request Beta App Review, because it is a queue and not a step.** Internal TestFlight works -
      the founder installed 1.0.0 (5) and then 1.0.0 (6) on 2026-08-27. External testers need Apple's review at one to
      two days, and it is the only item on the road to the first club that cannot be shortened by
      doing it more carefully, so it starts early rather than when the roster is ready.

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

- [ ] **The unread badge is the only surface that goes stale without saying so.** Every other
      offline surface tells the truth: a chat raises "Offline. Showing saved messages.", the chat
      header swaps to "Reconnecting", and `use-load` says "You appear to be offline". The tab
      badge does none of that. It keeps drawing its last known number at full confidence, so a
      member sitting on the tab bar with no signal is looking at a count that is quietly wrong and
      has no way to tell.

      **Bounded, which is why it is deferred and not urgent.** The count is re-read rather than
      accumulated and `IDLE_REFRESH_MS` is 60s, so it self-corrects within a minute of the network
      coming back, and an app that is properly offline is obvious from any screen that loads. This
      is about the honesty of one glyph, not about a wrong number in the database.

      Options, cheapest first: dim the badge while `offline` is true, or put a dot on the tab bar,
      or decide a silently stale count is acceptable for a value this small and write that down.
      Note that `offline` already reaches the chat screen from the provider, so the state is in
      hand and only the tab layout needs it. Raised 2026-08-24 while reading the wire, deferred on
      purpose.

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

- [ ] **Add `pg_stat_statements`, and a large seeded fixture.** The Sentry half of this item was
      done on 2026-08-25: tracing is live on the api and the gateway behind
      `SENTRY_TRACES_SAMPLE_RATE`, defaulting to 0.1, with `/health`, `/ready` and `/__parity`
      never traced. **What is still true is the sentence this item was really about**: the query
      counter built on 2026-08-19 measures development only, every number in
      [`TECH/18`](SPEC/TECH/18-mission-backend-cleaning.md) is a laptop against a database on the
      same machine, and the 133-statement poll read that cost 12ms there would cost far more
      across a network on Fly. `TECH/18` section 6 recommends `pg_stat_statements` second and a
      large seeded fixture third.

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

- [ ] **Deleting a photo message does not take the photo away.** Found 2026-08-29 while reading
      the delete path for the tombstone work, not by anything failing. `applySoftDelete` nulls the
      body and leaves `media_id` on the row, and `resolveMediaRedirects` authorizes a media read on
      channel membership alone with no `deleted_at` check - so anyone in the channel who kept the
      id can still fetch the bytes after the message is gone. The gallery is the only surface that
      filters them, so it is invisible from the app.

      **Decide before fixing, because it is not obviously a bug.** A photo deleted from chat may
      still be wanted in the club's gallery, and the two are the same object today. The narrow
      answer is to refuse a media read whose only referencing message is deleted; the broader one
      is to decide whether a deletion is meant to reach the bytes at all. `PRD/13` owns that.

- [ ] **A deleted message that was pinned still reports the moment it was pinned.**
      `applySoftDelete` sets `pinned = false` and leaves `pinned_at` alone, while `setPinned`
      clears both. Two of the four envelope builders then hard-code `pinnedAt: null` and the other
      two emit the stale timestamp, so the same tombstone describes itself differently depending on
      which route asked. Harmless today - nothing reads `pinnedAt` on an unpinned message - and it
      is the kind of disagreement that becomes a bug the first time something does.

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
