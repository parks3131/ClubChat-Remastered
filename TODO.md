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

- [ ] **Recurrence** is the next real feature, and is deferred rather than pending - see below.
      Nothing else in Weekly Meetups is outstanding: Nudge shipped and was verified on a device on
      2026-08-14, notification included.

## Known broken, or quietly wrong

- [ ] **Watch the first few CI runs for testcontainer flake.** `test/harness.ts` records a
      10-second ceiling on binding a container's port, and the suite starts one Postgres per file
      on a runner that is smaller and busier than a laptop. If it flakes, the standing fix is
      already written down in [`PRD/17`](SPEC/PRD/17-roadmap-and-open-questions.md): one container
      for the suite instead of one per file. Do that rather than raising the timeout.
- [ ] **A club must still declare a `sport`, and nothing reads it.** Required on create, free
      text, validated by nothing, displayed on the club profile - and it now asks a chess club
      what sport it plays.
      [ADR-0029](SPEC/decisions/0029-a-meetup-answers-where-when-and-what.md) removed the reason to
      replace it with a club type and did not remove the column. Deleting it is one migration plus
      the create form; what stops it being trivial is the profile screen showing it.
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
