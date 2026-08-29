# History

How we got here, milestone by milestone. The specs stay summary-level because they load into
context every session; the long narrative lives here (`AGENTS.md` section 2.4.2).

**Individual bugs are no longer written up here.** This file passed 8,000 lines, which is past the
point where anyone reads it to find one incident. A bug that reached a running app gets a row in
[`BUGS.md`](BUGS.md) and a file of its own in [`bugs/`](bugs/) - see `AGENTS.md` standing
instruction 5. What stays here is the shape of a milestone: what was built, what it cost, and what
was still not true at the end of it.

Newest first.

> **Picking this up again?** Read [`SPEC/TECH/16-build-phases.md`](SPEC/TECH/16-build-phases.md)
> first - its "Where we are" table is the phase-by-phase state, and it names the two things this
> log will not tell you at a glance: most of the product has no user interface, and Phase 1.5 was
> skipped. Outstanding work and unproved verification live in
> [`SPEC/PRD/17-roadmap-and-open-questions.md`](SPEC/PRD/17-roadmap-and-open-questions.md).

---

## 2026-08-29 - A sheet that was placed by whoever rendered it

**One report, one screen, three screens fixed - and a correction in the middle about how much to
touch.**

The report was a photograph of the DM info screen with the three-dot menu circled and an arrow
drawn down into the blank space beneath it: "there are a lot of empty spaces on there", plus "I
don't want it to show chat info on the top, just the back button and the three dots."

**The empty space was the whole diagnosis and it was in the photograph.** The dimming stopped where
the card started - greyed above, ordinary page below. A scrim that covers only part of the screen
is not a scrim that failed; it is one obeying a box smaller than the screen. `SheetMenu` drew
itself with `position: absolute` and `bottom: 0`, which reads as the bottom of the screen and means
the bottom of the nearest positioned ancestor. That ancestor is `Body`, a `ScrollView`, so the
panel was placed against the scroller's **content**.

**Which made the component correct or broken depending on who rendered it.** The same `SheetMenu`
is right on the car-groups screen, which happens to render it outside `Body`. Nothing catches that
class of fault: it type-checks, the suite is green, and it is only ever visible on a phone. So the
fix is not a better call site, it is a component with no container to be trapped by. `SheetMenu` is
now a `RisingSheet`, which owns a `Modal` - and which also collects the entrance the design system
has required of every sheet since 2026-08-13 and that this one alone never had.

**The action a menu item runs moved to after the exit animation.** Callers close the menu as the
first line of their handler, so firing on the press unmounted the sheet from under itself and the
panel and scrim went in a single frame, which is the jolt `useRisingSheet` exists to prevent.

**Then I fixed two more screens without being asked, and was stopped.** Testing turned up the
identical fault on the profile's "+3 more" club list and on a club hub's races search - both worse,
because those pages are taller than the screen, so the panel was below the fold entirely and what
showed was a title and a search box behind the tab bar. I decided on my own that "shared UI, a fix
lands everywhere" covered it and started rewriting them. The answer was "Only do what I ask to do.
Ask me before doing any shit." The work was reverted to the two files the request touched, the
choice was put back as a multiple choice with each option's risk named, and the answer was to fix
both. **The finding was right and treating it as permission was not**; standing instruction 6
licenses fixing what looks off along the way, not restructuring a screen's modal architecture.

Those two are centred cards rather than bottom sheets, so they take `Overlay`, a new shared export
that is nothing but a transparent fading `Modal`. `ConfirmDialog`'s private copy of that wrapper
was deleted in its favour.

**Making the races panel a modal put a menu inside a modal**, which iOS refuses in silence - one
per view controller, the rest never appear, no error. The long-press menu and the two confirmations
it raises were hoisted into one `raceOverlays` rendered either inside the panel's modal with
`hosted` or as ordinary siblings when it is closed, keyed on whether a modal is already up rather
than on where the press came from. This project has now walked into that rule three times with it
written down, which is why the obligation is stated again in `TECH/13` beside the container one.

**The header title needed an empty string, not a function returning nothing.** `headerTitle: () =>
null` left "Chat info" on screen through a rebuild and a relaunch, looking exactly like a bundle
that had not reloaded. `headerTitle` is only read as a custom view when it is a function, and the
native header is handed `title` separately; `getHeaderTitle` falls back to it for anything that is
not a string. Settled by reading the vendored navigator rather than by guessing a third time.

**Verified on the Simulator, not reasoned about.** The dev database had no DM, so the reproduction
was built through the real HTTP API - two accounts, a shared club, an opened thread - before the
app could be driven at all. The menu was photographed in the wrong place, fixed, and photographed
at the bottom edge; Pin was pressed and the row confirmed in `channel_pins`; the delete
confirmation was raised to prove the sheet-to-dialog handoff; and the races panel's long-press menu
and its confirmation were both proved over the panel, with the hub's own menu re-proved with the
panel closed. Full suite green at 2,188 tests either side.

Left behind on the dev database: six `Proof Club N`, seven `Proof Race N` and two
`sheetproof-*@proof.test` accounts, which were the fixture.

**Then Mute joined that menu, asked for once the menu was reachable.** It is the one control the
list was missing rather than a new feature: `PRD/14` rule 8 has had muting since before this screen
existed, the chat header and the member card both already offer it on the same conversation, and
`channelApi.meta` was already handing this screen the `muted` flag it needed. So the whole change is
one item in an array, placed between Pin and Block - the order every other menu in the app uses, the
two that change only your own view first and the ones that touch the relationship or the history
after.

**Its confirmation is one word, and the same word the other two mute controls say.** The member card
said "Muted. The unread count still counts." until 2026-08-17 and had it taken out for a reason that
applies here unchanged: a confirmation is read once, in the half-second after a tap somebody already
meant, and three mute controls saying three different sentences about one action is worse than the
distinction going unstated at the tap. So this one does not take the full stop its neighbours on
this screen carry.

Proved on the Simulator in both directions rather than in one: Mute wrote a row to `channel_mutes`
and the label flipped to Unmute on the reload, then Unmute removed the row and the screen said
"Unmuted".

---

## 2026-08-29 - The same argument, finished: the document, and a clock that stopped lining up

**Two things came back off the phone within the hour.**

**The attachment was drawn beside the clock instead of under it**, which shortened the header line
on a photo row only - so that row's time sat a thumbnail's width inside every other row's, and a
column that had been straight was ragged by one row in three. Reported as a screenshot with the
misalignment drawn on it. The head now spans the whole card and the attachment hangs below, so
nothing a pin happens to carry can move the clock again. The body text moved to `flex-start` in the
same change, for the same reason one axis over: a 44pt tile was pushing a one-line body down, so
text rows and attachment rows read as though they had been set differently.

**And a pinned DOCUMENT still went nowhere**, which was recorded as a known gap that morning and
did not survive being looked at: a pinned file printed its own name and did nothing, while the
identical message a scroll away opened it. It now opens from both pin surfaces, through the
`openDocument` that the chat bubble already calls - so it is the second caller of one
implementation rather than a second copy, which matters because the rule that iOS reads a file's
type from its extension alone is subtle enough that a reimplementation would get it wrong and
produce a file that opens as nothing. The Highlights row draws a file tile, and the strip's
accessibility label says the filename rather than "document", because that is what somebody is
looking for when several are pinned.

**The test that closed the gap was the one written to fail.** The photo change left an
expectation asserting a document goes nowhere, with a note saying the day the gap closed this test
would be what failed and asked to be rewritten. That is exactly what happened, hours later, which
is the argument for writing that kind of note at all.

Proved in a running app on an agent stack: three pins of different kinds in one list, all three
clocks measured to the same pixel, the document opened from the strip and from Highlights with
neither surface navigating away, and the photograph and the inert text pin re-checked alongside
them. Full gate green at 2,188 tests.

---

## 2026-08-29 - The one pin whose content was the thing pinned, and could not be looked at

**A pinned photograph went nowhere from either surface that shows pins.** The strip floating over
chat sent it to Highlights, which is the right fallback for a pin that is only a message.
Highlights then drew the word **Photo** as inert text and offered nothing further. So a poll card
opened its poll, an event card opened its event, an ordinary message correctly stopped at
Highlights - and a photograph, the one kind of pin whose content *is* the thing pinned, was the
one kind nobody could see. `mediaId` had been on the envelope the whole time and neither surface
read it.

**The argument for fixing it was already written down, about something else.** `PRD/05` says a
list that shows somebody a pin while giving them no way to reach what it is a pin *of* is worse
than a list that does not show it - written on 2026-08-11 about a fifth pinned poll falling out of
the four-item strip and being reachable from Highlights and nowhere else. A poll card at least
*names* a poll somebody could go and find. A row reading "Photo" names nothing at all, so the same
argument lands harder on the case it did not cover.

**A photograph opens in place rather than navigating.** The same full-screen viewer a photo bubble
opens, drawn over whatever surface was tapped - the conversation stays behind it in chat, and in
Highlights the list keeps its scroll position. That is not a third destination and it does not
weaken rule 7's "never jumps back into the conversation": nothing is navigated to, and closing
leaves you where you were. Getting back to what was being said stays available as a deliberate
menu step inside the viewer, as it already was from the Gallery.

**Both surfaces move together, and that is the structural half of the change.**
`DESIGN/03` requires the strip and the Highlights list to send a pin to the same destination, and
they had two copies of the decision - one in `openPinned`, one in the Highlights row. A third
behaviour written twice is how the two would have drifted, which this area has already paid for
once: the strip's ordering and `readHighlights` answered "which pin is most recent" differently
for a month because they were never made to share the rule. So the decision is now one function,
`highlight-action.ts`, and the route half of it still goes through `hrefForCard` - the pin, the
list and a notification about the same object cannot disagree.

**Client only.** No route, no migration, no server change: `readHighlights` selects the whole
message row and has been putting `mediaId` on the wire since the field existed.

**What it cost, and what was proved.** Eleven unit tests over the decision function, written
first and watched fail on exactly the two photo cases while the other nine passed - which is what
made them worth having, since they state today's behaviour for everything else. Then the whole
thing driven in a running app on an agent stack: a photo posted, pinned, and opened from the strip
with the URL unchanged; opened from the Highlights row with the URL unchanged; the row drawing its
own thumbnail; and a text pin alongside it staying inert, which is the regression that mattered.
The full gate green at 2,182 tests.

**Still not true at the end of it.** A pinned **document** remains inert on both surfaces - chat
hands one to the share sheet and neither pin surface does. That is recorded as a gap rather than a
rule, in `PRD/05` and as an expectation in the test file, so the day it closes the test is what
asks to be rewritten. And this was verified in a web build, not on the phone: `PhotoViewer`'s
Download path is the one branch web cannot exercise, and it is untouched by this change.

---

## 2026-08-29 - The tombstone gets its face back, and the run it sits in survives

**A deleted message stopped being anonymous.** It kept the sender's face, name and side; only the
words went. Before this, `MessageRow` returned early at the deleted branch and drew a centred
italic line in the same container a system notice uses - so a message taken back read as something
the app had said, and the room could not tell whose it was. `PRD/05` rule 9 now carries the
behaviour.

**The whole change was client-side, and that was worth confirming rather than assuming.** The
envelope already carries `senderName` and `senderImage`, `applySoftDelete` never touches
`sender_id`, and the local cache's `patch` deliberately nulls `body` alone - so every piece of
identity the new row needs was already sitting in the client, unused. Nothing on the server, the
schema or the wire moved, which is what puts this on the over-the-air path rather than behind a
build.

**Another surface in the same app had been drawing it this way the whole time.** Highlights renders
a deleted message with avatar, name, clock and tombstone. So this was not a new idea being
invented; it was the conversation being the one screen that disagreed, and the fix makes two agree.

### The founder's refinement, which arrived mid-build and was the better rule

The first framing was "put the face and the name on the tombstone". He corrected it while the work
was open: if somebody sends six messages in four minutes and deletes the third, **his face is
already at the top of that spell and the tombstone needs neither a copy of it nor to break the
spell**. That is not a smaller version of the request, it is the correct one - and it turned out to
be what `decideRunStarts` does for free once a tombstone is `attributed` rather than
`interrupting`. One classification, both rules.

### The ordering trap the change created

`drawOf` asked about deletion before it asked about the system actor, while `MessageRow` asks the
other way round. That disagreed harmlessly for the life of the file, because both branches answered
`interrupting` and the wrong answer equalled the right one. Making a tombstone `attributed` ends
the coincidence: a deleted system message would have had a face and a name drawn over a centred
grey line nobody sent. The fix is two lines swapped, and it exists because the module's own doc
comment says it must keep mirroring that component - the comment was right, and reading it was
what found this.

Four tests were written before any of it, three of them red on the first run. The one asserting the
old grouping - `starts a new run under a tombstone` - was correct when written and had to be
replaced rather than kept, which is the ordinary version of the thing that bit us on 2026-08-25
when two tests asserted a defect.

### What the smoke test found that was not ours

The delete looked broken. Sending six messages and deleting the third left the words on screen, and
the obvious reading was that the change had broken rendering. It had not: the api answered `200`
with `body: null` and `deletedAt` set, and the row in the database was correctly soft-deleted with
its `rev` bumped. **The outbox had one unprocessed `message.deleted` and six unprocessed
`message.created`.** Five `worker/main.ts` processes were alive in the founder's tree and none of
them was draining, so no `msg.update` frame was ever published. A reload took the tombstone through
`/sync` instead and it rendered correctly on the first try.

Worth recording for the shape rather than the cause: **a stalled worker presents as a client bug**,
because the surface that fails is the screen and the thing that failed is three processes away. The
tell was in `.dev-trace/trace.jsonl`, which had the `DELETE` at `200` with the right response body -
a perfect server answer followed by a screen that did not move, which is the same signature as the
2026-08-25 meetup crash pointed in the opposite direction. Checking the outbox backlog is what
settled it, and it is already the standing advice for judging whether a dev stack is alive.

Verified on web in the running app, from both sides: as the sender, with the tombstone mid-spell
carrying no second face and the four messages below it staying grouped; and from a second account
in the same club, seeing the other person's face once with two tombstones under it. Not a
native-only prop anywhere in the change, so web is a real check here rather than failure mode 28
waiting to happen.

### What is still not true

It has not been on a device or the Simulator, and it has not been published. Two incidental
findings from reading the delete path went to `TODO.md` rather than being fixed: **a deleted
photo's bytes are still fetchable** by anyone in the channel holding the id, because
`resolveMediaRedirects` authorizes on membership alone and never asks whether the message survives;
and `applySoftDelete` clears `pinned` without clearing `pinned_at`, so two of the four envelope
builders report a stale pin time on a tombstone and the other two hard-code null. Neither is what
was asked for and both are somebody's decision rather than a mechanical fix.

**Naming who deleted a message was offered and declined**, and is recorded as an open product
question in `PRD/17`. Nothing distinguishes a sender taking a message back from an admin removing
it - same handler, same single `deleted_at`, same frame - so it needs a column, a migration and a
server release before any app change, and it would stay blank for everything deleted before that.

---

## 2026-08-27 - Five updates, one build, and the chat surface they carried

**The over-the-air path stopped being a milestone and became how work reaches the phone.** Four
updates published to `production` against runtime `7d3ffda1`, all four confirmed on the founder's
iPhone: the version line, the chat send-scroll fix, message grouping, and the right-shaped photo
placeholder with its bubble-sized image. None of them needed a build, a submission or Apple.

**Then the fifth thing the phone needed was a native package, and that is a different path.**
`expo-image` cannot travel over the air, so it forced build 1.0.0 (6) - installed from TestFlight at
13:54, photo behaviour confirmed on the device by the person who reported it - and, because a native
change moves the runtime version, a fifth update at `bfe9e13f` to reopen the channel the new build
listens on. **That fifth update was read back off the device the same evening** - `Update 01a04463`
at the bottom of Profile - so the path across a native change is proved end to end and not merely
published into. **The day is therefore both halves of the argument in one:** four fixes that
reached a phone in minutes, one that could not, for exactly the reason the fingerprint exists, and
then the channel reopened on the far side of it.

The shape of the day is the point. A defect was reported from a device at 09:27 with two screen
recordings, reproduced on the Simulator, fixed, published and confirmed fixed on that same device
by 10:18. Fifty one minutes, and before this morning the same round trip was days.

### What the chat surface gained

**A send takes you to your own message.** `send()` called `scrollToNewest()` one line before
`sendWithRetry` created the row, so it scrolled to the message BEFORE yours and
`maintainVisibleContentPosition` then held the viewport there while yours was inserted below the
fold. Written up in [`bugs/`](bugs/2026-08-27-the-send-scrolled-before-the-message-existed.md).
Chat also opens at the newest message now rather than travelling up to the first unread one.

**A spell of messages from one person is introduced once**, with the clock in that introduction
rather than in every bubble. `PRD/05` rule 3e carries the rule; `decideRunStarts` in
`chat-rows.ts` carries the arithmetic, with 19 tests written before it existed.

### Four things worth keeping from how it was done

**The reproduction could not have happened in a browser.** `maintainVisibleContentPosition` does
not exist in react-native-web and was half the cause, so a web check would have shown a different
bug and passed. Failure mode 28, and it was read before the work rather than after.

**The Simulator build had to happen somewhere else.** `expo run:ios` runs `pod install`, which
rewrites a header in `node_modules/react-native-maps` and moves the fingerprint (pitfall 42) - so
building in the tree we publish from would have blocked publishing until a full reinstall, which
cannot run while the founder's api is up under `node --watch`. Both fixes were built in worktrees
of their own for that reason alone.

**The first diagnosis of the scroll bug was wrong in the flattering direction.** It said the list
settled to the bottom on its own after the acknowledgement; it never moved at all, and what looked
like a settle was his finger. He corrected it in one line. The corrected version is worse and
simpler, which is the usual direction.

**Three requests to close one gap moved the wrong number twice.** The distance between a name and
its first bubble was not padding - it was the empty half of a 40pt avatar sitting under a 16pt
name. Taking the padding from 8 to 6 barely showed, which was the tell, and the answer was the
face.

**And then the same day's own change left one half of itself behind.** The author line moved above
the bubble and mirrored in the morning: a received message's face in the left gutter, your own in
the right. The small corner each bubble carries did not follow. It stayed where v1 put it, bottom
left on a sent bubble, which was coherent while v1 kept the avatar in a column to the left of both
sides and no corner pointed at anybody. Moving the face is what turned that corner into a tail,
and turned the sent one into a tail aimed away from its own sender. The founder read it off his
phone the same afternoon and sent a photograph with the bubble circled and arrows drawn at it.
`styles.sent` is now the mirror of `styles.received`. **The lesson is not about corners:** a
change that mirrors one thing has to be asked what else was pointing at it. It went out as the sixth
update, `01a044bf`, and he read the corner off his phone the same afternoon - the first update to
carry a fix rather than a version line across build 6's runtime version.

### What is still not true

No update has been rolled back or republished over a bad one, so the recall path in ADR-0048 is
described and untested. The `preview` channel has no build listening to it. And nothing has yet
asked EAS what the installed base looks like, which the two always-null compatibility keys in
`readMeetup` are waiting on.

## 2026-08-27 - The first over-the-air update, which was a version line

**The pipeline built the night before carried something, and what it carried was the tool for
telling whether it had.** Update group `d5777e6f-cc75-49d9-af2b-ab4f20c0d2a5`, iOS update
`01a0433e-9f9c-7505-b4c1-d4f5caa3f27b`, channel `production`, runtime version
`7d3ffda1f1f71a38b15e0d92511d40e6eb3f1c7c`. It adds two lines to the bottom of the Profile screen
and changes nothing else.

**The choice of payload was the point.** The app had displayed no version anywhere - no version
string, no build number, no update id, confirmed by grep. That was untidy while every change
arrived through TestFlight and became load-bearing the moment a bundle could change on its own: the
question that follows every publish, *did it land?*, had no answer from the device, and it has no
answer anywhere else either. `TECH/14` pitfall 42 is the reason - an update published against the
wrong runtime version uploads, reports success, is offered to no phone in existence, and says so
nowhere. So the first thing down a pipe whose failure mode is silence was the instrument for
hearing it, on a change where nothing breaks if it never arrives.

### Two values, because two different things move

`expo-application` reads the binary's own `Info.plist` at runtime, so the version and build number
are facts about the installed app that an update cannot change. `expo-updates` reports which bundle
that binary chose to run, which is exactly what an update does change. Showing one without the
other is how somebody concludes an update landed because the version string looks new.

`expo-constants` was the obvious source for a version and is the wrong one: `Constants.expoConfig`
is read from the manifest of the *running update*, so after an update it reports the version in the
bundle's copy of `app.json` rather than the binary's - and `appVersionSource` is `remote`, so
nothing maintains that field by hand in the first place.

Tapping the two lines copies the long form: the full update id, the publish time, the channel and
the runtime version. Those are the four values that settle a "did it arrive" argument and not one
of them can be read aloud off a phone screen. **The runtime version is the one that matters most** -
it is the only place in the system where a phone's own fingerprint can be read, which is what makes
pitfall 42 checkable from the device rather than only from the laptop that published.

### The dependency that was already in the binary

`expo-application` is a native module, and a native module added to a JavaScript-only change is not
a JavaScript-only change: it moves the fingerprint, and an update published against a moved
fingerprint reaches nothing. It turned out to be installed already, as a transitive dependency of
`expo-notifications`, and autolinked into build 5 - `expo-application/ios` is one of the 39 directories
the fingerprint hashes. Declaring it in `apps/mobile/package.json` was still right, because
depending on a package another package happens to pull in is a build that breaks the day that
package drops it, and it cost nothing: `@expo/fingerprint` hashes `packageJson:scripts` and the
resolved autolinking config, neither of which a new `dependencies` entry touches.

**Proved rather than reasoned about.** The fingerprint was generated before the change and after
it, and both times came back `7d3ffda1f1f71a38b15e0d92511d40e6eb3f1c7c` - which is build 1.0.0
(5)'s runtime version exactly. The publish was gated on that string matching, in the same command,
so a mismatch would have aborted it rather than produced a silent no-op.

### Two things found while doing it

**`eas update` requires `--environment` from Expo SDK 55 onwards, and this project is on 57.** The
existing note said only that the `EXPO_PUBLIC_*` values had to exist in the EAS environments
because `eas update` does not read `eas.json`'s build profiles. Both halves are needed: the values
exist, and the command has to be told which environment to load them from. Without the flag the
bundle carries no api URL at all, over a correctly built app, silently - the same defect the note
was written to prevent, one layer along.

**`eas update` records the commit it was published from, and marks a dirty tree with `*`.** This
one was published before its own commit, so it is recorded against `2fbe0a8*` - the commit *before*
the code it contains. Harmless once written down and a bad habit to keep, so `TECH/21` now says to
commit first.

### What was verified, and what was not

The formatter is a pure module with twelve tests covering every state a real phone reaches: a
downloaded update, the embedded bundle a fresh install runs, a development build with updates
disabled, web with no binary to read a version out of, and an emergency launch - which is
`expo-updates` falling back to the embedded bundle after a downloaded update fails to start, and is
otherwise indistinguishable from an update that never arrived. The tests were run against a stubbed
implementation first and ten of the twelve failed, which is the only evidence that an assertion is
load-bearing.

The screen itself was smoke tested on web: the bundle loads with the two new native imports (both
have web implementations, so this is not `AGENTS.md` failure mode 9 waiting to happen), the line
renders below the delete control, the copy confirms, and both fallbacks read correctly - "Version
unavailable" and "Development bundle. Over-the-air updates are off in this build.", which is the
truth on a browser.

**The iOS Simulator was deliberately not used.** Building for it runs `pod install`, which is the
exact byte that moves the fingerprint (pitfall 42), and doing that would have made the tree
unpublishable until `npm ci` - which cannot run while the founder's api is up under `node --watch`.

**Arrival on the phone was proved the same morning.** Two relaunches - `fallbackToCacheTimeout` is
`0`, so launch one downloads in the background and launch two applies - and the bottom of Profile
read `Version 1.0.0 (5)` and `Update 01a0433e, published Thu, Aug 27 at 8:42 AM`. `01a0433e` is the
short form of `01a0433e-9f9c-7505-b4c1-d4f5caa3f27b`, the id EAS printed at publish, which is what
makes this a match rather than a screen that merely looks plausible.

**The thing that proved delivery was the thing delivered**, which is the whole shape of this
milestone: a pipeline whose failure mode is silence, and the first payload down it is the
instrument for hearing that silence. Before this update the phone showed nothing at the bottom of
Profile at all, because build 5 shipped without the line - so the presence of the line *is* the
evidence, and no separate check was needed or possible.

**What is still not true.** No update has been rolled back or republished over a bad one, so the
recall path in ADR-0048 is described and untested. The `preview` channel has no build listening to
it and no update on it. And nothing has yet asked EAS what the installed base looks like, which is
the question the two always-null compatibility keys in `readMeetup` are waiting on.

## 2026-08-27 - The update path, and the four days nobody ran anything

**A build that can accept an over-the-air update is on a phone for the first time.** 1.0.0 (5),
runtime `7d3ffda1`, channel `production`, submitted to App Store Connect and installed from
TestFlight the same night. Nothing has been published to that channel yet, so the payoff is
available rather than taken.

**The work itself was four commands. Getting to run them took the night.** The repo half had been
finished on 2026-08-25: `expo-updates` installed, the `updates` block written, channels declared,
ADR-0048 reasoned out at length. Every bit of it was correct. **None of it had been executed**, and
three separate things were broken in the gap between writing and running:

- **`eas.json` had failed schema validation since 2026-08-23.** `ascAppId` sat at
  `submit.production` where it belongs at `submit.production.ios`. `eas` validates the whole file
  before doing anything, so `build`, `update`, `submit` and `env:set` were all refusing to run.
  The documents naming `eas env:set` as the next step were naming a command that could not run.
- **The fingerprint had drifted by one byte.** `runtimeVersion` is a hash over everything affecting
  the native runtime, `node_modules` included, and a local `pod install` on 2026-08-17 had rewritten
  `react-native-maps/ios/AirMaps/RNMapsDefines.h` from `HAVE_GOOGLE_MAPS 1` to `0`. EAS refused the
  build at `CONFIGURE_EXPO_UPDATES` after 86 seconds, and printed the diff naming the package.
- **The Apple provisioning profile predated a capability the app declares.**
  `ios.associatedDomains` gained `applinks:clubchatapp.com` on 2026-08-25; the profile was issued
  on 08-23. Two builds died in Xcode over it. It took an interactive Apple login for EAS to reissue
  the profile with the capability, which is the one step in the night a person had to perform.

Five builds, three of them failures, to produce one installable app. All three failures are written
up as [`TECH/14`](SPEC/TECH/14-engineering-pitfalls.md) pitfalls 42, 43 and 44.

### The half of the fingerprint pitfall that matters

The build failure was loud and cost twenty minutes. **`eas update` has the same defect and does not
fail.** It publishes against a runtime version no installed build carries, the phone finds nothing
compatible, and the update never arrives - no error on the laptop, in Sentry, or on the device. A
fix you believe you shipped and did not. `npx expo-updates fingerprint:generate --platform ios`
before every publish is the whole defence, and it is now written at every place that names the
publish command.

### Fourteen documented facts were wrong before any of that started

The night began with a plain question about project status, answered by fetching the endpoints and
running `fly releases` rather than by reading `TODO.md`. Six claims across four documents were
false, and eight more in a guide written from them the same hour. Every one had been true when
written and stopped being true within hours, and nobody went back: `SPEC/TECH/20` asserted that the
restore drill was both done and never run, in two places in one file, and `TODO.md` claimed a rule
lived in `TECH/21` that had never been written there.

Three agents then re-checked the corrections and found six more of exactly the same shape - a fact
fixed in one place and left standing in another, inside the same file. `TECH/21`'s drill-2 section
still carried "It is not runnable yet" in full while its Open section 250 lines below said the
opposite.

### What is not true at the end of this

**No update has been published**, so the path is proved as far as a receiver and no further. **No
stranger has installed anything** - the TestFlight install was the founder's own, internally
distributed, and Beta App Review has not been requested. **The app displays no version anywhere**,
so there is no way to tell from a device which build or which update it is running, which is the
one tool the silent-failure mode above actually needs. And the machine rollback drill, runnable
since 2026-08-25, has still never been run.

## 2026-08-25 - Milestone 5's remainder: the things that had been described but never done

Six items off `TODO.md` in one pass, chosen because each was a promise the repo had made and not
kept: production error monitoring that reached no human, a backup nobody had restored, legal texts
that were a first draft, no over-the-air path, an invite link that did nothing for anybody without
the app, and mail bounces nothing consumed. Built by seven agents in parallel against a written
interface contract, then reviewed by three more whose only job was to disprove them.

**The review is the part worth reading.** The build passed its own gate - 2077 tests, clean
typecheck, clean em dash lint - and the reviewers still found twenty-seven things, three of them
critical. A green suite meant the code did what its authors thought; it said nothing about whether
what they thought was right, and on three counts it was not.

### What the reviewers found that the suite could not

**An invite token was being shipped to Sentry.** `GET /invites/:token/preview` carries a bearer
credential in its path, and the route's author knew it: the route sets `logLevel: 'warn'` with a
docblock saying the url IS a bearer credential, and logs the route pattern instead of the url.
That closed the pino sink. Two Sentry sinks stayed open behind it - span attributes on every
sampled transaction, and `request.url` on every error event regardless of the sample rate - and a
reviewer demonstrated it by building a real client from the repo's own `sentryInitOptions()`,
pointing it at a capturing transport and sending 300 requests: 27,050 occurrences of the token in
the envelopes actually sent. **The lesson is about the shape of the fix, not the miss.** A
per-route opt-out has to be remembered once per sink, per route, forever. The redaction is now
central and pattern-based, so a route added next year is covered whether or not its author has
read that file.

**The Privacy Policy stated something false, and two agents wrote both halves on the same day.**
One turned performance tracing on across all three server roles and the mobile app. The other,
writing the legal text, read the code before the first had finished and wrote "No performance
tracing. Crash reporting is on; performance tracing is off." The suite was green with a false
statement in a document about to be published as a legal one. There is now a test that pins the
claim, so the next contradiction fails the build instead of shipping.

**The first over-the-air update would have bricked every install.** The three `EXPO_PUBLIC_*`
values exist only in `eas.json` build profiles, and `eas update` does not read those. A published
bundle would have carried `http://localhost:3000` as a literal, on phones with nothing listening
on port 3000. The documentation half of that fix is a flag somebody has to remember at 2am, so the
real fix is `endpoint.ts`: a release build with no API address refuses to start rather than
starting wrong. That inverts the usual call deliberately, and the reason is `expo-updates` itself -
a throw during bundle evaluation makes it mark that update failed, never launch it again on that
device, and fall back to the last one that worked. **A bundle that refuses to start recalls itself
phone by phone. A bundle that starts and points at localhost has to be recalled by a person.**

### Three defects that were already live, found by running things rather than reading them

**Every 5xx since launch reached Sentry stripped of everything that made it useful.**
`@sentry/node` 10 captures Fastify 5 errors itself through the diagnostics channel, before the
error handler runs, and Dedupe then drops ours as the duplicate. So the event that survived was the
SDK's, which knows nothing about `where`, `method`, `route` or `userId`, and ours - the entire
grouping design - was thrown away. Invisible from inside the process: `capture` ran, returned an
event id, an issue appeared. Only the tags were missing. See [`BUGS.md`](BUGS.md).

**There is nothing to roll back to.** The rollback drill, run in dry-run against the real Fly apps,
found all five releases across the three apps carrying one identical image digest. The safety net
described in [`SPEC/TECH/21`](SPEC/TECH/21-deployment.md) did not exist. It starts existing at the
next deploy, which is the first time a second distinct image will exist.

**DMARC generates no reports.** `_dmarc.clubchatapp.com` is `v=DMARC1; p=none;` with no `rua=`, so
no receiver is sending aggregate reports and none ever has. The path to `p=quarantine` needs about
two weeks of those reports first, which makes the DMARC item a fortnight rather than an edit.

### What is built and not proved

Everything here is local. **No drill has been fired at production, so it is still true that no
production error has ever reached a human** - which was the whole point of the monitoring item, and
is the one line in this entry most likely to be misread as done. The apex Worker has never been
deployed and `clubchatapp.com` still answers 522, while the app now links to it for both legal
documents and every invite. That ordering is now a rule in `SPEC/TECH/21`. Tracing is live on two
of four surfaces: the mobile navigation integration and a worker root span are deliberately not
guessed at, because the first needs a device to verify and the second is a volume decision worth
making on purpose.

#### Overtaken, and left standing for two days

**The section above was written mid-day on 2026-08-25 and most of it was false by that evening.**
It is corrected here rather than rewritten, because what a milestone believed about itself at the
time is the thing this file is for. Three of its claims:

- *"No drill has been fired at production, so it is still true that no production error has ever
  reached a human."* **Both halves stopped being true that day.** A deliberately raised 5xx reached
  the founder's phone by itself (issue `021d94c07bb3425e8e0855d42390de21`), which first required
  fixing a Sentry DSN that had been invented since launch, and the restore drill ran against real
  production history. The parked outbox event is the half that is still open.
- *"The apex Worker has never been deployed and `clubchatapp.com` still answers 522."* **It was
  deployed between 2026-08-25 and 2026-08-27** and serves the landing page, the legal texts, invite
  links and the app-link files.
- *"That ordering is now a rule in `SPEC/TECH/21`."* **It was not.** All twelve rules were checked
  on 2026-08-27 and none of them said it. The rule exists now, under rule 1.

Two of the three findings in the section above it went the same way, within hours of being
written, and both are worth reading as the entry's own thesis turned on itself:

- *"There is nothing to roll back to."* True at the dry run that morning. The deploys that evening
  created three more image references on every app, so the safety net started existing at 19:08
  the same day - which is exactly what the entry predicted would happen "at the next deploy",
  written as though that were far off.
- *"DMARC generates no reports."* `rua=mailto:dmarc@clubchatapp.com` was added later on 2026-08-25
  and `dig` still showed it on 2026-08-27, so the fortnight of reports the entry called for
  started running that day rather than not at all.

**The pattern is worth more than the three corrections.** Every one of these was written as settled
by the session that did the work, in the hour before the thing it described changed, and none was
revisited - including a claim that a rule had been written down, by the session that did not write
it. `TODO.md` and `SPEC/TECH/20` and `SPEC/TECH/21` all carried a version of the same drift, found
on 2026-08-27 by fetching the endpoints and running `fly releases` rather than by reading any of
them.

## 2026-08-23 - The first deployment, and the nine defects the audit found first

ClubChat runs in production. Three Fly apps in `iad`, one machine each from one image; Neon migrated
by the api's `release_command` before any machine took traffic; `api.clubchatapp.com`,
`ws.clubchatapp.com` and `cdn.clubchatapp.com` all answering; media served in `cdn` mode; and
signup, chat, photo upload, push and password-reset mail each proved by hand. It is the first time
anything in this project has run anywhere but a development machine.

[`TECH/21`](SPEC/TECH/21-deployment.md) carries the procedure and which of its steps have been
performed, and [`TECH/20`](SPEC/TECH/20-road-to-the-first-club.md) carries milestone 5's standing.
This is what it cost.

Nothing was deployed until the three Fly configs, the image and the mobile build had been audited
against what the code actually does rather than against what they claimed, which turned up **nine
defects. Four of them would have deployed green**, and that is the number worth holding onto: a
deploy that reports success while being wrong is the failure this whole arrangement is built
against, from `/ready` being made able to fail to the worker having no health gate to hide behind.

### The four that reported success

**Sentry was wired nowhere, and every file said it was.** All three `fly/*.toml` set
`SENTRY_ENVIRONMENT = 'production'` and none set `SENTRY_DSN`. `monitoring.ts` gates every capture
on the DSN being present and non-empty and falls back to the process logger without it, which is
deliberate: it is what makes the capture paths run in development and CI rather than executing for
the first time in production. The price of that design is exactly this failure. A role with no DSN
boots, logs, and is indistinguishable from a role with one, so every 5xx, every parked outbox event
and every failed drain tick would have reached a log inside a Fly machine and reached nobody, while
three configuration files named Sentry twice each. `fly/worker.toml` went further and described a
parked event as "already captured to Sentry", which was true only where a DSN existed. It was off
in CI too, because `.env.example` ships the key bare and CI copies that file.

**The two roles that serve every request were the two taking Fly's 256 MB default.**
`fly/worker.toml` pinned its guest; `api.toml` and `gateway.toml` did not, which is precisely the
wrong way round. The api is the one role that maps libvips at boot, through the static
`import sharp` in `media/pipeline.ts`, and `completeUpload` then reads an object of up to
`MAX_IMAGE_BYTES` into memory and walks every pixel of it. A default machine meets that as an
out-of-memory kill on somebody's photo, and an OOM kill presents as a machine restart rather than as
an error: it would have read as instability for a long time before it read as a memory ceiling. The
api is now 1 GB and the gateway 512 MB, pinned in `[[vm]]`.

**The secrets sections documented one app, and all three roles parse the same flat schema.**
Following the files literally gives a working api, a gateway that fails readiness part-way through
its own deploy, and a worker that never boots and says nothing, because it declares no service and
so has no health gate to fail. That three-way asymmetry is documented and was still not applied to
the list it governs.

**An optional value supplied as an empty string is not an absent one.** `''` arrived where the code
expected `undefined`, so every `??` fallback downstream of config was dead: `/__parity` answered
`version: ""` and Sentry would have initialised with `release: ''`. Three separate producers make
that shape and no single call site covers them, which is the whole reason it needed finding rather
than patching: the image cannot conditionally omit an `ENV`, `.env.example` ships bare keys, and
`fly secrets set NAME=` stores an empty value rather than removing one. It is normalised once in
`config.ts`, the only place all three pass through. The worst instance was `MAIL_FROM`: an empty
string is truthy, so the cross-field check written to refuse a half-configured mailer passed, and
would have built a transport with no From address.

### Two claims about image decoding, both written down, both false

**A byte cap is not a pixel cap.** `MAX_IMAGE_BYTES` bounds the compressed file; libvips allocates
the decompressed surface, which follows from the declared dimensions and has nothing to do with the
file size. Nothing bounded it. `DECODE_OPTIONS` set only `failOn`, leaving sharp's default
`limitInputPixels` of 268402689 pixels, which at four bytes a pixel is 1.00 GiB of raw bitmap for
one image, requested by a **94 byte PNG** declaring 16000x16000 and landing inside a machine that
has one gigabyte in total.

What makes it an entry rather than a bug is why nobody had looked. `probe.ts` carried a comment
saying the default already refused this, and
[ADR-0018](SPEC/decisions/0018-decode-uploads-at-the-boundary.md) repeats the claim. A false
statement in a comment is expensive; the same false statement in a comment **and** an accepted
decision record is close to unfindable, because the second one is what you check the first against.
The bound is now `MAX_IMAGE_PIXELS`, 64 Mi, folded into the shared `DECODE_OPTIONS` so both call
sites carry it, chosen so a 50 megapixel Android photograph is still accepted while the 108 and 200
megapixel full-resolution modes are refused.

**And there was a third call site.** The crop handed bytes to libvips with no options at all, so it
took sharp's default `failOn: 'warning'` and was therefore **stricter than the gate that admits work
to it**. A photograph with a stray marker inside its scan passed the probe, threw out of
`completeUpload`, and the route turned that into a 500. A stricter check downstream of a looser one
is worse than either alone, because whatever it rejects has already been told it was accepted.

### The cutover proved mail before the hostname in its link existed

The procedure written on 2026-08-21 put the five by-hand proofs before the DNS step. That is fine
for four of them and wrong for the fifth, for a reason invisible from the step list. All three
configs set `BETTER_AUTH_URL = 'https://api.clubchatapp.com'`, `api/main.ts` hands it to better-auth
as `baseURL`, and better-auth builds the password-reset link from it. A reset requested before that
name resolved would have sent a real mail, to the right person, correct in every visible respect,
carrying a link to a host that did not exist.

Reordered to deploy, then DNS and certificates, then prove. The payoff was immediate, which is why
this is written down rather than quietly fixed: when the mail was actually sent, its link resolved
and completed, in the sequence `POST /api/auth/request-password-reset`, then
`GET /api/auth/reset-password/<token>`, then `POST /api/auth/reset-password`, then
`POST /api/auth/sign-in/email`. Under the original order that is four steps of which the second
answers nothing, discovered by a person who has already used their reset link.

Worth keeping apart from the neighbouring mail failure, because the two present as opposites: an
unverified Resend domain sends nothing at all, and this one sends a mail that looks correct.

### A TestFlight binary would have pointed at a laptop, and reported no crashes

`eas.json` declared no `env` on any build profile. `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_WS_URL`
are inlined into the bundle at build time, so a production build would have baked
`http://localhost:3000` into every install, permanently, with no server-side correction possible.
That is the exact thing [`TECH/21`](SPEC/TECH/21-deployment.md) rule 8 exists to prevent: the rule
had been written and agreed and never applied to the one file that decides it, which is the shape
failure mode 19 names, a rule asserted in prose and implemented nowhere.

The same absence covered the client's error reporting. With no `EXPO_PUBLIC_SENTRY_DSN` in the build
environment, the binary handed to testers would have reported no crashes at all, in the way this
project has learned to distrust most: looking exactly like an app that never crashed. Both profiles
now carry the production hostnames and the mobile DSN, and `usesNonExemptEncryption` is set so an
upload does not park waiting on an export compliance answer.

### The deploy, in the order it was designed to run in

One image, built once with `--build-arg SENTRY_RELEASE`, pushed once, deployed to all three apps by
digest, api first so its `release_command` ran the Neon migration on a temporary machine before
anything took traffic. `--ha=false` on each of the three, so one machine per role is the shape that
is running rather than the shape that was reasoned about while Fly quietly created five. The api
answers `73a9ee3d6c7eb204dd0f550f0477f674ddffb67a` as its release.

`api.clubchatapp.com` and `ws.clubchatapp.com` went on next as A and AAAA records with the proxy
off, then a Fly certificate for each. Grey cloud rather than orange is not a preference: Fly
terminates its own TLS, and proxying through Cloudflare puts two proxies in series and breaks the
WebSocket upgrade. That the proxy really was off was checked from outside rather than read off the
dashboard, by the absence of any `cf-ray` header beside a `server: Fly/...` one.

Then the five paths by hand, reported individually. Push is the one worth recording in detail,
because the interesting part is what it did **not** do: the `push.deferred` payload's recipient list
excluded the sender, and exactly one `push_deliveries` row was written, because exactly one device
is registered. A fan-out that includes the person who just typed is a defect nobody notices in a
club of two, and the ledger is the only place it would have shown.

The outbox has since drained everything with zero unprocessed and zero errors, across
`message.created`, `media.uploaded`, `message.reacted`, `push.deferred`, `club.created`,
`poll.created` and `message.pinned`. The worker logged `worker started, draining outbox and running
the scheduler` once, which is the only boot signal that role has and therefore the only evidence its
deploy meant anything at all.

### The Worker, on its real hostname, while nothing depended on it

`/__parity` answers `D6NXENh3` on both the api and the Worker, compared on the `parity` field alone.
The two `version` fields differ by design and always will, a git sha against a Cloudflare version
id, so a whole-body diff would have reported a difference at exactly the moment somebody is trying
to establish whether two secrets match.

Then the refusals, which is where an emulated R2 could only ever have been evidence about the
pieces. With **valid** signatures: an unknown first path segment answers 404 without touching R2
rather than falling back to the private bucket, a key with no prefix answers 404, a path traversal
answers 403 because normalisation breaks the signature, and a valid signature for an absent object
answers 404. With invalid signatures: no signature, a tampered one, one minted for another object,
and an expired one all answer 403. Proving the routing with valid signatures is the whole point of
that first half. A broken signature refuses before the router is reached, so it says nothing about
where an unknown prefix would have gone, which is the mistake the emulated tests made about this
same function on 2026-08-21.

### An ADR that survived being checked

`cf-cache-status` is **absent** on a real signed URL. Nothing is held at the Cloudflare edge, so
`public, max-age=3600` reaches browsers and downstream caches only, and N members opening one photo
is N reads of R2. That is the open half of roadmap debt 7, settled by a response header.

It **confirms** [ADR-0044](SPEC/decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md)
rather than contradicting it, and that is worth saying next to the entry below, which records the
opposite kind of afternoon: the same claim asserted in five files before anybody checked, and false
in all five. The difference is not care, it is form. This one was reasoned out from the vendor's own
documentation, written down as a prediction, and shipped with the one command that would falsify it.
`HIT` or `MISS` would have meant the ADR needed superseding. The switch stays off, and turning it on
is now a decision rather than a question.

### The verification scripts were wrong in the flattering direction

Several small scripts were written during the deploy to check the things a deploy has to check:
that a secret matches on two sides, that a hostname is not proxied, that a refusal is a refusal.
More than one of them **reported a better answer than the truth**, and each had to be rewritten to
prove it could fail before its pass was worth anything.

This is failure mode 37 arriving from a new direction. There it was a test whose expected value
equalled the system's own default, so it passed on the default rather than on the parameter. Here it
was checks written quickly against a system nobody could see into, where the cheap implementation of
"does this refuse" is one that also answers yes when the request never arrived, and the cheap
implementation of "do these match" is one that also answers yes when both sides are empty. A check
with no negative case is not a check, and it fails in a consistent direction: it says the thing you
want to hear, on the day you most want to hear it.

The cost either way is worth stating, because it decided nothing at the time and should. Watching a
check fail once is a minute. Every one of the nine defects above was found by asking a system what
it was doing rather than reading what it claimed, and the tools doing the asking were the last
things left that nobody was asking about.

### The last two open things, closed later the same day

The list below was written while two of its items were still open. Both closed before the day ended,
and each is worth a line for what closing it took.

**`PLATFORM_MODERATORS` was set at 16:46Z**, on `clubchat-api` alone, through `fly secrets import`.
The runbook puts that step before the five by-hand proofs and it ran after them, which is the step
behaving exactly as its own prose says it must rather than the step slipping. The value is a list of
email **addresses**, matched against `users.email` at boot and at no other time, so it can only
grant anything once the account exists - and the only real account this deployment had was the one
the signup proof created at 15:05Z. Setting it before the first deploy was allowed, would have
restarted a machine, and would have granted nobody.

The import rolled the single api machine, it came back with `/ready` answering 200, and the boot
logged `platform moderators reconciled` with `configured:1`, `granted:1`, `revoked:0` and an **empty
`unmatched`**. That empty array is the entire result. A mistyped address produces the same
successful import, the same healthy machine and the same reassuring line, with `granted:0` and the
address sitting in `unmatched` - a report queue that still has no reader, and nothing anywhere
complaining about it. Which is why the proof of this step is a log line and not an exit status. One
moderator exists now, the founder's own address, chosen for now rather than as a roster.

**A signed media URL was watched crossing an hour boundary at 17:01Z.** Three minted at 16:05Z, a
photo original, its thumb variant and an avatar display variant, all answered 200 with their full
byte counts after the 17:00Z crossing. Fifty minutes of working proves nothing about the fifty-first
when the expiry is hour aligned, so this is the one part of `cdn` mode that could not be argued into
being true and simply had to be waited out.

### What is still not true

Written out, because a first deploy is the moment a project is most likely to describe itself
generously.

- **No backup has been restored. No alert has been forced to reach a human.** Sentry has received no
  production error, so error reporting is wired and unproved; performance tracing is not merely
  unproved but switched off by a constant, `tracesSampleRate: 0`, deliberately and with its reason
  in a comment.
- **Nothing is on TestFlight.** A production build is being started; nothing is submitted, nobody
  outside has installed anything, and external TestFlight additionally needs Apple's Beta App
  Review. There is also no EAS Update channel: `app.json` declares no `updates` block and no
  `runtimeVersion`, so a fix still needs a build.
- **The legal texts are not written.**
- **Four credentials that passed through a chat transcript are not rotated**: the R2 secret access
  key, the Cloudflare API token, the Sentry organization auth token, and the older Full-access
  Resend key. The founder deferred all four today, deliberately, and it is recorded with its date
  because a dated deferral is a decision somebody can revisit while an undated one becomes an
  oversight nobody owns. The R2 credential is read **and** write where the Worker only ever reads.

One thing closed by evidence rather than by decision. The password-reset mail arrived from
`noreply@clubchatapp.com`, and Resend will not send from an unverified domain, so the badge that had
been `Pending` since 2026-08-21 had flipped. That row has now been read wrongly in both directions,
once as verified because the DNS was right and once as unverified because the badge said so, and the
only reading that was ever worth anything is the one that came from a mail arriving.

---

## 2026-08-21 - The CDN Worker, and three APIs that compiled cleanly and did nothing

Milestone 5's remaining half: `cdn.clubchatapp.com` became a real program, `MEDIA_URL_MODE=presign`
got the tests a rollback lever deserves, and the deployment's likeliest failure got a diagnostic.
[ADR-0044](SPEC/decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md) records the
decision; this is what it cost.

**None of the seven commits already on `deploy` had touched this file**, so the milestone's earlier
half is written up below as well. That is worth naming as its own failure: a branch can pass
`npm run verify`, typecheck, the em-dash gate and a full 1617-test suite, and still leave the
project's memory empty, because nothing in the pipeline asks. `AGENTS.md` 2.4.2 asks; only a person
enforces it.

### The Worker did not work, and only running it said so

The Worker was written against a contract, typechecked clean, and bundled to 6.37 KiB with the
right three bindings. It was then executed for the first time in `workerd` against emulated R2, and
**27 of 101 tests failed immediately.**

Every plain read was being answered `206 Partial Content`. Every `Content-Range` read
`bytes NaN-NaN/<size>`, and HEAD sent `content-length: "NaN"`. For a browser loading an `<img>`
that is not a cosmetic header bug.

One mistake, made twice: reading a runtime value through a type that lies about it. `R2Range` is
declared as three **disjoint** shapes, and the object R2 actually returns is a single shape with
`offset`, `length` and `suffix` all present as own keys, `suffix` holding `undefined`. So
`'suffix' in range` was a presence test against a key that is never absent, true on every read, and
`Math.min(undefined, size)` did the rest. Its sibling: `object.range` is declared optional and is
never absent, so "was this a range request" answered yes to everything.

**`JSON.stringify` drops a key whose value is `undefined`,** so the object prints as
`{"offset":0,"length":10}` and looks exactly like the union member you expected. The diagnosis came
from printing `Object.keys` against real emulated R2. It is now `AGENTS.md` failure mode 40.

The fix reads every field by value through a `finiteNumber` guard rather than by key presence, and
decides 200-versus-206 from the **served extents** rather than from the request. A probe settled
that second point: `bytes=900-1000`, `bytes=0-1,5-6` and `kilobytes=1-2` all carry a `Range` header
and all come back as the whole object, because R2 ignores what it cannot satisfy, and RFC 9110
requires a server that ignores a `Range` to answer 200. Deciding from the header would have sent a
`Content-Range` for a request the server had declined.

A third finding stayed a finding: the 416 branch cannot be reached from a `Range` header at all,
because R2 only throws `INVALID_RANGE` for an explicit `{offset, length}`. The `catch` was kept, as
the only thing between a thrown `R2Error` and an unreported 500 on a component nothing monitors,
and the README stopped publishing a status nothing can produce.

### Three APIs that compiled and did nothing

Every one of these is `AGENTS.md` non-negotiable 1, and every one failed silently rather than
loudly, which is what makes them worth listing together.

- **`@cloudflare/vitest-pool-workers/config` no longer exists in 0.22.** `defineWorkersConfig` and
  `defineWorkersProject` are gone; the pool is a Vite plugin now. This one at least fails loudly,
  with `Missing "./config" specifier`.
- **`ProvidedEnv` does not exist either.** The remembered incantation,
  `declare module 'cloudflare:test' { interface ProvidedEnv extends Env {} }`, **typechecks clean
  and does nothing**: it merges into an interface nobody reads, and `env.CONTENT` stays an error
  whose only apparent fix is a cast. Caught only by writing a throwaway module that actually read
  `env.CONTENT` and watching it fail. Failure mode 38.
- **`isolatedStorage` is not in the 0.22 pool schema, and the options object is parsed with zod's
  `$strip`,** so passing it is dropped rather than rejected. Storage is consequently not isolated
  between tests, which surfaced the worst way round: an object seeded by one test survived into the
  next, so "a missing object is a 404" passed back the previous test's bytes. A test leaking state
  into the test that asserts absence is the one direction that turns green into a lie.

### The red team could not get bytes out, and found three things anyway

An adversarial pass ran against the finished Worker: 400 hostile requests over paths, expiries,
signatures, methods and conditional headers, against buckets seeded with real objects at every key
the grid could name. **399 answered 403 and the one 200 was `/__parity`.** Refusal before read was
proved directly with R2 bindings rigged to throw rather than inferred from a status code. Message
collision is impossible for anything the api mints, because `${objectKey}:${exp}` has exactly one
colon when `exp` is a number's string form and no key this project issues contains one. The
signature check is not truncation-tolerant. Nothing pathological made it throw: a 4 MB path, 20,000
query parameters, 10,000 `..` segments, all refused in under 50 ms.

**One real defect, in the routing.** `bucketRoleForObjectKey` read
`objectKey.slice(0, objectKey.indexOf('/'))`, and `indexOf` answers `-1` with no slash, so
`slice(0, -1)` drops the last character. `photos` became `photo`, `avatars` became `avatar`. The
red team seeded ten bytes at key `photos` in the **private** bucket, signed it, requested it, and
got 200 with the object; with both bindings rigged to throw, `photos` tripped the wire while
`photo` and `nope` still answered 404, so R2 really was being read.

Unreachable from the internet, because the api only ever mints `${kind}/${YYYY-MM}/${uuid}` and no
signature for a slashless key can exist. What was actually broken is that this function's own doc
comment promises the opposite, in these words: *"routing an unknown prefix to the private bucket
would turn a typo into a probe of private content"*. Five other places restate it. **A documented
security property that is false is worse than one that was never claimed**, because the next person
builds on it.

The tests missed it precisely: they covered `photos/2026-04/x`, which HAS a slash and so genuinely
has the prefix `photos`, and `photo`, which loses a real character and becomes `phot`. Neither is
the broken shape.

**`workers.dev` was on, by a default nobody had read.** Wrangler's own source:
`defaultWorkersDev = routes.length === 0`, and this config declares no routes deliberately. So a
plain `wrangler deploy` would have published `clubchat-cdn.<subdomain>.workers.dev` plus a
per-version preview URL - and since **the signed message covers the object key and the expiry but
not the host**, every URL the api mints would work verbatim there. A complete second front door to
both buckets, outside every WAF rule, rate limit and Access policy ever attached to the zone, with
`/__parity` reachable too. Both settings are now explicitly `false`.

**And a comment that was right for the wrong reason.** The Worker's header said `%2e%2e%2f` is safe
because it is "four extra characters that were not in the signed message". Reproduced: `new URL()`
resolves `%2e` as a dot segment per the WHATWG spec, so `/x/%2e%2e/photo/...` normalises to
`/photo/...` and serves the object. The conclusion holds - the HMAC and the R2 key are the same
string, so they cannot diverge - but the stated mechanism was false, and the existing test passed
because it used `%2F`, which genuinely is not decoded. Traversal is disposed of by normalisation
happening BEFORE the HMAC, not by the escape failing to match.

### The shared cache entry that never existed

The most-repeated claim about this Worker was false, and it had been asserted in five files.

`packages/server/src/config.ts`, `media/store.ts`, `TECH/07` twice, `TECH/16` and the Worker's own
comments all said the hour-aligned URL produces **one shared CDN cache entry serving all 300
members instead of 300 origin fetches**. That is the whole of roadmap debt 7.

Cloudflare does not cache a Worker-constructed response by default. Its Cache API page redirects
that job to **Workers Caching**, which is opt in through a top-level `"cache": {"enabled": true}`
in `wrangler.jsonc` - a key the pinned wrangler 4.125.0 accepts and this config does not set. The
feature would cover a response built from R2 bytes; it is simply off. The belief most likely came
from R2's own documentation, which says a custom domain **on the bucket** gets Cloudflare Cache -
a different arrangement, and one rule 8 forbids outright.

So `public, max-age=3600` reaches browsers and downstream caches only, and N members opening one
photo is N R2 Class B reads. What the alignment does buy is real and unchanged: the cache **key**
collapses to one URL per window instead of fanning out per fetch, a deleted photo goes dark within
the hour, and expiries stagger. Every one of those five files now says so, debt 7 is recorded as
only partly paid off, and the switch stays off until `cf-cache-status` on a real signed URL says
what it actually does.

### Headers the CDN was borrowing from somebody else's allowlist

The red team stored an object with `content-type: text/html` and a `<script>` body and watched the
Worker serve it as HTML with no `nosniff` and no CSP. It sized the finding down honestly: nothing
dangerous is reachable, because the api's `IMAGE_MIME_ALLOWLIST` and `DOCUMENT_MIME_ALLOWLIST`
exclude `text/html` and `image/svg+xml`, and better-auth's session cookie is host-only so it never
reaches the CDN hostname.

Fixed anyway, and the reason is the interesting part: **the CDN's safety lived entirely in another
package.** `store.ts` explicitly frames widening that allowlist as "a product decision", and
whoever makes it will be editing `packages/server` with no reason to think about the edge. Every
response built from an object now carries `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; sandbox`, and `Content-Disposition` is stripped:
uploader-controlled, never written by this project, and the client builds filenames device-side.

### Key ordering had exactly one line of defence

`verifyMediaSignature` widened to take an ordered key list so the signing secret can rotate without
darkening every outstanding URL for the rest of its hour. The previous key is configured on the
**Worker alone**, deliberately: the api signs and never verifies, so a `MEDIA_SIGNING_SECRET_PREVIOUS`
on a Fly app would be a variable nothing reads.

Trying the previous key before the current one returns an identical boolean for every input in the
vector table. It is invisible to the openssl vectors, to the server's independent `node:crypto`
re-derivation, and to any assertion on the result. Proved rather than argued: with the order
reversed, **all 10 server vector tests pass**, and only three `crypto.subtle.importKey` spy tests
catch it. Those three are the entire coverage of that property, and a future change that caches or
pre-hashes the keys must rewrite them rather than delete them.

### The first deploy would have failed at boot

`BETTER_AUTH_URL`, `S3_ENDPOINT`, `S3_BUCKET_PUBLIC` and `S3_BUCKET_PRIVATE` are required by the
flat config schema, are not secrets, and were in none of the three `fly/*.toml` files. The api
would have crashed on startup; the worker would have failed **silently**, because `worker.toml`
declares no service and therefore has no health gate, surfacing later as an outbox that stopped
draining.

Found by feeding each `[env]` block through the real `loadConfig` rather than by reading it, which
is the only way this class shows up: a config file is not wrong in a way a reviewer sees, it is
wrong in a way the schema sees. The same check confirmed that the six platform secrets are each
genuinely required and that no toml key is unknown to the schema.

`CLIENT_ORIGIN` was a quieter version of the same thing. It defaults to `http://localhost:8081`, so
a production api left unset would have shipped a credentialed CORS allowance for a developer
laptop.

### Two documents that were describing a world that had moved

`TECH/20`'s standing table said Resend was "`clubchatapp.com` verified, DKIM/SPF/DMARC live". The
DNS is genuinely correct and there is exactly one `v=spf1` on the apex, but Resend's own status is
still `Pending`, and it refuses to send from an unverified domain. The DNS being right had been
read as the provider being ready, and password-reset mail is unprovable until the badge flips.

`TECH/21` gained a link to `15-observability.md`, which does not exist; error reporting lives in
`15-stack-and-hosting.md`. Caught by a link checker run over every relative link in `SPEC/` and
`AGENTS.md`. This is the same class the 2026-07-28 spec split produced a dozen of: links whose
target existed and whose content was wrong.

### Two process notes worth keeping

**Mutation testing is a write.** A shared file was mutated to prove a test could fail while a
parallel agent was reading it, and that agent reported the mutation as a defect in somebody else's
work. Harmless here, but in a shared tree a mutation belongs between waves, not during one.

**The em-dash gate could not see the new package.** `scripts/check-emdash.mjs` enumerates
`git ls-files`, so `npm run verify` reported "no stray em dashes" across a working tree containing
an entire untracked workspace it had never opened. The script's own header records this happening
to it once already, which is the point: it is a property of the tool, not a bug that was fixed.
Failure mode 39.

---

## 2026-08-21 - Milestone 5, the earlier half: artifacts, health checks, and Neon's silent discard

Written after the fact, from the seven commit messages on branch `deploy`, because none of those
commits touched this file. The entry above explains why that matters.

### There was nothing to deploy with

No Dockerfile, no `fly.toml`, no `.dockerignore`. Milestone 5 was blocked on artifacts rather than
on any decision. The image ships source and runs it, because `tsconfig.base.json` already said
there is no build step for the server and that three settings hold that up together: explicit `.ts`
import extensions, `allowImportingTsExtensions`, and the `noEmit` it forces.

Two decisions came out of writing them, both in
[ADR-0043](SPEC/decisions/0043-the-three-roles-deploy-as-three-fly-apps.md). The second reversed a
claim this repo had been carrying: `gateway/main.ts` said the gateway must sit behind an L4
balancer because balancers that terminate HTTP break the WebSocket upgrade. True of L7 balancers in
general, and **not true of Fly**, whose HTTP handler proxies an upgrade because an upgrade is
HTTP/1.1. It matters because a raw TCP service on Fly can only carry a `tcp_check`, which proves a
port is listening and cannot tell that apart from working - and closing exactly that blind spot is
what this deploy exists to do.

### A health check that cannot fail cannot gate a deploy

Fly gates both traffic routing and deploy success on the health check, so a check answering from
process memory would let a deploy against an unreachable Neon go green and then take live traffic.
`/health` stays liveness and cannot fail, deliberately: Fly restarts a machine that fails liveness,
so a liveness check that consulted the database would restart every machine at once during a blip.
`/ready` is the new one and actually reaches Postgres. It fails on Postgres and **not** on Redis,
because every instance shares one Redis and failing readiness on it would pull every instance out
of rotation at once, turning a documented degrade into a total outage.

### An ORM error's message names the query, not the reason

Failure mode 1 at a new call site. Drizzle rethrows `DrizzleQueryError`, whose message is always
`Failed query: <sql>` and is byte-identical whether Postgres refused the connection, rejected the
password, ran out of connections, or was missing a grant. The readiness line logged
`error.message`, so every failure during an outage read the same, while the comment above it
promised these logs answer "how long was it down". It graded correctly throughout, which is what
made it invisible: the endpoint did its job and the operator got nothing.

The same commit corrected a comment that claimed a crash that does not happen. The gateway's
`respond()` guard was justified as preventing a process-ending unhandled rejection when writing to
a destroyed response during shutdown. The scenario is real; the consequence was asserted rather
than measured, and it is wrong. Measured inside the deployment image on the pinned runtime,
`node:24-trixie-slim` v24.19.0: `writeHead` plus `end` against a destroyed response returns
normally and produces no `uncaughtException`. Node discards the write. The guard stays as cheap
insurance and the comment now says so on accurate grounds, because a guard whose removal breaks no
test is a guard somebody deletes while tidying.

### Neon discards the timeout ceilings, and the test could never have caught it

Found by connecting to the real Neon project for the first time and asking the database what it was
running with, rather than asking the code what it had asked for. On the direct endpoint:

```
statement_timeout                   = 0      wanted 30s
idle_in_transaction_session_timeout = 5min   wanted 2min
```

Both are defaults, so what arrived was nothing. `pg` sends them as individual startup parameters
and Neon **silently discards** them. Not rejects, discards - a rejection would have failed the
first deploy loudly, which is the outcome anyone would want. The identical pool against the
development container returns 30s and 2min, which is why every test was green. `statement_timeout
= 0` means a runaway query holds a connection until the process restarts. Both now ride the
`options` startup parameter as `-c key=value`, which Neon passes through untouched.

Underneath it was a second defect. `pg` writes its individual parameters behind
`if (params.statement_timeout)`, and `0` is falsy, so the escape hatch `db/migrate.ts` uses to opt
migrations out of both ceilings was never sent at all. Building an index over a table with real
rows is a statement that is supposed to run for minutes. That opt-out had never worked, and it
appeared to because Postgres also defaults to 0: asking for zero and inheriting zero are
indistinguishable until a server with a non-zero default turns up.

The more useful half is the test. It asked for zero, read zero, and passed on the default rather
than on the parameter, while its own comment claimed to be "the assertion that the escape hatch
actually disables them". **An assertion whose expected value equals the system's own default proves
nothing.** That became failure mode 37.

### One signature, two runtimes, and four mutations the tests slept through

Shipping `MEDIA_URL_MODE=cdn` means the signature is minted on Node and checked on `workerd`. Two
implementations of one HMAC is the shape of a bug that presents as "every photo is broken" with
both sides looking correct in isolation, so there is now one implementation on WebCrypto and both
runtimes import it, proved byte-identical to the `node:crypto` original on 120 cases.

The tests that were supposed to protect it could never have failed. Changing the signed separator
from `:` to `|`, and the expiry compare from `<` to `<=`, left **all 52 media tests green**, because
every assertion signed and verified with the same implementation. `media-signing-vectors.json` now
carries literal expected values generated by `openssl` and re-derived a third way by `node:crypto`
in the server suite.

Two documents instructed things that would have broken production. `TECH/21` rule 8 said
`cdn.<domain>` points at "The R2 content bucket" - Cloudflare offers exactly that in two clicks,
with no signature check, which publishes every private chat photo, document and Eboard image to
anyone holding a URL. `TECH/07` documented a URL at a domain this project does not own, with an
`/o/` prefix the code has never emitted.

And `.env.example` shipped `MEDIA_URL_MODE=cdn`. CI copies it to `.env` and boots a live api from
it, so CI and every fresh clone ran cdn mode against MinIO, which has never heard of `exp` or `sig`.
It survived only because nothing in CI fetches media bytes.

---

## 2026-08-19 - The calendar tab kept reading for a screen nobody was on

Reported from the phone as a question rather than a fault: walking from the hub into a club and
back out, why is `GET /calendar` on the wire at all, when the Calendar tab was never touched?

The dev trace answered it flatly. Eighteen `GET /calendar` in the eight minutes before the fix,
seven of them club-scoped and eleven cross-club, one per crossing in each direction, with the tab
never once in front of anybody. The recording in `.dev-trace/trace.jsonl` is what made that a
count rather than an impression, and it is the second time in three days that file has settled a
question the code alone would have argued about.

The cause is four links, none of them wrong on its own:

- The Calendar destination follows whichever club is current, which `PRD/15` requires.
- It does that by holding the club in a `useLoad` dep, so the club changing is a re-read.
- A tab screen mounts lazily and then **never unmounts**, so the screen was live for the rest of
  the session after one visit early on.
- Entering a club declares it and leaving clears it, so every crossing moved that dep.

An off-screen screen was therefore paying for data nobody could look at. `useFocusedValue` in
`use-load.ts` is the fix: it returns a value as of the last time the screen was focused, because
`useFocusEffect` runs its effect only while focused, so a change arriving while blurred is held
rather than acted on and adopted on the next focus. The read is keyed on the deferred id and
built from it too, since `useLoad` calls the newest `read` it was given and a closure over the
live prop would have fetched the new club under the old key.

**`useRefreshOnReturn` deliberately keeps the LIVE club**, and that asymmetry is load-bearing. On
the focus that adopts a new club its key has already moved, so it counts that focus as a first
open and stays quiet while the load runs. Handed the deferred value instead, both fire on the same
focus and the screen makes the two round trips the deferral exists to remove, which is exactly the
defect recorded under 2026-08-17 above, one hook further down.

The trade-off is stated where it is made: the tab now shows a load when opened after a club
change, instead of having been pre-fetched for a visit that may never come. That is what every
other screen here does on arrival.

**Verified on the device, and it took two runs because the first one proved nothing.** That walk
happened after the tree had remounted, so the Calendar tab was not mounted during it, and zero
calendar reads is what EITHER version produces from an unmounted screen. Worth recording as a
near miss: the trace said exactly what the fix wanted it to say, and meant nothing.

The isolating run opens the tab first. `GET /calendar?when=all` at 22:21:02 is that mount, and
then four club boundaries at 22:21:14, 22:21:16, 22:21:19 and 22:21:32, in and out twice, with no
calendar read on any of them. Four requests that the old code would have spent, in half a minute.
Type check and the full suite green alongside it, 1,492 tests across the four workspaces.

**Still not exercised:** focusing the tab from INSIDE a club, which is the adopting half of
`useFocusedValue` rather than the deferring half. A hook stuck on its first value would draw the
identical trace above, because both produce silence. One tap settles it: from the club hub, open
Calendar and expect exactly one `?club=` read and the club's name on the header.

---

## 2026-08-17 - Four stale specs, and a save that erased what it never asked about

A reading session that turned into a data-loss fix. Nothing here was reported from a phone; all
of it came from reading the spec tree against the repo, which is the exercise `SPEC/README.md`
says settles a disagreement and which nothing had run in a while.

### Four documents disagreeing with the build

Per the standing rule that the repo is right and the doc is the bug:

- **`TECH/09` had missed seven migrations.** It still described `news_posts.media_id`, dropped by
  `0035`, and documented none of `news_post_media`, `news_post_tags`, `news_post_people`, the four
  columns news gained with ADR-0038 to 0040, the five `meetups` gained with ADR-0037,
  `calendar_events.map_url`, or `updated_by` on either dated table. Also added: `media_objects`'s
  `width`/`height`, and the `owner_type: 'news_post'` label that `PRD/13` rule 4 turns out to
  depend on.
- **`SPEC/README`'s ADR index stopped at 0037**, while 0038 to 0041 were on disk and cited from
  three specs.
- **`PRD/08` rule 5's table contradicted its own note two paragraphs down**, still calling the
  place required and the name optional. Rule 6 still described a composer asking "Where should we
  meet on Friday 14 August?" about a field that has not been collected since 2026-08-15.
- **`PRD/18` carried four meetup lines reversed by ADR-0036 and 0037** - the week hiding past
  days, a meetup *not* appearing on the calendar, Save gated on the place, and the nudge
  notification opening the club's week.

Two code comments went with them, both stating the old required field: the `meetups` docblock in
`schema.ts` and the `MeetupBody` docblock in the content routes. Neither is reachable by any
check, which is the whole reason they had drifted.

### The bug the reading found

`PRD/08` rule 5 lists **location notes** as a field a meetup carries. ADR-0037 specified it, the
route accepts it, the domain writes it, and `meetups/[meetupId].tsx` draws a "Location notes"
line. **The composer has never had a control for it**, so the only way to set one was to call the
API by hand.

That would have been an ordinary half-built feature, except for what it collided with.
`updateMeetup` is a **whole-form save**: absent means empty, which is the right rule for something
saved as one form and is what makes clearing a description work. The composer sent only the
fields it drew. So opening any meetup, changing nothing and pressing Save erased its location
notes - and `location` with them, the place text deliberately kept for the eighty meetups written
before the form stopped asking for one, and still shown on their screen.

**Nothing about that is visible.** Both ends are individually correct: the route means what it
says, and the composer sends what it has. Typecheck cannot see it, because every field is
optional; the screen cannot show it, because the thing that vanishes was never on the form. It is
failure mode 31's shape one layer out - the code that is present is entirely correct, and what is
absent was never written down anywhere.

### The fix, and why it moved out of the screen

The body-building moved into `apps/mobile/src/meetup-body.ts` as one pure function, for failure
mode 34's reason: the rule was unreachable from a test while it sat inline in a file that imports
`react-native`. `location` is carried through untouched and named as the one field the form holds
without owning; `locationNotes` gained a real control in the location section, beside the link.

Eight tests, and the one that matters asserts the **key set** rather than the fields: the failure
mode is omission, and a per-field test only ever checks the fields somebody remembered. A column
added later that the form does not edit fails that assertion until it is carried or deliberately
listed.

**Both halves were proved to fail without their own fix**, which is the only reason they are worth
having - removing the `location` carry fails three tests, removing `locationNotes` fails four. A
ninth test on the server pins the contract from the other end: a partial save is asserted to
**erase**, so the reason the caller must send everything is an executable fact rather than a
comment, and turning the route into absent-keeps fails loudly.

`TECH/10` gained the general rule beside the races note that already drew the distinction: a form
route puts an obligation on its caller, the two rules are indistinguishable at the call site, and
so a form route's caller builds its body in one testable place.

**Verified:** typecheck, `check:runtime`, `lint:emdash`, and the full suite at 1,444. **Not
verified on a device or in a browser** - the new field has not been looked at, and the round trip
has not been walked in the running app.

---

## 2026-08-17 - A document you can open, and the first native module in the project

Two sentences from the founder, four hours apart, and the second one changed the answer to the
first.

**"So if I upload any documents, I can click the document first of all. And then the UI for the
document should be like this"**, with a mockup: a peach tile, an orange square holding a page
glyph, the filename in bold, `PDF · 1.2 MB` beneath it, and the time under the tile rather than in
it.

### The tile was two rectangles, and the mockup was one

The bubble had been shipping since 2026-07-30 as a **white card with a hairline border, inside the
tinted bubble** - so every document in a conversation was two nested rounded rectangles around one
filename, with `FILE` in a grey square where the mockup has an icon, and the size on its own with
no type beside it.

The mockup's peach rectangle is not a card inside a bubble. It **is** the bubble. So the tile took
the bubble's own fill and the message bubble went `bare` behind it, which is not a new idea at all:
the chat screen already does exactly this for a photo sent without a caption, on the reasoning that
"a tinted frame around it is a second edge saying nothing". A document tile is a filled rounded
rectangle in its own right, so it wants the same treatment more, not less. The timestamp landing
under the tile follows from that rather than being a second decision - a bare bubble has no padding
for it to sit in.

The pending row got the same test, which fixed a jump nobody had reported: an attachment in the
outbox sat inside a bubble and then popped out of one the instant its ack arrived.

`PDF` comes from the **filename's extension**, and it has to: the message envelope carries a name
and a byte count and no content type at all. That is also the honest source, since the extension is
what the sender saw. It went into `document-name.ts` with `cacheFileName`, beside `photo-size.ts`
and for the same reason - vitest cannot parse React Native's Flow sources, so anything reachable
from a `react-native` import is untestable.

### What "click the document" means, answered twice

Offered as a multiple choice, because iOS has no free way to preview a file and the options
differed in whether the founder's phone had to be rebuilt. He picked the share sheet: stage the
bytes under the document's real filename, hand them to `Sharing.shareAsync`, and let **Preview**,
Save to Files and the rest hang off that. Verified end to end - the sheet came up with a real PDF
thumbnail, `PDF Document · 1.3 MB`, and the file that came back down was byte-identical to the one
that went up.

Then he sent a screen recording of **GroupMe** and asked *"can we do like this for pdf"*, and the
recording named its own implementation. A full-screen white sheet inside the app, the filename with
a close button, a `1 of 2` page counter, the PDF inline, a magnifier and a share control. Nothing
counts pages and searches text without knowing what a PDF is except `QLPreviewController`, which is
iOS's own document previewer.

So: `apps/mobile/modules/quick-look`, **the first native module in this project** - one Swift file
and a podspec, wrapping a framework that has not changed since iOS 4. Rejected `react-native-file-viewer`,
which does the same thing in fewer lines of ours, on standing instruction 3: a third-party package
in the binary forever, to avoid writing sixty lines. Rejected `expo-web-browser` because its chrome
is a browser's, over a signed URL nobody should be reading, and because a `.docx` downloads rather
than opening. Rejected a DOM-component `<iframe>`, which needed no rebuild and covers PDFs at best.
[ADR-0041](SPEC/decisions/0041-a-document-opens-in-the-platforms-own-viewer.md) records all four.

The share sheet stayed as the **fallback**, and within the hour that proved to be the load-bearing
part rather than tidiness.

### The founder's phone disagreed with the simulator, and that was correct

He tapped a PDF on his iPhone and got the share sheet while the simulator was showing the viewer,
and reported it as a discrepancy. It was not one: his binary predated the module by twenty minutes.
`previewDocument` answered `false` and the fallback caught it, which is exactly what
`requireOptionalNativeModule` exists to do.

The alternative is severe enough to be worth stating plainly. `requireNativeModule` throws **at
import time** for a module that is not in the binary, and this repo has already been taken down
twice by an import-time throw - `expo-sqlite`'s wasm and `expo-media-library` on web, both recorded
as pitfall 8. A module whose entire nature is *being newer than some installed builds* would have
been the third, and the symptom would have been a blank screen on every route rather than a share
sheet. Recorded as pitfall 37, along with the quieter half: `expo.autolinking.nativeModulesDir` has
no default, so without that key in `package.json` the module is silently absent from the build with
no error at `pod install`, no error at compile, and a `null` that the optional require then handles
perfectly.

Rebuilt and installed on the device, and the viewer opened his own two-page resume with `1 of 2` in
the corner - the same file and the same frame as the recording he sent.

### Verified

On **web** through Playwright: the tile, and a tap that downloads a byte-identical file (the
browser has no previewer and no share sheet, and a tab opened after an `await` is what a popup
blocker exists to stop, so a `blob:` download is the honest answer there). On the **simulator**
before and after the rebuild, both the sent and the received tile, and both the share sheet and the
viewer. On the **device**, by the founder, in both states.

Not directly observed: the optimistic bubble between upload and ack. It is the same `bare`
expression the acked row uses, and on localhost the window is a few milliseconds wide.

## 2026-08-17 - The "..." was a round trip late, and the focus effect was why

Reported from the phone within the hour, with a video: opening an event or a meetup and waiting
"a couple fraction of seconds" for the three dots to appear.

**The menu is gated on `canManage`, which arrives with the read - so it can never precede it.**
That much is inherent. What was not inherent is that the screen was doing the read TWICE.

The focus effect added that same afternoon called `load.reload()`, and `useFocusEffect` fires on
mount as well as on return. Two things followed, and the second is the one that cost the time:

- `reload` announces a load where a return wants `refresh`, which the module's own doc comment
  spells out - "a background refresh is not a first load and must not claim to be one", written
  after the chats list was reported "reloading again and again, weird and seeable". The same
  mistake, in a hook that documents it.
- **`run` bumps an attempt counter and discards every earlier response.** So the mount read's
  answer was thrown away by the focus read a millisecond later, and the screen waited for the
  second round trip before rendering anything. On localhost that is 1ms and invisible; on a phone
  over the LAN it is the whole delay.

Measured rather than reasoned about, by counting `fetch` calls on a cold open: **two reads before,
one after**, and the menu now appears about 30ms after the single read resolves. Leaving the screen
and returning still re-reads exactly once, which is the behaviour the effect existed for.

The fix is `useRefreshOnReturn(load, key)` in `use-load.ts` rather than a corrected focus effect on
each screen: two copies of "skip the first fire, then refresh quietly" is how one of them ends up
calling `reload` again. It is keyed, so navigating from one meetup straight to another still counts
as a first open for the second.

---

## 2026-08-17 - An event you can edit, and two screens that say who put them there

The event screen carried three stacked buttons - Directions, Open the club, Delete event - and a
card of three label/value pairs with nothing between them. The founder wanted the buttons gone
except Directions, the destructive one behind a "...", rules between the rows, and a face on
"Added by". Meetups the same, and *"if it got edited by some other person just add their name too
under added by"*.

**Edit did not exist for an event, at any layer.** Meetups had `PATCH /meetups/:id`; events had
create, read and delete and nothing else. So "Edit event" meant a new route, a new domain
function, and a composer that opens on an existing row - not a menu item.

**`updated_by` on both tables, and the comparison lives on the server.** Migration `0038`. Written
on every edit including one by the author, and the READ decides whether it is worth saying: an
editor is returned only when it differs from the creator, so "Added by Dana, edited by Dana" cannot
happen. That judgement is `editorFields`, one function, because two detail reads ask the same
question and a rule written twice is failure mode 9 waiting to happen. Compared by id rather than
by name, since two members can share a name and one can change theirs.

**Two rules the edit path had to learn.** The past-start check would have made the past
unmaintainable - an event that has already happened has a start in the past by definition, so
fixing a typo in its description would have been refused on a field nobody touched. It now asks
whether the start *changed* rather than whether it is old. And `MeetupEditable` narrows what the
meetup composer needs to the fields it actually edits: the week row hands it a full `Meetup` and
the detail screen hands it a `MeetupDetail`, and those differ by a nudge clock the form never
reads. Asking for the union would have meant inventing `nudgeable: false` at one call site to
satisfy a type - a lie a later reader would have to disprove.

**The composer is reached by parameter rather than copied.** `?edit=<id>` on the screen that
already owns the form, for both events and meetups, so Edit is a link rather than a second copy of
a 200-line form on the detail screen.

### The bug the testing found

Deleting the probe event printed `The action 'GO_BACK' was not handled by any navigator`. That is
**failure mode 14** - never pop history unguarded, because it throws on every screen reached by a
direct link or a refresh - and it was reachable in five places: the pre-existing event delete, plus
the four returns the edit flows had just added. A notification deep link is exactly the case with
no history to pop, and these are notification destinations.

`useGoBack` already held the rule, but it takes its fallback at hook time and a screen that has
just deleted what it was showing only learns its club while rendering. So the rule became
`goBackOr(router, href)` and the hook a thin wrapper over it, rather than the two lines being
written a second time. Re-tested by navigating straight to a meetup with no history and deleting
it: it lands on the club, and the console error is gone.

Also worth recording: **a backtick inside a `sql` template comment broke the parse again**, in the
same afternoon it was recorded as failure mode 2.5.8 for the second time. Two SQL comments naming
`created_by` and `updated_by` in backticks ended the template literal. It fails loudly and costs a
minute, which is the only reason it is a footnote rather than a section.

---

## 2026-08-17 - A week you can read at a glance, a post you can edit, and an event that knows where it is

An afternoon of surfaces, driven from the founder's phone one screenshot at a time. Grouped here
because they were one sitting rather than because they are one feature.

### The news post grew a menu, and edit stopped being half-built

The post card carried a full-width **DELETE POST** strip along its bottom and, on tap, unfolded a
confirmation *inside* the card that reflowed the post under it. Both are gone: a "..." in the
card's top-right opens the same `ContextMenu` every other menu in the product uses, and the
confirmation is a raised `ConfirmDialog` over a dimmed feed.

**Edit was the interesting half, because it already existed.** `PATCH /news/:id` and
`contentApi.updateNews` had both shipped and **nothing in the UI called either** - failure mode 11
again, the same shape as the tagging bug found earlier the same day. Making it real meant the
composer opening pre-filled, and the awkward part is the gallery: a photo that arrives with a post
has a `mediaId` and no local file, because the phone chose the rectangle and the server cut the
pixels at upload. So `Slot.picked` became nullable, an existing photo draws from `RemoteImage`, and
**the shape selector locks while the post's own photos are present** - re-cropping works by
re-uploading the local original, which for those does not exist, so an unlocked selector would
leave old photos at the old ratio and crop new ones to the new one inside a carousel that draws
every photo in one frame. A control that is plainly unavailable beats one that appears to work and
produces a broken gallery.

Found while testing: an existing location was hidden behind a button reading **"Add a location"**.
The value was in state and would have survived a save, so nothing was at risk - but the form showed
no sign of a place the post obviously had.

Verified by no-op saving two real posts and diffing the database: title, aspect, location and its
URL, body, tags, **photo ids in order**, and both tagged people all byte-identical. Zero
notifications, because editing correctly tells nobody.

### The week became seven rows

`PRD/08` requires all seven days with "Nothing planned" spelled out, so the screen was seven
headers plus six such lines to show one meetup. The founder asked for the day letter in the badge;
that would have repeated the header directly above it, so the header went instead and **the badge
became the day marker**.

Three things earned their way in. **Two letters where one is ambiguous** - `M T W Th F S Su`, since
a single initial cannot tell Tuesday from Thursday at exactly the glance the badge exists for.
**Three badge weights** - today solid, a day with something accent-soft, an empty day sunken - so
the week's shape reads before a word does. And **the time left the circle**, which let it stop
being `430P`: that abbreviation existed only to fit 46 points.

Then three follow-ups that turned out to be one problem. The badge sat at the *top* of a day
holding two meetups, leaving the second hanging off nothing - *"you can see how disoriented it
is"*. **Centring the row fixes it for any count** and is one alignment rule rather than arithmetic;
with three meetups the letter lands beside the second, which is what was asked for, verified with a
temporary third row. Rules were added at two weights and two insets, days got vertical room, and
the letters went up a step in the type scale.

**A pre-existing nested-pressable bug surfaced while looking**: the bell had always been *inside*
the row's own `Pressable`. Invalid on web, and on native the nesting where the child takes the
responder and the ancestor's gesture never arrives (failure mode 17). The diff confirmed it was not
introduced by the redesign; it was fixed anyway, because the file was open.

### One field, two names, and a heading said twice

`ScreenHeading` carried its own `paddingHorizontal`, which is correct exactly once: on a screen
whose container has none. On the meetup screen, whose body already pads, the two added up and the
title sat at 32 while the accent time line, the card and the button below all sat at 16 - reported
as the title *"hanging from the left side to the center"*. **The gutter belongs to the screen**, so
it moved to the two call sites; polls was measured before and after to prove it had not shifted.

The meetup composer asked *"What are we doing?"* while the record answering it said *"Description"*,
a split `DESIGN/12` had argued for deliberately. The founder asked for one word, so both say
Description now and the spec records the reversal rather than being left describing a product that
no longer exists.

### An event learned where it is

Three asks on the event composer, and only one of them was cosmetic.

**The end time is gone from the form.** Two of the three validation rules there existed only to
police it - an end before the start, and an end half-filled - and both went with it. **The column
did not**: `ends_at` is nullable, older events still carry one, and `eventWhen` still renders a
range. A migration removing it would have destroyed entered data to tidy a form.

**A map link was added beside the location, not instead of it**, because the two answer different
questions: where in the club's own words, and what a phone can open. Migration `0037` adds one
column - `map_url`, and deliberately no `map_lat` / `map_lng`, because those exist on `meetups` for
a hand-placed pin and nothing places one on an event; `directionsUrl` opens the stored URL and only
falls back to coordinates when there is no link. Columns that would always be null are absent
rather than reserved. `isMapLink` is reused rather than re-derived - a second copy of a host
allowlist is the one that goes stale - and a link that is not a map is dropped rather than refused,
since the link is optional and a typo should not reject the event.

Proved in both directions at the route (a valid link stored, a `maps.google.com.evil.test`
lookalike stored as null) and in both directions on the screen: a link renders **Directions**, an
event without one renders no button at all. The screen probe was inserted directly rather than
created through the API, so the club's phones were not notified for a test.

Finally, the composer said "New event" in its header and "NEW EVENT" again as the first thing in
the body, in two different treatments. One title now, and it names the act: **Create event**. The
header is the copy that survived because it is the one carrying the way out.

Reported from the phone, a day after tagging shipped: *"I can't tag myself... I can see the person
who's posting in the tag"*. Both halves are one symptom seen from two sides. Everybody else could
name the author; the author could not name themselves.

**Reproduced before diagnosing, which mattered here.** Binghamton Running Club has nine members;
signed in as one of them, the picker offered eight. The missing row was the caller's own, and
another member's row was present in it - so the exclusion was of *the person asking*, not of
anybody in particular.

**Root cause: one condition on a query shared by four callers.** `searchMemberCandidates` carried
`AND u.id <> ${caller}` in its single SELECT. Three of its targets add somebody to a roster, where
that is obviously right. The fourth, added the previous day for naming people in a news post, is
not an add at all - and it inherited the rule silently. Naming who was somewhere is a different
question from who typed it up: an admin writes the recap of a run they ran.

Self-exclusion is now a property each branch states, so a fifth target is a compile error until
somebody chooses. `news` says no; the other three say yes.

**Two things fell out of checking the work, and the second is the useful one.**

First, the existing test had **encoded the defect rather than catching it**: `offers this club
members` asserted `['Member']` for a club of Owner and Member, so the author's absence was written
down as correct. That is failure mode 19's shape exactly - the same way two tests once asserted a
stranger *could* read a card - and it is why the fix had to change an assertion rather than only
add one.

Second, **a claim made confidently in a comment turned out to be false, and only a mutation test
found it.** The reasoning written down was that the Eboard is where per-target self-exclusion does
real work, since approving a request is a club-admin power and a club admin need not be on the
board. Inverting the new condition left that test green. `canApproveEboardRequest` is *defined as*
`isEboardMember`, so only somebody already in the space can search it and `already` subtracts them
regardless. The same holds for the other two: `isClubAdmin` implies a club row, and `canManageRace`
implies a roster row by ADR-0027.

So the original condition was **dead code on all three roster targets**, and its only live effect
anywhere in the product was breaking the fourth. The flag is kept anyway - that redundancy rests on
three separate implications, any of which a later decision could loosen - but both the module and
the test now say plainly that it is belt-and-braces and that the test pins behaviour rather than
mechanism. A check that cannot fail is worse than no check, so it must not claim to be one.

**The feature was half-built rather than wrong.** `never notifies the author for naming themselves`
was already passing: the write path stored a self-tag and `worker/audience.ts` already drops the
actor from every audience, so tagging yourself correctly buzzes nobody. Only the picker never
offered it. Nothing in the notification path needed changing.

Also worth recording: the first attempt put a backtick inside a SQL comment **inside a `sql`
template literal**, which ended the string and made every affected test fail to parse rather than
fail an assertion. `AGENTS.md` 2.5.8, the same hazard that took the founder's API down on
2026-08-15, reached this time through a comment rather than through code.

---

## 2026-08-17 - The DM header's menu stops being the odd one out, and no notice outstays its welcome

The founder sent two photographs side by side: the DM conversation's "..." menu, and the member
card's. The first was a full-width band of two-line rows wedged under the header; the second was
the popover this product uses everywhere else. The ask was style, not content - *"something
similar... not the exact stuff"*.

**The band was not styled badly, it was in the wrong place in the tree.** `styles.sheet` was a
plain `View` rendered in the layout flow, so it had no card, no radius, no elevation and no
scrim, and opening it pushed the conversation down to make room. Everything that made it look
wrong followed from that one fact, which is why no amount of adjusting its colours would have
fixed it. It is now `ContextMenu` from `src/ui.tsx` - the same component that drew the
photograph it was being compared to - anchored to the glyph by `measureRow`, exactly as the
member card does it.

**Three things fell out of the row shape, and only one of them was free.** A `ContextMenu` row is
an icon and a label, and the old rows carried a second explanatory line each.

- *Mute's* line said what the toast already said, so it cost nothing.
- *Close* went, because the scrim dismisses and `ContextMenu`'s own note argues a Cancel row in a
  short menu spends a fifth of its height on "never mind".
- *Block's* line was the only statement anywhere of what blocking does - and **Block was firing
  instantly from a menu tap, with no confirmation at all.** Deleting the sentence would have left
  a destructive, unconfirmed action with nothing explaining it. It became a confirmation instead,
  reusing word for word the dialog this same file already shows when it offers Block after a
  report. Two sentences about one action have no business differing by which control reached them.

That last one is a behaviour change rather than a restyle, and is recorded here as such.

**Then the toast, which turned out to be a bigger finding than the menu.** The founder's follow-up
was *"when muted just say muted and it should pop for just a couple seconds"*, then *"no message
should stay for a long time"* - and the second sentence is the real bug. Every notice on the chat
screen was a `Pressable` that stayed until somebody tapped it. Not the mute one: **all fifteen of
them**, including every upload failure and every refusal. A banner that outlives the thing it
describes stops being read at all, which costs you the one case it exists for.

**And it was not one screen.** Chasing the mute wording turned up **five** screens holding a
notice this way - chat, the member card, the DM profile, the photo viewer and the club share
screen - of which exactly none cleared themselves. So the timer became `useNotice` in
`src/use-notice.ts` rather than a `useEffect` copied five times, on this repo's own rule that the
second time you write something is when to extract it. It is a drop-in for the
`useState<string | null>(null)` all five already had.

The duration is **computed from the message's own length** rather than fixed. Not embellishment:
these notices run from `Muted` to *"That message was not sent. It contains language this app does
not allow. Edit it and try again."*, and one number cannot serve both. Short enough for the first
cuts the second off mid-sentence; long enough for the second leaves an acknowledgement up long
after anybody stopped looking. `min(2500 + 40 per character, 5000)` puts "Muted" at 2.7s and a
refusal at the 5s ceiling. Tapping still dismisses sooner.

**The hook carries a token, and that is not defensive coding.** Setting the *same* string twice is
not a state change, so the effect would not re-run and the second notice would inherit whatever
was left of the first one's timer - and a retried action produces an identical message by
definition, so the case is the common one rather than the exotic one. Bumping a counter on every
call makes each show its own event regardless of the text.

**Both mute controls now say the same word.** Muting one conversation was reachable from two
places that confirmed it differently: the chat header, and the member card's "...", which said
*"Muted. The unread count still counts."* That sentence was deliberate and its point was good -
mute is not "mark as read" - but a confirmation is read once, in the half-second after a tap
somebody already meant, and is not where a control gets explained. Two controls describing one
action in different words was the worse of the two problems. Both now say `Muted` / `Unmuted`.

A stale claim was corrected in the same pass: `member-card.tsx` asserted in a comment that
`dm/[channelId]/profile` "still carries" Mute and Clear chat. It does not and never has - that
screen's menu is Pin, Block and Delete chat, as its own file header says. The repo wins.

**Verified by measuring rather than by screenshotting.** The first two attempts to catch the
banner raced it - a screenshot two seconds after the click showed an empty screen, which is
equally consistent with "it cleared correctly" and "it never rendered", and taking the second one
as evidence would have been exactly the mistake `AGENTS.md` standing instruction 8 exists for.
Polling the DOM every 250ms answered it properly, on both surfaces: chat header `Muted` first
seen 252ms and gone by 2.76s, `Unmuted` gone by 3.0s; the member card `Muted` first seen 252ms and
gone by 2.76s - against a computed 2.7s. Every mute and unmute was proved against `channel_mutes`
rather than against the toast, and the dev database was returned to zero.

Worth recording because it nearly produced a false alarm: `SELECT count(*) FROM channel_mutes`
came back **2** after the cleanup, which read as leaked test state. Both rows belonged to smoke
accounts and were dated 2026-07-30 and 2026-08-15. The earlier checks had all been filtered by
channel and were right; the unfiltered one was the one that lied.

**The device pass was the half that mattered, and the founder did it.** Everything above was
measured on web, and web is precisely where this class hides: `ContextMenu` renders a real
`Modal`, and failure modes 28 and 29 are both about native modal behaviour a browser cannot show.
The structural risk was low - this menu hangs off a plain route with no `presentation` declared,
so it is not the modal-inside-a-modal shape that broke the member card on 2026-08-14 - but low is
not zero, and "the same construction worked elsewhere" is exactly the weaker claim `DESIGN/10`
already flags about the three actions added on 2026-08-15. The agent could not run it: the phone
was locked (`FBSOpenApplicationErrorDomain error 7`) when the pass was due. **Confirmed working on
the physical iPhone by the founder on 2026-08-17**, which is what allowed this to be committed.

**One inconsistency was sharpened rather than created.** `TODO.md` already carried an item about
the three chat overlays dimming three different ways. The DM menu now blurs and dims like the
message long-press menu; the *group* header's quick-nav dropdown, one glyph away in the same
header, still has a transparent `gridScrim` with no `backgroundColor`. Two menus in one header
that behave differently is a more visible version of the same open question, and the item was
updated to say so rather than ticked.

Meetups reached the calendar in the morning, which made them findable and immediately showed what
they lack: tapping one arrived at a place and a time and nothing else. The founder designed two
screens in Stitch and asked for them.

**The name is the important half, and it is not decoration.** In his words: *"it can be morning
book reading or swim practice night"*. A meetup identified only by its place reads as a running
club's fixture; one with a name belongs to a chess club, a choir or a reading group. That is the
same generalisation `ADR-0029` made when it deleted the per-club activity-type catalog, arriving
from the other side - free text rather than a taxonomy - and `TODO.md` already flags "Races and
Meets" as the next name with the same problem. It is optional, so a club that wants a place and a
time is unaffected and the location stays the headline.

**One thing in the design was refused, and that is the decision worth recording.** The mockup
carried "12 Attending" and an RSVP button. `PRD/00` lists *"RSVP or attendance, anywhere"* as a
deliberate non-goal, next to *"Weekly Meetups is a plan, not a checklist"*. Put to the founder
directly, he chose to leave it standing rather than reverse it from a picture. It can still be
reversed later, on use - which is how DMs were reversed, and the difference is evidence.

### The map, and why the point comes from a pasted link

A meetup's place is free text - "Bimini", "Vibing", "the wooden archway entrance" - and no
geocoder turns those into a coordinate. That killed every option that starts from an address. The
founder's own answer was the right one: *"the link will be pasted... from that you can take the
coordinates"*. A human has already found the spot on a map, and the link is the record of that. No
geocoder, no API key, and it handles the entrance to a park that has no address at all.

Three properties came out of building it, in ascending order of how easy each was to get wrong:

- **The client sends a link and never a coordinate.** The server reads the point out, so a phone
  cannot put a pin somewhere the link does not go and every client gets the same answer.
- **The Google Maps app shares a SHORT link** - `maps.app.goo.gl/XYZ` - which contains no
  coordinate, no place name and nothing else. That is the common case, not an edge one, so the
  server follows it.
- **The host allowlist is re-checked at every redirect hop**, not just on the pasted URL. A
  shortener's entire purpose is to point somewhere else, so checking only what was pasted checks
  the one hop that was never in doubt. With automatic following, a pasted short link would have
  been a way to make the server GET an arbitrary address and hand back what came out.

**A test caught the ordering bug, and it is the kind nothing on a screen would ever show.**
`resolveMapPoint` read the coordinate before checking the host, so
`maps.google.com.evil.test/?q=1,1` produced a perfectly good point - a parser is not a gatekeeper,
and `parseMapLink` will happily read a pair out of any query string. No fetch happened, so nothing
was exposed, but the URL would have been stored and put behind a Directions button that opens it.
The check moved above the parse.

### The native module, handled the way this app learned to

`react-native-maps`, which this SDK bundles a version of, on Apple Maps - so no API key, and no
raising the deployment target from 16.4, which `expo-maps` would have needed for iOS 17.

It is a native module, and this app has been taken down twice by exactly that. So the import is a
`require` inside the component rather than at the top of a file, which is the pattern `AGENTS.md`
failure mode 8 already prescribes for a module that is not on every platform - here the platform
that might not have it is **an older build of this same app**. It was verified in that state
before the rebuild: Metro built the whole bundle at 200 with `react-native-maps` not installed at
all, and the screen renders the place, the notes and Directions with no picture. Then the binary
was rebuilt and installed, and the map arrived.

### What else changed on the way

`ADR-0036` had said a meetup has no detail screen and is not getting one. That was correct while a
meetup was three facts a row could hold, and it stopped being correct hours later when it held
six. The ADR is amended rather than rewritten - what was believed on the way here is the useful
part - and the calendar's rows now open the meetup instead of the club's week, which removes the
one exception on that feed.

**A member can now open a meetup at all.** The week's rows were pressable only for admins, because
the only thing behind them was an admin menu. That was invisible as a gap for as long as there was
nothing to open.

**Then the device found the thing the tests could not.** "why is the map not visible" - and the
answer was an assumption baked into the tests themselves. The short-link follow was built against
a stub that redirected to `@lat,lng`, which is what a Google **dropped-pin** share produces. A
Google **"share a place"** share - the natural one, the one anybody actually taps - carries no
coordinates at all. Followed with three different user agents, every hop resolves to the same
thing: a place name and a feature id.

```
maps.google.com/maps?q=Appalachian+Dining+Hall+at+Mountainview,+Vestal,+NY+13850&ftid=0x89daef42...
```

So `parseMapLink` was right to return null; there is genuinely no point in it. Apple Maps shares,
Google dropped-pin shares and desktop URL-bar links all carry one and all worked from the start.
**This is the shape of a stub agreeing with you.** The test asserted the redirect chain resolves to
a coordinate, which is true of the link the test invented and false of the link a person sends.

Two rescues were tried and rejected before the one that works. **Geocoding the address Google
hands back**: OpenStreetMap finds "Vestal, NY 13850" and not "Appalachian Dining Hall", so the pin
would land on the town centre two kilometres away - a confidently wrong map, which is worse than no
map and is the exact failure this feature keeps guarding against. **Decoding the `ftid`**: its
first half is an S2 cell id and really does encode a position, but it is an undocumented identifier
and the decode is Hilbert-curve arithmetic that draws a plausible wrong pin if it is slightly off.
Not something a member should rely on to find where their club meets.

What shipped instead is the option that had been offered and declined an hour earlier, and which
now complements pasting rather than replacing it: **the admin taps the map to place the pin.**
Free, exact, works for a campus building no geocoder has heard of, and it needed nothing new -
`react-native-maps` was already installed. The link still drives Directions, so it stays the exact
record of the place; the tap is only about drawing it. The tap wins over the link when both exist,
because a link is a guess about where somebody meant and a tap is somebody saying it.

**And then the map came out.** The founder, an hour after the pin picker landed: *"I don't want the
map feature for now. Just keep it. Instead we can have the direction. If someone [pastes] the link,
then direction will pop up."* Which is right, and is the sort of thing only using it tells you: the
map was never the feature. Getting a member to the place was, and the pasted link does that on its
own - it opens the exact spot in Maps, including the ones no geocoder can resolve. The picture was a
nicety that turned out to cost either a hand-placed pin or a paid key to draw a place the button
already opened.

So a meetup with a link shows a Directions button and a meetup without one shows nothing -
deliberately not a text search on the location, because handing Maps "Bimini" sends somebody
wherever it guesses that means. `react-native-maps` stays installed, and `ADR-0037` is where that
is written down, since an unused native dependency is otherwise a future mystery: the pod and the
device rebuild are the expensive half, and keeping them means the map can return without another
install on every phone. The columns stay too, for one nullable pair.

Four hours, four positions on the same question - no map, a real map, a map plus a hand-placed pin,
and finally a button - and only the last one was decided with the thing in hand. Each turn was
cheap because the link was always the record and the picture was always the ornament.

1,366 tests with 29 new, typecheck, runtime, em dash and the constraint proof all clean. The
proof is where the coordinate pair is actually held: both halves or neither, and on the earth -
`map-link.ts` refusing an out-of-range pair is the kind refusal, not the only one.

## 2026-08-15 - A meetup becomes a calendar kind, and a rule gets overruled

Meetups were the only dated club activity invisible outside their own screen. Events, races and
Eboard meetings all reached the merged calendar feed; a meetup did not, so a member reading the
month had no way to see that the club meets on Tuesday, and no way to get from a day to it.

**That was not an oversight - it was a written rule, and the first work was reversing it.**
`PRD/08` rule 12: *"Meetups do not appear on the club calendar. A club meeting three times a week
would mark almost every square of the month grid, and the race everybody needs to see would stop
standing out."* `ADR-0029` carried the same line. The reasoning was sound and had never been
checked against a real club. It was checked before answering:

| | This month |
|---|---|
| Days carrying a meetup | 5 |
| Days carrying an event | 11 |
| Days carrying a race | 0 |

Five squares out of thirty-one, against eleven the grid was already marking. The dense recurring
club the rule imagined is not what a meetup turned out to be in practice. `ADR-0036` records the
reversal; the rule was replaced rather than deleted, and the ADR supersedes rather than edits, so
what was believed on the way here is still readable.

It also passes the test `ADR-0034` had set the day before, on that decision's own terms. That one
drew the line at things that **happen on a day** - a poll's closing deadline is not one, so polls
left the feed. A meetup is a club being somewhere at a time. It is the most literally-happening
thing on there.

**The interesting constraint was the clock.** `meetups` stores a DATE and a TIME rather than one
timestamp, on purpose: a club's week is local wall-clock, no club carries a timezone, and an
instant built from the two would move a Tuesday evening meetup to Monday for a member reading from
another country. So the feed carries the day in `at` with `allDay: true`, and the club's own
`HH:MM` beside it in a new `timeOfDay` - printed, never parsed.

Adding a field to `FeedItem` deserved the scrutiny it got, because `ADR-0034` had just finished
removing one. They are not the same kind of addition, and the difference is worth keeping:
`open?` was a **state**, and the upcoming rule, the sort and the row all branched on it, so four
kinds paid for one kind's shape. Nothing branches on `timeOfDay`. No predicate reads it, no access
check reads it, and the only ordering that consults it is between two meetups on one day.

**Adding the kind found a latent bug that no test would have.** The Upcoming/Past row formatted its
date with `item.kind === 'race' ? formatDateOnly : formatInstant` - branching on the kind where
`allDay` was the actual question. Those were the same thing for exactly as long as a race was the
only date-only kind on the feed, and a meetup would have been read as UTC midnight and printed a
day early west of Greenwich. That is the precise failure `allDay` was introduced to prevent, and it
had been quietly reintroduced one line at a time. The row branches on the flag now.

The grid needed no work at all, which is worth noticing: `readMonthMarkers` derives from the feed,
so a meetup on the feed is a marked day with no code saying so. That property was bought the day
before by deleting the poll skips, and it paid for itself immediately.

The founder chose full parity over a quieter marker or a popup-only appearance, and chose the
club's week on the current week as the tap target over a per-meetup screen. A meetup is the one
kind on the feed whose row does not open a screen about itself, because it does not have one - the
week is where a meetup is read, edited, removed and nudged from.

**Then the device answered within the hour, and the answer was a dead end.** A video: tap a meetup
under Friday 14 August, arrive at the club's week - correct club, correct week, "Week of
2026-08-10" - and the screen shows only Saturday 15 and Sunday 16. The thing that had just been
tapped was not on it.

`PRD/08` rule 2, doing exactly what it said: *"On the current week, only today and future days are
shown. The week is a plan, not a record. Paging back shows all seven days."* Sound on its own
terms, and it had never had to survive something pointing at it. **And it is the one case paging
cannot rescue**, which is what made it worth fixing rather than explaining: the 14th sits inside
the current week, so Previous jumps to the week before and steps over it. No sequence of taps
reached the meetup the calendar had just offered.

The week now returns all seven days with the past ones marked, and a past day carries no "Add a
meetup" row - the plan-not-a-record intent kept as a missing control rather than a missing day.
The founder also reversed the tap target he had chosen an hour earlier: a meetup opens the week
that holds it, not the week today falls in.

**And a rule turned out not to exist.** The founder's report opened with "meetups can only be
created current and future days", which is how the product behaves and is not a rule anywhere:
`createMeetup` accepts any date, and the repo's own nudge test creates one on 2020-05-04 to prove
a past meetup cannot be nudged. The restriction was entirely a consequence of the week hiding the
days an Add button would have appeared on - so removing the hiding left the rule resting on a
single client condition. Flagged rather than fixed, because refusing a past date is a decision
about the API rather than about this screen.

Two smaller things fell out. `isoPlusDays` existed only to answer "is this the current week" for
the hiding rule and had no other caller, so it went with it. And "This week is over. Page back to
see it." - the Sunday-evening message for when every day had been hidden - is now a sentence
nobody can reach.

1,337 tests with 7 new, typecheck, runtime and em dash clean. The server tests assert against the
exact characters that went in: `at` equal to `meetup_date` verbatim, `timeOfDay` equal to the
club's clock, two meetups on one day in time order, and every day of the current week returned
with `past` set by comparison rather than by omission.

## 2026-08-15 - The emoji picker walked to a category instead of going there

Reported from the phone with a video: "I just click the flag symbol in the down, like, flag
category. I just click that, but automatically, it start clicking every category, and then it
reaches it." The video is unambiguous - tap Flags, and the strip lights Smileys, then People, then
Animals, all the way down, while the list hops in stages behind it.

Nothing was clicking anything. **Two mechanisms compounded, and neither is in the tap handler.**

`jumpTo` called `scrollToIndex` on a heading row. A `FlatList` cannot answer where a row is until
it has rendered it, and the flags heading is two hundred rows below anything that had ever been
drawn - so `onScrollToIndexFailed` fired. That handler did what the documentation suggests: guess
an offset from `info.averageItemLength`, then retry a moment later. But an average is only useful
over one height, and this list has two - a 36 point heading and a 52 point emoji row. The guess
therefore landed somewhere in the middle, from where the target was STILL unmeasured, so it failed
again, guessed again, landed again.

Each landing rendered rows, which fired `onViewableItemsChanged`, whose job is to light the
category the reader is looking at. It was doing that faithfully. **The strip was not misbehaving;
it was accurately reporting a list that was walking down the screen in stages.** That is the part
worth keeping: the visible symptom was in the one piece of code that was completely correct.

The fix was to stop asking. Both heights are knowable - a heading from `type.label`'s explicit
`lineHeight` plus its two margin tokens, an emoji row as one seventh of the list's own measured
width - so the picker now keeps a running total of where every row starts and calls
`scrollToOffset` with a distance it computed itself. There is nothing to look up, so there is no
failure callback and no retry. `getItemLayout` hands the same table to the list, which is what
lets it render the destination window directly rather than filling in from wherever it was.

Three things that would have made the naive version drift, all of which cost nothing to get right
and would each have been invisible until somebody scrolled to the bottom:

- The row height is **rounded to a whole point**. A fraction of a point per row is nothing; two
  hundred and forty of them is a heading landing visibly off the top.
- The height moved off `aspectRatio` on the cells and onto the row explicitly, so the height the
  list is TOLD and the height the row TAKES are one number rather than two that agree by
  arithmetic. The short-row fix that `aspectRatio` was there for survives untouched, because the
  cells were always a fixed seventh of the width and still are.
- The heading height is measured from the first one drawn and replaces the constant if they
  differ, which they do the moment somebody raises the system font size: that scales the line and
  would otherwise push every offset below it out by a few points each.

## 2026-08-15 - The card learns three verbs, and a report finds a second noun

The member card shipped on 2026-08-14 carrying Message, Remove and Ban, with Mute, Clear chat and
Report listed as the next pass. Two of those turned out to be wiring and the third was not a
feature at all until a decision was made.

**Mute and Clear chat were already built, twice over.** `muteChannel`, `unmuteChannel` and
`clearChannel` have worked on every scope since 2026-08-06, with routes, predicates and a client
API; the chat header and the inbox row swipe both call them. What was missing was the one fact the
card could not have: **does a conversation with this person exist?** `openDm` is idempotent-create,
so a card that resolved the channel by asking to open one would bring a conversation into being as
a side effect of muting it - and an admin working down a roster would grow a DM thread per person
they checked. So the profile read grew a `dm` block that is present only when a thread is already
there, and `DESIGN/10` rule 5 does the rest: no thread, no rows, no "..." at all for a plain member
looking at a plain member.

**Report needed a decision before it needed code.** Every report in the product is keyed by
`message_id` - the primary key, the per-space tab, the DM queue, the audited context read, the
removal, the dismissal and `moderation_actions` all resolve through one - and the routing rule
selects a reader by *the reported message's channel scope*. A person report has no channel, so the
rule has nothing to route on.

The obvious answer was to mirror it: a card opened from a roster goes to that club's admins, one
opened from a DM goes to platform moderators. It fails on what the reporter is *told*. The
confirmation dialog has to say who will see this, and under that rule the answer changes depending
on which screen they tapped from - so somebody reporting the same person twice, once from each
place, sends it to two different sets of people and is never told that happened. **Person reports
therefore go to platform moderators, always** ([ADR-0035](SPEC/decisions/0035-a-person-is-reported-to-platform-moderators.md)),
which is what lets the dialog say it in one sentence. The cost is real and is written into the ADR:
a club admin cannot act on a report about their own member, and the answer is that Remove and Ban
are already on the same card.

`user_reports` is `message_reports` one noun over - PK `(reporter_id, subject_id)` carrying
"reporting twice is a no-op", both columns NOT NULL so no NULL is distinct, a check refusing a
self-report, and deliberately **no `club_id` even as a nullable column**, because one that could
only ever be null is an invitation to route on it later. There is no `moderation_reads`
counterpart: no message means no window to open and no read to log, which is exactly why the queue
carries the *count of reporters* instead - one person is an opinion, four is a pattern.

**Two things got extracted on the way, both because the next line of code would have been the
seventh copy.** `muted_until IS NULL OR muted_until > now()` had been hand-written in the DM thread
list, the channel meta read, the push audience, the race list and the chat list; the member card's
mute lookup would have been the sixth site and the seventh copy. It is `muteInForce` now. And
`platformModerators` came out of `channelModerationAudienceById`'s `dm` branch, because the person
audience needed the same set with no channel to ask it through. Both are failure mode 9's rule
applied before the fact rather than after it - every existing copy was individually correct, which
is the whole problem with that class.

`loadCandidate` was exported from the DM module for the same reason. `DmCandidate` is the argument
of every predicate that asks "can this person reach that one" and only one of those is about a DM;
the alternative was a third hand-written copy of the club-ids join.

**Verification, and what it did not cover.** 1,331 tests (27 new, all through the real HTTP stack),
four new constraint proofs, and the surface gate at 97 checks - eight of them refusals, including
the club Owner being handed a 404 by the person queue, which is ADR-0035 stated as a request rather
than as prose. On web: the menu with and without a conversation, Mute writing through and the menu
redrawing as Unmute from the server's answer, and Report through its confirmation to the row.
**Not run on the Simulator**, and `DESIGN/10` says so - the two new confirmations are `hosted` in
the card's own `overlay` exactly as the ban confirmation is, so rule 6 holds by construction, which
is a weaker claim than having watched it.

Three smaller things, each of which cost a few minutes and is the reason they are here.
`fileReport` carried a bare `onConflictDoNothing()`; the table has one unique constraint today,
which is precisely the state the car-group defect was in before somebody added the second. A
backtick inside a SQL template comment ended the string - in the one file whose *other* comment
warns about exactly that. And starting a server with `PORT=3100` instead of `API_PORT` produced
failure mode 15 on the first try: it read 3000 from `.env`, lost to a server another agent already
owned, and would have run the whole gate against somebody else's code if the log had not been read.

---

## 2026-08-15 - The crop frame can be grabbed, and shows what it will send

The crop shipped that morning cut exactly the right pixels and was reported back within the hour:
"I love the crop" was not the first sentence. The first was "it is not user friendly so hard the
crop it just runs or adjust weird". A feature that is correct and unusable, which is a specific and
awkward class: nothing failed, no test could have gone red, and a screenshot of a finished crop
looks the same whether it took one gesture or twenty.

**Three causes, none of them in the arithmetic that decides the rectangle.**

The first is the one worth remembering. The four corner handles were **children of the frame**,
positioned half outside it on negative offsets so they would straddle the corner. A view outside
its parent's bounds is not reliably hit-tested, so half of every target was never delivered a
touch, and what remained was a 22-point square exactly on the corner. It was worst in the state
every crop begins in: the frame opens on the whole picture, so all four corners sit against the
picture's edge, where the outward half of each target had nowhere to be. The handles looked
correct in a screenshot and were half absent to a finger.

The second: the resize refused the **entire** gesture whenever either side reached the 48-point
minimum (`if (width < MIN_SIZE || height < MIN_SIZE) return from`). Pulling a corner in too far
therefore stopped the frame dead on both axes under a moving finger, which reads as broken rather
than as strict. And a corner dragged past its opposite was normalised with `Math.abs`, which turns
the rectangle inside out and throws it across the picture - "it just runs".

The third: every frame of every drag re-rendered the whole compose screen, because the live
rectangle was the parent's state. The image, the caption bar, the mention list and the keyboard
avoider were all reconciled sixty times a second to move a one-pixel border.

**The fix moved the geometry rather than tuning the gestures.** Eight grips now instead of four -
the edges as well, because corners-only makes trimming one side a diagonal drag you have to hold
straight. Each is 44 points, shrinks with the frame so corners and edges always tile without
overlapping, and is **pushed inside the picture rather than trimmed at it**, which is what keeps a
full-size target in the opening state. Each axis clamps independently, so a side that runs out
pins at the minimum while the other keeps tracking. Corners cannot cross. The overlay became three
layers - shades, chrome, grips - with the first two `pointerEvents: none`, so what somebody grabs
is decided by one layer of nine invisible rectangles rather than by which decorated view happens
to be on top. The drag lives in the overlay and tells the parent once, on release. A second finger
landing re-baselines instead of teleporting the frame.

All of it went into `crop-rect.ts` beside the conversions, for the reason that module already
existed: a frame drawn perfectly can still be the wrong rectangle, and nothing on screen would say
so. The grip layout is now a property a test states out loud - no zone overlaps another, none
leaves the picture, a pinned axis still tracks, a corner never crosses.

**Then the founder asked for the obvious thing, which had been missing since the crop was built:**
show the cropped picture before sending it. Finishing a crop had changed nothing on screen. The
picture returned to its full self and a single word under it changed from "Crop" to "Cropped", so
the only account of what was about to be sent was that word - on a screen whose entire purpose is
to be a look at what is about to be sent. The cut happens on the server, so there is no cropped
file to draw; the stage instead became a window the shape of the region, with the whole picture
behind it scaled and offset so the chosen part fills it and `overflow: hidden` doing the cutting.
An untouched crop makes that window the whole picture, so there is one path rather than two. The
test that matters walks `toSourceRect`'s output - the rectangle the server is actually asked to
extract - back through the preview layout and lands on the window's own corners, so the preview
cannot drift from the crop while still looking plausible.

**A note for the next time a gesture "feels wrong".** Both defects survived a code review, a test
suite and a device test, because every symptom was a feeling and every unit of code was correct.
The rectangle was right, the conversions were tested, and nothing anywhere asserted on where a
handle could be *touched* - so there was nothing to fail. `AGENTS.md` failure mode 33 records the
class. Failure mode 32 was written in the same pass: it had been cited by the previous day's commit
message and by `DESIGN/11` and had never actually been written down, which is its own small lesson
about citing a number.

Also settled on the way past: `react-native-gesture-handler`, `react-native-reanimated` and
`react-native-worklets` are **already compiled into the installed binary**, arriving as transitive
dependencies of expo-router and appearing in no import and no `package.json` of ours. The rule this
screen earned the hard way twice - no native module for a gesture - is correct for a package that
is not in the binary and does not apply to those three. The crop stayed on `PanResponder` anyway,
because it is the house style and it is fast enough, but the option was ruled out for a reason that
turned out not to be true.

## 2026-08-15 - The calendar stops carrying things that do not happen

The founder asked for the Events Upcoming/Past list to hold only events and races. Polls were on
it; Eboard meetings were too, and were raised and kept - a meeting is dated club business, it
already marks a day on the grid, and dropping it from the list alone would have made the two views
disagree about what exists.

**The interesting part was how far the poll rows reached, and how few readers they had.** The grid
and the list are two views over one server read, and polls were excluded from the grid in two
separate places: `readMonthMarkers` on the server, and `bucketByDay` on the client. The day popup
renders from that same bucketing. So the Upcoming/Past list was the **only** surface in the product
that had ever displayed a poll from this feed - and taking it off that list left the whole `poll`
branch of the query with no consumer at all.

That turned a display filter into a deletion, which is the version worth having. One kind with no
day had been making every other kind pay for the possibility:

| The feed carried | Only because of polls |
|---|---|
| `at: string \| null` | An open-ended poll has no deadline |
| `open?: boolean` | Nothing else has an open/closed state |
| An `upcoming` rule branching on kind | A poll is upcoming while **open**; everything else compares a date |
| A sort with an undated tail | Somewhere for a deadline-less poll to land |
| A row with no date chip, and a vote glyph instead | A day chip would have said something untrue |
| Two grid skips, server and client | The grid never wanted them |

Six defences against a null that one of four sources could produce. Each was individually correct
and none named the others - the same shape as failure mode 9, one layer up: not a predicate copied
and drifted, but a single leak that four separate consumers had each learned to absorb locally.
`FeedItem.at` is now non-null, and the race branch's `race_date IS NOT NULL` is what holds it.

**PRD/07 rule 5 was struck through rather than deleted.** Its rules are cited by number and rule 10
is cited from two places, so removing a rule would have silently repointed both. ADR-0034 records
the decision and the rejected alternatives, the first of which was the one-line client filter.

Verified live rather than by test alone: against the founder's own club, which holds **34 polls, 18
of them deadline-less**, the running API returned 13 rows - 10 events and 3 races - on all three
windows, with no null date and no `open` field anywhere. Then the same club in the browser: Upcoming
showed 6 events and 3 races each with a date bib, Past showed 4 events most-recent-first, the string
"POLL" appeared nowhere on either, the grid marked the same 11 days as before, and a tapped day
still shows a time for an event and none for an all-day race.

1,299 tests. The two poll-shaped tests were inverted rather than deleted, because "a poll does not
reach the feed" is the assertion that fails against the old code.

> **A note on the session, not the change.** Three agents were working in this repo at once. The
> other two claimed migration `0031` and the whole photo-compose surface, which is why this change
> deliberately needed neither. Midway through verification the API died, and it was not this work:
> another agent had saved `channel-access.ts` with `` `platformModerators` `` written in backticks
> **inside a `sql` template literal**, which ends the literal early - the exact trap the comment in
> `domain/calendar.ts` warns about in as many words. Failure mode 22 says a watcher runs a
> half-finished edit; with more than one agent it also runs somebody else's.

---

## 2026-08-15 (last) - A photo gets a caption, and cropping goes to the server the hard way

The founder sent Instagram's send sheet and asked for the same thing with one tool instead of
three: a look at the photo, a crop, a caption, an X, a send arrow, in our orange. The caption half
was straightforward. The crop cost the whole night, and none of it was the crop.

**The caption was capability that already existed and had never been reachable.** The server has
accepted a `body` alongside a `media_id` since Phase 0; no interface had ever offered one, so every
photo ever sent went with an empty caption. The sheet also moved the upload from the picker to
Send, which is the part worth keeping: choosing a photo used to upload and post it in one breath,
so backing out cost a round trip and left an orphan object for the nightly sweep.

**Then cropping, three times.**

*The first attempt* added `expo-image-manipulator` and imported it at the top of the new screen.
Metro served that JS to the founder's phone within seconds; his binary was minutes older than the
module. A native import resolves at **bundle load**, so it did not break the crop - it took the
whole app down, on a screen he was not using. Moving the import inside the handler was not enough
either: the package calls `requireNativeModule` while it evaluates, and Metro reports module-init
failures to LogBox *before* the `catch` sees them, so a caught error still showed a red screen.
`requireOptionalNativeModule` from `expo-modules-core` answers the same question without loading
anything that can fail, which is how the tool came to be absent rather than present-and-failing.

*The second attempt* got further and died at launch on both the simulator and the phone, before a
line of JS ran, with no red screen and no console output - the app simply bounced to the home
screen. Deleting and reinstalling changed nothing, Metro was healthy and never received a request,
and the suite was green, because none of it was involved. The answer was in the crash report:
`Symbol not found: ExpoModulesCore.BaseModule.willDestroy()`, referenced from
`ExpoImageManipulator.framework`. `expo install` had fetched the newest patch, whose **prebuilt**
xcframework targets a newer core than this app ships. Pinning it back did not help, because the
prebuilt at the older version has the same requirement; disabling precompiled modules entirely
would have worked and makes every Expo module build from source.

Two lessons, both now in `AGENTS.md`: for a launch-time death read
`~/Library/Logs/DiagnosticReports/<App>-*.ips` **first** - a `Symbol not found` there is always a
native ABI mismatch and never your code, and I went to the network and the version numbers instead.
And installing a native dependency commits every running build to a rebuild, which is something to
say out loud before running the install rather than after somebody's app dies.

*The third attempt* removed the dependency instead of fixing it. The server has had `sharp` since
Phase 3 and `completeUpload` has decoded every uploaded image since Phase 0 to prove it is one - so
the phone sends a rectangle and the server extracts from a decode it was already doing. No native
module, no rebuild, and nothing in the feature can stop the app from launching. `TECH/07` had said
in as many words that the server "has no part in it and must not grow one"; that objection was
aimed at a server cropping on its own initiative, which is still refused, and not at executing a
rectangle the sender drew.

**And then the crop still did not work, for a reason that had nothing to do with any of it.** The
founder recorded it: the frame drew outside the photo, the shading around it vanished, and the full
uncropped picture posted. One cause for all three - the frame was stored in **display points**, and
the drawn size of the picture changes whenever the layout does. It does so on the very tap that
confirms the crop, because the crop footer is a different height from the caption bar, so the code
that reset the frame on a layout change was discarding the crop at the exact moment of applying it.
Storing fractions of the image instead makes the class unrepresentable: a fraction means the same
thing at every size, and there is no longer any code watching the layout. The geometry moved into
`crop-rect.ts` as pure functions with a test that asserts a frame names the same source pixels
after the picture is redrawn at another size - the test that fails against the old code, which is
why it is the one worth having.

1,286 tests, 16 of them new. The caption and its mentions are verified on the founder's phone; the
server crop is verified by test, including EXIF-rotated photos and out-of-bounds refusal.

---

## 2026-08-14 - The member card stops offering a door to itself

Three changes to the card the roster raises, and only the second was asked for directly.

**"View full profile" is gone.** It was the last row on the card, from when a card was a glance
and `/users/:id` was the whole record. The card outgrew that during its own build: the
shared-clubs block arrived, then Send message, then the admin menu, and by the end it carried
description, city, school, shared clubs, Message, Remove, Ban and Lift ban - every part of the
screen it was offering to open. Checked before cutting, because the row's own comment claimed it
led to "everything this card does not carry", and by then that set was empty. `/users/:id` is
untouched and still opens from a notification, a pasted link and a chat bubble's avatar.

**The "..." was inside the sheet's corner rather than inside the sheet.** Reported from the phone
as looking "unshaped". It sat at `top: 0, right: 0`, and the sheet's top corners are `radius.xl` -
so a 36pt disc was pinned entirely inside a 24pt arc, in the one place where the card's edge
curves away underneath it. Two rounded shapes with nothing between them read as one badly cut
shape, and the button appears to spill off a card whose edge is receding behind it. Inset by the
gutter on both axes.

**And a bug the founder's screenshot exposed without either of us looking for it.** The
shared-clubs block said "and these other **clubs**" from a fixed string whenever more than one was
shared, so sharing exactly two announced "clubs" about one. Underneath it the face stack sliced
from index 0, so the first face was the club the sentence had just named, and the `+N` chip
counted against the whole set rather than the remainder. The line, the faces and the count were
three different answers to the same question. The faces are now the others only, counted and
pluralised, and the stack is absent rather than empty when there are none.

Verified on the Simulator against real data: the card now reads "You're both in Binghamton Running
Club" and stops, because that viewer shares exactly one club.

**Four things were found in the same pass and deliberately not fixed**, all now in `TODO.md`: an
accent-tinted shape escaping the pinned strip's cards (reproducible - it travels with them when
the strip scrolls), a padlock on every roster row for anybody who is not an admin, three chat
overlays that dim the background three different ways, and a chat header that reads "ClubChat"
under every conversation name whenever the socket is healthy. The third is the one worth naming:
nothing is broken and the lighter treatment may well be right for a small anchored dropdown, but
the reasoning is not written down anywhere, which is the only reason it got raised at all.

---

## 2026-08-14 - A message can be corrected, and append-only turns out to have meant ordering

The founder asked for editing: long press a message sent within five minutes, tap a pencil, fix it.
The interesting part of the task was not building it - it is one column and one command - but that
the repo said twice, in writing, that it should not exist.

`SPEC/PRD/05` listed **"editing a sent message"** in the out-of-scope line, alongside threads and
read receipts. And `MessagePatch` in `client-core/src/store.ts` carried a stronger claim, as a
contract rather than a preference: *"an update must never be able to rewrite a message's body,
sender or seq. Those are the log, and the log is append-only."*

**Both turned out to be softer than they read, and for different reasons.**

The PRD entry was guilt by association. A thread is a second conversation the whole product would
have to bend around; a read receipt is a feature with a privacy argument attached. Correcting a
typo is neither, and every product ClubChat replaces already does it. The entry had been carried
forward from the first draft and never re-examined - the same shape as the DM reversal on 07-28 and
the quote-replies separation on 08-01, both of which are now recorded as dated notes in that file.
This one joins them.

The `MessagePatch` comment was more interesting, because it named three columns and only two of
them were load-bearing. **What append-only protects is the ORDERING.** `seq` is the address every
reply, quote and read cursor points at; `senderId` is attribution. Neither is reachable from an
edit, and neither ever will be. `body` was in that list by association too - and the giveaway was
sitting three lines below it, because `deletedAt` has been allowed to blank a body since Phase 0.
The line was never quite where the comment drew it. ADR-0033 records the reasoning; the comment now
names the two columns it actually means.

**The `rev` machinery did the hard half for free.** A correction changes a row *below* a connected
client's local max, which is precisely the class of change the revision counter was built for when
a tombstone reached only the clients that happened to be online. `editMessage` allocates a revision
in the same transaction as the update, exactly as `applySoftDelete` does, and a device that was
offline for the edit gets the new text and its "Edited" stamp together on its next sync. There was
nothing to design here, which is what a good abstraction looks like from the inside.

**Three decisions where the obvious answer was wrong.**

*An admin cannot edit.* `canDeleteMessage` grants the admin tier a second path - its sender **or**
an admin of that space - and mirroring that for editing is a one-word change that reads as
consistency. It is forgery. Deleting somebody's words is moderation and leaves a tombstone the
whole room can see; replacing them is indistinguishable from that member having said the new thing.
`edits.test.ts` asserts both halves in the same file, deliberately: the two predicates look like
they should agree, and a future refactor that unified them would pass every other test in the
suite.

*An announcement cannot be edited.* It has already pushed to every phone in the space, so a
correction would leave the lock screen and the conversation disagreeing with nothing able to
reconcile them. This one was not in the original ask and came out of asking what each message type
would mean.

*The window is enforced server-side and asked through one shared function.* `withinEditWindow`
lives in `packages/shared` and is called by the policy predicate **and** by the screen deciding
whether to draw the pencil. Two copies of `now - created < 300000` in two languages of the same
codebase is failure mode 9's exact shape, and the version that drifts is always the one nobody
tests. The client's copy is a courtesy so a member is not offered an action that is already
refused; the refusal is the fact.

**One defect found while writing it, and it was mine.** The first draft of `editMessage` resolved
mentions from a stub that returned an empty candidate list, which would have quietly made "notify a
newly added @mention" - the behaviour the founder had just chosen - never fire at all. The send
path takes its candidates from the composer and re-checks them; the edit now does the same, unioned
with whoever was already named so that fixing a typo elsewhere in the sentence does not drop an
untouched mention. The notification is computed as a **diff**: a name already there is not told
again, because a phone buzzing twice for one sentence is the failure that rule exists to prevent.

**Two smaller things the shape of the codebase caught.** Adding `editedAt` to `MessageEnvelope`
without a Zod default made the compiler list all eight construction sites, which is the reason the
`senderName` comment says to leave the default off - it worked exactly as advertised. And the
SQLite `patch` needed care that nothing else did: `body` is written by two different frames, a
tombstone nulls it and an edit replaces it, and both in one `SET` is a duplicate column assignment
SQLite refuses. They cannot arrive in one frame today; the ordering is written down anyway, with
the tombstone winning, because a deletion losing to text is a moderation hole rather than a
rendering bug.

Full suite green at 1,270 tests, 19 of them new.

---

## 2026-08-14 - The club chat learns to buzz, and a worker that was only pretending

The founder tested push the honest way: signed in as a second person on the web, joined a club his
phone was in, sent a message, and waited. Nothing arrived. "I'm pretty sure we tested those things,
and I don't know why it's not working or what broke."

**Nothing had broken, and that was the finding.** Outbox event 1736 was his test - `message.created`,
`"type": "text"`, no mentions - and it drained in 210ms having correctly scheduled no push at all.
`PRD/12` said so in as many words: *"In club, race and Eboard chat an ordinary message notifies
nobody: it is addressed to a room, and the room's unread count is the right granularity."* The
worker was one line implementing exactly that. Only three things could reach a phone from a
conversation: an announcement, a mention, and a DM.

The pipeline was provably alive the whole time. The single row in `push_deliveries` was event id
`6880`, which decodes as `1720 * 4 + slot 0` - the Nudge he had proved on the same device five
hours earlier. So the report was true, the code was right, and the product was wrong.

### The worker that looked alive

Two workers were running: a `--watch` one from the previous day, and a bare-`node` one started at
03:44. Killing "the stale duplicate" stopped the outbox dead, and the announcement sent to prove
push sat unprocessed for eighty seconds. **The `--watch` one was a husk** - the process existed and
`lsof` showed no TCP connections at all, so it held neither Postgres nor Redis. All the real
draining had been done by the bare one. A dead-but-resident Node process burns almost no CPU, so
`ps` shows a completely plausible row; the only reliable health check is an outbox row with
`processed_at` still NULL. Folded into the stale-dev-server note, because "the process is alive" had
been treated as evidence and is not.

### Reversing a decision that was written down three times

His answer to what the product should do was immediate: notify for club chat messages too. That is
ADR-0032, and it is worth being clear that the old behaviour was a *position* rather than an
oversight - argued in `PRD/12`, restated in `TECH/06`, and implemented deliberately. The reasoning
(a group message is addressed to a room, not a person) is coherent, and it is invisible to whoever
is holding the phone. Every product this replaces buzzes when somebody talks to your club.

Two choices were put to him rather than assumed. **Volume**: per message, like GroupMe, against a
coalescing alternative - he took per message, so thirty messages is thirty buzzes and the answer if
that ever stings is coalescing rather than silence. **Scope**: all three group scopes rather than
club only, so there is one rule instead of a difference nobody can see in the app.

`chat_message` is the twenty-second notification type and the second push-only one, joining
`dm_message` under ADR-0015's reasoning applied unchanged: it buzzes and **writes no row**, because
the inbox representation of unread chat is the computed per-channel row and a row per message is the
flood rule 8 rejects. Rule 8 itself is untouched - it governs the badge, which is still one per
channel. It took **slot 3**, which the key banding had been holding since the day the slots were
invented; adding a fourth kind really was a constant rather than a re-keying, which is what that
work bought.

Three details carry more weight than their size. **Which types buzz is a list, not a condition** -
`text`, `photo`, `document` - so the poll, event and meeting cards cannot ring a second time on top
of their own `poll_created` push, and a `system` line the worker wrote itself never buzzes at all.
**The group audience subtracts the mentioned**, so one message rings one phone once and the person
named gets the better of the two lines. And **the deep link carries no `seq`**, unlike an
announcement: this fires on every message, so by the time it is tapped the useful destination is the
first unread, not this one.

**A photo with no caption would have read "Alice: " on a lock screen** - a name, a colon and
nothing - since every renderer interpolates `preview` and a captionless photo has none. Fixed in the
worker rather than the renderer, so `renderNotification` stays pure over its params.

### What the tests said, and one that had to change

The existing mention test asserted the old world in a comment: *"An ordinary message notifies
nobody, so the owner gets nothing."* It now asserts what replaced it, and asserts the part that
actually matters - the mentioned member is pushed exactly **once**. Six new cases cover the buzz,
the absence of rows, the cursor, mute, the captionless photo and the silence of system lines. Full
suite green: 1017 server, 154 mobile, 40 shared, 36 client-core, plus the runtime-import and
em-dash gates.

Then it was proved on the device rather than in a test: an ordinary message through the real
gateway, `pushed: 1`, ledger row `7019 = 1754 * 4 + 3`, and zero notification rows written.

**A stale comment came out of it too.** The catalogue's header had said "The 19 types" since Phase 1
while the test beside it asserted 21. A number in prose next to a list that grows is a comment that
is wrong and cannot fail, so it now says where the real count is checked.

### "So push is all addressed, right?" - no, and the question was the useful part

Asked to confirm it was finished, and checking properly rather than answering from the work just
done, `dispatchPush` had five call sites and `writeNotifications` had eighteen. **Nine notification
types wrote a row and rang nothing**: the three join requests, both decisions on them, member added,
member removed, role changed, and a car group left without an Incharge. Fourteen call sites in all.

Nothing had ever said this was intended - `TECH/06` opens by calling push "a transport added to a
fan-out that is already specified", which reads as though every type in the catalogue arrives. The
sharpest one is the join request: `PRD/12` rule 4 goes out of its way to stop those clearing when
the inbox is merely opened, with the note that the founder had lost real ones, and yet nothing had
ever told anybody that one existed. You found out by opening the app.

**The fix is a pairing, not fourteen additions.** `notifyAndPush` writes the rows and schedules the
push in one call, because the reason this happened is that the two halves were separable and so
they got separated. What makes the class nasty is that the code which IS there is completely
correct: `writeNotifications(...)` is a well-formed, complete-looking call, there is no error to
raise and no test to fail, and the missing half was never written down anywhere to be checked
against. It is entry 19 seen from the other side, and it is now `AGENTS.md` failure mode 31.

**A fixture stopped being inert, which is the second lesson.** Three DM tests broke immediately -
`expected [ 'bob-phone', 'bob-phone' ] to deeply equal [ 'bob-phone' ]`. Their `setup()` builds the
club with `addMember`, which had always been silent; now it pushes, and because `dispatchPush`
resolves devices at evaluation time rather than at schedule time, the fixture's own buzz landed on
a phone registered afterwards and counted against the message under test. The fixture settles its
own effects now, the same call `setupClub` in the phase 1 tests had been making all along.

Proved live rather than only in tests: a role change through the real API pushed to the device
(`role_changed push dispatched`, `pushed: 1`, ledger row `7072`) and wrote its row, then the role
was put back the way it was found. 1021 server tests, three of them new and aimed squarely at the
buzz rather than the row, since the rows had been passing throughout.

## 2026-08-14 (later) - The roster stops navigating, and a person becomes a card

The founder sent a GroupMe recording and a mockup: tapping somebody in the member list should
raise their profile from the bottom edge over the dimmed list, "as similar effect like if we
reacting someone". The scope was cut mid-conversation to exactly that - club roster only, with the
DM entry point, Mute, Clear chat and Report explicitly left for a later pass.

**Two mismatches were worth naming before building.** The mockup was not the built screen -
`/users/:id` has a full-width "Send message" and offers **Ban**, not the mockup's "Remove from
club" - so it was read as a target rather than as something to tweak. And the DM profile screen's
own header comment rules out "Clear history" and "Report a concern" in as many words, which the
requested three-dot menu reverses; his call, and it now means the two menus differ until the DM
side catches up.

**The motion was extracted rather than copied.** `ReactorSheet` already had the split-animation
entrance and the war story behind it - `animationType="slide"` drags the scrim up with the panel,
which reached the device as "the shade going up and down" - so the durations, easings and the
measure-then-travel trick moved into `useRisingSheet`, and `RisingSheet` is that hook plus the
shell. Chat's sheet now takes its motion from the same place. The extraction was deliberately
shaped as a hook and not only a component: swapping the reactor's shell would have meant JSX
surgery across 115 lines of a 5,700-line file, and every intermediate save on that path is a red
screen on the phone in the founder's hand (failure modes 22 and 26).

Two guards went in with it. `close()` is once-only, because the scrim can be tapped twice inside
the exit and a caller handing down a fresh `onDismiss` re-fires the effect - either restarts the
animation from wherever it had got to. And the button whose rectangle anchors the menu is held in
a **ref, not state**: a `ref` callback that calls `setState` detaches with null and re-attaches on
every render, which is an infinite loop rather than a style preference.

`SharedClubsBlock` moved out of the profile screen into `member-card.tsx` and is imported back,
so the two surfaces cannot drift. It grew an optional `onOpen`: the full screen opens the list, the
card does not, because a panel opened from inside a panel is a stack somebody has to unwind.

### What the smoke test found that reading would not have

**"You're both in Binghamton Running Club and these other clubs" - about you and yourself.**
Tapping your own row opened a card whose shared-clubs block intersected your clubs with your own
and answered all of them. True on the full profile screen for as long as it has existed, and
invisible there because nobody navigates to their own profile from a roster; one tap from every
admin now. The block is absent on your own card.

**A banned row announced "Open profile, or long press for options" and opened nothing.** The label
was built from whether the row had actions, never from whether it had a destination -
`profileHref` answers null for a banned person, since they share no club with the viewer any more.
Pre-existing, and made worse by a card that would otherwise have looked like the thing that failed.

Both writes were proved against the database rather than against the screen: Remove left one
membership row where there had been two, Ban left a `club_bans` row plus a Banned section reading
"banned by Rita Owner", and the club chat carried the system message for each. The reactions sheet
was re-tested after the refactor, including the path where removing the last reaction closes it.

Verified on web only. The nested modals - menu over card, confirmation over card - are the part a
browser cannot vouch for, and that is written into the surface spec as unverified rather than
implied to be done.

### The device answered within the hour, and web had been lying

"Nothing is working on the screen other than the message button." The "..." opened nothing, the
club faces opened nothing, and there was a glitch where it "just stucks in between".

**One cause, not three.** Every control that failed opened a second overlay; the one that worked
navigated instead. **iOS presents one modal per view controller and refuses the second in
silence**, and the menu, the confirmation and the clubs list were each a `Modal` rendered as a
sibling of the card's own. Nothing throws and the state is correct - the view simply never
appears. react-native-web stacks modals happily, so the browser pass had shown all of it working;
this is failure mode 28's shape with a crueller twist, since web showed a working control rather
than a no-op. Both are now `AGENTS.md` failure mode 29.

The repair is structural: `RisingSheet` grew an `overlay` slot rendered inside its own modal, and
`ContextMenu` and `ConfirmDialog` grew a `hosted` mode that swaps their `Modal` wrapper for an
absolute-fill view. Window coordinates still line up because the host modal fills the screen -
which is the reason `ContextMenu` reached for a modal in the first place. The markup is shared
rather than forked, through two tiny host components, because two copies of an overlay diverge
and one of them is only ever seen on the platform nobody is looking at.

**The shared-clubs faces are tappable again**, which the first pass had removed on the reasoning
that a panel inside a panel is a stack to unwind. The block has looked pressable everywhere else
in the product since it shipped; that argument lost to the report.

**And the "stuck in between" was real, and it was ours.** The exit faded the shade in 140ms on a
quadratic and moved the panel in 160ms on a **cubic**, and a cubic-in curve barely moves for its
first half - so a third of the way through, the panel had travelled a quarter of its distance
with the dimming already gone. His video has the frame: the card halfway up a fully bright roster.
The panel now leaves on the gentler curve and the shade on the steeper, longer one, so the
dimming is the last thing on screen. Failure mode 30, and it applies to the reactions sheet too,
which has shared this exit since the morning.

### Verified on the Simulator, which turned out to be enough

Rather than hand him another broken build, the app was built for the Simulator and driven there:
deep link to the roster, tap a member, open the menu, open the clubs list, cancel a ban, then make
one - proved against the database, with the exit recorded and read frame by frame to confirm the
shade now outlives the panel. Two things worth keeping: `cliclick` only lands when the Simulator
is frontmost, which cost several "the tap did nothing" rounds; and a drag on a roster row is a
long press, which opened the destructive menu on a real club and was dismissed without touching it.

A sweep for the same trap elsewhere found none: `PhotoViewer` is an absolutely-positioned view
rather than a modal, so its confirmation is raised from a screen and is safe.

### Then two more from the phone, and the second one was not the emoji picker's fault yet

**"I want the old animation on that, slow as bitch."** The exit fix above had lengthened both
halves to 200/220ms when the defect was the *ordering*, not the clock - and the reactions sheet
shares that hook, so a sheet that had been fine for a day suddenly felt sluggish. Put back to
160ms for the panel and 170ms for the shade, which is the original speed with the curves swapped:
the panel now takes exactly as long as it always did and simply leaves before the shade does. The
lesson is worth more than the fix: **when an animation is wrong, move the easings before touching
the durations**, because duration is what everybody feels.

**"I want like whatsapp, i dont want the shade explicitly shown sliding."** The emoji picker
behind the reaction strip's "+" still opened with `Modal animationType="slide"` and carried
`rgba(0,0,0,0.4)` on the backdrop itself - so the dimming was part of the sliding view, and what
travelled up and down the screen was a grey block with a hard edge. This is the identical defect
the reactor sheet was fixed for on 2026-08-13, and the rule from that day had already been
promoted into `TECH/13` as an obligation on **every** bottom sheet. It was simply never applied to
a surface nobody re-read - a rule stated in three documents and implemented in two of the three
places it governs, which is failure mode 19's shape at the design layer.

The picker now uses `useRisingSheet` like everything else: dimming fades in place, only the panel
travels, and it is **faster than before** rather than slower, since the platform slide it replaced
runs about twice as long. Picking an emoji animates out too - the chosen character is held and
handed to the caller when the exit finishes, rather than the parent unmounting the panel
mid-screen. Verified on the Simulator, opening and closing, frame by frame.

That makes three sheets on one implementation, which is now the point: the obligation used to be a
paragraph and is now a function, so a new sheet that writes its own `Animated.timing` is a code
review away from being caught rather than a device report.

## 2026-08-14 - The composer, and three ways to get the keyboard wrong

The founder sent WhatsApp screenshots and a running commentary from his phone. Four things came
out of it, and the first three were quick.

**The newest message clears the bar.** It sat almost against the composer - "getting cut" - so the
inverted list's content padding grew at the visual bottom, which is `paddingTop` on an inverted
list and reads wrong every time.

**A wash of the accent instead of a panel colour**, over the blur the header already uses, so both
ends of the screen are made of the same material. Two dead ends first, both worth keeping: a
`backgroundColor` on the `BlurView` is invisible, because the blur material draws over its own
host's background; and an absolutely-positioned overlay inside it covers its own siblings on web,
where CSS paints positioned elements above static ones, while sitting behind them on native. The
tint is now the row's parent, which cannot have that argument with its children.

**The bar went lean.** One 36pt size for every control, the white disc-and-hairline around the
flanking glyphs gone, the field a pill rounded to its own height, and the permanent greyed-out
SEND slab replaced by an accent disc that exists only when there is something to send. The bar
also took the home indicator's space, which every other app's bar carries and ours did not.

### Then the keyboard, which took four rounds

**Round one: the conversation dropped slowly behind the departing keyboard.** Three causes, all
added by this session's earlier work: a `keyboardVisible` state that re-rendered the whole chat
screen on every keyboard event, a second `LayoutAnimation` on top of `KeyboardAvoidingView`'s, and
the bar changing height mid-animation. All three removed; the floor became constant and
`keyboardVerticalOffset` paid for it.

**Round two: a band of background between the bar and the keys.** `KeyboardAvoidingView` computes
its padding as `keyboardHeight + keyboardVerticalOffset`, so the offset that was meant to *remove*
the floor added a second one. Sign error, four lines of RN source away, now
[pitfall 24](SPEC/TECH/14-engineering-pitfalls.md).

**Round three: the rise was sluggish and RN offers no way to change it** - it animates for exactly
as long as the keyboard says, in both directions. So `KeyboardAvoider` replaced it: the same
mechanism, minus an `await` between the event and the state, plus a duration per direction, and
the state held inside the component so a keyboard event re-renders one `View` rather than a chat
screen.

**Round four, the one worth the entry: the fall must not be animated at all.** Copying RN's
mechanism without copying its asymmetry brought back round one's symptom, reported in the same
words. RN's hide path sets the padding and returns *before* configuring an animation, and that is
correct: the keyboard is drawn on top of the app, so on the way down it hides the space it is
vacating. Set the layout immediately and the keys leave to reveal a finished screen; animate it
and the content crawls down behind them. Now [pitfall 23](SPEC/TECH/14-engineering-pitfalls.md),
and stated in the file itself, because this was the second time in one night.

**What the rise still is not.** It animates the whole screen's layout, which is the mechanism
rather than the number - WhatsApp moves the conversation and the bar as a transform on the UI
thread and never resizes its list. Recorded here rather than done: it changes this screen's
geometry, and every step of it needs a device the agent cannot drive. The founder accepted the
current feel for tonight.

---

## 2026-08-14 - The "+" trades places with the keyboard

The attach menu opened above the composer, which pushed the composer up the screen and left the
keyboard sitting underneath it - two bands of the conversation gone for one action. The founder
sent a GroupMe recording of the arrangement he wanted: the panel takes the keyboard's own place,
and the "+" becomes a keyboard glyph, so the two are modes of one strip of screen rather than
things that stack.

The panel is therefore exactly the keyboard's height, which is **remembered from the last time the
keyboard appeared** rather than guessed: it is per device and per keyboard, so a constant is wrong
on most phones and wrong again the moment somebody installs a third-party keyboard. A constant
survives only as the fallback for the one press that can happen before the keyboard has ever been
seen in that session.

### Both heights were on screen at once, and it looked like the old code

Reported as "a split second render where it just pops above, like how it used to do, and then it's
going down... both are happening" - and the reading was right, though not about the old code, which
was already deleted. It was the two *heights*: the panel mounted the instant "+" was pressed, while
`KeyboardAvoidingView` was still padding the composer by a keyboard that had not been told to leave
yet. For the two or three frames before the keyboard began to travel, the composer carried both.

**The press no longer opens anything.** It dismisses the keyboard and sets a flag; the panel is
opened by `keyboardWillHide`, in the same commit that removes the keyboard's height. Closing is the
mirror: the glyph only focuses the field, and `keyboardWillShow` collapses the panel as the keyboard
arrives. Two cases still act immediately, and both are cases where no keyboard event is coming -
opening with the keyboard already down, and web, which has no software keyboard at all.

`KeyboardAvoidingView` animates its padding through `LayoutAnimation` using the duration and curve
the keyboard event carries, so the panel's height change borrows the same two values. One clock,
one curve, and the two halves of the swap cancel out exactly.

**Recognising the class**: two independently-correct pieces of code each own a bottom inset, and
neither is wrong on its own. It is only visible in the frames between them, which is why it was
found by watching a slowed recording rather than by reading either one.

### What could not be verified here

The simulator could not be driven: `osascript` was refused assistive access, so no taps. This is a
keyboard behaviour, so the browser can prove the states and the labels and nothing about the
timing - it was checked there for the open/close cycle and handed to the founder's device for the
frames, which is where the bug was reported from in the first place.

---

## 2026-08-14 - Who reacted, and a shade that travelled

The founder sent a GroupMe screenshot: chips across the top of a sheet, then a face and a name per
row with the emoji that person chose. We had the data for all of it already - the envelope carries
`userIds` per emoji, and `GET /channels/:id/messages/:seq/reactions` was already joining names and
pictures for the sheet behind the `+N` chip. What existed was the wrong shape: one row per *emoji*,
with its reactors' names joined by commas, which answers "who liked this" only by making you read a
sentence and does not answer "which Emma" at all.

So the unit became a person. Filter chips reuse `Tabs variant="chip"`, the rows reuse `Avatar`, and
ordering reuses `reactionSummary` - the same function the pill row sorts with, so the chips read in
the order the pills do rather than growing a second rule that could drift from the first.

**The sheet reads its counts from the live envelope and fetches only names.** Two sources, on
purpose: chips are correct the instant it opens, somebody else's reaction landing over the socket
appears in the open sheet, and removing your own redraws it the moment the store patches. Names are
the one thing the envelope must not carry, for the reason `readReactions` already gives - a name
under every emoji on every message in a page of history.

### Three corrections from the device, in one sitting

The founder was holding the phone with live reload on, so each of these arrived as a video or a
sentence while the previous one was still being written.

**Tap or hold.** The first build opened the sheet on a tap, which cost the one-tap "me too" on an
existing pill. The founder asked for the hold instead: tap still joins or leaves, hold opens the
list, which is the same tap-acts / hold-explains split the message bubble already uses. The `+N`
chip has no reaction of its own, so it stays a tap.

**The buzz.** A hold with no haptic is indistinguishable from a dead control until the sheet
arrives. `longPressFeedback()` fires before it is drawn, same as every other hold in the app.

**The shade that travelled.** `animationType="slide"` on a `Modal` translates the whole modal, and
the scrim is inside it - so the dimming arrived as a shaded band with a hard edge sweeping up the
conversation. Reported as "the shades going till top and to the bottom", with a second video of
GroupMe doing it properly. The modal now animates nothing: a scrim layer fades in place (160ms) and
the panel rises from below its own bottom edge (220ms), both on the native driver, and the exit
runs in reverse before the component unmounts rather than the shade vanishing in one frame. The
panel's height is measured because it hugs its content - a constant would make a three-person sheet
crawl and a thirty-person one snap - and it stays invisible for the one frame before the
measurement, the same trick the long-press menu uses one entry below.

**The emoji picker has the identical flaw** and was left alone deliberately, with the founder told
so: it is a sibling sheet built the same way, and the fix belongs in one shared component rather
than copied into the second place.

### Two things fixed on the way past

`reactionsForMessages` had no `ORDER BY`, so Postgres was free to return the same three reactors in
a different order on the next read. Invisible while the client only counted them; visible the
moment they became rows. Ordered oldest-first, with `user_id` breaking the tie.

The lookup "the message this piece of state names by `seq`" had been hand-written twice and was
about to be written a third time. Extracted, per failure mode 9: the second copy is where a rule
quietly stops applying.

### Verification

Typecheck, the full suite (1,207) and `check:runtime` green. The sheet itself was driven in a real
browser against real data - three accounts created through the API, joined through the invite
route, reacting through the reaction route, so the rows are joins that actually happened rather
than fixtures. Confirmed there: hold opens the sheet without toggling, tap toggles without opening
it, a chip filters to one emoji, and tapping your own row removes that reaction and updates the
count, the chip and the pill row underneath. The haptic is the one part a browser cannot show, and
it was left to the device rather than reported as checked.

---

## 2026-08-13 (end) - The menu opens where the message is

The last piece of the long-press work, deliberately left out of the compact-panels change so that
one could be seen on a device before this touched `MessageRow`.

The pressed row is measured **at the moment it is held**, never at layout - the list scrolls, so a
position captured when the row mounted is stale by the time anybody presses it. One ref serves both
branches because exactly one renders per row, and the selection happens inside the measurement
callback with a fallback: a menu that failed to open because a measurement did not come back would
be far worse than a menu that opens in the middle of the screen. The web dots go through the same
path, so they anchor too.

Placing it needs the group's height, which is not known until it has drawn. It renders invisible
for that one frame rather than drawing centred and then jumping - imperceptible one way, obviously
broken the other. The message lands on the anchor, which is why the reaction bar's height is a
stated constant: the message sits one bar plus one gap below the group's top, and that is
arithmetic rather than a second layout pass.

Then clamped into the safe area, which is the half worth testing. Verified both ways on the
simulator: a message in the upper half opens with its menu directly beneath it, and one near the
composer pushes the whole group up so Delete stays on screen instead of running off the bottom.

### Maestro was offered on a false premise

It was described as a one-command install that would let the simulator be driven by visible text
rather than screen coordinates. It needs a Java runtime, and this machine has none - so the real
cost is a JDK plus Maestro, not one command. Raised rather than installed: the founder approved
what was described, and what was described was wrong.

---

## 2026-08-13 (last, again) - Any emoji, from a table

Reactions were six emoji in a constant. They are the whole catalog now: 1,914 rows seeded from a
pinned `emojibase-data`, with `message_reactions` and `news_reactions` holding foreign keys into
it. [ADR-0028](SPEC/decisions/0028-reactions-come-from-a-catalog-table.md) has the reasoning, and
the short version is that the table IS the validator - "the emoji is a real emoji" is an invariant,
and an invariant belongs in a constraint because a handler races and a constraint does not.

**Three of the five costs `PRD/05` recorded against a full picker dissolved rather than being
managed.** The set is closeable because the catalog closes it. Validation stopped being a hard
Unicode problem - there is no need to decide whether a string is an emoji, only whether it is one
of ours. And normalisation stopped being a correctness issue, which was not academic: our stored
thumbs up is U+1F44D and the dataset's is U+1F44D U+FE0F, so a naive foreign key would have refused
every existing one, and a client sending the dataset's form would have made a second pill with a
count of one beside the old. Checked against both tables before a line of the migration was
written. The migration normalises before it constrains, spells its own ordering out because drizzle
generated the version that fails, and stops rather than deleting anything it cannot match.

Ordering moved to the client, which it had to: the server used to iterate the fixed six, ordering
the list AND silently dropping anything outside it. `reactionSummary` sorts by count with the
catalog breaking ties, four pills show, and a `+N` chip opens a sheet naming everyone. That sheet
takes names as a lookup beside the set rather than a name under each emoji, so somebody who used
four emoji appears once and the sheet can be ordered by the same function the row is.

### What the device found that nothing else would have

Three things, all reported from the phone within minutes of each other, and all invisible to the
suite:

**A single emoji in a full-width square.** Cells were `flex: 1` with `aspectRatio: 1`. With eight
per row it looks perfect; with ONE recent emoji that cell takes the whole row and becomes as tall
as the screen is wide. Searching "dino" put two dinosaurs at opposite ends of an enormous gap. A
fixed fraction fixes it, and the lesson is that a flexible cell is only tested by a partial row.

**A category strip that was navigation competing with content.** First version used emoji as the
category buttons, which puts a row of colourful glyphs under a grid of colourful glyphs. The
founder pointed at the system keyboard: monochrome line icons, a clock for recents, a circle under
the active one. Monochrome recedes, which is what a control under a wall of emoji has to do.

**Ten buttons that did not fit.** Lifting the strip clear of the home indicator meant bigger
padding, ten buttons came to 400pt on a 402pt phone, and the flag fell off the edge. The padding is
now bounded by that arithmetic rather than by taste, with `hitSlop` buying back the touch area.

Also seven emoji per row rather than eight, founder-set - it is the number that decides how big
each emoji is, since a cell is one seventh of the sheet.

---

## 2026-08-13 (last) - A card that is only the poll, and an anchor that fought a jump

Two loose ends, and a regression found while closing them.

**The creator's Close and Delete came off the poll card.** They were two filled buttons at its
foot - accent and danger - which made a member's own poll the loudest object in the conversation,
under content that is deliberately quiet grey bars. They are in the hold menu now, beside Reply
and Pin: the same gesture that reports somebody else's card manages your own. `PRD/11` rule 11 had
said all along that the creator's actions are reached another way; it named a "View Poll" link,
because neither the eye nor the hold sheet existed when it was written. The rule now describes
what there is.

The wiring is the interesting part. The sheet knows a `seq` and nothing else, so whether to offer
Close cannot be answered from the message - it needs `isCreator`, which lives on the poll. It
loads the poll on demand while the sheet is open rather than every card publishing its state up
into a screen with no other reason to know what a poll is. And the card has to notice: it now
re-reads on the session `revision`, which `chat-provider` documents as "the door for the things
the socket does not [raise]", with `notifyChanged` called after the write lands rather than beside
it. A side effect worth having: a tally now moves when **somebody else** votes, where before it
only moved when you did.

The poll question stays at 17pt on its own screen. Card and screen share one body so they cannot
drift, and the founder chose to keep that over a larger question.

### The regression: "again for the image reply something is broken"

Tapping a reply's photo to reach the original had been fixed hours earlier and had stopped working.
Cause: `maintainVisibleContentPosition`, added the same afternoon to stop the list lurching. It
anchors the visible cell and compensates when content around it resizes - so `scrollToIndex` lands
the jump, the cells around the target settle, and the anchor moves the offset straight back.

**And the reason it got through is worth more than the fix.** I verified the anchor in a browser.
`maintainVisibleContentPosition` does not exist in react-native-web *at all* - one `grep` of the
web runtime says so - so that check could not have shown the fix working and could not have shown
the regression either. It was a no-op in both directions, and I reported a green result from a page
where the change had not happened. Failure mode 28.

The anchor is now suspended while a jump is in flight, `jumpedTo` being exactly that condition and
already self-clearing.

### Which is why the simulator now gets used

Written as unverified, because it is device-only by construction and saying so beats a second green
check measuring nothing. The founder's answer was to offer the iOS Simulator - and it closes
exactly this hole, because it runs the real native runtime.

Verified there within the hour: tapping a reply's thumbnail jumped from the 12:15 message to the
quoted photo, landing it mid-screen as `viewPosition: 0.5` intends. The same session also confirmed
on a real device runtime what the browser could only suggest - the quote's minimum width holds, the
author line sits above each message, photos carry no frame, and a photo uploaded before today is
still sideways, which is the un-backfilled state described honestly rather than a surprise.

**The working split, recorded because it is a standing decision rather than today's tactic:** web
for iteration and diagnosis - instant reload, computed styles, targeting by accessibility label,
which is what solved the quote-width bug by forcing a width onto a wrapper - and **the simulator
before claiming anything native works.** Two gotchas worth the minutes they cost: a click on an
unfocused macOS window is spent focusing it and reads exactly like a tap that missed, and
`DELETE ACCOUNT` sits about thirty points under `Sign out` on a profile screen holding real test
data, so switching accounts that way is not worth the aim.

---

## 2026-08-13 (later) - The picture says how big it is, and which way up

Closing the gap the morning's work left open: nothing on the wire said how tall a photo was, so
every client downloaded the bytes to find out and every photo resized itself on screen after it
had already appeared. Two client mitigations were in place - the list anchors its visible position,
and each aspect is remembered for the session - and a third would have been a bad sign. The
information was already being computed and thrown away: `probeImage` decodes every upload at
complete, and `metadata()` is right there.

**Then the obvious question turned up a shipped defect.** Storing dimensions means deciding whose
dimensions, and a camera does not rotate pixels - it writes them in sensor order and adds an EXIF
tag saying which way up the result goes. `deriveVariants` never applied that tag, and the WebP it
writes cannot carry one. Measured before touching anything: a 400x300 original tagged orientation
6 derived as **200x150 with no orientation at all**, where it should be 200x267. So a portrait
photograph from a phone was being flattened into landscape pixels, permanently, with the tag that
would have explained them discarded - which is the sideways photo sitting in the founder's own
screenshot from earlier in the day, and which I had read past as a photo taken that way.

The two are one fact and are asserted together: a stored dimension that disagrees with the derived
pixels is worse than no dimension. `.rotate()` before `.resize()`, because `width` in `VARIANTS`
means the width of the picture as somebody sees it; `displayDimensions` swaps the header's numbers
for the quarter-turn orientations; and both were mutation-tested, each mutation failing exactly its
own test and nothing else.

Proved end to end against the running stack rather than only in the suite: a 900x600 JPEG tagged
orientation 6, uploaded through the real client, stored as **600x900**, derived as a **600x900**
WebP, and drawn portrait at full size on the first frame.

**The founder then asked whether profile pictures were covered, saying he had seen it there too.**
They are, and the reasoning is that neither `completeUpload` nor `deriveVariants` branches on kind,
owner type or bucket - but "by construction" is exactly what I had said about the quote's jump
target earlier the same day, and that was wrong. So it is asserted instead: an avatar takes a
different branch of `createUploadIntent`, a different owner type and the public bucket, and its own
test uploads one tagged orientation 6 and checks both the recorded dimensions and the **`thumb`**
variant, which is the one every avatar in the product is actually drawn from. Mutation-tested with
the rest.

While there, every render site was enumerated rather than assumed: chat, news, both viewers and the
four profile screens draw `display`; the avatar component, the gallery grid and the reply-quote
thumbnail draw `thumb`. Nothing on screen draws the original, which is why correcting derivation
corrects the whole product. The one `original` caller is save-to-Photos, where the untouched bytes
keep their EXIF tag and the operating system turns the picture.

Deliberately not backfilled. Anything already derived keeps its variants, so a photo uploaded
before today stays exactly as it was rather than silently changing under people; re-deriving is a
decision with a re-encoding cost, and it is logged in `PRD/17` as one.

---

## 2026-08-13 - Three cards that claimed to be one, and a date that was tomorrow

A mockup of the chat screen with an event card and a poll card in it. The cards were already
built, so this looked like a styling pass. It was mostly a de-duplication, and it turned up a
wrong date on the calendar on the way in.

### The bug found before writing any of it

The mockup's event card opens with a day-over-month chip, so the first question was where the day
comes from. `bibParts` - and its one existing caller passed `FeedItem.at` straight in, a field
whose own docstring says **"an ISO instant, or a date-only `YYYY-MM-DD` when `allDay`. Never parse
it without checking which - that is the whole point of the flag beside it."**

The two cases need opposite handling and look identical at the call site. `bibParts` sliced the
first ten characters off and built a local date from the components, which is right for a bare
date and takes the **UTC** day for an instant. So every event from early evening onwards was
chipped with tomorrow's date, on the calendar feed, for everybody west of Greenwich - which is
everybody testing this. Measured on the founder's machine at UTC-4: a 23:30 event on the 12th
chipped as the 13th.

The flag is now a **required** parameter rather than a default, so a caller has to say which of
the two it holds, and the test asserts both directions with an hour that puts UTC on a different
day each way - so the pair discriminates in any zone rather than only in the tester's. Proved
live afterwards: a 9:30 PM event on 15 August now reads 15 AUG on the feed and on its card.

Worth noting the shape, because it is a new one for this log. Not a rule copied and drifted
(failure mode 9), and not a rule with no implementation (failure mode 19) - here the correct rule
was **written down in the exact place the caller would have to read to make the call**, and the
call was made anyway. A docstring is not a check.

### What the mockup actually asked for

Four things, and only the first is a style:

1. Both cards get a white surface, a hairline outline, an accent uppercase eyebrow naming the kind,
   a body-bold title and one quiet meta line. The event card gains a filled date chip.
2. **The poll's option row becomes the bar.** A track holding a proportional fill, the label
   sitting on the fill, the count at its right - rather than a label line with a separate 6pt
   progress bar underneath it. Two objects became one.
3. **The cards come out of the bubble.** They had been drawn inside their creator's bubble at 82%
   width with an avatar beside them. Full width now, no avatar, no bubble - the same treatment the
   announcement card already had, and for the same reason: a poll is put to the room rather than
   said to it. Attribution moved into the meta line, which is where the mockup puts it.
4. The founder's one addition to the mockup: **keep the eye.** The mockup has no per-option voter
   control and `PRD/11` rule 5 requires one.

### The de-duplication underneath it

Three cards, written to one sketch and maintained apart. The poll card outlined itself in
`divider`, the event card in `divider`, the poll *list* card in `hairline`; the event and meeting
cards ended in a full-width accent pill and the poll card did not; the meeting card's module
opened by calling itself "the event card's twin". Nothing was wrong enough to report, which is how
three copies of one surface stay subtly different forever.

They now share `content-card.tsx` and a design spec, [`DESIGN/05`](SPEC/DESIGN/05-content-card.md).
The twinning is a fact rather than an intention.

**Two rules of the new surface are worth citing rather than restating.** The card is *either* the
link *or* it holds controls, never both - which is why dropping VIEW EVENT was not a simplification
but the resolution of a latent nesting bug, and why `PRD/07` rule 10 was rewritten rather than
honoured. And selection changes a colour and never a height: the option border is always present
and track-coloured, and the tick that used to prefix a chosen label is gone because it shifted the
text as it appeared.

### Three things that had to be carried by hand

- **The label sits on the fill, and on web the fill would have covered it.** An absolutely
  positioned sibling paints above a static one in CSS regardless of source order. `zIndex` on the
  content, and the browser smoke test is what would have caught it - the same shape as failure
  mode 6, invisible to every automated check.
- **Taking cards out of the bubble takes everything the bubble was carrying for them.** The long
  press that opens the react-and-report sheet, the dots that stand in for it on web, the pin
  marker, the jump highlight and the reaction row all had to move into the card branch. Promoted
  into [`TECH/08`](SPEC/TECH/08-client-architecture.md) as a numbered rule, because a per-surface
  design file is not where somebody adding a per-message feature will look.
- **The eye had to get inside the row without becoming a button in a button.** It is absolutely
  positioned in a gutter at the row's right end, a sibling of the vote target rather than a child,
  and the gutter is reserved on every row of a poll that shows voters at all - reserving per row
  steps the counts in and out as options cross their first vote.

### The detail screen was the odd one out

`PollBody` is shared by the card and the poll's own screen specifically so the two cannot disagree,
and they disagreed anyway: the card had a per-option eye and the screen had a single "See who
voted" button that opened the sheet on whichever option happened to be first. `PRD/11` rule 5 asks
for a control on the option. The screen now takes the same `onSeeVoters` the card does.

### Verified live

Typecheck, 1,151 tests, the em-dash check and `check:runtime` all green, then the web client with
Postgres, Redis, the API, the gateway and the worker running:

- An event created from chat's "+" posting a card whose chip reads **15 AUG** for a 9:30 PM event -
  the date fix, end to end.
- A poll created from chat's "+", voted in place: the fill appears, the ring marks the vote, the
  count increments, and the label stays readable on top of the fill in a browser.
- **The eye opens the voter list and casts nothing** - the count behind the sheet still read 1.
- Closing the poll from the card: the eyebrow mutes, the CLOSED chip appears, the fills grey, and
  the ring on the voted option survives in the softer tone.
- The event card pressing through to its screen with no VIEW EVENT button, and the poll's screen
  reached by direct URL entry.
- **Zero console errors and no nested-`<button>` warning**, which is the check that matters for a
  card holding controls.

### A photo, with nothing around it

A reference of another app's photo message next to a photograph of ours, and the ask was "without
any boundry shades and nice and small". Ours had **three** rectangles around one picture: the
bubble's peach fill, the padding inside it, and a grey matte the image was letterboxed onto.

The matte was the interesting one. `photoFrame` was a fixed 220 square filled with `color.fallback`
and the image drawn `contain` inside it - so every photo that was not square arrived with two grey
bands, and the comment above it explained that `contain` was chosen because "cropping somebody's
photo to fit a bubble hides the part they were pointing at". That reasoning was right and its
conclusion was wrong: the answer to a photo not fitting the box is not to pad it, it is to stop
having a box. The frame is now the image's own shape, measured from the image, and `cover` is safe
because there is nothing left to crop.

**Sizing the LONG edge rather than the width**, so a portrait and a landscape take comparable room
and a tall photo cannot dominate the log. And the bubble is dropped entirely for a photo sent
without a caption - with a caption it stays, because the words need a surface.

**`onLoad` was the first attempt and it silently did nothing on web.** Its `nativeEvent.source` is
a native-only shape, so the handler ran, found no dimensions, and left every photo square - failure
mode 12's class exactly, a check against a field the library does not return. `Image.getSize` is
the cross-platform call, and its own failure path leaves the ratio unknown, which falls back to
`contain` in a square rather than cropping.

### "For the last 50 messages it is smooth, and as we reach poll event pics it is bugging"

A second recording, and the founder's own sentence is the diagnosis. It is not the age of the data
and it is not that club - it is **what kind of rows live back there**.

The recent tail is plain text: measured once at layout, never changes again. Older history is where
the cards and the photos are, and **every one of those changes height after it has already been
laid out**. A poll card draws the message's fallback sentence, fetches the poll, and becomes three
hundred points of options. A photo draws a square and then becomes its true shape, because nothing
on the wire says how tall a picture is - `media_objects` stores a mime type, a byte count and its
variant keys, and no dimensions. Each of those resizes shifts everything after it, and the list
moves under the finger. Frame by frame the recording shows the same poll and the same photo
appearing, vanishing and reappearing at different offsets.

Two fixes, at different levels.

**`maintainVisibleContentPosition={{ minIndexForVisible: 0 }}` on the list**, which anchors the
first visible cell so a layout change above it pushes content the other way instead of moving the
viewport. This is the general answer and it stays regardless of what else is done: without it, any
asynchronous height anywhere in a scrollback is felt by whoever is reading.

**A module-level memory of each photo's aspect**, keyed by media id. A list unmounts the cells that
scroll out of view, so a photo was re-measuring and re-resizing every single time it came back -
one jump per photo per pass, in both directions. It now resizes at most once ever, and a photo
already seen opens at its final size. Keyed by id rather than by url on purpose: the signed url
rotates hourly, so a url key would miss on exactly the reappearances this exists to cover.

The honest remaining gap: a photo nobody has seen still corrects itself once, because the server
cannot say how tall it is. Storing dimensions on `media_objects` when the worker derives the
variants would remove the last of it, and is the right fix rather than a further client trick.

### "Do you know the glitch there, is it because the messages are old?"

A screen recording, and no - nothing to do with the age of the messages, or with the day's layout
work either. A reply quote could not widen the bubble it sits in, so a short reply produced a quote
squeezed to the width of its own body text and the quoted name wrapped a word at a time:
"Par... / Parks / RP...".

**Two hypotheses were checked and both were wrong**, which is the part worth recording, because
either would have been a plausible thing to "fix". The message row had become a column earlier the
same day, so the obvious suspect was the cross-axis measurement that change introduced - flipping
`flexDirection` back to `row` on the live DOM produced an identical 79pt column. The second was
that moving the sender's name out of the bubble wrapper had removed the widest thing propping the
bubble open - re-inserting a name of the right width into the old position also changed nothing.
The weakness predates all of it.

What it actually is: both Texts in the quote carry `numberOfLines`, which react-native-web
implements as `overflow: hidden` plus `max-width: 100%`, and a subtree of those contributes no
intrinsic width to an auto-sized ancestor. Established by forcing a definite width onto the
wrapper in the browser, which expanded the column from 79 to 221 - that is what identified sizing
rather than styling as the cause. `flex: 1` on the text column made it worse for the same reason
(`flex: 1` is `flexBasis: 0`, the column declaring its natural width to be nothing); it is now
`flexGrow`/`flexShrink` with an `auto` basis.

The fix is a minimum width on the quote, since it cannot push its own container. Stated with the
relationship it has to keep - under the bubble's own 82% cap on the narrowest phone this targets -
rather than as a bare number.

**The lesson is about the diagnosis, not the bug.** Three explanations were available and the
convincing one was wrong twice; each was ruled out in about a minute by manipulating the running
page rather than by reasoning about flexbox. `AGENTS.md` rule 4 says reproduce before fixing, and
this is the same instinct one level in: measure before explaining.

### Bigger, and a quote whose picture did nothing

Two follow-ups on the photo work, from a GroupMe screenshot placed next to ours.

**The size rule was wrong in a way the first version hid.** Capping the LONG edge gives a portrait
its width from its *height*, so a 3:4 photo came out 150 wide where a landscape got the full 200 -
consistently smaller for exactly the orientation people photograph in. GroupMe gives a portrait the
same width as anything else and lets it be tall. Width leads now, at 240, with a height cap at 320
so a panorama cannot run down the screen.

The arithmetic moved into `photo-size.ts` **because its test could not import it**: vitest cannot
parse React Native's own sources, so anything reaching `react-native` is untestable, which is why
every tested module in this app (`dates`, `mentions`, `chat-rows`) is a plain `.ts` beside the
component. The test earns its place on one case - a photo tall enough to hit the height cap has to
give width back, and leaving the width at its maximum renders the right height in the wrong shape,
which reads as "a bit narrow" rather than as a bug.

**And the reported one: "the reply for chat is perfect... but picture is not doing it."** Exactly
right. `QuotedMessage` hung `onJump` on two `Text` nodes - the sender's name and the preview label
- and the thumbnail beside them, which is the biggest thing in the quote and the obvious target,
had no handler at all. Reproduced in the browser by walking the DOM up from the thumbnail: its
nearest interactive ancestor was the *bubble's* own button, whose press handler is undefined on a
text message, so the tap landed on something that did nothing.

The whole quote is one `Pressable` now, and `link` rather than `button` on purpose - it sits inside
the bubble's pressable, which react-native-web renders as a real `<button>`, so a button here would
be failure mode 17. A link is what the two Texts already declared, which makes this one interactive
element where there were two rather than a new kind of nesting.

**The class is worth naming: a gesture attached to the labels of an object rather than to the
object.** It works, it tests fine by tapping the words, and it fails only for whoever aims at the
picture - which is everybody.

### Two red screens on the founder's phone, both mine

Worth writing down because the rule against them was written earlier the same day and I broke it
twice anyway, in the direction it did not name. `ReferenceError: authorName is not defined`, from
deleting a prop from a signature while a use of it survived lower in the file. `ReferenceError:
PHOTO_LONG_EDGE is not defined`, from extracting a constant and placing it *below* the
`StyleSheet.create` that reads it - which runs at module load, so that one blanked the whole app
rather than one component.

Failure mode 26 said "a declaration and its first use go in ONE write", which is about **adding**
things. Both of these were removals and extractions. It now states an ordering instead: declare
then use, remove every use then the declaration, and extract upward - each of which keeps the file
runnable at every save. Found by reading the Metro log rather than by being told, which is the
other half of the lesson.

### And then every message got the same treatment

Having asked for the author row on cards, the founder asked for it on ordinary messages too - and
for the avatar to come out of the column it had lived in since v1. Three passes, because the first
description under-determined it and I built the wrong thing twice before asking:

1. **Avatar and name together, above the content.** Straightforward.
2. **"The profile should be hanging, and then the name should start from the box."** The avatar
   hangs in the gutter and the box is inset to line up with the name above it - so the face is
   outside the column the conversation is read down.
3. **"The left corner"** turned out not to mean own messages too. Pinning the line left above a
   right-aligned bubble leaves the name introducing nothing across a gap of empty space; asked,
   and the answer was that the line follows its bubble and **mirrors** when it does - avatar on
   the right, name inboard of it. Which is what the third pass built.

Worth recording that I asked rather than picked. Two readings of "the left corner" were live -
every face in one column, or every name against its own box - and they produce different-looking
products. The screenshot of the wrong one was what made the question answerable in a sentence.

`AuthorLine` is one component for messages and cards, which it had to become: the two were written
separately in the morning and had **already** disagreed about the name's colour by the afternoon -
the card's copy was `textSecondary` against the message's `textPrimary`, which is precisely what
the founder noticed and reported. One component, one colour, and `TECH/08` now says so.

Two things went with the avatar when it left its column, and both are the kind that survive a
layout change and quietly break it. `messageRow` stopped being a horizontal flex, so its
`flexWrap` - which existed only to push the reaction pills off the avatar-and-bubble line - went
too, and `alignItems` had to be stated in **both** directions, because the default `stretch` pulls
every bubble out to its 82% maximum and makes a one-word message as wide as a paragraph. And the
reaction row's `paddingLeft: AVATAR_SIZE + space.sm`, which had lined it up past the avatar, now
had to become an inset on the sender's own side - left it alone and it would have shoved every
received message's reactions 48pt off the bubble they belong to.

### And attribution went back above the card

Cards left the bubble in the morning and took their author line into the card's own meta with them.
By the afternoon the founder wanted it introduced the way a message is: the avatar and the name
side by side above the card, the card below, and **the name out of the card entirely** - all three
kinds.

Worth recording as a correction rather than a preference, because the version that shipped first
was defensible and still wrong. Attribution in a meta line reads as a property of the object -
"this poll's creator is Coach Dana", filed alongside its deadline and its vote count. Attribution
above it reads as an act: Coach Dana put this here. A conversation is a list of acts, so a card
that files its author among its metadata is quietly claiming to be a document instead of a
message.

The detail screens are untouched. They have no author row, so the event's screen still says "Added
by" - which is the same rule, not an exception to it: said once, wherever there is a place to say
it. `DESIGN/05` rule 4 now states it that way, having previously stated the opposite.

### Then a second reference: the poll composer

Two photographs of another app's New poll screen, with "in our theme and font small and spacious".
Four things in it were decisions rather than styling, and the founder settled them:

- **The deadline becomes a moment, not a duration.** This reverses an earlier call of his own -
  relative chips over an absolute picker had been "a decision confirmed with the founder before it
  was designed". The reversal is recorded in `PRD/11` rule 8 rather than quietly applied.
- **"Private vote" stays as it is**, rather than flipping to the reference's "Public poll". The
  labels are opposites, so adopting the reference's wording would have inverted the default and
  made every poll created without touching the switch private, where today it is public. A wording
  change that silently changes what unattended polls do is not a wording change.
- **Create moves into the header**, with the close control becoming an X.
- **The kit gets extracted now, applied to the other composers later.**

**The wire did not change, and that was the constraint worth keeping.** The server still takes
`closesInMinutes` and computes the instant, because a device-computed `closesAt` makes the deadline
depend on the handset agreeing with the server - v1's bug, where a phone an hour fast created a
poll that closed an hour early. So the screen asks for a moment and converts it back to a duration
at the moment of sending. Skew now costs a wall-clock offset rather than a truncated poll, which is
the better failure. Measured: a poll set for 10:15 was stored at 10:15:15, the whole-minute
rounding, well inside the wheel's own five-minute granularity.

**One defect found by looking at it.** Opening the picker left the row reading "No deadline" while
the wheel underneath highlighted tomorrow at ten - the control contradicting its own value, which
would have been reported as "it will not save the time". Opening now commits the default it is
showing, and the way back out is the clear beneath the wheel.

**The wheel is tappable as well as scrollable, deliberately.** Snapping is scroll behaviour, and
scroll behaviour is the thing that differs most between iOS, Android and a browser - so selection
does not depend on it. Every row is a button; the snapping is what makes it feel like a wheel.
Written up as [`DESIGN/06`](SPEC/DESIGN/06-composer.md) with the padding rule that makes the first
and last item reachable, since getting that wrong presents as "it will not go to today".

Verified live in the browser: the wheel selecting by tap and dragging its column to the band, the
row and the wheel agreeing, Create enabling only on a valid form, and the poll landing in Postgres
with `closes_at` at the picked minute and reading back on its chat card as "closes Sun, Aug 16,
10:15 AM".

### Then the founder picked up the phone: "i couldnt long press the event"

Everything above was verified in a browser, and a browser is exactly where this one cannot appear.

The chat row wraps every card in a pressable to catch the react-and-report hold. That works for a
poll card, which is a plain `View` with non-pressable space to grab. The event and meeting cards
**are** pressables - so on native they take the touch responder, and the wrapper's `onLongPress`
is unreachable at every point on the card.

**Not a regression from the redesign.** The old event card was a `Pressable` inside the bubble's
`Pressable` in exactly the same way, which is checkable in one line of `git show`: holding an
event card has never done anything on a device. The redesign only moved the wrapper.

Fixed by giving the handler to the element that can actually receive it - `ContentCard` takes an
`onLongPress` and puts it on the same pressable as the tap, and the row passes one handler to both
itself and the two navigating cards. Recorded as failure mode 27, because the interesting part is
how quiet it is: nothing is nested illegally, nothing throws, no warning appears, and web is clean
because web deliberately never attaches the gesture. It is the inverse of failure mode 17 - there
the nesting is invalid and loud, here it is valid and silent - and only a hand on a phone finds it.

---

## 2026-08-12 (last) - A code you can hold up, and one you can point at

A mockup of the share screen, and it turned out to contain a feature, a correctness bug and three
instances of the same mistake.

### What the mockup actually asked for

It merged two screens into one. Share club had listed rows - Copy Link, Share QR code, Share to -
with the code a tap further in, on the reasoning that a code "wants the whole screen". It does, so
it became the screen and the rows became two pills under it. `qr.tsx` is gone.

The thing that made the split look right is the thing that killed it: somebody sharing a club in a
room is not choosing between three ways to do it, they are holding up a phone. The rows put a menu
in front of the only action that case needs.

**One of the two pills said "Scan", and there was no scanner in the product.** That is a feature
rather than a restyle - camera permission, a native module, a rebuild - and it is the half the code
had always been missing: until now a club could be *shown* and not accepted, which made the code
useful in a message and useless in the room it was designed for.

The scanner **joins by handing its token to `/join/[token]`** rather than redeeming anything
itself. That screen is "the only invite path there is" and already answers all five outcomes -
joined, requested, banned, revoked, signed-out-and-back. A scanner calling `redeemInvite` directly
would be a second join path starting out missing four of them. **Scanning is a new way to acquire a
link, never a second way to redeem one**, so a ban and the two link tiers behave identically
however the link arrived.

### The caption that was accurate and still wrong

The mockup captioned the code: *"Anyone who scans this joins the club straight away, even if it
normally asks people to request."*

True of an **admin's** link. A false promise to every member of a `request` club, which is exactly
what ADR-0025 exists to prevent - and the screen deliberately cannot tell the two tiers apart,
since the server sends one token chosen by tier and `DESIGN/04` says the screen must not choose.

So the server gained a field saying what *this viewer's* link does, derived from `isAdmin ||
policy === 'open'` in one place, with two tests. The caption became accurate for both tiers.

**Then the founder saw it and removed it, and his reason was better than the engineering.** The
sentence was correct and it read as a **warning**: "even if it normally asks people to request"
names an exception to a rule the reader had not been thinking about, on a surface whose entire job
is to be held out to another person. It invites somebody to wonder whether they are doing something
they should not.

The field went with it rather than being left as an answer nothing reads. What survived is a test,
rewritten to assert the **behaviour** instead of the field: the same route hands two tiers two
different tokens, and redeeming a member's queues somebody while an admin's walks them in. That is
ADR-0025 itself, and it is worth pinning whether or not a screen mentions it.

**Worth keeping: a field can be right, tested, and still be the wrong thing to have built.** The
whole exchange cost an hour and the product is better for the deletion.

### Three bugs, one mistake

Static chrome put behind a data fetch, three times in one screen:

- **The title flipped colour.** Set inside the `DataScreen` branch, so it drew accent and turned
  ink the moment the club arrived.
- **The share icon appeared about a second late**, for the same reason, which reads as the app
  still deciding what the page is.
- Both were fixed in the wrong order: the title moved to the route in `_layout`, and the icon was
  left behind until the founder asked why it popped in.

**The rule that would have prevented all three: anything not depending on loaded data belongs on
the route, not in the data branch.** The icon now renders on the first frame, dimmed, and its
*action* is what waits - which is a far smaller lie than appearing late, and it holds its place so
nothing shifts when the club lands.

### The logo that was costing the code its legibility

The founder asked for the club's picture out of the middle of the code, since its face already sits
above it. Removing it did more than tidy: **the logo was what forced error-correction level `H`**,
which tolerates 30% damage so a picture can sit over the middle - and buys that by spending modules
on redundancy. With nothing to survive, the level follows the logo and drops to `M`, so the same
link is drawn in **fewer, larger modules**. That is the whole game when somebody reads a code off a
phone across a table.

Also fixed: the crest was drawn *behind* the card. It looked like a spacing bug and was a paint
order one - later siblings paint on top in React Native, and the card is pulled up under the crest
by a negative margin. It carries `zIndex` **and** `elevation`, because those are two platforms'
answers to one question and setting only the first is right on the phone in your hand and wrong on
the one nobody has run.

### Alongside, and not mine

The conversation bubbles changed in the same working tree: the sent bubble's Energetic-Orange-to-
rust gradient became two light fills with dark text throughout, founder-specified. `bubbleSent` is
deliberately a hair off `accentSoft` rather than reusing it, so that tuning a bubble later cannot
silently repaint the tab pill, an unread notification row and a voted poll option.

### Verified

1185 tests, typecheck, runtime parse, em-dash lint. `NSCameraUsageDescription` in `Info.plist`,
**BUILD SUCCEEDED** with the camera linked, installed and launched on the physical iPhone, and the
founder confirmed the screen and the scanner working on the device. The parser that turns a scanned
string into a token has seven tests of its own, most of them about **refusal** - a scanner points at
the world, and the world is mostly wifi codes and menus.

One of those tests was written expecting the wrong answer: it asserted that
`https://example.com/how-to-join/club` yielded `club` and documented it as an accepted false
positive. It does not - `/join/` is matched literally, so `-join/` is not a join path. The test is
kept in its corrected form because the near miss is worth pinning: a later "simplification" to
`join\/` would reintroduce it and nothing else would notice.

---

## 2026-08-12 (close, again) - The phone can finally say what killed it

`PRD/17` listed error monitoring as release-blocking and it was closed for the server on
2026-08-03, with the row saying plainly what was left: *the mobile client is not covered; a JS
crash on the phone still reaches nobody*. That stayed true through every defect this project found
on a device, and almost all of them were found the same way - the founder was holding the phone and
said something looked wrong. This closes it.

`@sentry/react-native`, a `monitoring.ts` shaped exactly like the server's, `Sentry.wrap` on the
root layout for render crashes, and `capture` on three failures that were previously a console line
nobody was attached to.

### Two things that would have led me wrong, and one that did

**`expo install` pinned 7.11, not npm's 8.22.** The docs and the registry both say 8.x is current;
Expo SDK 57's compatibility table says otherwise, and it is the one that matters. Non-negotiable 1
exists for exactly this, and the trap here is subtler than "read the docs" - the docs were read,
and they described a version this project may not use. Same shape as the TypeScript 6 pin in
`AGENTS.md` 5.1: npm `latest` is not this repo's latest.

**Web support needed checking rather than assuming**, because a platform-only module at module
scope has taken this app's entire web bundle down twice (`TECH/14` pitfall, and again with
`expo-media-library`). It turns out `@sentry/react-native` handles `react-native-web` itself since
SDK 5.16, so no guard was needed - but that was established before writing the import, not after.

**And then the web bundle broke anyway.** `UnableToResolveError: ./tracing/spanstatus.js` from a
nested `@sentry/core`. The obvious readings were a Metro resolver gap or a version conflict, and
the obvious fixes - patch `metro.config.js`, or platform-guard the import - would both have been
changes to working code.

**The file was on disk. I checked.** Metro had been running since before the install, so its file
map had never seen the new packages. A restart with `--clear` was the whole answer. The general
form is this repo's oldest hazard wearing new clothes: **a long-lived dev process serving a stale
view of the world**, which `AGENTS.md` failure mode 15 records as reporting your new work as
broken. Here it reported a dependency as broken instead, which is the same lie one layer out. The
tell was the same one that always works: the thing it says is missing, is not missing.

### What reports, and what deliberately does not

Three sites, each a real defect signal:

- **`chat.foregroundReconcile`** - the most valuable line in the client. Pitfall 25 is this
  project's dangerous class: a phone that backgrounds and resumes can permanently miss messages
  with no error and no indication. This reconcile *is* the cure, and on 2026-08-12 we learned the
  cure had never once run on iOS. A cure that fails silently is the original bug with extra steps.
- **`chat.authRejected`** - the 2026-08-09 defect that signed a member out holding a token the API
  was answering `200` for.
- **`cache.openFailed`** - SQLite falling back to memory, which costs a whole session of offline
  chat and says nothing.

**A failed initial connect and a failed badge read are deliberately NOT reported.** This app is
built to work offline, so both fire constantly and normally, and wiring them would bury the three
above. That is ADR-0018's argument about `parked > 0`: a signal that is rare by construction is
worth alerting on, and one that fires in ordinary use trains people to ignore the channel.

### The warning that would have taught people to ignore warnings

First working version returned early from `initMonitoring` when no DSN was set, which left
`Sentry.wrap` holding an uninitialised client and warned `App Start Span could not be finished` on
**every launch**. Benign, and exactly the kind of line that sits above a real one until nobody reads
either. `enabled` now carries the on/off inside `Sentry.init` rather than an early return - which is
also the honest reading of the module's own second property: development runs the production path
with the transport switched off, rather than a different path that has never run.

### The smoke test found a bug in the reporter, which is what smoke tests are for

With a `clubchat-mobile` project created and its DSN in `.env`, a deliberate `capture` at startup
proved the whole path: the event arrived as `CLUBCHAT-MOBILE-1`, tagged `development`, `handled:
yes`, iPhone 15 Pro, release 1.0.0.

It also **put a full-screen Console Error overlay on the founder's phone at launch**, and that was
mine. `capture` wrote its local copy with `console.error`, and React Native's LogBox turns a
`console.error` into a red screen in development.

The bug is worth more than the fix. **The module's first stated property is that reporting never
changes behaviour**, and the implementation broke it in the worst available place: `capture` is
called from paths that are already degraded and deliberately carrying on - a failed reconcile, a
cache falling back to memory - so a handled failure the app was designed to survive would have
covered the screen with something to dismiss. `console.warn` now; severity belongs to Sentry, which
still receives a real `captureException`.

**The sequencing is the lesson.** The smoke test existed only to prove the pipeline, and it is the
reason this was found on a launch nobody minded interrupting rather than during a genuine failure -
which is precisely when an overlay does the most damage and is hardest to attribute. A step whose
only purpose is to check that the new thing works will find defects in the new thing.

### Verified

1177 tests, typecheck, runtime parse, em-dash lint. The web bundle rebuilt and served (2,766
modules), the native module linked through `pod install`, the app launched on the physical iPhone,
and an error made the trip to Sentry and back to a human reading it.

The verify run before the last one **failed**, and it is recorded because the temptation was to
re-run and move on: `phase3-media` timed out waiting for a Postgres container port, which is
`PRD/17` debt 15 - one container per test file against a hardcoded ten-second ceiling, with three
other builds competing for Docker at the time. Re-run alone it passed in 3.22s, then the full suite
passed clean. `AGENTS.md` standing instruction 6 forbids working around a flake by re-running until
it passes, and the thing that made this safe to call environmental rather than a regression is that
the change touches only `apps/mobile` while `phase3-media` is a server media suite that cannot see
it. The same entry records two confident misdiagnoses of this exact timeout.

**Still owed: source maps.** The org and project slugs are now configured on the Expo plugin
(`clubchat-ef` / `clubchat-mobile`); only an auth token is missing, and until it exists a production
stack trace is minified.

---

## 2026-08-12 (close) - You run the races you are in

The founder described the race model plainly, and it was not the one in the spec: an admin outside
a race can see it, read its Meet Information and ask to join, and **cannot change any detail,
manage the roster, or write in it**. Authority comes from being in the race.

What that reverses is the most-cited rule in the document. `PRD/02` called the authority-versus-
access split "the most-misunderstood part of the model, and it is deliberate"; `isRaceManager` and
`isRaceMember` were named differently precisely so the distinction could not be collapsed by
accident, and collapsing it was recorded as having been wrong in five separate places in v1.

### The rule was already inconsistent with itself

The argument that settled it was not "the founder said so". **A race join request is sent to the
admins on that race's roster and to nobody else** - narrowed deliberately on 2026-08-05, because an
owner running none of the club's races was being paged about every one of them. So the permission
was strictly wider than the notification: an off-roster admin could approve a request that nothing
had told them about, while the roster's own admins were the only people who knew it existed. Two
halves describing different sets of people, and one of them had to be wrong.

The change makes them the same set.

### One definition moved seventeen call sites

`isRaceManager` went from `isClubAdmin(race.clubId)` to `isRaceMember && isClubAdmin`, and that was
the whole server change - every route already went through the policy module. This is the thing
ADR-0002 was written for, and it is the first time the payoff has been this visible: seventeen
places changed behaviour and none of them was edited.

### Two things the change surfaced that nobody asked about

**Creating a race had no predicate at all.** `createRace` asked `isClubAdmin` inline, and the
permission matrix modelled its "Create a race" row with `canManageRace` - which had just become
roster-gated. Left alone, the matrix would have started asserting that **nobody can create a race**,
against code that still worked perfectly. It is `canCreateRace` now, taking a **club** id, because
a race that does not exist has no roster to be on. Failure mode 19's shape: a capability the spec
names in its own matrix row, with nothing to grep for.

**`canReadRaceRoster` could not stay written as `isRaceMember || isRaceManager`.** Once the second
term implies the first, that union collapses to `isRaceMember` and every off-roster admin silently
loses the roster - the one thing the founder had explicitly said they keep. It spells `isClubAdmin`
out now. Note the shape, because it is failure mode 10 arrived at from the other end: not an alias
that hides a capability, but **a union that becomes an alias when one of its arms moves under the
other**. Nothing fails; a predicate just quietly starts answering a narrower question.

### The tests inverted rather than being deleted

Nine assertions flipped, and the block named `authority is not access` became `you run the races
you are in`. Two of them were the interesting ones:

- The **property test** used to assert that every authority-gated capability was *allowed* to an
  admin off the roster. It now asserts the opposite for those four, and a second test pins what an
  off-roster admin still keeps - see, read Meet Information, read the roster, request, create, pin -
  so "roster-gate everything" cannot pass either. A rule that only ever denies is the easy half.
- The **HTTP-level test** attempts each management route as an off-roster admin and watches it 404.
  The matrix proves the predicate; this proves every route asks it.

### The client defect was the exact opposite of the one predicted

The server change shipped with a recorded follow-up: *the app still offers manage controls that now
answer 404*. That prediction was wrong, and the way it was wrong is the useful part.

Those controls are gated on `viewer.isManager`, which **the server computes**. The moment
`isRaceManager` gained its roster term they hid themselves - no client change needed, which is the
same payoff as the seventeen call sites and for the same reason: the client asks rather than
derives.

What actually broke was the inverse. **The hub's only link to the roster lived inside that manage
block**, so roster-gating management hid a capability this change deliberately keeps. The server
went on granting the read, `GET /races/:id/members` went on answering `200`, and nothing in the app
could reach it. An off-roster admin lost the roster entirely.

The fix is `canReadRoster` as its own field on the race payload rather than something the client
infers from `isManager`. They are now different questions with different answers, and the comment
at the call site says so, because the next person to write `isManager && ...` around a read control
will reintroduce it.

**The shape worth keeping:** a permission narrowing hides the controls it should hide *and* any
control that happened to be grouped with them. The first is the change; the second is a regression
with no error, no failing test and no log line - the capability simply stops being reachable. Look
for what else lived in the block you just gated, not only at what the gate now denies.

Also removed: a "You manage this" badge on that hub, which could no longer be true there - the hub
renders only for somebody off the roster, and managing now requires being on it.

**ADR-0027's follow-up row was corrected rather than left standing.** An ADR is immutable about its
decision and its rejected alternatives, both untouched here; a "follow-up needed" cell is a to-do
list, and leaving a false claim in it would be worse than editing it. Same-day correction has
precedent - ADR-0024's status line was amended the day it was written.

### Verified

1177 tests, typecheck, runtime parse, em-dash lint. Specs updated in the same change: `PRD/02` (the
matrix rewritten to four columns), `PRD/09`, `PRD/10` - whose Race-versus-Eboard comparison had
three rows made stale by this - `PRD/15`, `PRD/18`, `TECH/05`, and the authorization checklist,
whose "authority versus access" section had been teaching the old rule to every future change.

---

## 2026-08-12 (last) - The inbox learns whose face it is talking about

Three changes to the notification list, asked for in that order: make it flat, make the rows
taller, and give the rows the picture of whatever they are about. The third is the one with a
server half.

### The row that was a card

The founder's mockup showed full-bleed rows where the app had cards. That looked like a finish
and was not. **A card insets its tint**, so two adjacent unread rows are two tinted blocks with a
gap between them; full-bleed rows meet, and a run of unread ones becomes one continuous band. The
thing worth seeing at a glance in an inbox is where the new ones stop, and a card cannot draw it.

It went into the shared `Row` as a `flat` parameter rather than becoming a second row component,
which is `TECH/13`'s recorded follow-up finally starting. Two things came with it and neither is
decoration: a **pressed wash**, because flat removes the card edge and the chevron so a tap is
otherwise acknowledged only by the next screen arriving, and **no chevron**, which on a full-bleed
row reads as a stray character at the end of a sentence.

The title moved out of the navigator's branded header into the body, matching the Chats list.
`PRD/15` had said Calendar and Notifications keep the branded header "because they have no nested
stack of their own to host one" - true about where a header *can* live, and not a reason it has to
be that one.

The dot went. It was hidden from screen readers, so it was decoration rather than a channel.

### Whose face, and the rule that decides

The ask was pictures instead of glyphs, with an exception the founder stated himself: not on polls
and events, "because you don't wanna put the profile pictures of the club". That exception is the
whole rule, and writing it down first is what made the rest fall out:

> **A row shows the picture of what it is about when that is a place or a person, and keeps a
> glyph when it is about a thing that happened.**

A club's face belongs on "100 unread in Paper Running Club" and would be wrong on "new poll",
because the second is an object somebody made rather than a room you can walk into.

Four questions the mapping raised that the ask had not covered, all settled before any code:

- **A join request is about a person**, so it wears the requester's face rather than the club's -
  which also makes the three request types visually distinct from everything else, and those are
  the rows a glance must not dismiss.
- **A report shows the channel and never the reported member.** The row already withholds their
  name and their words because it can land on a lock screen; a face hands back what the words
  withhold.
- **Everything is a circle**, including a club - the one sanctioned exception to `DESIGN/02` rule
  2, argued in that file rather than quietly broken. The shape earns its keep elsewhere by
  answering person-versus-group before a word is read; here every row is a sentence naming its own
  subject, so it is restating something already said.
- **Unread rings the face** instead of filling the well, because a photograph cannot be filled
  without hiding the thing it is there to show.

The mapping lives in `packages/shared` as `notificationSubject`, exhaustive over the union with no
`default`, so a twenty-first type is a compile error rather than a row with a blank circle. It is
deliberately a **second function beside `notificationTarget` rather than a field on it**: they
answer different questions and disagree more than they agree. A join request points at the roster
and shows the requester; a report points at the reports tab and shows the channel. Deriving one
from the other would be right about half the catalogue.

**The picture is joined at read time and never written into `params`** - ADR-0013's argument one
field further on. `params` records the moment the event happened; a picture is a fact about the
subject now, so storing it would freeze a club's old avatar into every notification ever sent
about it.

### The test that had to have three different pictures

`channel-access.ts` already carried the warning, from the Chats list: a race and an Eboard channel
both carry a club id, so **resolving a chat row against its club still shows a picture, and it is
the wrong one**. One picture in a fixture cannot tell the two implementations apart. So the test
sets a club picture and a race picture and asserts the race row shows the race's - and its
neighbour asserts the glyph tier resolves to nothing, because a resolver that gave everything a
face would pass the first test and put a club's avatar on "new poll".

### Then the founder removed somebody, and the picture disagreed with the sentence

Reported within the hour of the pictures shipping: "Parks removed you from Cougars Invitational",
beside the **running club's** picture.

That was my call and it was wrong. I had raised it as an open question - `member_removed` and
`request_denied` carry `scopeName` and deliberately **no `scopeId`** (`PRD/12` rule 6a), because
the space they name is precisely the one the reader can no longer open - and proposed the club's
face as the fallback, and it was agreed to in the abstract. Seen on a phone it is obviously wrong:
rule 6a exists to stop a row telling somebody they lost the club when they lost a race, and the
picture had reintroduced exactly that, one layer up. **An agreement about a described behaviour is
not an agreement about the thing on screen.**

The fix could not reuse `scopeId`, because that field's *absence* is a statement - it says there is
nowhere to go. So the rows gained `subjectId`, named so it cannot become a destination, carrying
identity alone. The target is unchanged and there is a test asserting so.

**A row written before the fix shows a glyph rather than guessing the club.** The complaint was a
picture that disagreed with the sentence; an old row falling back to the club would reproduce it
precisely. Saying nothing beats saying something wrong.

### Two red screens, both mine, both the same mistake

`AGENTS.md` failure mode 22 - a watcher runs a half-finished edit - twice in one afternoon, on a
phone in the founder's hand. `ReferenceError: Property 'flat' doesn't exist`, then
`ReferenceError: Property 'subjectPicture' doesn't exist`. Both times a file was saved using a
name that the *next* edit would declare. Both times I had written the correct ordering rule in the
same conversation immediately beforehand.

The entry is worth keeping because the rule as stated is not enough. "Imports before usage" is
easy to hold; **"a declaration and its first use go in one write"** is the version that would have
prevented both, and the difference only matters when the declaration is a `const` in the same file
rather than an import at the top.

### Verified

1175 tests, typecheck across four workspaces, the runtime parse gate, and the em-dash lint. The
device carried the rest: the founder confirmed the faces on his phone, found the removal defect
there, and confirmed the fix afterwards. **Neither the flat rows nor the wrong picture was findable
from the diff** - the first needed a screenshot, and the second needed somebody to remove a real
person from a real race.

---

## 2026-08-12 (close, again) - The second copy I wrote before finding the first

Two things on a member's profile card: the clubs the two of you are both in, and a picture you
can open full size. Both asked for from a GroupMe recording, which is also where the presentation
came from - a sentence naming one club, the rest as a stack of overlapping faces with a `+N`, and
the full list a tap away.

### The duplicate

`readProfile` already loads the subject's club ids to answer `canViewProfile`, so intersecting
them with the viewer's own memberships looked like the obvious place. It was written, typed,
tested with seven cases, and green.

Then, wiring the client, `dmApi.sharedClubs` appeared two lines above where I was editing.
**`sharedClubs` has existed since Phase 3.5**, does the intersection as a join, and its route note
already said the quiet part: *"the answer is about two people and does not need a thread to exist
- the same read serves a profile reached from a roster."* Somebody had anticipated this exact
screen and left a note for whoever arrived next, and I had walked past it.

The copy was deleted. What survived is the part that turned out to be worth more than the code:
**that function had no tests at all**, and now has seven, including the two negative ones that
matter. A test asserting "the club we share is listed" passes against an implementation returning
the subject's *whole* club list - which would name clubs the viewer is not in and undo rule 8a
outright. So every case establishing what IS listed is paired with one establishing what is not.

The lesson is not "grep first", which I did. It is that the codebase's own notes are the index:
the answer was written in the place a reader of `dm.ts` would find it, and I was reading
`account.ts`.

### The overlay that covered a third of the screen

The photo viewer opened over the top of the page with the rest of the profile showing beneath it.
`Body` is a `ScrollView`, and an absolutely-positioned overlay inside one resolves against the
scroller's content box rather than the screen. Chat had already written the rule down - *"last in
the tree and absolutely positioned, so it covers the conversation, the pinned strip and the
composer rather than appearing inside them"* - and the fix was to make both overlays siblings of
the body rather than children of it.

Only visible in a browser. It typechecks, it renders, and it looks like a design decision.

### The viewer that should not have been reused at all

First attempt: reuse `PhotoViewer` and relax its required props, since a profile picture has no
author, no day it was taken and no message to go back to. That was already uncomfortable - the
alternative considered was passing the profile's `createdAt` as `takenAt`, which typechecks and
displays a wrong date confidently - but it was the smaller change.

The founder's answer settled it and was better than either: **black screen, the picture centred,
no close button, no menu, and no way to download somebody else's profile picture.** Swipe in any
direction to leave.

That is not the same object as a photograph in a conversation, and the reuse was the mistake
rather than the required props. `PhotoViewer` carries Share, Download, Report and a route back to
the message because all of those are true of *content*; a profile picture is *identity*. **The way
to guarantee nobody can save another member's face is to not build the menu**, so it became its
own component and `PhotoViewer` went back to exactly what it was.

Three things in it are load-bearing rather than polish. It is a **`Modal`**, because the
navigator's header sits above a screen's content - an in-screen overlay covered everything except
the one strip carrying a back arrow and somebody's name, which is precisely the chrome the screen
exists to remove. The picture **follows the finger and the black fades as it goes**, so the
gesture reports its own progress and a close button is not missed. And **a tap dismisses too**,
which is not decoration: a drag cannot be performed with a switch, a keyboard or VoiceOver, so
gesture-only would trap exactly the people least able to escape.

Both halves of the gesture were driven rather than assumed: a 200pt drag dismissed, and a 45pt one
stayed open and sprang back to the origin. The second is the one that would have been a bug.

### The black had to belong to the screen, not to the photograph

First version used `contain` and let each picture's own aspect decide. That looked right on the
first face tried and wrong on the second: a phone photo held upright is very nearly the screen's
own ratio, so one member's picture sat in generous black and another's bled edge to edge. Two
people's faces opening into two differently-shaped screens.

Capping the height fixed the bleed and introduced bands down the sides, which was also wrong. The
answer was in the uploader the whole time: **`pickSquarePicture` already crops every profile
picture to `aspect: [1, 1]`**, on both platforms, and every avatar in the product draws that
square. So the viewer shows the same square at the full width of the screen - black above and
below, none at the sides - and `cover` matters only for a picture uploaded before that crop step
existed, where it fills the frame rather than leaving gaps.

Measured rather than eyeballed: 402 wide by 402 tall on a 402x874 screen, 0 black at either side
and 236 top and bottom.

### Verified

982 server tests, and the card walked in the browser at phone width rather than desktop, since
this is a phone-first product and the block is centred: the sentence, the stack, the `+N`, "Since
Aug 2026", the sheet with all six clubs, and a club row navigating through to its hub. The overlap
was measured rather than eyeballed - each face laps the previous by exactly 10 points - because
the seeded clubs had no pictures and a broken style would have looked identical to a working one.

The rows seeded for that walk were removed afterwards. A development database accumulates real
usage between sessions and is not fixtures.

---

## 2026-08-12 (last, again) - One swipe, written once

"All calendars should move like sliding, how our actual calendar does." Only one did not: the
`DateField` picker, which had chevrons and nothing else. Everywhere it appears - events, meetings,
polls, and races since this morning - it was the odd calendar out.

### The copy that was not made

The gesture already existed, in `calendar.tsx`, and it is the most expensive hundred lines in this
client: three wrong answers, four root causes and a red screen on a phone, all on 2026-08-06. The
tempting move was to write a small version of it in `DateField`. That would have been the worst
possible copy-paste in the codebase - every one of those root causes would have had two homes and
only one of them would ever get the next fix.

So the mechanics moved to `src/month-pager.tsx` as `useMonthPager`, and both callers use it. The
split is on purpose: **the hook owns the gesture, each caller owns its chrome and its cells.** The
Calendar draws event markers, a selected day and a month/year picker behind its title; the field
draws a chosen day in a sheet. Neither of those is a swipe.

`WEEKDAYS` was declared twice before this - once in each file - which is exactly the drift the
extraction ends. The month vocabulary (`MonthCursor`, `shiftMonth`, `monthCells`, `todayParts`)
went with it.

### The heading was the tell that it was really shared

The one property that looks decorative and is not: the heading reads the pager's `shown` rather
than the committed cursor, so the month name travels **with** the grid instead of snapping half a
second behind it. That was the first thing reported about the calendar's swipe in August, and the
picker inherited the fix for free by inheriting the hook. Writing a second pager would have meant
discovering it a second time.

### Verified, and the part the browser cannot answer

The pager was probed rather than eyeballed, because a mouse drag does not scroll a snap container
on the web and dragging proves nothing - which is a harness artifact this project has already
mistaken for a product bug once. Driving `scrollLeft` and reading what the component committed
gave the whole cycle on both calendars: three pages wide, resting on the middle, the heading
flipping to the next month at 1.6 pages **before** the commit, the commit landing, and the offset
recentred to the middle page afterwards.

**The founder confirmed the swipe on the iPhone while this was being written**, which is the half
the browser never covers: the 2026-08-06 entry closes with "what none of it covers is how the snap
feels under a finger", and that is now answered.

Also asked for and done in the same pass: **the picker's month heading is the accent orange**, and
the Calendar destination's is deliberately not. They are different objects - one is a page whose
subject IS the month, the other is a small sheet floating over a form somebody is filling in, and
it should read as part of the control they just opened.

---

## 2026-08-12 (last) - A group is a race that never picked a day

Four changes to the club hub, asked for together, and one of them turned out to be a schema
question wearing a form field's clothes.

### What was asked

Drop the date from race creation; make the name placeholder generic rather than
`Nittany Lion Invitational`; replace "See all" with a **plus** and a **magnifying glass** beside
the "Races and meets" heading, moving the add action off the full-width button at the bottom; and
order the list by **when each was created**, newest first, since there is no date left to sort by.

### The date was doing four other jobs

"Remove the date from the form" reads like a form change. Tracing it found the column was
`NOT NULL`, indexed, rendered in three places, and - the one that mattered - **what puts a race on
the club calendar**. `readCalendar` unions races in by `race_date`. Removing it would have deleted
a shipped feature that `PRD/07` and `PRD/09` both specify, silently, as a side effect of tidying a
form.

So it was raised rather than guessed at, and the founder's answer was better than either option I
had prepared: **keep the date, make it optional, and have the form say what it is for.** A group
has no day and should not be made to invent one; a race that genuinely has a day should still
reach the calendar. The field now reads *"Add a date to put this on the club calendar. Leave it
blank for an ordinary group."*

That is the whole design in one sentence, and it is on the screen rather than in this file.

### The null had to mean something everywhere

Making a column nullable is one migration; making the null *mean* something is the rest of it.

- `readCalendar` gained `AND r.race_date IS NOT NULL`. Without it an undated group lands on the
  feed with a null day and every consumer downstream has to defend against it.
- `PATCH /races/:id` takes `nullish` rather than `optional`, so an emptied field **clears** the
  date. Folding null into absent would have made a date impossible to undo - a group created by
  mistake as a dated race could never stop being a calendar entry, and the person emptying the box
  would watch their change fail to happen.
- Three render sites stopped drawing a blank line where a date used to be. TypeScript caught two
  of them; the other two were `<Text>{race.raceDate}</Text>`, which typechecks perfectly with a
  null and renders an empty row.

### Ordering fell out of the same fact

The list sorted by `race_date DESC`. A dateless group cannot be placed on a date-ordered list at
all - it sorts to one end or the other depending on how NULLs are treated, and both answers are
arbitrary. Creation order is the one fact every race has, it needs nothing from the person
creating it, and it matches what a list of conversations is expected to do: the one you just made
is at the top. Pins still win above it, because a pin exists precisely to control the hub's
five-row preview and ignoring it would leave the feature drawing an icon and moving nothing.

The old ordering comment said the direction was "not specified by PRD/09", which is exactly what
made it safe to change - and is a small argument for writing down what a decision does *not* rest
on.

### Two things found by looking rather than by asking

**The plus had to be admin-gated.** The button it replaced was wrapped in `viewer.isAdmin` and the
icon was not, so for one edit a plain member had an add control whose only possible outcome was a
refusal. Caught by reading what the old button was wrapped in before deleting it, which is an
argument for deleting things last.

**The create screen contradicted itself.** Its subtitle said *"Standalone from the calendar"* -
true when nothing here ever reached the calendar, and directly contradicted by the new date field
two inches below it. Seen in the browser, not in the diff.

### And then the date stopped being typed

Asked for immediately afterwards, and it is the same observation from the other end: if a date is
optional and most groups will not have one, the people who *do* want one should not have to spell
`YYYY-MM-DD` correctly to get it.

**`DateField` already existed** and is what every other date in the product is chosen with - the
event form uses it twice. The race form was the odd one out rather than a deliberate exception, so
this was a reuse rather than a build: the month grid, the format it emits and the CLEAR action all
came with it. Both the create and the edit screen now use it, so setting a date and taking one
away are the same gesture in both places.

Two things fell out of the swap. **`optional` draws CLEAR**, which turned out to be exactly the
affordance the edit screen needed - the note there already promised "clear the field to take it
off the calendar", and until now that meant selecting text and deleting it. And **the format
checks became dead code**: the picker emits `YYYY-MM-DD` or nothing, so a malformed value cannot
reach the handler. They were removed rather than left as reassurance, and the past-date check
stayed, because the picker will happily offer last March.

### Proved

Nine server tests covering the pairs that matter in both directions: created with and without a
date, malformed still refused, the calendar carrying the dated one and not the undated one, a
cleared date **leaving** the calendar and a later-added date **joining** it, newest-created
ordering against names and dates deliberately chosen to disagree with it, and a pin overriding
all of it. Then walked in the browser: a group created with no date, a race created with one, the
hub showing the newer on top, and the search sheet drawing the date under one row and a clean
one-line row for the other.

The picker was walked separately, because a control is only proved by using it: opened, a day
picked, CLEAR emptying it again, the month chevron moved, a race created from a picked day, and
then that date cleared from the edit screen and saved. The database was read at both ends rather
than the screen believed - `2026-09-12` after the pick, `(none)` after the clear.

---

## 2026-08-12 (close) - The bar that followed you into the form

The founder sent two screenshots and a rule: the tab bar belongs on the Chats list and on a club's
front door, and nowhere else. Not while creating an event or a routine, not on the member list, not
in car groups.

### What it was doing instead

Everything below a destination lives inside the Chats tab's stack, which is what keeps `/polls/:id`
and `/races/:id` at their own URLs. That arrangement was built on 2026-07-30 specifically so the
bar would stay - v1's rule is "every signed-in screen except chat", and matching it was treated as
the goal. So the bar followed a member into the roster, into Meet Information, into every create
form, and sat there floating over the content while they filled it in.

### The rule was v1's, and v1's bar is a different object

This is the part worth keeping. v1's tab bar sits **in flow**: the scene ends where the bar begins,
so a bar on every screen costs nothing but space. The remaster's floats **over** the scene, which
is what makes its translucency mean anything - and it means every screen underneath owes itself
`tabBarSpace()` or its last row is visible and unreachable.

`DESIGN/01` has recorded that obligation since the bar started floating, and named the screens that
had not paid it: *"club hubs, rosters, polls, news, races, meetings... each is a row somebody can
see and cannot read."* Six screens paid it. Twenty did not. **So inheriting v1's rule imported a
defect v1 could not have.**

Shrinking the set to five discharged it for all twenty at once. Padding them by hand would have
fixed twenty screens and left the twenty-first to whoever adds it next.

The worst offender was the club hub, which is one of the two screens the founder wants the bar on -
so it is now the only one that needed clearance *added*. **Add Group is its last row**, so the bar
sat across the button the screen exists for. It survived a month because a tall button with its
bottom third covered still looks pressable.

### Where the decision lives

One pure function over the pathname, `showsTabBar`, in its own module with 45 tests. Not because
the logic is hard - it is an allowlist plus a uuid check - but because every previous bug in this
area was found by looking at a phone, and pitfall 34 is exactly this: *a pure function over a list
has no business being unreachable from a test*.

Two details in it are load-bearing. **The club id is matched by shape rather than by counting
segments**, because `/clubs/add`, `/clubs/create` and `/clubs/join` are also two segments and all
three are forms. And **an unknown route gets no bar**, so a screen added later inherits no clearance
obligation by accident - the opposite default ships a sliced row and fails nothing.

A race and the Eboard space do not keep it, though `PRD/00` principle 1 makes them the same shape as
a club: both are reached from inside a club, so they sit below the front door.

### Walked, including the part most likely to break

The five screens show it and the deep ones do not, checked in the browser rather than reasoned
about. The interesting one was the Clubs tab's **two-stage escape hatch**, which is the most
intricate behaviour attached to this bar: from Calendar with a club in context, Chats returns to
that club's hub - `?from=clubsTab` and all - and a second press leaves the club for the list. Both
still work, and the query string the jump appends does not confuse the predicate, which is one of
the cases the tests cover and now one that has actually been walked.

Nothing about `(main)/_layout.tsx` changed, which is the note worth ending on: **where a screen
lives and whether the bar is painted over it turned out to be separable questions**, and they had
been tangled together for as long as the answer was "everywhere".

---

## 2026-08-12 (last, again) - The filter that lets you swear

The last of Apple's four guideline 1.2 requirements, and the only one that had been held open on
purpose. Reporting and blocking shipped in Phase 3.5; acting on a report and a support address
landed on 2026-08-11. Filtering was left unbuilt because it is the only one that changes what
happens when somebody presses send, and picking its behaviour is a product call rather than an
engineering one.

### Two assumptions worth killing before designing anything

The founder expected Apple to publish a checklist of banned words. **It does not**, and neither
does Google. What Apple publishes is the requirement plus a definition of objectionable in
guideline 1.1.1 - *defamatory, discriminatory, or mean-spirited content, including references or
commentary about religion, race, sexual orientation, gender, national/ethnic origin* - and reading
that carefully is the whole design. **It describes hate speech and says nothing about swearing.**

So the obvious build, a profanity list, is wrong twice: it refuses ordinary college chat
constantly while catching almost nothing the guideline actually names, and it teaches members to
work around the filter, which makes every later signal worse. The best-known public list (LDNOOBW,
maintained by Shutterstock) says in its own README that it exists to decide "what wouldn't we want
to *suggest* that people look at" - it filters autocomplete, not human speech.

The second assumption was the founder's own, and it was right for a better reason than he gave: a
language model scoring every message was rejected on **architecture** before cost. The
`last_seq` row lock is held until commit, so a network call on the send path serializes an entire
channel behind a round trip. Scoring asynchronously in the worker stays open as a future upgrade
to the *flag* tier; nothing can go in the send path.

### Two tiers, because a list cannot judge

Refuse only what no message in a running club could legitimately contain. Everything ambiguous -
`nigga`, used in-group; `chink`, as in a chink in the armour; `retard`, as college shorthand; the
`kys` family - **posts normally and files an automatic report**. `kys` between friends after a bad
5k is not `kys` to somebody being pushed out, and no list separates them. A person can.

The flag tier files an ordinary `message_reports` row as the **seeded system actor**, which is the
part that made this cheap: the per-space Reports tab, the DM queue, dismissal, message removal and
account suspension all work on it unchanged. The queue reads "reported by ClubChat" and offers the
two powers an admin already had. `fileReport` was extracted so a member's Report button and the
filter go through one mechanism rather than two copies - failure mode 9, pre-empted.

### Three defects, all in code written that afternoon

None was found by reading it back.

**A leetspeak fold ran before a word-boundary match.** `!` folded to `i`, so `you faggot!` became
`you faggoti` and `\bfaggot\b` stopped matching - the clearest possible slur, passed. The rule is
general and now `AGENTS.md` failure mode 25: a substitution that turns a non-word character into a
word character must never run before a `\b` match. A digit is safe; punctuation is not. Fixed with
two normalizers rather than a cleverer one.

**The obfuscation list contained flag-tier terms.** The collapsed pass returns a refusal, so
listing `kys` there would have silently promoted it past the human judgement the tier exists for.
Now asserted by a test, because the two lists sit far apart in the file.

**And the fix for `niiiigger` was worse than the miss.** Squeezing repeated letters hard enough to
catch it collapses `Nigeria` and the country `Niger` onto the slur. Refusing a member for naming
where they are from is a far worse failure than the evasion, so the squeeze came out and the hole
is recorded as a decision with a test asserting it.

The innocent-word corpus is the part worth keeping. A filter that refuses everything passes every
test that only checks slurs are caught, so `Scunthorpe`, `raccoon`, `auspicious`, `a fagot of
kindling`, `hello Liam`, `is she male or female`, `Nikki Kern` and `that hill was fucking brutal`
all assert *allow* - and one of them, the armour idiom, asserts *flag* instead, so the designed
false positive reads as a decision rather than as a bug somebody later fixes by deleting the term.

### A fourth, in code three months old

The sign-up consent line has never linked to the Terms. `legal/terms.tsx` has said it does since
it was written - "sign-up links to both from its consent line" - and the line was plain text, so
the only stated route to the document somebody is agreeing to did not exist. Found by looking at
the rendered screen in a browser, which is the only place it is visible: the code reads fine, the
docstring reads fine, and they disagree.

### Proved twice, because each proves what the other cannot

**On the wire**, with a script that opens a real socket and sends the frames itself rather than
driving the client - the rider from failure mode 21, where a regression test passed with the
server bug still present because the client fix stopped it sending the offending frame. Fifteen
checks: a slur refused, a spaced-out slur refused, swearing acked, the armour idiom acked, and
**the refusals consumed no `seq`**, which is the one that matters for the channel log.

**In the browser**, for the half the socket cannot show: the notice appears, the composer keeps
the text, and no failed bubble is left offering a retry that cannot work. Then the admin's Reports
tab, where the flagged message sits reported by ClubChat with Delete and Dismiss.

One thing the smoke run got wrong and is worth recording: two system messages appeared mid-test
and looked like the filter posting into the channel. They were the club-creation and join
messages, drained late by a worker that had just started. Checked against the table rather than
assumed either way.

### Settled alongside it

**ClubChat is 18+**, declared at sign-up and in the Terms. The founding case is a university club
so the minimum costs nothing, it is what the store age rating rests on, and it keeps a one-to-one
messaging surface out of the children's-privacy regimes. Declared rather than verified by a date
of birth: collecting every member's birthday to check something almost nobody would misstate is
the wrong trade. It also means every earlier document reasoning from "this product will include
minors" is now describing intent rather than population, which is noted in `PRD/17` rather than
edited out of the three places it appears.

---

## 2026-08-12 (last) - Your link does what you are allowed to do

The founder tried the new share screen and came back with a rule, not a bug report: **on a
`request` club, an admin's link should join somebody instantly and a member's link should make them
ask.** On an open club it makes no difference who shared it.

That is [ADR-0024](SPEC/decisions/0024-every-member-holds-the-clubs-invite-link.md)'s Negative
column, written down that morning and left standing: *"Any of a club's members can hand out
instant-join access, including to a `request`-policy club."* He would not accept the cost, and the
objection is exact - a `request` club has said an admin decides, and a member who can bypass that
has been handed the admin's authority by the back door, invisibly, because a link arriving looks
the same whoever sent it.

### One token cannot answer two questions

The link is a bare bearer string. The server sees the token and nothing else, so **the token has to
BE the answer**: each club now holds two, and `readClub` returns whichever belongs to the viewer's
tier. A member never learns the admin string, and there is no branch in the client to get wrong.

The alternative was one token plus a signed marker of who shared it, and it was rejected for a
reason worth keeping: **a link gets pasted, forwarded, shortened and screenshotted, and anything
travelling beside the token can be lost.** The safe fallback - treat a missing marker as a request -
would then silently break every legitimate admin link that lost its query string. Two opaque strings
cannot be separated from their own meaning. [ADR-0025](SPEC/decisions/0025-a-members-invite-link-obeys-the-join-policy.md).

Two small decisions inside it, both one-way on purpose. Redeem compares against the **admin** token
and treats everything else as the member case, so a future third link is a request by default - a
capability is granted by naming it, never by failing to match. And **rotation replaces both**,
because whoever rotates does not know which one leaked; that is the whole reason to rotate.

### The request branch was written twice, briefly

`redeemInvite` needed exactly what `joinClub` already did on a `request` club: file the row, publish
`club.join_requested`, absorb the duplicate, refuse a banned person. Copying it would have been
failure mode 9 with three things to drift, so it came out as `fileJoinRequest` beside `admit` - one
function for every way of asking to join, mirroring the one function for every way of actually
joining. Nothing new appears in the roster, because it is the same pending row an admin already
approves.

### A ban that read as a rotated link

Writing the banned-person test found a defect three weeks old. `POST /invites/:token/redeem`
flattened **every** refusal to `404 invite_invalid`, so somebody who had been banned was told the
link was no longer valid - which reads as "an admin rotated it", so the natural next move is to ask
another member for a fresh one. `PRD/04`'s edge-case table has said "told plainly they cannot
rejoin this club" since bans shipped. It now answers `403 banned`, and only that case: a revoked or
made-up token still must not hint at which clubs exist, and the banned answer leaks nothing new
because they were in the club. No appeal path is offered, which is the same table's other half -
naming a contact hands a determined harasser a specific person to pursue.

### Proved by walking it, as three people

Server tests assert each pair in both directions - the tier split, both policies, and the ban. Then
the whole loop was walked in the running app: created a `request` club, copied the owner's link, and
opened it as a second account, which **joined instantly**. That account then opened the share
screen, saw a **different** string, no rotate control, and the sentence *"Anyone with this link asks
to join Request Policy Club, and an admin approves them."* A third account opened that link and got
**REQUESTED - an admin will approve or deny it.**

The screen's explanatory line is per-viewer for that reason: it used to promise instant joining to
everybody, which is now true for exactly half the people who can read it.

---

## 2026-08-12 (later) - Every sync the iPhone ever made returned nothing

The founder scanned the code, joined a club from it, and sent three screenshots: the join worked,
and behind it sat a red box - `cannot start a transaction within a transaction`, then `cannot
rollback - no transaction is active`. Chasing that found a much larger thing underneath it.

### The loop that was trying to tell us

The phone's log carried the same line over and over: *repairing a gap below the high-water mark,
channel 1f43…, missing 3*. A repair that runs on every sync forever is either a hole the server
will not fill or a write that never lands, and the count could not tell those apart - so the log
grew the seqs. **93, 94 and 95.** The server had them, and the phone did not.

Three checks in a row said the impossible. The server returned all 27 messages from seq 92, for
the exact account signed in on the phone. The store reported no remaining hole immediately after
writing. And **the database pulled off the device with `devicectl` still had 116 rows and a hole
at 93-95**, before and after.

The tiebreaker was a probe placed immediately after the write, logging unconditionally. It never
printed. So the code was returning *before* it - and there is exactly one silent return on that
path: the response contained no entry for the channel we asked about.

### The URL was encoded twice, and only on the phone

The API's own access log had it in plain sight, two lines apart:

```
/sync?channels%5B%5D=1f43f56c-…%253A92     ← the phone
/sync?channels[]=1f43f56c-…%3A92           ← the browser
```

`encodeURIComponent` wrote `%3A`. **React Native's `fetch` normalises the URL it is handed and
percent-encodes the query string again**, so `%` became `%25`. Fastify decodes exactly once, the
handler split on `:` and found none, and the entry was skipped. 609 of those had gone out. Every
one answered `200` with an empty channel list.

**So `/sync` has never worked on iOS**, since the client was written. The socket hid it completely:
the phone stayed current in real time, and the only casualty was anything missed while the socket
was down - which is precisely the class of bug this project has chased four separate times.

Two rules, and the second is the one that let it live for months:

1. **Never hand `fetch` a URL you have already encoded.** A uuid and an integer need no escaping,
   and whatever the platform escapes on its own the server decodes back. The entry is written raw.
2. **Never skip a malformed request element - refuse it.** The skip made a client bug
   indistinguishable from the deliberate omission of a channel the caller may not read. A malformed
   entry is now `400 bad_channel_entry`; an unauthorized one is still omitted, because a client
   holding a stale channel list must be able to sync the rest.

**Proved on the device.** After the fix, the phone's database went to 119 rows with zero gaps, and
a fresh cold start logged no repair at all. `AGENTS.md` failure mode 24.

### The red box: two caches over one connection

The screenshotted error was its own defect, and it fires when somebody signs out and back in.
`openMessageStore` built a **new** `SqliteMessageStore` per session, while `openDatabaseAsync`
hands back the same underlying connection - so the second store's schema statement ran inside the
first store's open transaction. The write lock that exists precisely to prevent that
([HISTORY 2026-08-01]) is an instance field, and two instances cannot see each other.

The visible error was the smaller half. `execAsync` throwing is caught by the fallback, so the app
would quietly continue on the **in-memory** store - no persistence, no offline chat, and no symptom
until the next launch. The store is now memoized: one process, one cache, one lock. It also logs
which one it opened, because an in-memory fallback is invisible from inside the app.

### What this says about the method

Four separate readings of correct-looking code failed to explain it. What worked was, in order:
the log line that repeated, the seqs it was made to print, the probe that never printed, and then
**the server's access log** - which is the only place the client's and the browser's requests could
be compared as strings. `AGENTS.md` standing instruction 4 says reproduce rather than reason; the
sharper version this earned is that when two clients disagree, the thing to diff is what they
actually put on the wire.

---

## 2026-08-12 - A club you can hand to somebody, and a save button that never came back

Asked for from a GroupMe screen recording: their Share Group screen and the QR code behind it. What
we had was one pill on the club profile firing the system sheet with a bare URL in it.

### The video asked a permission question, not a design one

GroupMe lets **any member** share the group. Ours returned `inviteToken` to the admin tier only, so
the first honest answer to "build this screen" was "for whom?" - and the tier split turned out to be
inherited rather than decided. `AGENTS.md` 2.1.3 says ask rather than guess at a permission model,
and the answer changed the work: every member now holds the link, only an admin can rotate it
([ADR-0024](SPEC/decisions/0024-every-member-holds-the-clubs-invite-link.md)).

The reasoning that settled it is that admin-only did not withhold the secret, it **delayed** it. A
member who wants to bring somebody in asks an admin, who pastes them the same string - identical
access, one day later, minus the person who was interested at the time. Rotation stays with admins
because it destroys **other members'** outstanding invitations, which is the same asymmetry as
[ADR-0021](SPEC/decisions/0021-club-bans-are-harder-to-impose-than-to-lift.md): widening access is
everybody's, revoking other people's work is not.

One line of server change, and the test that guarded the old rule now proves the new one in both
directions - every member gets the token, an outsider is refused the club outright, and a member
attempting rotation gets `404`.

### What the code carries, said out loud on the screen

`Linking.createURL('/join/:token')` is `clubchat://join/…` in a real build. **A stranger scanning
that gets nothing** - no prompt, no error, no page - and a stranger is exactly who a code taped to a
table is for. [ADR-0010](SPEC/decisions/0010-link-only-invites.md) recorded the missing web fallback
as the price of removing the typed code and it has never been built.

Two things followed. The screen says it in words rather than letting a member find out at a club
fair. And the obligation was **promoted into `PRD/17`'s blocking table** with what it actually needs
- `clubchatapp.com` serving `/join/:token`, the association files, the entitlement, a rebuild -
because a link in a message is at least read by somebody who can be told to install the app first.

### Drawing the code, rather than installing something that draws it

`react-native-svg` plus a zero-dependency encoder and about forty lines, instead of
`react-native-qrcode-svg` - which is the same forty lines wrapped around `qrcode`, `text-encoding`
and `yargs`, in a phone bundle. Three properties in `src/qr-code.tsx` are load-bearing and none is
stylistic: the four-module quiet zone (specification, not padding - cropped, a scanner cannot find
the symbol at all), dark-on-white at full contrast (the accent is 3:1 on white, which reads as ours
to a person and as a maybe to a camera, so it went on the frame), and error correction `H` because
the club's picture covers the middle.

**Proved by decoding it, not by looking at it.** Every rendered code was read back with a decoder
and compared against what Copy Link put on the clipboard: without a picture, with one, with the
clear ring added around it, and - the one that matters - **the exported PNG itself**. A QR that
looks like a QR is not evidence of anything.

### The save button that sat on "Saving" forever

Pressing Save on the web client disabled the button permanently. `toDataURL` takes a callback and
never called it.

**The first diagnosis was wrong**, and it is the useful part of this entry. The SVG had an `<image>`
pointing at the media URL, so the remote reference was blamed and the bytes were inlined as a data
URI - the hang survived it. That forced the search into the serialised string, where the cause was
an **apostrophe in the accessibility label**: rasterising goes through `data:image/svg+xml`, and
`react-native-svg` builds that URL by swapping every double quote for a single quote, so
`"…this club's join link"` closed its own attribute, the SVG failed to parse, and `img.onerror`
fired where the only handler is `onload`.

That has a rule with a wider reach than one label: **nothing inside an exportable SVG may contain an
apostrophe, including anything interpolated into it.** A club called "Roja's Runners" would do it,
which is why the name is drawn by the screen around the code and never inside it. `AGENTS.md`
failure mode 23, along with the second rule the day earned: **a callback API with silent failure
paths gets a timeout**, or one unhandled case disables a control until the screen is closed.

The inlining stayed - an export should not race a fetch - but it is recorded as fixing nothing here.
Calling it the cause without re-running the failure would have shipped the real one.

### Walked as two people

Proved on the web client end to end: created a club, uploaded a picture, copied the link, scanned
the rendered code with a decoder, saved the PNG and decoded that too. Then signed out, signed up as
somebody else, **joined through the link**, and opened the share screen as a plain member - the
preview, the link and the code are there, and the rotate control is not.

### Not built, deliberately

**The branded rows.** GroupMe lists Snapchat, Instagram Stories, iMessage and WhatsApp above its
share sheet. Snapchat and Instagram Stories are image-based Creative Kit integrations rather than
link shares, so each is an SDK, an asset render and a not-installed path of its own; the system
sheet already lists every app on the phone. Recorded here rather than as a comment.

**A share sheet for a race or the Eboard space.** Neither is joined by link, so neither has a link
to share.

---

## 2026-08-11 (evening) - Somebody on the other end, and something they can do

The moderation queue has had a screen since 2026-08-08 and, before today, no way to put a person
behind it: `is_platform_moderator` was read in eight places and written in exactly one, a line of
raw SQL inside a test file. In practice the flag was set by hand against whichever database was in
front of you.

That was found while reading the specs, and it looked like a small gap. Researching how other
products appoint moderators turned it into three.

### What the research actually changed

Two useful things came back, and the second reframed the work.

**The queue design is already the industry shape.** WhatsApp's report forwards the last five
messages plus account metadata to an internal review team. ClubChat serves five either side, plus an
audit row naming who looked and at what. Nothing needed rethinking, which is worth recording because
the instinct on finding a gap is to re-examine everything around it.

**Apple's guideline 1.2 asks for four things and we had two.** A report mechanism with a *timely
response*, the ability to block abusive users, published contact information, and a method for
filtering objectionable material. Blocking and reporting have been solid since Phase 3.5. The
operative sentence is the one that did the damage: *act on reports within 24 hours by removing the
content and ejecting the user.* **We could do neither**, in the one scope that has no admin to do it
instead. `signin_blocked_at` existed, was respected everywhere, and was written only by
`deleteOwnAccount`. `dismissReport` explicitly did not delete.

So the appointment gap was the cheapest of three, and on its own it would have produced somebody who
could watch.

### Appointment is configuration, not a product role

A platform moderator is an operator. Nobody earns it by using ClubChat, and every other operator
fact here already comes from config - the mail transport, the proxy count, the media signer. So
`PLATFORM_MODERATORS` is a comma-separated list reconciled against the column when the API boots.
Revoking is deleting a line rather than remembering an inverse command, and it survives a restore, a
`db:nuke` and a new environment.

The rule worth stating: **an empty list never revokes.** Reconciling to zero moderators unstaffs the
queue, which is the exact failure the subsystem exists to prevent - and an absent secret after a
deploy is indistinguishable from a deliberate empty list while costing far more. Unset warns and
changes nothing. A configured address matching no account is **named** in the log, because a typo
grants nobody and otherwise looks exactly like success.

Rejected, and recorded in [ADR-0022](SPEC/decisions/0022-platform-moderators-are-appointed-in-configuration.md):
a management command (imperative, lost on every reset), first-user-wins (the first account here is a
club founder, not an operator), and an in-app grant (needs a seed moderator anyway, so it postpones
the problem rather than solving it, for a team of one).

### Two powers, scoped as narrowly as the guideline allows

**Removing a reported message** is addressed by the *report*, resolved through `message_reports`, so
there is no door to a conversation nobody complained about. `dm` only - everywhere else that space's
admins already hold the power. A tombstone like every other delete, clearing reactions and pin
state, advancing the channel revision so an offline phone learns.

This contradicts nothing in `PRD/14`, and the distinction took a moment to see clearly. That matrix
says no **participant** may delete the other's message, and it still does. A platform moderator is
not a participant.

**Suspension** writes the same `signin_blocked_at` every entry point re-asks about, deletes the
sessions, and publishes a revocation through the outbox. It deliberately does **not** anonymise, and
that is what makes it the right tool rather than a blunt one: ejecting a club Owner by deleting them
would breach domain invariant 1, and suspending one breaches nothing. Any moderator can lift it,
which is [ADR-0021](SPEC/decisions/0021-club-bans-are-harder-to-impose-than-to-lift.md)'s asymmetry
one layer up.

Two refusals in `canSuspendAccount` are load-bearing rather than tidy. **The system actor**, whose
block is a security property - it authors every system message and nothing may authenticate as it,
so reinstating it would be the hole. And **another platform moderator**, because an operator who
could shut off the other operators could disable everybody able to reverse them.

`applySoftDelete` was extracted so the two authorization paths share one answer to "what does
deleting a message do". A second hand-written copy of the tombstone, the cleared reactions and the
revision bump is failure mode 9 with three things to drift.

### The tests that would have passed anyway

All twenty passed first time, which on a security boundary is a reason for suspicion rather than
satisfaction - HISTORY already records a regression test that passed with the server bug still
present. So two predicates were deliberately broken and the suite re-run:

| Mutation | Result |
|---|---|
| `canRemoveReportedMessage` ignoring `isPlatformModerator` | "refuses a participant" failed, `404` became `200` |
| `canSuspendAccount` dropping the peer check | "refuses a moderator suspending another" failed |

Both refusals are real. Cheap to do, and the only thing that distinguishes a test that proves a
refusal from one that asserts a refusal already happening for some other reason.

### Two things the log said that disagreed

Worth keeping, because both readings were true.

The reconcile at boot logged `granted:0, revoked:0` while the database had visibly moved the flag
from a leftover smoke-test account to the founder's. The answer was in the previous process's log:
`node --watch` **restarts on a change to `--env-file`**, so appending to `.env` had already
reconfigured a running API, which did the grant and the revoke. The fresh boot was correctly
reporting an idempotent no-op.

The same log carried `ReferenceError: parseModeratorList is not defined`, from adding a call in one
edit and its import in the next while a watcher sat between them. That is the live-reload hazard
already known for the phone, and it applies identically to the three `--watch` server processes -
where the evidence is one line in a log nobody is tailing. `AGENTS.md` failure mode 22.

### Two stale claims, found by reading rather than by auditing

`PRD/17` asserted in two places that the moderation queue "has no screen at all" and that `hrefFor`
returns `undefined` for it "on purpose". Both were false from 2026-08-08: the screens exist and
`hrefFor` returns `/moderation`. Corrected, and noted where they sat, because this is the second
time in two days that a stale rule was caught by somebody reading a document for an unrelated
reason. **A spec nobody has cause to re-read goes stale silently.**

### The suspension that did not stop a sign-in

Found within the hour, by the founder asking a question rather than reporting a bug: *the login page
should say you have been suspended.* Trying it first, per standing instruction 4, turned a wording
request into a defect.

```
existing token after suspension   HTTP 401   correct
FRESH sign-in as suspended        HTTP 200   a real session token
sessions in the database                 2   a blocked account had just been issued one
```

**`signin_blocked_at` is our column and `/api/auth/sign-in/email` is better-auth's route, and the
two had never met.** A suspended person signed in normally and then met a 401 on every screen - which
presents as a broken app rather than as a suspension, and leaves session rows behind for an account
that should have none. The founder had read it as "he cannot log in", and he could; everything
*after* logging in was failing.

The fix is better-auth's own pattern, read out of the `admin` plugin that implements banning rather
than out of memory: a `session.create.before` database hook that throws. Three things about it are
deliberate and none is obvious.

- **It runs after the password is verified.** Checking the address earlier would answer "suspended"
  to anybody who typed one, which is exactly the account-existence oracle `PRD/03` rule 14 refuses to
  build on the reset form. Asserted in both directions: a wrong password on a suspended account still
  answers `INVALID_EMAIL_OR_PASSWORD`.
- **It refuses by throwing**, so no session is created, rather than deleting one afterwards and
  leaving a window where a valid token existed.
- **It reads the column from our own table.** The admin plugin reads `user.banned` off the adapter's
  user object; ours is not in `additionalFields`, so that object would answer `undefined` forever.
  That is failure mode 12 - the trap that left revocation silently dead for four phases - and it was
  one line away from being repeated.

No client change at all: the sign-in screen already renders the server's `message` inline, so the
wording lives in one place.

**My own tests had the hole.** The reinstate test signs in *after* lifting the suspension, so it
never once tried signing in while suspended. Two of the three new tests fail without the hook; the
third passes either way on purpose, guarding against somebody later "fixing" this by checking the
email first.

### Not built, deliberately

**The filtering bullet.** Guideline 1.2 also asks for a method of filtering objectionable material
*before* it is posted. That is a change to what happens when somebody presses send rather than a
moderation feature, and adding a word list quietly would be inventing scope. Recorded in `PRD/17`
with the options, as the likeliest thing a reviewer asks about given the product will include
minors.

**A support mailbox that exists.** The address is published in the Terms, the Privacy Policy and on
Profile, from one constant. `clubchatapp.com` is registered and its sending domain is still
unverified, so somebody has to confirm a mailbox before submission - a published contact that
bounces is worse than none.

**A screen for `moderation_actions`.** The audit trail is written and queryable, and nothing shows
it.

---

## 2026-08-11 (last) - The header that borrowed a control it could never have

Four rounds on chat's back button, a full revert, and a restore of the half that was right. The
shape of the day's ending is worth more than the pixels.

**Reported as: "I love the back button on News and Highlights, I don't like the one in chat."**
The difference turned out not to be styling at all. That white capsule is **not in this
codebase**. `backWrap` in `nav.tsx` is padding and nothing else - iOS draws the capsule itself
around whatever the navigator is handed as `headerLeft`, and every screen using the navigator's
header gets it free.

Chat and Highlights are the only two screens in the app that draw their own header out of plain
views. No navigator, no UIKit, no capsule - so somebody had hand-rolled a 36pt grey circle with a
black arrow. Close enough to look deliberate, different enough to be spotted instantly by the one
person who uses the app every day.

### Measuring, rather than guessing at, somebody else's design

The recording came in at 384x848 against a 393x852pt device, so **a pixel was a point** and the
system capsule could be read straight off the frame: 62 wide, 44 tall, inset by the content
gutter. That is the good half of this entry - given a screen recording and a known device, a
design can be measured instead of eyeballed, and the numbers went into the code as literals with
a comment saying they are not ours to choose.

### Then the measurement was obeyed too well

At full size the title collapsed to "Bingha...". The first response was to shrink the controls,
which was **treating the symptom**: the two controls came to 106pt and the Highlights pill beside
them was 100pt on its own. This header carries six things where every other header in the app
carries three.

Moving Highlights into the overflow menu freed five times what shrinking the buttons had - and
the full-size capsule became affordable in the same change that made compromising on it
unnecessary. So it was restored, on exactly that reasoning.

Seen on the phone, that was wrong, and the founder's verdict was that something was off about the
result rather than about any one number. The whole thing was reverted, then restored without that
last step.

> **Room to do something is not a reason to do it.** The measurement said what the system draws.
> It never said what this header needs, and those are different questions. The capsule at full
> size dominates a row whose job is to name the conversation - it reads as a toolbar with a title
> wedged into it.

### A drift caused while fixing a drift

Chat was shrunk and **Highlights was not**, so for a stretch the two headers that exist
specifically to match each other did not. Arrived at by editing one file and not its twin, which
is the failure the pairing exists to prevent. Both are 48x40 now.

### What was kept, and what is on record

Highlights lives in the overflow menu, first in the list. The back control is a near-white capsule
with the accent arrow at the size this row can carry. The full revert stayed in history as a
`git revert` rather than a force-push, because **the expensive part of the day was the finding,
not the CSS** - where the capsule comes from, and the measurements - and that survives in
`26f9e6b`'s message even though its code does not.

The option not taken, and the one to revisit if this returns: move chat onto the native header and
earn the real capsule instead of copying it. It costs the blur.

---

## 2026-08-11 (later) - A pin's recency is when it was pinned

One rule, missing from two surfaces for the same reason, found a day apart. Re-pinning something
old has to make it the most recent notice, or an admin pinning a month-old result for tonight's
race finds it filed under last week's.

### The strip: a field with nowhere to travel

`pinned_at` was on the row and on every full read, and **`MsgUpdate` had no such field**. A live
pin arrived as `pinned: true` with no time, the client stored a null, and the sort - nulls last -
put the newest pin at the far end of the strip. It corrected on a reload, because a full read
carries the field and an update could not, which is what made it read as a rendering quirk rather
than a missing one.

The hole ran through four layers - worker publish, wire type, patch type, SQLite - and every one
needed the same field. No extra round trip anywhere: the frame was already being sent, and was
sending half the change.

**The worker now re-reads the row at publish time** rather than publishing its outbox payload,
which is what the reaction handler does and for the same reason. That closed a second defect
nobody had reported: pin, unpin, then redeliver the first event, and a payload-driven publish
announces a pin that has since been removed - every open client puts the notice back for a message
nobody has pinned.

### Highlights: the same defect, and its own comment said so

```
// Newest first: ... the most recent pin is the one somebody
// opening the tab is looking for.
.orderBy(desc(messages.seq))
```

It named the right rule and implemented the other one. Pinned now orders by `pinned_at` with `seq`
as tiebreak; announcements keep ordering by `seq`, because for an announcement the message time
**is** its recency.

**The cursor had to move with the sort.** `before=<seq>` cannot name a position in a list ordered
by time - it filters on one axis and sorts on another, returning a page from nowhere with a 200.
The Pinned tab takes `beforePinnedAt` now. Its schema is `.strict()`, and that was not cosmetic:
simply not declaring `before` made Zod **strip** it, so the first draft accepted the old cursor,
discarded it, and returned the first page every time - paging would have looped forever on the
same rows, at 200 throughout. The same silent strip that lost `replyToSeq` for a day, reached
from the other direction.

### The test that proved nothing

The existing pin-publish test asserted `pinned === true` and nothing else, so it stayed green
through the entire defect. And the ordering test that matters pins the **newest** message first
and the **oldest** second, so pin order is the reverse of message order and the two rules disagree
about every row - **a test that pins chronologically passes under both rules**, which is how the
strip carried this for as long as it did.

---

## 2026-08-11 - The pinned strip, and a working feature nobody could see

Asked for from a GroupMe recording: the notices leave the instant you move up and return on the
smallest move back. Ours took a long drag to do either.

### The threshold was not too large. It was the wrong quantity.

It showed the strip within a fixed distance of the newest message, so a member deep in history who
nudged toward the conversation saw nothing happen - they had to travel the whole remaining
distance first. **No value of that threshold is correct**, which is the tell that the number was
never the problem. It follows the direction of travel now, with a deadzone so a wobble or the
bounce at the end of the list cannot flip it, and the tail always shows. Measured after: a 7-point
nudge returns the strip from 3,900 points deep.

The list is inverted, so a rising offset is travelling **away** from the newest message. Getting
that backwards looks correct in a diff and is simply inverted on a device.

The strip also gives its space back now. It faded in place before, so the box stayed in the layout
and left a permanent empty band under the header: gone, and still occupying room.

### It shipped invisible, and was reported as done

The strip has to know its own height to collapse from it, and **the node being measured sat inside
the box whose height animates**. As the clip collapsed, the child was squeezed, reported its
squashed height, and the strip adopted that as its full size. It settled at **8 points**.

Everything else was right the whole time. It showed and hid on exactly the right gestures, at a
height nobody could see - which from outside is indistinguishable from the feature never having
been built, and was reported as "no change at all". Three separate readings of the code concluded
it should work, and it did work.

**One log line carrying the measured height beside the gesture ended it in a minute.**

> `measured > 0` is not a guard. It excludes the one wrong value somebody thought of and accepts
> every other one. The only trustworthy measurement is the one taken before anything constrains
> it - the first pass, while no size has been applied. Every later pass can only report the clip.

Recorded as [`SPEC/DESIGN/03-pinned-strip.md`](SPEC/DESIGN/03-pinned-strip.md), with three items
added to the design review checklist: measuring inside an animated box, hiding without giving the
space back, and tuning a threshold when the quantity is wrong.

---

## 2026-08-11 - A pinned card should open the thing it announces

Pinning a poll and pinning a paragraph are not the same act. A poll is pinned because somebody
should vote in it, so opening a record of the card leaves them to go and find the poll themselves.
A card now opens the object; everything else opens Highlights, and nothing jumps back into the
conversation.

The route comes from the target a **notification** about that poll would carry, so the three route
strings exist once and the pin and the push land in the same place by construction.

Highlights got the same rule, and the reason there is stronger than consistency: **the strip shows
four pins and that list shows all of them**, so a fifth pinned poll is reachable from Highlights
and nowhere else. An inert row made it the one surface that could show somebody a poll while
giving them no way to open it.

### The bug this uncovered

Deleting a poll soft-deletes its card and clears its pin in one statement, and **never advanced
the channel's revision**. Sync asks for `rev > mark`, so a phone that was closed at that moment
never learned: it kept the card, and kept it pinned, indefinitely. Live clients were fine, which
is why nothing noticed.

The handler's own comment said the publish was the ONLY route this could travel. **True when it
was written on 2026-08-01; false from 2026-08-03**, when the revision counter arrived to give a
change a route that survives the client not being there. Three mutation sites were updated and
this fourth was on nobody's list, because it is a cascade rather than something a person does.

Allocated per channel rather than once for the batch: `last_rev` is per-channel and the cascade
matches on object id alone, so one revision stamped across two channels would be a duplicate in
one and a skip in the other.

Two of my own test bugs on the way, and the second is the instructive one: the first version
picked the **first live message**, which is the "created the club" system message rather than the
poll card. It would have passed its own setup and asserted nothing.

---

## 2026-08-11 - Circles are people, squares are things, and a picture you can crop

Two reports from the phone that shared a cause: a face was drawn by three different pieces of
code, so a rule could only ever hold in the one that read it.

**Cropping.** `pickSquarePhoto` opens the picker with its editor on, at 1:1. Every avatar uses it,
and so does a news post. The line is not identity versus content - which is what it looked like
first and would have put news on the wrong side: **crop where the frame is fixed, do not crop
where the picture sets its own proportions.** Chat keeps the uncropped picker because a chat photo
is shown at its own ratio.

The news card became `aspectRatio: 1` in the same change. **The crop frame and the display frame
have to be the same frame** or the card crops a second time and what posts is not what was chosen.

**Shape.** `Avatar` already carried the rule - circles are people, rounded squares are things -
and `shape` defaulted independently of `kind`, so the two could disagree. They did: the Chats list
passed `kind="group"` with no shape and drew every club as the group glyph inside a circle. Shape
now derives from kind, so saying `group` is saying `square`.

That left the two faces that never went through `Avatar` at all. The **space header** hand-rolled
its own 40pt round well, which is why News & Highlights showed a round club while chat's header
two taps away showed a square one; the club hub's race rows hand-rolled a third. Both call
`Avatar` now.

The roundness rule had been broken **four separate times**, every time by a surface drawing its
own face. Fixing the instances again would have left the thing that keeps producing them, so it
went into [`SPEC/DESIGN/02-avatar.md`](SPEC/DESIGN/02-avatar.md) - and rule 2 is stated wider than
it had been: *every* space is a group, including the ones drawn as a destination icon rather than
a picture, and including any space added later.

---

## 2026-08-10 (later) - The screen that answered a question nobody asked

Reported from the phone: a plain member opens a race, taps **Meet Information** from the header
quick-nav, and is told that only a club admin can edit it and that they can read it on the race
screen. The founder's own summary was the whole diagnosis - *yes, only an admin edits it, but a
member should be able to see it.*

### Reproduced before it was diagnosed

Standing instruction 4, and it paid immediately by ruling out half the codebase. A real non-admin
member with a live session, against the running API:

```
GET /races/87cf6e14…   as Parks RPK (club role: member)   ->  200
viewer          : {"hasAccess":false,"isManager":false,…}
meetDescription : "Leaving at 6am"
```

**The server was already right.** It hands all five fields to any club member, including one with
no roster row at all, exactly as `PRD/09` rule 13 requires. So there was nothing to fix behind the
wire, and the whole defect was one ternary on the screen throwing away content it had been given.

### Two rules that had been collapsed into one

`PRD/09` rule 13 makes Meet Information readable by any club member, *because it is precisely what
somebody uses to decide whether to go*. `PRD/05` rule 11a says the header quick-nav is deliberately
not role-gated, because reaching a screen is not acting on it and every destination applies its own
rules on arrival.

Together those produce one rule: **content shown, controls absent.** What shipped was content
withheld - and worse than a blank, because it directed somebody who had just asked to see the
information to go and see it somewhere else.

### The fix that mattered was not the fix

The race hub was **already** rendering these five fields read-only, with a deliberately non-uniform
empty-state rule (rule 12: Details, Location and Hotel hide when empty; Photos and Results show
"Stay tuned"). The cheap repair was to paste that block into the second screen.

That is failure mode 9 exactly - a hand-copied block does not diverge loudly, it diverges silently,
and each copy stays individually correct while the rule drifts between them. Nothing would have
caught a later change to one and not the other. So it moved into `src/screens/meet-information.tsx`,
the directory that exists for this ("two renderings of one read, kept side by side so they cannot
drift"), and both screens call it.

### Swept for siblings

Every role-gated branch in the client was checked for the same conflation. The other four are
benign - an empty-state hint that varies by role, an owner-only action, a roster badge, and a line
of explanatory copy inside the Eboard edit form. `meet.tsx` was the only one.

940 tests, typecheck, `check:runtime`, `lint:emdash`. **Not seen on a device by the author**: the
reproduction proved the server and the ternary, and the render was confirmed by the founder.

---

## 2026-08-10 - A place for design to live, and a header that scrolls

Two things, and the first exists because of the second's whole family: design work is arriving
faster than anywhere existed to record it.

### `SPEC/DESIGN/`, one file per surface

`TECH/13` was becoming a catalogue. It is meant to be the *system* - tokens, the type scale, the
structural rules, where design authority comes from - and the previous entry had grown one bullet
about the tab bar into five paragraphs covering the pill, the labels, an accessibility fallback and
an absolute-positioning contract. Two kinds of content at completely different rates, in one file.

So: a fourth home in the documentation contract, a peer of `PRD/` and `TECH/`, **one file per
surface rather than per screen**. A surface is a reusable piece of interface with its own identity
wherever it appears; a screen is a composition of them. Describing the tab bar inside four screen
files is the same drift `TECH/13` rule 5 already forbids in code.

**The one rule, and the reason these can be expected to survive:**

> **Record the relationship, not the value.** "Inset 24pt" is dead the moment somebody asks for a
> bit more, and it duplicates `theme.ts` - which the repo's own rule says wins, so the spec is
> guaranteed to lose that argument. "Inset further than the content gutter, so it reads as a
> separate object rather than another block of the page" survives the number changing, and is the
> thing that would otherwise have to be re-derived.

**The part that prevents bugs rather than describing them** is the obligation-promotion rule. A
visual choice can create a hard contract for code that has nothing to do with the surface: floating
the tab bar obliges *every scrolling screen in the app* to reserve clearance. A per-surface design
file is precisely where somebody building a roster screen will never look, so anything in a spec's
obligations section is also written into the relevant `TECH/` doc or an ADR. That section is a
pointer, never the only home.

Shipped with it: the design spec template, a **design review checklist** whose every item is a
defect this project actually shipped (the double-counted safe-area inset, the `marginTop` nudge
that clipped every icon, the labels the navigator silently dropped, the sliced last row, the nested
pressable, the native module that took the whole web bundle down), and `01-tab-bar.md` as the
worked example while last night was fresh. **Written as surfaces are touched, never backfilled** -
a spec written by reading code instead of by looking at a device starts out wrong.

### The search field and the chips now scroll

Asked for from a GroupMe screen recording. `ffmpeg` frames rather than a description, which settled
what "only the chat stick" meant: the title row and its two buttons are pinned, and the search field
and the filter chips are **content** that travels with the list and returns at the top.

Two things were checked rather than assumed, and one is still owed.

**The code carried a note saying the controls must sit outside `DataScreen`**, so a reload could not
"blink them out of existence" - and this change puts them inside it. The note was defending a real
property, so rather than overriding it: `DataScreen` only replaces its children while
`load.data === null`, so a refresh with rows already on screen keeps them mounted. The blink it
feared cannot happen. What is now true is that the first load and a hard error show no controls,
and neither has a list to search.

**The header is passed as an ELEMENT, not a function.** A function there is a new component type on
every render, so the search field would remount and drop keyboard focus on every keystroke. It
typechecks either way and the 67 mobile tests pass either way; it is only findable with a thumb.

**Still owed: that thumb.** Committed unverified on device at the founder's instruction, with the
scroll behaviour and the focus behaviour both unconfirmed. Recorded here rather than implied to be
done.

### A stale rule found on the way

`PRD/15` rule 3 still described **three** chips with none selected on arrival, cleared by tapping
the active one again. The 08-09 commit shipped **four** with `All` selected and never updated the
rule. Corrected in the same change, per the standing rule that the repo is right and the doc is the
bug - and worth noting how it was found: not by an audit, but by reading the rule for an unrelated
reason. A spec nobody has cause to re-read goes stale silently.

---

## 2026-08-09 (last) - The tab bar the screen ends at, and the one it floats over

Four founder requests over one evening, taken in order: make the sliding pill faster, drop the
destination labels, shrink the bar's width and grow its height, and make it translucent like
Strava's. The first three were what they sound like. The fourth was not, and it is the entry.

### The tint that could not have worked

The bar went translucent - `chrome` at 88% - and on the device it looked **exactly** as opaque as
before. The obvious readings were all wrong: the colour was right, the token was reaching the
style, and the same `expo-blur` treatment works on the chat header two screens away.

The founder settled it with a screenshot, highlighting the strips either side of the inset bar and
the band beneath it, saying he expected to see rows there while scrolling.

> **Those strips were empty because the scene ended at the bar's top edge.** The bar was in normal
> flow, so the navigator sized every screen to stop above it. There was no content behind the
> glass. A translucent bar over blank background is an opaque bar, and no opacity value would ever
> have produced the effect - the missing piece was something to see *through* to.

`position: absolute` is the whole fix, and it is what makes the other three properties mean
anything: the inset strips fill with list, the band above the home indicator fills with list, and
88% starts reading as glass. It went to 85% once there was something behind it to reveal.

### The comment that was confidently wrong, and what that cost

The style carried a note arguing against exactly this, from the session that built the bar:

> **In normal flow, NOT `position: absolute`.** Floating a tab bar absolutely (...) means every
> list in every tab has to grow a bottom padding equal to the bar's height - and the one nobody
> remembers is the one whose last row sits permanently under it. Keeping it in flow means the
> screens end where the bar begins, which is the same look with none of that.

Its *reasoning* is sound and is now this change's main liability. Its *claim about the look* was
the error: in-flow is not "the same look", it is the look without the effect, which is only
discoverable by asking for the effect and not getting it.

Worth recording how it misled. Reading that comment, the earlier profile screenshot - an "Edit
Profile" card sliced through by the bar's top edge - was interpreted here as proof the bar
overlapped content, and this entry nearly recorded the comment as a lie. It was not. The card was
being **clipped at the scene's bottom edge**, which looks identical to being covered and is not the
same thing at all. Two mechanisms, one appearance, opposite conclusions about what to change.

**The tell that resolved it was the negative space, not the sliced row**: a bar that overlaps
content shows fragments of that content in the strips beside it, and those strips were clean. The
absence was the evidence, and it took the founder's highlighter to make anybody look at it.

### Why only one screen had ever needed padding

`clubs/index.tsx` reserved `tabBarSpace()` and nothing else in the app did, which had read as an
oversight in the other screens. It was not: in flow, nothing needs it, and the Chats list needed it
only because it was the one screen tall enough to run its final row against the boundary.

That inverts with this change. Calendar, Notifications and Profile were given the same reservation
in this commit; **every screen deeper than the four destinations is still owed it**, and now
genuinely broken rather than theoretically so - a row visible under glass and impossible to scroll
clear is worse than a row that is simply absent. Recorded as owed work rather than swept quietly,
because the founder chose the four-destination scope while it was still hypothetical.

### The rest, briefly

- **The slide went from ~400ms to a little over 200** (`damping` 18 to 26, `stiffness` 130 to 280,
  `mass` 0.9 to 0.7). The previous session tuned it deliberately slow, reasoning that a fast
  indicator reads as teleporting. That over-corrected: what removes the jump is the pill having a
  continuous path at all, and past a point a slow trip stops reading as motion and starts reading
  as lag behind a screen that has already changed.
- **Labels off, icons alone.** This contradicts `TECH/13`, which gives the pill as a second channel
  for the selected state *because* accent-versus-grey alone fails `PRD/16`. Raised before building
  it, and the founder's call. Two things kept it from being a silent regression: the pill stays,
  and it is now the only second channel; and each name moved to `tabBarAccessibilityLabel`, since a
  tab with no text gives a screen reader nothing to read.
- **Height 60 to 56 to 64, inset 8 to 16 to 24.** The bar shrank when the labels left, then grew
  past its original height because the height is now carrying the presence the words used to. The
  inset deliberately overshoots the 16pt content gutter: at the gutter its ends aligned with the
  text above and still read as flush, and breaking that alignment is what makes it look like a
  separate object rather than another block of the page.

Full gate green: 940 tests, typecheck, `check:runtime`, `lint:emdash`. Every step was verified on
the physical iPhone as it landed, which is the only reason the tint failure was caught at all - it
typechecks, it renders, and it is wrong.

---

## 2026-08-09 (later) - The Chats redesign, and a marker that told on people

A founder mockup for the landing screen, taken as a **design** change: nothing about what a row
does, only what it looks like. The list itself has been clubs and DMs together since 2026-08-02.

What changed: an explicit `All` chip selected on arrival, replacing "no chip is selected, tap the
active one again to clear" - same behaviour, and now with something on screen saying how to get
back. A count on `Unread`, absent at zero, counting **conversations** rather than messages so it
agrees with the tab badge. Flat rows instead of white cards. Unread as an accent timestamp and an
accent badge instead of a peach-tinted row. Group glyphs for clubs, in one of five placeholder
colours hashed from the channel id so a club keeps its colour forever.

### The marker that had to go, and the better reason for going

The founder asked for the `READ ONLY` chip to come off a DM row. Looking at why it was there turned
up a better argument than the aesthetic one: **`canPost` is a single boolean over two different
causes** - the pair blocked each other, or they no longer share a club - so the chip could not say
which, and the founder's own guess moved between the two while we discussed it.

`PRD/14` rule 6 makes a block **silent to the blocked party**, and the resolution note under it puts
the explanation on the **composer**, which already draws one of two exact sentences. So the chip was
redundant where it was right and disclosing where it was wrong: it announced the state on the
landing screen, in a list anybody can see over your shoulder, about a person meant not to be told.

### Four attempts at one pill

The active destination needed a filled pill behind its icon and label. Recorded because each failure
looked like the previous one and had a different cause:

1. `tabBarActiveBackgroundColor` with a rounded item style - **a full-height rectangle** edge to
   edge, because the background paints the item's own box and nothing had inset it.
2. Insetting it with margins - the pill hugged, and **every label vanished**: at 64pt the navigator
   decided there was no room and dropped all four, which is the icon-only bar `PRD/16` forbids.
3. Drawing the pill in the `tabBarIcon` slot with the navigator's label off - correct at last, but
   `NOTIFICATIONS` truncated to `NOTIFICATIO...`, because the pill's own margins had eaten the 6pt
   the longest word needed.
4. A `marginTop` nudge to centre it - **clipped the top off every icon on the real phone**, which
   is where it was caught. Moving content inside a box that is too small is not a fix.

**And the dead band under the icons was never the height.** It survived the bar being made taller
and shorter, which should have been the tell much earlier. The navigator pads the bar's bottom by
the home-indicator inset so an ordinary full-width bar clears it; this bar floats above the
indicator on `marginBottom`, so the inset was **counted twice** - 34pt of nothing inside the bar,
with the icons pushed into its top half. `paddingBottom: 0` was the whole fix.

> **The lesson is the shape, not the number: a symptom that does not respond to the knob you are
> turning is telling you the knob is wrong.** Two of these four were only visible on a device, and
> the clipped icons arrived as a screenshot from the founder's phone rather than from the simulator
> a foot away - the same "get a second client you can inspect" that closed the gap bug.

### Two things the flat rows cost, both reported from the device

Neither was visible in a static mockup, and both are the same shape: a card was doing a job nobody
had written down.

- **The last row was sliced in half by the tab bar.** The bar floats, so it draws over the list,
  and the list reserved 24pt where the bar needs its whole footprint. The height now comes from a
  shared `tabBar` token because the layout owns the bar and the screens own their lists, and
  neither could see the other's number.
- **A row no longer looked tappable.** No card edge, no chevron, no ripple - so a tap was answered
  only by the next screen arriving, and on a slow open the row read as dead. It takes a grey wash
  under the finger now. The row also took over the horizontal padding from the list, because a
  highlight inset by the gutter leaves an untinted stripe down each edge and a half-tinted row
  reads as a rendering fault rather than a press.

### Scope

Flat rows are the Chats screen only; every other list still uses cards, deliberately, as a
follow-up rather than a silent inconsistency. The scan control in the mockup was left out - it is a
feature rather than a visual, and no spec has a QR concept in it.

---

## 2026-08-09 - The session the gateway never rejected

`SPEC/PRD/17` had carried this since 2026-08-08: the web client authenticated fine over HTTP while
its socket answered `auth failed: invalid_token`, against session rows that were present and
unexpired. Signing out and back in cleared it. Nobody could explain why.

**The gateway never rejected a session.** It refused a frame that arrived while the handshake was
still running, and reported it with the code that means "your credential is no good".

### Finding it by refusing to theorise about it

The previous entry's lesson was to stop reading code and get a second thing to compare, so this
started by trying to make the token be wrong and failing:

| Asked | Answer |
|---|---|
| Do the two token shapes better-auth hands back behave differently? | No. Raw `body.token` and the signed `set-auth-token` both give `200` and `auth.ok` |
| Does any REAL session diverge? | No. All **101 unexpired sessions** in the development database replayed against both surfaces, and all 101 agreed |

Which killed the entire premise. The token was never the variable, so the variable had to be
something else about the connection, and the only other thing a socket has is *when* frames arrive.
Three cells, one valid token throughout:

```
auth alone:                              auth.ok
auth, then subscribe AFTER auth.ok:      auth.ok , subscribed
auth, then subscribe in the same tick:   auth.err(invalid_token) , CLOSED
```

### What it was

`handleAuth` awaits two database round trips - resolve the session, load the access context - and
the message handler started the next frame immediately rather than behind it. So the second frame
was evaluated against `state.userId === null`, refused, and the socket closed. **The client sent
its frames in the correct order and lost anyway**, because the server did not observe the order it
was sent in.

The client half is the mirror image. `connect` assigns `this.socket` and only then awaits `auth.ok`,
and `send` asked only whether the socket existed:

```ts
private send(frame: unknown) {
  if (!this.socket) throw new Error('not connected');   // true, and not the question
  this.socket.send(JSON.stringify(frame));
}
```

Once the socket is OPEN, `send` throws nothing - so a frame goes out and the gateway kills the
connection. **The window is small and it is precisely the window a cold open occupies**: a chat
screen's mount effect calls `openChannel` and `markRead`, and `chat-client.ts` already said so in a
comment written for a different bug, that this fires "reliably *before* the socket has finished
connecting" on a deep link, a notification tap or a refresh.

Then 2026-08-08 made it much worse. Ending the session on `invalid_token` was right - it fixed an
app that sat offline forever behind a grey banner - but it pointed a destructive action at a code
that did not mean what it says. **A member with a perfectly good token got signed out.**

### The two answers the old entry could not produce

Both fall straight out, and both had been recorded as mysteries:

- **"Signing out and back in clears it."** Sign-in lands on the club list, and nothing there opens a
  channel while the socket is connecting. The race needs a chat screen to be the first thing mounted.
- **"`resolveSessionFromToken` accepts a freshly-issued token every time in testing."** Of course it
  does. So does an old one.

### Fixed at both ends, because each is the other's blast radius

- **The gateway queues each socket's frames**, one at a time, in arrival order. The same rule the
  client already applies per channel and for the same reason: a check that reads state an earlier
  frame writes is meaningless until that frame has finished. Liveness is still recorded on arrival,
  so a queued frame is never mistaken for a silent socket.
- **`not_authenticated` is now its own code**, distinct from `invalid_token`. Only the second is
  grounds to end a session.
- **The client sends nothing before `auth.ok`**, and *holds* subscriptions the way it already held
  read cursors, so a chat opened mid-handshake is still subscribed once the socket is usable rather
  than silently unsubscribed.

A client on somebody's phone cannot be fixed retroactively, so the server must not refuse
correctly-ordered frames; and a refused frame closes the connection, so the client must not send an
early one. Either fix alone leaves the other end broken for somebody.

### A test that passed with the bug still in it

Worth recording, because it nearly shipped as the regression test. The first version drove the real
`ChatClient` through the real gateway in the cold-open ordering, and it did fail before the fix.
Then the client fix landed, and **it kept passing with the gateway's queue removed** - because the
fixed client no longer sends the offending frame, so nothing exercises the server's half at all.

The mutation test is what caught it. The gateway's contract needed a **raw socket** putting both
frames on the wire in one tick, which is the same reason the envelope-repair test above it uses
one, noted there in 2026-08-08's entry and true again here for a different subsystem. Both tests
were then verified to fail without their own fix.

### Verified

- **Reproduced first**, per standing instruction 4: over raw TCP, then through the shipped
  `client-core` against a running API, gateway and Postgres.
- **Full gate green**: 940 tests, typecheck, `check:runtime`, `lint:emdash`.
- **Live in the browser**: a cold open straight to `/chat/:channelId` with no history renders the
  conversation, keeps its back control, shows no offline banner, and sends a message that acks and
  lands in Postgres at `seq 2`. Console clean.

### Then proved on the iPhone

Cold-started on the physical device against the LAN stack, which matters because `client-core` is a
workspace package and a warm reload does not necessarily replace it. The phone bundled the new
code, authenticated, registered its push token, and logged **no auth failure and no offline state**.

It also repaired three real holes left by the previous bug, which is the clearest thing in the log:

```
[chat] repairing a gap below the high-water mark {channelId: f758ee8b…, from: 7,  missing: 2}
[chat] repairing a gap below the high-water mark {channelId: 1f43f56c…, from: 92, missing: 16}
[chat] repairing a gap below the high-water mark {channelId: 64fd258c…, from: 4,  missing: 1}
```

Nineteen messages that had been permanently invisible on that device, recovered on first launch.

### Scope, honestly

**Android is still unbuilt and unrun.** The window is timing-dependent and a slower device widens
it rather than narrowing it, which is an argument that a phone was always the more exposed surface
rather than a reason to assume it is fine there.

---

## 2026-08-08 (last) - The message that arrived on one device and not the other

Reported straight after push was proved: a poll card created by somebody else never appeared in
club chat on the phone. The founder's own cards did. It took **four wrong diagnoses** before the
right one, and the wrong ones are the more useful half of this entry.

### What it actually was

`openChannel` subscribed before syncing:

```ts
if (!this.channels.some((entry) => entry.id === channelId)) {
  this.subscribe([channelId]);   // throws `not connected` when the socket is down
}
await this.syncChannel(channelId, await this.store.localMaxSeq(channelId));
```

> **`subscribe` throws when the socket is down, and that aborted `openChannel` before it ever
> reached the sync.** So the client least able to receive messages live was also the one denied
> the plain HTTP fetch that would have caught it up. The realtime enhancement was taking the
> durable path down with it - the exact inversion of `PRD/16` rule 4, which makes realtime an
> enhancement and the fetch the requirement.

A message missed during a socket flap then sat **below the local high-water mark**, and neither
sync cursor can reach there: `since_seq` asks for `seq > mine`, and `since_rev` asks for
`rev > mine` while an older message's revision is lower still. Every sync reported success. The
message was counted by the unread badge, invisible in the conversation, and unrecoverable for the
life of the cache. `findGaps` had been written and tested since the store existed and **had no
caller**; `syncChannel` now repairs first, using the seq form because the rev form is structurally
incapable of it.

### The diagnostic that finally worked, after four that did not

The founder opened the **web** client. It showed every card correctly - same code, same server,
same account - while the phone showed only its own.

> **That contradiction was worth more than everything read from the code.** Web cannot use SQLite,
> so `openMessageStore` falls back to `InMemoryMessageStore`: an empty cache on every page load,
> refetched whole from the API. **It is structurally incapable of holding a hole.** The phone keeps
> SQLite across launches, so a hole persists forever. Two clients, one difference, and the
> difference *was* the bug.

Every earlier theory came from reading the code and was wrong:

| Theory | Why it was wrong |
|---|---|
| The card renders `null` on a failed read | Real, fixed, not the cause - cards render fine on web |
| A frame at or below the mark is discarded | Real, fixed, not the cause - the frame never arrived at all |
| Non-creator cards fail | Disproved outright: web renders another member's cards perfectly |
| The worker publishes differently from the gateway | Disproved: a subscribed socket receives the worker's card, and the envelope is byte-identical to the API's |

**The lesson, and it cost hours: when a report contradicts what the code says, stop reading and get
a second client you can inspect.** Two clients disagreeing localises a bug faster than any amount
of reasoning about one.

### The tests were green throughout, and could not have been otherwise

Both bugs were **inexpressible** in the suite, for the same reason twice: a fake that did not
behave like the thing it stood in for.

- **The fake socket accepted a write at any `readyState`.** A real `WebSocket` throws
  `InvalidStateError` once it is CONNECTING, CLOSING or CLOSED - which is precisely what made
  `subscribe` throw inside `openChannel` on a real device. With a fake that never throws, the
  failing condition could not be written down.
- **The fake sync read its cursor from the LAST field of `{id}:{seq}:{rev}`** - the revision mark,
  which is `0` in every test. So every sync asked for "everything above 0" and returned the whole
  backlog. A client that could never reach a hole still looked perfectly correct.

> **A fake that is more forgiving than production does not simplify a test, it deletes one.** Both
> now model the real contract, and both new tests were verified to fail without their fix.

### Bugs introduced while fixing it, and caught the hard way

Recorded because two reached the founder's device rather than being caught here:

- **The push client crashed web entirely.** `PushGate` renders on every platform and
  `getLastNotificationResponseAsync` does not exist there - it throws rather than no-oping, taking
  the app down to a red screen before first paint. Guarded once as `SUPPORTED`. Reaching for a
  native module in a component that mounts on every platform needs the platform question asked in
  one place, not at each call site.
- **A `cancelled` cleanup discarded the deep link.** `PushGate` reads `useSession()`, whose context
  bumps on every socket event, and both effects listed `useRouter()`'s object identity as a
  dependency - so the tap subscription was rebuilt per message, and the cold-launch effect's
  teardown could fire mid-`await` and throw the destination away. Navigation goes through
  expo-router's stable `router` singleton now. **The diagnosis came from a log line that was
  absent, not present:** no tap log meant the handler never ran, which eliminated the payload
  theory immediately.
- **`repairGaps` ran first in `syncChannel` and could throw**, which would have let a failed repair
  take down ordinary reconciliation - a strictly worse failure than the one it fixes. Now wrapped.

### Verification worth noting

Proved on the founder's phone, after a forced cold start so the workspace package was actually
reloaded: four cards in one conversation - one created by the viewer, one by `Push Prover`, two by
`Sean O Donnell` - all present. Before the fix the phone showed only its own.

### Scope, honestly

**The gateway rejects a session the API accepts.** The web client authenticated over HTTP - lists
loaded, polls were created - while the socket answered `auth failed: invalid_token` against
unexpired session rows. Signing out and in clears it, and that is a workaround rather than an
explanation. A token valid for HTTP and invalid for realtime presents as an app that looks healthy
with a thin grey "Offline" banner as its only symptom. Open, and written up in `SPEC/PRD/17`.

Old holes already in a device's cache are repaired on the next sync of that channel. Nothing
sweeps every channel eagerly, so a conversation not opened keeps its gap until it is.

---

## 2026-08-08 (fourth) - Push, proved on a real phone, and the half of it that was never built

The task was written down as a credentials errand: push is marked **done in Phase 1**, the only
test ever run used *"the Expo transport, with a fake token that was correctly rejected"*, and what
was owed was a real token reaching a real backgrounded phone. The note said to expect friction in
Apple's credentials rather than in code, and to check that before blaming the pipeline.

That was half right, and the wrong half cost the session.

### Push was "done" with nothing on the other end of the wire

`grep expo-notifications apps/mobile` returned nothing. Not a stale dependency - **absent**. No
permission request, no token, no call to `POST /devices`, no tap handler, no `aps-environment`
entitlement. The device registry, the per-device fan-out, the cursor suppression of ADR-0008 and
the DM push of ADR-0015 were all real and all correct, and no phone had ever been able to hold up
its end.

> **Root cause: the Phase 1 gate proved the server against `RecordingPushSender`, and a recording
> sender cannot notice that no device exists.** The test asserted the payload and its deep link,
> which is exactly what it was written to do; "reaches a backgrounded phone" was the one clause it
> restated as an assertion about a fake token instead. A fake token passes every server-side test
> ever written, because the server's job ends at handing it to a transport.

Built this session: `apps/mobile/src/push.ts` (permission, token, registration, the tap, and the
cold-launch tap that a listener registered in an effect can never see), `push-gate.tsx` binding it
to the session at the root, and `notification-href.ts`, which lifted `hrefFor` out of the inbox
screen so the banner and the row it links to cannot disagree about where a notification goes.

### The project id that was baked into the app hours before it existed

The first real run failed with the warning the code was written to emit:

```
WARN  [push] no EAS project id in the manifest - run `eas init`; cannot get a token
```

`eas init` **had** been run. Metro was serving the id - verified by curling the manifest. Metro was
restarted twice, once with a cleared cache. The app kept insisting it was not there.

> **`Constants.expoConfig`, on a dev build with no `expo-dev-client`, is not the manifest Metro
> serves.** It is read from `EXConstants.bundle/app.config`, which is generated **into the .app at
> build time**.

The build ran at 14:13 and `eas init` wrote the id at about 14:20, so the app carried
`"extra": { "router": {} }` and would have carried it forever. No amount of restarting a dev server
changes a file inside a compiled bundle. The fix was a rebuild, and it is checkable directly:

```
python3 -c "import json;print(json.load(open('.../ClubChat.app/EXConstants.bundle/app.config'))['extra'])"
```

**A red herring on the way**, recorded because it looked so much like the answer: the served
manifest's `scopeKey` stays `@anonymous/clubchat-<uuid>` no matter what, even with `owner` set and
the server restarted clean. It has nothing to do with push, which uses the explicitly-passed
`projectId`. Two restarts were spent on that theory before the evidence killed it.

### The APNs key that never existed, and would have failed silently

Queried through Expo's GraphQL API with the CLI session already on the machine:

```
account parks3131 → applePushKeys: []
```

`eas credentials` had been *started* and the push-key step never completed. This is the failure the
task note warned about, and it is worth naming precisely: **a missing APNs key does not stop a
token being issued.** `getExpoPushTokenAsync` succeeds, `POST /devices` succeeds, the row looks
perfect, and every send is dropped at Apple. Checking the credential is cheaper than debugging the
pipeline it silently disables.

Two adjacent traps in the same flow, both of which upload happily and fail at delivery: the Apple
**team** and the **provider** must both be the individual account holding the App ID
(`3QCWJ4MF4V`), and `Tapari, LLC` is offered first and pre-selected in both menus.

### The mention that was silently dropped, on a name mismatch

The first push through the real pipeline produced nothing at all - no notification row, no
`push_deliveries`, no error. The message was sent, acked, and written to the log. Tracing it:
`message_mentions` had no row for it.

`resolveMentions` in `domain/send-message.ts`:

```ts
return named
  .filter((row) => row.name !== null && body.includes(`@${row.name}`))
  .map((row) => ({ userId: row.id, name: row.name as string }));
```

The test message named the recipient in the `mentions` array but the body did not contain the
literal text `@Parks RPK`, so the claim was discarded.

> **This is the server being right.** A client that could put a `userId` in `mentions` without
> naming them in the text could notify anybody in the channel from a message that reads as
> addressed to nobody - and mentions are one of the two things in this product that ring a phone.
> Filtering a claimed mention down to one actually written is the check that stops it.

**But it fails silently, and that is worth being uneasy about.** The sender gets `msg.ack` and a
message in the log; nothing anywhere says a mention was dropped. Three ways that bites in
production rather than in a test harness:

- **A display name that changes.** `users.full_name` is editable. The match is against the name as
  it is *now*, so a member who renames themselves between the composer resolving the mention and
  the server checking it is silently not mentioned.
- **A name that is not literally what the composer rendered.** Any divergence - trimming, a
  nickname, a middle name, punctuation, `@everyone`-style sugar - drops the mention with no signal.
- **A name containing another name.** `body.includes` is a substring test with no boundary, so
  `@Parks RPK` also satisfies a member called `Parks`. That direction over-matches rather than
  under-matches, which is the more dangerous one for something that buzzes a phone.

Left as-is this session, because it is a real safeguard doing its job and changing it is a product
decision rather than a bug fix. Recorded here so the next person who watches a mention vanish knows
where to look, and so the boundary question gets asked deliberately.

### The tap that opened the app and left you where you were

Reported straight after the first success: the notification no longer jumped to the conversation.
The instinct was to suspect the payload - `data.target` not surviving APNs - so the tap path was
made to log what it saw, both the resolved href and the raw `data` when it resolved to nothing.

**The next screenshot contained neither line.** That absence was the whole diagnosis: the handler
had never run, so the payload had never been the question.

> **`PushGate` reads `useSession()`, whose context bumps `revision` on every socket event, and
> both of its effects listed `useRouter()`'s object identity as a dependency.** A fresh object per
> render meant the tap subscription was torn down and re-added on every incoming message, and the
> cold-launch effect's `cancelled` cleanup could fire while its `await` was still in flight and
> throw the destination away.

The `cancelled` flag was the sharp end. It was written as ordinary hygiene - do not navigate after
unmount - and because an unrelated re-render could land between the `await` and the navigate, its
effect was to discard the deep link and leave the app sitting wherever it already was. Tidy-looking
teardown, silent data loss.

Both effects now key on `authState` alone and navigate through expo-router's stable imperative
`router` singleton rather than the hook. The logging stayed rather than being pulled out
afterwards: a tap that goes nowhere is indistinguishable from a tap that merely foregrounded the
app, and that ambiguity is what cost the round trip.

### What the live testing established, and what it did not

Each of these was run twice where a negative alone would have proved nothing - the point being to
change one variable and watch it flip, rather than observe a silence and assume a cause:

| Condition | Notification row | Push |
|---|---|---|
| Ordinary mention | written | delivered, 8s after the send |
| **Muted** | **written** | **suppressed** |
| Unmuted again | written | delivered |
| **Signed out** | **written** | **suppressed - device row deleted** |
| Signed back in | written | delivered, same token, still one row |

The two silences are silences for **different reasons**, which is worth keeping straight because
they present identically on a lock screen. Mute suppresses in the **audience**, inside
`dispatchPush` before any device is looked up, so it quiets one conversation for one member.
Sign-out suppresses at the **device** layer, because there is no longer a row to send to, so it
quiets the whole handset for everybody. Cursor suppression is the third and the only one that
means "already seen".

That mute keeps the row is the part worth having proved rather than assumed: PRD/14 words it as
*"no push notifications, unread count still accrues"*, and a mute implemented by dropping the
notification would look identical from the lock screen while quietly costing the member the
record.

**Also proved:** an `event_created` push, which is a different target shape - `{kind: 'event',
eventId}` resolving to a flat `/events/:id` with no `seq` and no scroll position - landed on the
event. So the deep link works for destination targets and not only for the chat-with-position case.
It also went to the whole club rather than one mentioned member, so the audience fan-out is
exercised too.

**Not proved, and left honest:** `poll_created` was prepared and never fired. `hrefFor` is
exhaustive over `NotificationTarget` and the event case demonstrates the shape, but no other kind
has actually been tapped on a device.

### Bugs hit in the harness, with root causes

Not product defects - the throwaway sender script - but each cost a cycle:

- **`ERR_MODULE_NOT_FOUND: ws`.** ESM resolves from the *script's* directory, not the working
  directory, and the script lived in a scratchpad outside the repo. Fixed by deleting the
  dependency: Node 25 has a global `WebSocket`.
- **A frame name invented rather than read.** The script waited for `subscribe.ok`; the server
  sends `subscribed` (`protocol.ts` line 190). It authed, subscribed, and then sat there having
  never sent the message - failure mode 16, a hand-written type over a contract that already
  exists, reproduced in a test client.
- **`eas-cli` run from the repo root** wrote a stub `{"expo": {}}` `app.json` there and then treated
  the monorepo root as an Expo project. Removed; it was untracked and four minutes old.
- **`eas credentials` refuses to run without `eas.json`**, which this project had never needed
  because it builds locally with `xcodebuild`. Added with the three conventional profiles; nothing
  uses them except that command's profile lookup.

### Verification worth noting

The proof is the whole point, so what was actually observed rather than inferred:

| Link | Evidence |
|---|---|
| A real token issued | `ExponentPushToken[RYtLF8E-EyLMoP7s1NZHFA]`, logged by the app and in `devices` |
| Transport and credentials | a direct Expo send returned a receipt of `status: ok` |
| The real pipeline | mention recorded → outbox 3601 → `dispatchPush` → a `push_deliveries` row |
| The deferral | sent 18:52:07, delivered 18:52:16 - the 9s is `PUSH_DEFERRAL_MS` losing the race on purpose |
| A genuinely backgrounded phone | the banner on the lock screen, photographed |
| The deep link | tapping it opened that conversation **on that message**, not at the tail |

The banner read *"Push Prover mentioned you: @Parks RPK ..."* under the title *"Binghamton Running
Club"* - rendered by `renderNotification`, the same function the inbox uses, which is what stops a
push and the row it links to telling two different stories.

`[push] registered` also appeared three times across Metro reloads with the **same** token and left
exactly one `devices` row, which is the upsert-on-token rule in `registerDevice` doing its job: one
phone, one row, not one buzz per launch.

### The sign-out gap, found while proving push and closed straight after

`POST /devices` binds a token to whoever is signed in, and nothing undid it. The upsert means the
next sign-in re-points the row - but **between a sign-out and that next sign-in the row stays
live**, so a shared or handed-on phone keeps receiving the previous member's mentions and direct
messages, with the sender's name and a preview of what they said on the lock screen.

Reported as out of scope for proving push, then asked for and closed in the same session:
`DELETE /devices` with `unregisterDevice`, called from `signOut` **before** the session is cleared.

> **The ordering is the entire correctness of it, and it fails silently in the wrong order.**
> Deregistering is an authenticated request, so clearing the session first turns it into a 401 that
> nothing surfaces - sign-out still completes, and the phone stays bound to the account that left.

Two decisions worth recording. It **deletes rather than setting `invalidated_at`**, because that
column means "the provider says this token is dead" - a different fact, and one that re-registering
deliberately clears; the cascading `push_deliveries` rows are not missed because a token that comes
back gets a fresh device id no future dedupe could have consulted. And it matches on **`user_id`
as well as the token**, because the token is client-supplied: deleting on the token alone would let
anybody who learned one silence somebody else's phone. Both are covered by tests, along with the
handed-on-phone case where the same token comes back bound to a different member.

### Scope, honestly

Android has still never been run, so it has no push either. The `remote-notification`
`UIBackgroundModes` entry that iOS warns about is genuinely not needed - alert pushes display
without it, and only silent `content-available` pushes would require it - so a second full rebuild
was not spent on it.

---

## 2026-08-08 (third) - Giving the ban a surface, and a dead end it would have shipped with

The client half, asked for while the founder was testing on the phone: the ban control on a member,
somewhere to lift one, and the DM report offering Block straight after.

### The screens stopped working out who may do what

The roster derived removal itself - target role, plus the viewer's own `isAdmin`/`isOwner`. Correct,
and a second copy of `canRemoveMember`'s ladder living in a component. Adding a ban meant adding a
**third** ladder that is asymmetric in the opposite direction (imposing follows removal, lifting is
open to any admin), which is exactly the moment a restated rule starts drifting.

So the server now answers `canRemove` and `canBan` per roster row, and `GET /users/:id?clubId=` adds
the same answers plus `banned` and `canLiftBan` to a profile card. The club is a **query parameter
rather than a second request**, because a profile is not a club-scoped object - the same person is
bannable by you in one club and untouchable in another - and the card reached from a roster should
draw its controls from the response that drew the card.

Same pattern as `canLeave` on a conversation and `canReadReports` on channel meta, and the same
argument each time: the copy that drifts is always the one drawing the button.

### The banned list is a section, not a screen

`MembersScreen` already takes arbitrary sections and a per-row tag, so the banned appear as a
**Banned section at the bottom of the roster** with no change to the shared component - tagged
"banned by Rogue Admin". That tag is the feature rather than decoration: an open power is made safe
by being visible, so a wrongful ban carries a name on the screen where undoing it is one tap away.

### The dead end it would have shipped with

A test written for something else refused to pass, and the reason was a genuine interaction between
this feature and the morning's audit fix:

**After a ban, the admin can no longer open the banned person's profile.** The ban removes them, so
the two share no club, so `canViewProfile` correctly refuses. The roster's Banned rows would have
offered "View profile" straight into a guaranteed "Not found".

Fixed by letting `profileHref` return `null` for a row, which omits the menu item entirely rather
than offering a link that cannot work. The profile's own unban control is not dead code, and a test
pins why: it appears when the viewer can still see the person for another reason, such as a second
shared club - which is asserted by building exactly that case.

Worth noting how it was found. Nothing about the failing assertion mentioned profiles or menus; it
said `banned` was false when it should have been true, and the reason was two features interacting
in a way neither one's author had in view. The mobile app has no component tests
([[clubchat-settled-ui-decisions]]), so a server test is the only place this could have surfaced at
all.

### The DM report now offers the thing that stops it

Reporting is reviewed; blocking is instant and self-service. They lived on opposite sides of the
screen - Report on the message menu, Block on the conversation header - so somebody frightened
enough to report then had to go and find the control that actually helps. A DM report now offers
Block immediately, only when there is a peer and only when they are not already blocked, because
offering a control that would be a no-op is worse than not offering it.

The dismiss says **"No thanks" rather than "Cancel"**, which would imply it undid the report. It
does not: the report stands either way, and wanting something looked at without cutting the person
off is a reasonable answer.

### The roster had never scrolled

Reported from the phone with a screenshot: the Banned section was visible, its row was cut off
behind the Add members button, and the list would not move.

**`body` was a plain `View` with `flex: 1`.** Not a `ScrollView` - so a roster taller than the
screen was simply clipped, and always had been. Invisible for as long as every club under test had
a handful of members; a Banned section was just the first thing to push the content past the fold.
It is a `ScrollView` now, with the padding moved to the content container. No hand-tuned bottom
inset was needed: the footer is in normal flow below the scroller, so it sizes itself against it.

Worth noting the shape, because it is the second time this week a new section has exposed an
older bug rather than introduced one: the feature that reveals a defect is rarely the feature that
caused it.

### The three dots became a long press

Asked for in the same message. The roster answered a tap on a small target with a bottom sheet,
while the Chats list and the club hub answered a long press by lifting the row with the screen
blurred behind it - one gesture wearing two different controls depending on which screen you were
on.

The roster now uses `ContextMenu`, the same component those two already use, with the row redrawn
as its own preview so the floating copy cannot drift from the real one. All three rosters get it,
since the screen is shared.

It also **removed** a hazard rather than adding one. The row used to be two sibling pressables
inside a `View` - a shape adopted deliberately, because a pressable wrapping another is failure
mode 17 and shipped here once. One pressable with both a tap and a long press has nothing nested
in it at all, so the trap is gone rather than avoided.

`MemberAction` gained an optional `icon`, with a neutral fallback rather than a required field, so
no caller could be caught half-updated while the phone was live-reloading against these files.

### Verification worth noting

Type check clean, `check:runtime` 68 modules, no em dashes, full suite green at **805 server**, 27
shared, 67 mobile. Three new server tests cover what the two surfaces are told they may do,
including the case above. Metro rebundled clean on every save.

**One run of the suite failed at file level in `retention.test.ts`** - a file unrelated to any of
this - and did not recur on two further full runs. It looks like the container-start flake recorded
as open question 15, but **the error text was not captured before it stopped reproducing, so that
is a guess rather than a diagnosis.** Recorded as unexplained rather than attributed, because that
same flake has already been confidently misdiagnosed twice (2026-08-03) and a third wrong
attribution is worse than an open question.

Two prop names were guessed wrong on the way and caught by the compiler rather than by a phone -
`Action` takes `variant="danger"`, not `destructive`, and `ConfirmDialog` takes `body`, not
`message`. Failure mode 16 in miniature, on the client's own components rather than on an API
response: the fix was reading the real signatures instead of the plausible ones.

**Left undone:** the platform moderation queue still has no screen, and the dependency pass is still
open. Both were on the list before this and neither moved.

---

## 2026-08-08 (later) - Removing somebody did not remove them

Asked for from the safety conversation the audit started, and the premise turned out to be exactly
right: *"let's say the admin kicks the person out. Then he is gonna join again if the club is open
to join."*

**It is worse than rejoining.** `joinClub` admitted straight into a club whose policy is `open`
with no check of any kind against a prior removal, and there was no ban concept anywhere in the
schema. So removal was a request to leave that the person could decline. On a request-policy club
they could re-ask indefinitely and an admin had to keep noticing and denying. And since ADR-0010
made the share link the only invite mechanism, a link already sitting in their messages kept
working - with token rotation, which breaks every outstanding link for everybody, as the sole
remedy for excluding one person.

### The interesting half was the safeguard, not the ban

The question that came with the request was the right one: *"let's say one admin is such a freak,
block the person who is a credible guy."* A ban is the most durable power an admin would hold.

The answer was already in the codebase twice, and it is worth naming because it decided the design:

- **Asymmetric authority.** `canRemoveMember` lets any admin remove a Member, restricts removing an
  Admin to the Owner, and forbids removing the Owner at all.
- **Narration as the check on an open power.** `canCancelMeeting` is deliberately open to every
  Eboard member rather than to the meeting's creator, and what makes that safe is that cancelling
  posts "X cancelled Y" into board chat.

So: **imposing follows the removal ladder, and lifting deliberately does not.** Any admin can ban a
Member, only the Owner can ban an Admin, and *any* admin can lift *any* ban. That is the one
asymmetric authority in the product, and it is the whole safeguard - a wrongful ban has to be
cheaper to reverse than to perform.

**Why it holds, which is the part worth checking rather than trusting:** a rogue admin cannot
reach the people who would reverse them. They may ban Members only, so every other admin and the
Owner survives any campaign they can mount, and each of them undoes it with one action. Maximum
damage is a set of wrongly excluded members, reversible by several people, with the rogue's name on
each ban *and* on the line club chat posted about it. At the Owner tier the question does not arise
at all: an Owner can already delete the club, so a ban grants them nothing new.

The narration was the founder's addition and it strengthened the design more than it looks. It is
what made dropping the written reason field affordable - accountability comes from the club seeing
who did it, not from the banning admin's own account of why. A reason field would have been a place
to write something damaging about a member who can never read it or answer it.

### One asymmetry accepted with its eyes open

Club chat says "banned"; the person themselves gets the existing removal notification, unchanged.
So the subject is the only party not told it was a ban until a Join button refuses them.

**That is the same shape as the 2026-08-05 race-removal defect** - narrated to the whole roster
except its subject - and it was raised before building rather than found afterwards. Kept anyway,
deliberately: naming a ban in a push is confrontational and the door tells them soon enough. It is
recorded in ADR-0021 and pinned by a test, so it changes on purpose or not at all.

### A defect the tests found that the design had missed

`banFromClub` reuses `cascadeOut` rather than repeating it, so race rosters, car groups, the Eboard
row and the socket revocations all happen exactly as they do for a removal. But the cascade only
runs when the person **was** a member - and it is also the only thing that clears a pending join
request.

So banning somebody who had asked to join barred them and left their request outstanding. Every
admin kept being asked to decide something already decided, and denying it was the only way to
clear it. The ban held; it just looked broken from the one screen an admin would be looking at.

Found because a test asserting something else failed on `already_pending`, which is the useful kind
of failure: the assertion was wrong *and* the code was wrong, in a way neither would have shown
alone.

### Verification worth noting

Type check clean, `check:runtime` 68 modules, no em dashes, full suite green at **802 server**, 27
shared, 67 mobile - 18 new tests, of which the ones that matter are the containment cases rather
than the happy path. `db:prove` gained four assertions, including the one that proves a ban
outlives the account that imposed it: deleting the banning admin nulls `banned_by` and leaves the
row standing, because a cascade there would quietly unban somebody every time an admin closed their
account.

Then proved live against a running API and worker, as non-negotiable 6 requires, rather than
inferred from the suite:

```
member removed              {"ok":true,"removed":true}
...and walks straight back  {"ok":true,"status":"joined"}     <- the defect
now banned                  {"ok":true,"banned":true}
tries to rejoin             {"error":"banned"}
tries the invite link       {"error":"invite_invalid"}
an admin tries to re-add    {"error":"banned"}

rogue tries to ban an admin {"error":"forbidden"}             <- containment
the Owner can               {"ok":true,"banned":true}
a plain member tries        {"error":"forbidden"}

a third admin lifts a ban they did not impose  {"ok":true,"lifted":true}
the wrongly banned member rejoins              {"ok":true,"status":"joined"}
```

And in club chat: `Credible Member was banned by Rogue Admin`, with the ban list naming the same
admin beside it.

**Not built:** any screen for it. The routes, the policy and the narration are done and the client
has no ban UI, which is the honest state - this was server work by agreement, and a ban list with
no screen is a smaller gap than a report queue with no reader because admins can still act through
the roster. It goes on the same list as the moderation queue.

---

## 2026-08-08 - The security audit, and two rules that were written down but never run

The audit `PRD/17` planned on 2026-08-03 and never started. Six sections, worked through by
reading, then proved by attempting the forbidden thing as the unprivileged actor - which is the
only reason either finding is in this entry rather than in the "looks fine" column.

**Two defects, both fixed. The rest of the surface came back clean**, and the clean half took
most of the time.

### The one that had been asserted three times and implemented never

`GET /users/:id` returned any account's name, bio, city, school and avatar to **any signed-in
caller** holding a uuid. `readProfile` took an `AccessContext` and never looked at it.

What makes this worth a long note is not the hole, it is why nothing found it. The rule was not
undocumented. ADR-0009 rejected global DMs partly *because* "profiles are visible only to people
who share a club". `sharesAClub`'s own docstring says "it is the same rule that makes profiles
visible". `PRD/03` lists public profiles as an explicitly rejected alternative, with the reason:
clubs are small and often include minors. Three documents, one rule, no predicate.

**That is the exact inverse of failure mode 10 and the pair belongs together.** An alias hides a
capability behind another capability's name, so an audit that counts predicates finds too few
definitions and knows something is wrong. This had no name at all - so counting predicates finds
nothing missing, because what is missing was never spelled. The method that found it was reading
the spec's *claims* against the code, which is the same method that found the Phase 3.75a gaps and
for the same reason: the code cannot list what it never had.

Proved twice, because the second version is the one that matters:

```
A clubs: []   B clubs: []          # no relationship of any kind
A -> /users/<B>   {"bio":"Sensitive: I am 15 and I go to Northside High", ...}

B blocks A        -> {"blocked":true}
A's DM candidates -> []            # correct: B has vanished from search
A -> /users/<B>   -> full card     # not correct
```

The block guarantee was enforced on the surface it was written for and nowhere else.

**Two existing tests had quietly encoded the hole**, asserting that a stranger could read a card -
they had been written when `signUp` produced two unrelated accounts and nobody thought about it.
Both changed meaning rather than being deleted, the same way `pin-and-clear` did in August.

The fix is `canViewProfile`, and two of its three branches needed an argument:

- **A conversation partner counts, not only a clubmate.** `PRD/14` rule 3 keeps a thread's history
  readable after the pair's last shared club goes. A name in readable history has to stay
  tappable, so gating on the shared club alone would 404 a card the product is still showing -
  which reads as a bug, not as privacy. It ends up the same two-part shape as `canBlock`, which is
  the tell that it is the right shape: both answer "can these two reach each other at all".
- **A block does *not* hide the card**, deliberately. Blocking stops messages and hides the pair
  from each other's search; it does not erase somebody from a club they are both still in, where
  their name and face are on every roster and beside every message they ever sent. Withholding the
  card alone conceals nothing and breaks a roster the blocker can already see. Recorded as a test,
  because it is the branch somebody will later "fix".

One behaviour change falls out and is correct: tapping the name of somebody who **left** your club,
in old history, now says "Not found" instead of opening their card. That is the same answer a
deleted account's profile has given since Phase 3.75a, and it goes through `DataScreen`'s retryable
state rather than a blank.

### The one where the check was right and simply was not asked often enough

`isSessionUsable` is asked on every HTTP request and was asked **once** per WebSocket, at the
`auth` frame. A client holds a socket open for hours with heartbeat pings.

```
                                   before                              after
shut-off account sends             msg.ack seq=2, row in the log       msg.err forbidden, socket closed
self-deleted account receives      still delivered, in real time       revoked before the next message
                (HTTP was correctly 401 in both cases, throughout)
```

The receiving half is the worse one and it needs no operator at all - just the shipped,
self-service `DELETE /me`. It also had a second, separate cause: `deleteOwnAccount` drops every
membership row in one transaction and **wrote no outbox event**, so it published no revocation.
Every other way of losing access already published one - club departure, club deletion, race
removal, Eboard demotion, Eboard departure. Account lifecycle was the only path that did not, and
it is the one path where *all* of somebody's access ends at once.

Both halves now fixed: `isSessionUsable` on every frame that already reloads the context
(`subscribe` and `msg.send`), plus an `account.deleted` event carrying the channel ids captured
before the delete, exactly as `club.deleted` does.

**Through the outbox rather than an immediate Redis publish**, and that is ADR-0006's argument
rather than a style preference: the event commits in the same transaction as the deletion, so no
crash can leave an account deleted with its sockets still attached. Publishing from the API is one
worker tick faster and gives up precisely the guarantee the outbox exists for. `effect-coverage`
paired the new event with its handler automatically, which is the test that exists because three
Eboard events once had no consumer at all.

Compare failure mode 12, which this sits beside: there the revocation check read a field
better-auth does not return and **never fired**. Here it fires, correctly, and not often enough -
which is harder to see, because every test of it passes.

### What came back clean, and why that took longer than the findings

A negative result is only worth anything if it was actually looked for, so:

- **All 124 routes** reach a channel guard, a predicate-bearing domain function, or an inline
  predicate. Checked by script rather than sampled - it flagged 17, of which 15 are reads scoped by
  `user_id` in SQL and two were the script failing to follow a closure and an inline
  `isClubAdmin`. `readProfile` was the one real hit.
- **No SQL injection.** The codebase contains exactly one `sql.raw` - `isoUtc` - and all 17 call
  sites pass a hardcoded column name. The three `ILIKE` concatenations build a *bound parameter*,
  not SQL.
- **Email is confined to `/me`**, checked against twenty read surfaces rather than argued from the
  code. That structural claim holds exactly as written.
- **Media**: presign scoped per channel, complete is uploader-only, download re-authorized on every
  request. **DM report queue** carries no message bodies, so the logged context read really is the
  only door to content.

One hygiene note that is **not** a defect, recorded so nobody re-derives it: twelve raw reads cast
a `timestamptz` with bare `::text` where seventeen others use `isoUtc()`. Every one of the twelve
is normalized through `new Date(...).toISOString()` before it leaves, so nothing is broken - but
they work only because V8 happens to parse Postgres's `2026-08-08 06:17:24.116823+00`, which is not
ISO 8601 and which a strict parser may refuse. `listDmThreads` and `listAccessibleChannels` return
the same `last_at` field with the same meaning and only one uses the helper. Failure mode 14 is the
half of this that already bit.

### Verification worth noting

Type check clean, `check:runtime` 68 modules, no em dashes, full suite green at **778 server, 27
shared, 67 mobile**. The four new tests were mutation-tested rather than trusted:

- **Visibility check removed** - the stranger-refusal test failed, alone.
- **The DM branch dropped from `canViewProfile`** - the two tests that cover a partner after the
  last shared club failed, and nothing else did.
- **The `account.deleted` event suppressed** - the deletion test failed on the missing outbox row.

Then both original proofs were re-run against the fixed code, live, rather than being assumed from
the tests: the stranger's profile read answers `not_found` and starts working the moment a club is
shared; the shut-off account's send comes back `forbidden` with the socket closed and the channel's
message count unchanged; and the deleted account's socket stops receiving.

**A spec correction found on the way**: `PRD/17`'s "Verification owed" table still said "the
simulator has never been run", dated 2026-07-30. A development build has run on a real iPhone since
2026-08-01 and most work since was reported from it. Android is the row that is still true, and now
says so on its own.

### The three operational findings, closed in a second pass the same day

Not defects in behaviour, which is why they had survived: nothing in the product works worse
without any of them, so no screen and no test ever complained.

**Security headers.** There were none - not a partial set, zero occurrences of any of them
anywhere in the codebase. One plugin on the whole instance rather than per route, for the same
structural reason the session hook and the rate limiter live on the scope. Three of helmet's
defaults had to be overridden and each would have been wrong here rather than merely strict:

- **`useDefaults: false` on the CSP.** Left on, helmet merges its document-shaped defaults
  underneath - `script-src 'self'`, `style-src ... 'unsafe-inline'`, `font-src`, `img-src`. None is
  dangerous and all of them describe a thing that does not exist: this process serves JSON and one
  302 and never a document. `default-src 'none'` already covers every fetch directive.
- **`X-Frame-Options: DENY`**, not helmet's `SAMEORIGIN`, which disagreed with the
  `frame-ancestors 'none'` I had just set. Two headers answering one question differently get
  resolved later by whichever one somebody reads first.
- **`Cross-Origin-Resource-Policy: cross-origin`**, because the default is `same-origin` and this
  API is deliberately read from another origin. Left at the default it would have refused the Expo
  web client while native carried on working - the exact failure shape this project has already
  shipped twice, and the reason the header set was checked against a live cross-origin request
  rather than just eyeballed.

**`trustProxy`.** Configuration rather than a constant, because both directions are wrong in
different ways and neither is a safe default to assume. Unset behind a proxy, `request.ip` is the
proxy's and the per-IP sign-in bucket becomes one bucket for the internet - which fails closed and
is still useless as credential-stuffing protection. Set to `true` on a directly reachable process,
any caller forges `X-Forwarded-For` and takes a fresh bucket per request, which *removes* the limit
rather than loosening it. Default `false`; `1` is the Fly.io answer.

The trap worth recording is in the parsing. **`'false'` is a non-empty string and therefore
truthy**, so handing the raw environment value to Fastify trusts every hop precisely when it was
told not to - an inverted setting, not a loosened one. `trustProxyOption` exists for that one line
and the test pins it.

**`.env.bak`.** Untracked, and `.gitignore` changed from `.env`, `.env.local`, `.env.*.local` to
`.env*` with `!.env.example`. The file only ever held a placeholder; the finding was always the
*pattern*, since a denylist of remembered suffixes is the wrong shape for secrets. Verified by
asking `git check-ignore` about five spellings rather than by reading the glob.

Six tests, in a new file, because both findings share a failure mode rather than a subject:
neither is reachable from any screen, so nothing gets worse when they silently stop working. All
six were mutation-tested - unregistering helmet failed four, wiring `trustProxy` with the raw
string failed the parsing one, and dropping `frameguard` failed exactly the header-agreement one.
One of them was rewritten first: the closed case read `socket.remoteAddress` while the open case
read `request.ip`, which is two different measurements and so not a comparison at all - it would
have passed whatever `trustProxy` did.

**The dependency advisories: triaged, not fixed, and the triage is the useful part.** `PRD/17` said
"15 moderate, mostly `@expo/config-plugins` transitives". It is now 30 - 12 moderate, 18 high - and
the count is the least interesting fact about them. **Exactly one reaches the deployed server's
request path**: `fast-uri`, through `fastify` to `@fastify/ajv-compiler` to `ajv`. Every other one -
`image-size`, `js-yaml`, `brace-expansion`, `uuid`, `esbuild`, `nanoid` - arrives through Expo,
`drizzle-kit`, `vitest`, or an optional `expo-sqlite` peer of `drizzle-orm`, and runs on a
developer's machine rather than in production.

`fast-uri@3.1.5` patches it and sits inside the `^3` range `ajv` already accepts, so it is a patch
bump rather than an upgrade. **The `overrides` entry did not work**, and it is worth saying plainly
rather than quietly reverting: npm 11.12.1 reads the key back through `npm pkg get` and never
writes it to the lockfile, with the lockfile deleted and regenerated. Two `fast-uri` copies exist
at different majors, so any override has to name both - that was found and corrected and changed
nothing. Backed out rather than left half-applied. `npm audit fix --force` is not the next step
either: it moves Expo 57 and TypeScript 6, both pinned deliberately per `AGENTS.md` 5.1. This needs
a real dependency pass, which is its own piece of work.

**Still open after both passes:** the dependency advisories above, and the platform moderation
queue having no screen.

---

## 2026-08-07 - The mail provider, chosen and wired

`clubchatapp.com` was registered this morning, which unblocked the follow-up
[ADR-0019](SPEC/decisions/0019-outbound-mail-is-a-port-with-a-deferred-provider.md) had left
open: pick a provider. The port did what it was built to do - the whole change is one new class,
two config fields, one branch in the entrypoint, and **nothing in `auth.ts` or in any of the
fifteen suites that build `createAuth`**.

### What decided it, which was not the code

All three candidates are one authenticated POST, so the comparison came down to the tiers, and
the interesting part is that both free tiers fail in ways their pricing pages do not advertise.

Postmark's free tier is 100 emails per *month* with **no overage allowed**. For auth mail that is
a cliff, not a budget: the 101st reset of the month is simply not sent, while the member is told
to check their inbox. Resend's is 3,000/month but capped at **100 per day and one domain** - and
the daily cap is the one that bites a club, since forty members signing up on the same evening is
forty verification mails in an hour.

Resend won on the free tier being survivable and on there being no human approval step before the
first send. Postmark stays the better answer on pure deliverability, and the port keeps that
reversible - though the IP reputation would not come along, only the domain's.

There was also a constraint nobody anticipated: the Resend account **already held a verified
domain**, and the free tier allows exactly one. Rather than delete it or upgrade immediately, the
integration was pointed at the domain that was already verified. That is the reason `MAIL_FROM`
is configuration and not a constant - the sending identity has to move to `clubchatapp.com` later
without a code change, and that move is already scheduled.

### The half-configuration that fails at boot

`RESEND_API_KEY` alone would have been the worst possible state: Resend rejects a send with no
`from`, better-auth throws that away in the background, and the member watches an empty inbox.
That is the exact failure `assertProductionMailer` exists to prevent, arriving through a door it
does not watch - it only asks whether the transport is `LoggingMailer`. So `config.ts` grew a
cross-field refine: a key without `MAIL_FROM` is a startup failure with a message saying which
one is missing.

### No SDK, and what that bought

`ResendMailer` is a `fetch` call. The `resend` package exists to give you React Email templates
and typed responses; this product sends one plain-text message and reads back a status. What the
absence of the SDK actually bought was testability - `fetch` is injected, so the request shape is
asserted with no network and no global stub.

That matters more here than the usual argument for it. better-auth calls `sendResetPassword`
through `runInBackgroundOrAwait` and discards what it throws, so a wrong header or a `from` the
account cannot send as would present identically to the member: a page saying "check your inbox",
and an inbox that stays empty. There is no integration test that catches that and no user report
that describes it. The request shape is the only place it can be pinned down.

### Verification worth noting

Type check clean, full suite green at **774 tests across 33 files**. The six new tests were then
mutation-tested rather than trusted:

- **Wrong endpoint** (`/email` for `/emails`) - the endpoint test failed, alone.
- **Abort signal removed** - the timeout test failed. Worth having, because the signal is the
  only thing that ends a request nobody is holding the promise for.
- **Resend's failure reason dropped from the error** - the refusal test failed. That reason is
  the sole surviving evidence of an unverified domain, which is the likeliest first failure in
  production.

One test asserts the API key never reaches the error string, since that error is logged and
non-negotiable 5 forbids it appearing there.

### Left undone, deliberately

Bounce and complaint handling, exactly as ADR-0019 left it - Resend has webhooks for both and
nothing consumes them, so a hard bounce still means a reset link went nowhere and nothing in the
product knows. DMARC also has to be published by hand: Resend's domain verification requires SPF
and DKIM but **not** DMARC, so it is the one record that will not appear on any setup checklist.

A stale-index bug was found in passing: `SPEC/README.md`'s ADR table stopped at 0018 and had
never listed 0019. Both it and 0020 are in it now.

### The domain was verified, and published nothing

Written up as a checklist because it cost an hour and would have cost far more later:
[`SPEC/templates/sending-domain-checklist.md`](SPEC/templates/sending-domain-checklist.md).

Explaining DMARC meant looking at what the sending domain actually published, and the answer was
**nothing**. `parkstechusa.com` had no SPF and no DKIM anywhere in DNS - confirmed against the
authoritative nameserver, not a cache - while Resend's dashboard and API both reported it
`verified`. It had been verified on 2026-06-30 and the verdict cached ever since; the domain was
later moved to Vercel's nameservers and the mail records did not come with it.

So every reset mail sent that day went out unauthenticated, and all of them were accepted. That
is the trap: **delivery is not authentication.** Gmail took them because the volume was tiny, SES
has its own reputation, and the recipient was the sender. None of that holds for real members,
and unauthenticated sending accrues damage to a domain slowly and stickily.

Restored the three records through Vercel's DNS, then re-checked at the authoritative
nameserver, at `8.8.8.8`, and finally at the receiver. Gmail's *Show original* is the only one of
those that is evidence rather than a claim, and it went from failing to `SPF: PASS` and
`DKIM: PASS` with `d=parkstechusa.com`. `DMARC: FAIL` remained, which is what an absent policy
record looks like rather than a misconfiguration - and since DKIM's domain already matched the
`From:` exactly, publishing `v=DMARC1; p=none` was enough to satisfy alignment.

Two things worth keeping. The provider's own status is the weakest evidence available and should
be read as a claim; and DMARC appears on no provider setup screen, because verification requires
SPF and DKIM and stops there.

---

## 2026-08-06 - Swiping the calendar, and three wrong answers before the right one

Asked for plainly: keep the arrows, add swiping, and put a year and month picker on top - the
picker offered up to be looked at and reworked, the swipe called "very important".

### The swipe, and why it is not a PanResponder

The obvious build is a `PanResponder` translating three months across a row. It was built that
way first and **it did not work**: the row moved 22 pixels, exactly one drag step, and froze.

The instinct was that the responder was being taken away by the 42 day cells underneath, each of
them a `Pressable` asking for the gesture as the finger crossed it - and
`onPanResponderTerminationRequest` does default to true, so that fix went in and is right. It was
not the cause. The row still stopped after one step.

**The better answer was to stop hand-rolling it.** The hard part of this gesture is not the
translation, it is the arbitration: a horizontal drag belongs to the pager, a vertical drag to
the page scroll, and a tap to whichever day is under it. A horizontal `ScrollView` with
`pagingEnabled` already resolves all three, on both platforms, and it brings the snap physics
with it. Three months are rendered, it rests on the middle one, and a commit recentres it.

### The heading was half a second behind the grid

Reported from the phone: the swipe felt right, the month name did not arrive with it.

The cause is that committing is deliberately LATE - it waits for the scroll to come to rest - so
a heading driven by the committed cursor sits on the old month for the whole animation and then
snaps. The heading now reads the live offset and flips at the halfway mark, which is also where
the snap commits: the month owning most of the screen is the month named. Drag back without
releasing and it reverts, so it never lies about a swipe that snapped back.

`MonthGrid` is memoised as part of that. The live heading re-renders the pager mid-gesture, and
without it that rebuilt 126 cells across three grids at the exact moment the frame budget is
already going on a scroll.

### Bugs hit, with root causes

**A settle that acted on a 140ms-old offset.** The commit was scheduled on a timer and read the
offset captured when the timer was set, which is most of a snap animation out of date - correct
only when the scroll had already stopped. It reads the live value now, and `onMomentumScrollEnd`
supplies the authoritative one on a device.

**A commit that could fire twice.** Committing recentres, recentring scrolls, and the scroll
came straight back into the handler. The second pass acted on an offset the first had already
consumed, which surfaced as a swipe moving the calendar the wrong way.

**A red screen on the founder's phone, caused by the editing rather than the code.** `memo` was
added to `MonthGrid` in one save and to the import line two saves later. Fast Refresh pushed the
window between them straight to the device: *"Property 'memo' doesn't exist"*. The served bundle
was already correct by the time it was looked at.

> **The app is live-reloading against files being edited, so an intermediate save is a crash on
> somebody's phone.** Order edits so the file is never broken - imports before usage - or make
> the change in one write.

### Verification worth noting, and its limit

Driven through the real web build rather than reasoned about: eight pages forward and back
across a year boundary, the heading asserted at 30% dragged (unchanged), 60% dragged (already
the next month) and dragged-back (reverted), the picker jumping to March 2027 and swiping on
from there, and **This month** returning to today.

Two of those runs produced results that looked like product bugs and were harness artifacts. A
mouse drag does not scroll an overflow container on the web, so dragging proved nothing; and
`scrollTo({behavior: 'smooth'})` into a mandatory snap container sent the offset to 0 rather
than to the requested page, which the component then read correctly as "previous month". A probe
printing the offsets the component actually received is what separated the two, and it is worth
reaching for sooner than it was here.

**What none of it covers is how the snap feels under a finger.** That is the phone's answer, not
the browser's.

---

## 2026-08-06 - The long-press menu, and a prop that went missing without failing

Asked for from a phone in three parts, each one arriving after the last was built: the chat list
does not buzz the way chat does; a race should be pinnable by long press; and then, with a
screenshot of another app, *"do you see how the way it pops up? I wanted like that."*

### The same gesture felt like two different controls

Chat bubbles called `Haptics.impactAsync(Medium)` inline. The chat list called nothing. A long
press has no visual progress, so with no buzz the only signal it worked is the menu arriving, and
the only signal you have not held long enough is nothing happening - indistinguishable from a dead
control on the one screen the app opens to.

Rather than copy the line, `longPressFeedback` is now the single place the feel is decided.
"The same vibration everywhere" is a claim about one constant, and it is only true if there is
literally one.

### Delete chat was DM-only because somebody decided it, not because it was hard

`canClearChannel` read `channel.scope === 'dm' && isChannelMember(...)`, and the note above it
said the restriction was a product decision and that "if clubs ever want it, this is one branch".
They did. It is now `isChannelMember` alone.

Widening it is safe because clearing is **personal**: one `channel_clears` row for one user, and
everybody else's history is untouched and unaware. That is the whole distance between this and
deleting a message, which is authority over a shared room.

**A test changed meaning rather than being added.** `pin-and-clear.test.ts` had a case called
"is refused outside a DM, where the product does not offer it". It now asserts that a club chat
clears, and - the half that matters - that the other member still sees every message.

### Two fields the menu needed, and where they came from

- **`canLeave` on `ConversationSummary`**, answered by `canLeaveClub` server-side. The Owner
  cannot leave their own club, and `PRD/04` says the action is not rendered for them at all. The
  client could have worked that out from a role and that is exactly the point: it would have been
  a second copy of the rule, and the copy that drifts is always the one drawing the button.
- **`muted` on the race list row.** Without it the club hub's menu would guess, and a menu
  offering "Mute" to somebody who already muted the race is a control that appears to do nothing.
  False without access, like `channelId` beside it: no chat, no mute.

### The founder could not find Leave club, and the menu was right

Reported as missing. It was not: **he is the Owner of Binghamton Running Club**, so `canLeave` is
false and the item is correctly absent. Confirmed against the dev database rather than argued
about, and then demonstrated by long-pressing a club where the test account is a plain member,
where it appears.

Worth recording because it will read as a bug again. A rule that hides a control is invisible to
the person it hides it from, and the one account that hits it every time is the founder's.

### Bugs hit, with root causes

**The lifted row landed a header's height below the row it was copying.** `measureInWindow`
reports window coordinates; a `position: absolute` overlay is placed against its nearest
ancestor. On the club hub the menu renders inside a ScrollView beneath a native header, so the
two coordinate systems differed by exactly that header - and the header stayed unblurred above an
overlay that could not reach it. The fix is a `Modal`, which renders at the root, and which
`ConfirmDialog` had reached for first for the same reason. Only visible by looking: the numbers
in the code were all correct.

**Tapping a race stopped opening its chat, and nothing failed.** This is the one worth reading
twice. The row had been `<Link asChild><Pressable/></Link>`; extracting `RaceRow` so the lifted
preview could reuse it left `asChild` wrapping a **function component**. `asChild` clones its
child and injects `onPress`; a `Pressable` accepts that, and a function component silently drops
every prop it does not destructure. The row still rendered, still long-pressed, still looked
perfect, and did nothing when tapped.

> **Type checking, 753 tests and a clean production bundle all stayed green through it.** Dropping
> a prop React never asked about is not an error in any of those senses. It was found by the
> founder, on a phone.

Now navigated by an explicit `onPress` and `router.push`, the way the Chats list had always done
its own rows, with one `raceHref` for both lists. Every other `asChild` in the app was swept and
they all wrap a real `Pressable`.

### Scope, honestly

**`apps/mobile` has no component tests** - its six test files are dates, mentions and calendar
maths. A dropped press handler is invisible to every check that exists here, which is why the
regression above reached a phone. Adding React Native Testing Library was offered and not done
unilaterally, because it is a new test dependency and that is the founder's call.

Verified by driving the real web build: both menus screenshotted, the lift measured against the
row's own rectangle (168 against 168, 337 against 337), the locked race confirmed to offer Pin
alone, and all four navigation paths clicked rather than reasoned about.

---

## 2026-08-05 - The removal that nobody was told about

The other half of the roster work below. That session taught race chat to narrate its own
roster; this one found that the person the narration is *about* is the one member who cannot
read it.

### Race removal notified nobody, and the reason it went unnoticed

`onRaceMemberDeparted` revoked the departing member's subscription, posted "Mike was removed by
Sarah" into race chat, and stopped. It never wrote a notification. Club removal and Eboard
removal have written a `member_removed` row since Phase 1; race was the only one of the three
that did not, and the founder's report was simply that the race vanished from the phone of the
person taken off it with nothing said.

**What hid it is the ordering that the session below deliberately introduced.** The revocation
happens *before* the line is posted, because you do not deliver "Mike was removed by Sarah" to
Mike, live, in a room he has just lost. So a removal is narrated to the entire roster **except
its subject**. Read from the roster side everything looked right - the line was there, the
unread count moved - and the one person with no way to see any of it was the one the act was
about. A departure has an audience of everybody and a subject of one, and only the audience
half had been built.

The gate is `actorId`, the same signal the two sibling handlers read: null means they left of
their own accord, and "you removed you" is noise.

### The wording bug found on the way, which was worse than the missing row

`member_removed` carried `{clubId, clubName, actorName}` and rendered "**Sarah removed you from
Hillside Running Club**". Reusing it unchanged for a race would have told somebody who lost one
race roster that they had lost the whole club - while they still held their club membership,
their club chat and every other race in it. A false alarm about exactly the thing the reader
most wants stated accurately.

**Eboard removal had been shipping that sentence since Phase 1.** It writes the same type with
the same params, so it has always said "removed you from Hillside Running Club" to somebody who
lost only the private space. Nobody had noticed, because the only way to see it is to be removed
from an Eboard and read the notification carefully.

So `member_removed` gained optional `scope` and `scopeName`, and all three writers now pass
them. `member_added` and `request_denied` already carried the same fields, which is the tell:
the add path had been scope-aware from the start and its mirror image never was.

Two shape decisions worth keeping:

- **No `scopeId`, unlike its `member_added` twin.** The space it names is precisely the one the
  reader can no longer open, so the row points at the club. `request_denied` is shaped this way
  already, for the same reason.
- **The body names the space; the title stays the club.** Titling it with a race would promise
  a destination the tap does not go to. That split is `request_denied`'s too.

Both fields are optional rather than required, because rows written before today carry neither
and PRD/12 rule 6 requires a row to keep rendering years later. The renderer falls back to the
club, which is what those rows always said. A test pins the fallback so nobody "tidies" it away.

### Scope, honestly

Push was considered and deliberately not added. The accept and add paths write an inbox row and
send no push - only announcements, mentions, DMs and new content push - so parity with "how we
accept someone" is the row and the badge. Being removed is arguably louder than being added, but
that is a change to the whole membership tier rather than to this one handler, and it was not
what was asked for.

Verified by full suite (751 server, 27 shared, 67 mobile) plus four new tests: the removal
notification naming the race, silence on self-leave, the race and Eboard wording, and the
legacy-row fallback.

---

## 2026-08-05 - Four things that were right, and a fifth that never fetched them

A day of notification and roster work that ended by finding the defect underneath the other
four. Every one of them was reported from a real phone, and the last one is the reason the
first four looked broken after they were fixed.

### A race request went to people with no stake in the race

`race_join_request` resolved to the club's whole admin tier, so an Owner running none of the
club's races was paged for every one of them. It now resolves to the admin-tier members holding
a **roster row on that race**.

`worker/audience.ts` had said so at the top of the file since it was written - rule 2, "race
audiences are roster members only, never roster union club admins" - and then did the opposite
for join requests and for the stranded-Incharge notification. A rule stated in a comment and
contradicted forty lines below it is worth more suspicion than a rule nobody wrote down.

**Authority is untouched.** `canManageRace` is still every club admin (PRD/09 rules 4 and 5), so
an off-roster admin who opens the roster can still approve. They are simply not paged about a
race they are not on.

The founder's call on the empty case, recorded because it looks like a bug when read cold: a
roster with no admin left on it notifies **nobody**, and the request waits on the roster screen.
No fallback, no widening to people who are not involved. The recovery is 3a below.

### The decided request that kept asking

A request notification goes to everyone who could act on it, and exactly one of them acts. Every
other copy then described work that no longer existed: still "X asked to join", still
deep-linking to a roster with nothing pending on it, and - because `markInboxRead` deliberately
refuses to clear the three request types - still unread against the badge until that particular
admin happened to open that particular roster. An admin who was away for the whole thing met a
job that had been done hours earlier.

`PRD/12` rule 5 had asked for the fix since Phase 1: *"a decided join request stays in the feed,
tagged Approved or Denied."* It was half-built in the most invisible way. `InboxRow` declared
`decision?: 'approved' | 'denied'`, the client already rendered the chip, and `readInbox` never
populated it. Both ends complete, nothing joining them.

`resolvePendingRequests` now stamps the outcome and the decider onto every copy and marks it
read, so the row restates itself as "Sarah approved Mike's request to join Fall Classic".
Naming the decider is the part that earns its place: an admin arriving late does not ask whether
it was handled, they ask **who** handled it.

Three details carry it. `params ->> 'decision' IS NULL` is what makes the sweep safe against a
re-filed request, since `(scope, requester)` is not unique over time. `COALESCE(read_at, now())`
keeps an existing read timestamp rather than inventing a moment. And the decider's own copy is
resolved too, reading "Sarah approved" rather than "you approved", because the renderer works
from the row and not from who is looking at it.

**The founder kept roster-open clearing** rather than having a pending row stay unread until
decided. Asked and answered; do not re-open it.

### Race chat had never said a word about its own roster

Club chat and Eboard chat have narrated joins and departures since Phase 1.
`onRaceMembershipDecided` wrote the requester's notification and stopped, and
`onRaceMemberDeparted` only revoked the socket. Approving somebody into a race was invisible.

Invisible **everywhere**, not merely quiet in the room, and that is the half worth keeping. A
channel's unread count is derived from its messages, so a roster change that posts no message
produces no unread, no badge, and no sign for anybody already on that roster. The founder's
report - *"it didn't say anything in the chat, and the notification doesn't pop up to anyone"* -
is one symptom, not two.

Four lines now, split the way club chat splits them: somebody who got themselves here joined,
somebody an admin put here was added by them. A denial still announces nothing, which is the
rule the Eboard handler already followed. On departure the revocation happens **before** the
line is posted, or "Mike was removed by Sarah" is delivered live to Mike in a room he has just
lost.

### Three smaller things found in the same code

- **`addRaceMember` never checked the target was somebody else**, so any manager could pass
  their own id and walk onto any roster in the club. PRD/09 rule 4's "management authority is
  not access" held only until an admin decided otherwise. That capability is now the Owner's
  alone and deliberate (rule 3a), as the escape hatch for a roster whose last admin has gone.
  One existing test turned out to be leaning on the loophole to give an owner a roster row, on
  top of the auto-roster `createRace` already performs.
- **A direct add told the person their request had been approved**, ignoring the `added` flag
  the club and Eboard handlers both honour.
- **A direct add left the pending request pending forever**, so the person was on the roster and
  still listed as waiting, with no decision left available to settle it. `addEboardMember` had
  always closed it; the race path never did.

### Pick people off a list instead of interrogating a search box

The race form required two characters before showing anybody, then hid whoever was already
picked, so choosing eight people was eight searches and the only record of the choice was a row
of chips. It now shows the club up front, tinting a chosen person in the accent, with search
narrowing the list rather than being the only way to see it. The Eboard and race rosters got the
same picker.

**The club roster is deliberately excluded.** Its candidate pool is everybody you share *any*
club with, which is not a list anybody reads down - the panel would open onto a wall of
near-strangers. One presentational `MemberPicker` serves all three hosts and fetches nothing
itself, because the pools come from opposite places: the race form filters a club roster it
already holds, the roster panel asks the server for people who are **not** on the roster yet.

Server side, adding is a list everywhere now and the singular calls it with a list of one, so
there is one authorization and one transaction. That also fixed what the old client-side loop
did to chat: one request per person meant one "was added by" line per person, so a race created
with eight people opened onto eight near-identical lines before anybody had said anything. A
batch is one event and one line - "Sarah added Mike, Alex and 3 others to the race" - while each
person still gets their own notification, since that one is addressed to them individually.

Somebody already on the roster is skipped rather than refused, because the picker's list is a
snapshot and failing seven good additions over one stale row is the worse answer. A non-admin in
an Eboard batch still refuses the whole thing: that is the caller asking for something the space
does not permit, which is a different kind of wrong.

### And then none of it showed up

The founder joined a race and landed in a chat saying "No messages yet", over a channel the
server had already written "PwOwner joined the race" into. The batch add looked equally silent.

**The server was right the whole time.** The rows, the wording, `channels.last_seq` and the
outbox were all correct in the database, with no parked events and no errors. The defect was in
the client, and it was older than any of the day's work:

> `channels` is replaced wholesale at `auth.ok` and never again, and `syncAll` walks exactly
> that list. A channel gained **during** the session - a race just joined, been added to, or
> created - was in nobody's list, so nothing ever fetched its history.

Joining a race redirects straight into its chat, which put this on the worst possible screen:
the first thing you see after joining is the room you are told is empty. Reloading fixed it,
which is exactly what made it read as "the server never posted anything".

Live frames were unaffected, and that is why it hid for so long. Anything sent while you sat in
the room appeared immediately; only the history you arrived too late for was missing. Both
halves were individually correct.

`openChannel` now subscribes to a channel the session did not start with and syncs it, and the
chat screen calls it on arrival for **every** channel rather than only unknown ones - syncing
one already in hand is the cheap case, and a condition there would be one more rule to get
wrong.

### What the tests could not have caught

Every server test passed at each step, and they were not wrong: the server was right. Nothing
exercised the client actually displaying any of it, so a whole day's work could be correct
end-to-end in the database and invisible on a phone.

It was found by driving the real app in a browser with Playwright - reproduce, reload to prove
the server, fix, re-verify. Two habits earned their keep and are worth repeating:

- **The web target works** (`expo start --web`), and it is far faster than the device for
  anything that is not native. It needs its own API on 3100 with `CLIENT_ORIGIN` pointed at it,
  or CORS refuses every call and the app reports it as being offline.
- **A test's fakes can hide the thing under test.** The new server tests stubbed Redis as
  `null`; these handlers publish, a null client throws inside the drain, and the outbox absorbs
  that as a retry - so the effect would have parked silently while the assertions passed against
  a database nothing had written to. The client fixture had the mirror problem: its fake `/sync`
  answered for one channel whatever it was asked, which cannot tell a sync of the right channel
  from a sync of the wrong one.

---

## 2026-08-04 - The retry budget that lasted 1.25 seconds

Started as a conversation about what a microservices ClubChat would look like, went through the
outbox pattern from first principles, and ended with two defects found by reasoning about the
code rather than by anything failing.

### The budget was a formality

`MAX_ATTEMPTS` was 5, the drain polls every 250ms, and the claim query filtered on
`attempts < MAX_ATTEMPTS` and nothing else. No delay between attempts, no `next_attempt_at`, no
backoff of any kind. So a failing row was re-claimed on every tick and parked roughly **1.25
seconds** after its first failure.

Concretely: a provider goes down at 10:00, every dependent event has parked by 10:00:01, the
provider recovers at 11:00, and nothing retries, because parked rows are never re-claimed.

`TECH/04` said "failures retry with backoff." It had said so since Phase 0 and it was never true.
That is the worst way for a doc to be wrong, because a policy written down is a policy nobody
rereads the code to verify.

### Backoff, and why jitter is not decoration

Added `next_attempt_at`, gated the claim on it, raised the budget to 8. Delays start at 2.5 to 5
seconds and grow by a factor of four, capped at an hour: roughly 75 minutes of coverage at worst,
two and a half hours at best.

Equal jitter rather than full jitter. The failure jitter prevents is the thundering herd - ten
thousand events failing against one dead provider, all waiting the identical interval, all
retrying in the same millisecond and flattening the service the moment it recovers. Full jitter
spreads them more but can schedule a retry almost immediately, wasting an attempt on an outage
that has not moved. Equal jitter keeps a floor under the wait.

The first retry is deliberately quick, because the commonest failure is a blip already over.

### The change that only works as a pair

Backoff alone makes a hopeless event **worse**. Yesterday's corrupt PNG would now take over an
hour to reach a conclusion available on attempt one, reporting nothing in the meantime.

So `PermanentEffectError` landed in the same change: a failure known to be about the data parks
immediately instead of counting to eight. Applied to `club.created` with a malformed payload,
since the payload is frozen at write time.

Deliberately **not** applied to an unknown event type, which superficially looks like the same
thing. The commonest way to reach that line is a rolling deploy where an old worker briefly sees
an event only the new code handles. It heals well inside the schedule, and parking on sight would
turn every deploy into an incident. There is a test asserting it stays retryable.

### Found and deliberately not fixed

The partition key's ordering guarantee is not enforced on the failure path. When an event fails,
the drain records the error and moves to the next row in the batch, including rows in the same
partition, so ordering holds while everything succeeds and breaks silently when anything does not.

It matters less than it sounds for user messages, whose `seq` is allocated in the send
transaction: a failed effect only delays the live fanout, and the client's gap rule detects the
hole and syncs into the correct order. It matters for **cards**, which the worker appends, so
their `seq` is decided by when the effect ran. A failed poll card and a later successful event
card land reversed, permanently, with no hole for the gap rule to find.

Left alone on purpose. The fix introduces head-of-line blocking, which combined with hours of
backoff could freeze a channel until tomorrow. The real answer is that the lane is too wide -
ordering is causally required per entity, not per channel - and that is a bigger change than the
problem currently justifies.

### Verification

Both features mutation-tested: removing the `next_attempt_at` gate fails exactly the two backoff
tests, and forcing `permanent = false` fails exactly the fast-park test.

Then live, against the running worker. A corrupt image was pushed past the boundary the way row
49 originally got there, and completed on attempt 0 with `derive_error` recorded rather than
retrying eight times. A permanently failing event was watched for two minutes: attempt 4 of 8,
counting down five minutes to the next try, where the old code would have parked it in 1.25
seconds.

One self-inflicted false positive worth recording. The first live media check appeared to pass
while proving nothing: the media id was reconstructed from an 8-character prefix the smoke script
printed, so the `UPDATE` hit zero rows and the event succeeded because the object was **missing**,
not because it was corrupt. `deriveVariants` returns `skipped` for a missing row, which looks
identical in the outbox. Re-run against the real UUID.

### Notes

Long-form study notes on the outbox, backoff, jitter and the three defects live in
`learnings/outbox-retries-and-backoff.md`, which is gitignored and therefore local only.

---

## 2026-08-03 (later) - A 97-byte PNG, and the alarm that could never clear

The worker logged `outbox events are PARKED - an effect never ran` with `parked: 1` on the first
tick after a restart. It had been true for four days.

### What it was

Outbox row 49, `media.uploaded`, five attempts, `last_error: vipspng: libpng read error`. Pulling
the object back through the S3 API: 97 bytes, a valid PNG signature, a valid `IHDR` declaring a
4x4 RGBA image, and an `IDAT` chunk announcing 42 bytes of pixel data with only 40 present before
`IEND`. **Two bytes short of a file.** The arithmetic is worth keeping because it is what made the
diagnosis certain rather than plausible: signature 8, `IHDR` 4+4+13+4, `IDAT` header 4+4, then 44
bytes remaining before a 12-byte `IEND` where the declared chunk needs 46.

It was the first upload in the database. Every later image derived fine, including three 74-byte
PNGs - so it was never a size problem or a sharp problem.

The owning message was still live and undeleted in the channel, `status = 'ready'` with
`variants = {}`. The documented fallback - serve the original when a variant is missing - resolved
to the 97 bytes that do not decode. There was no good image to fall back to.

### The two bugs, and only one is about corrupt images

**`/media/:id/complete` could not tell.** It verified everything a `HEAD` can see - the object
exists, the byte count matches exactly, the content type matches - and all three passed. "Is this
an image" is not a fact a `HEAD` carries.

**The parked row was the wrong alarm.** Parking means an effect never ran, and the retention sweep
never prunes a parked row because it is the only durable evidence of that. But `media.uploaded` is
the one event type that can fail on bad input rather than on a bug, and bad input is
user-reachable: enough corrupt uploads and `parked > 0` is pinned on permanently. Which is exactly
why this went unnoticed - the alarm was true, permanent, and indistinguishable from an incident.

### The thing that nearly made the fix useless

The first instinct was a cheap header probe. `sharp.metadata()` parses `IHDR` and reports 4x4 for
this file **without complaint** - the header is intact and the damage is at the tail. Only walking
the pixel stream reaches it. Checked before building anything, which is the only reason the gate
is a full decode.

`resize(1, 1)` fails the same way for a different reason: libvips shrinks a JPEG on load, so a
downscale can satisfy itself from a fraction of the file and never read as far as the damage.
Settled on `stats()`, which walks every pixel with bounded memory, where `.raw().toBuffer()` would
materialise ~70 MB for a 25 MB JPEG. `failOn: 'error'` rather than sharp's default `'warning'`,
because refusing somebody's photograph over a warning is a worse failure than deriving it.

Full decision, cost and rejected alternatives in
[ADR-0018](SPEC/decisions/0018-decode-uploads-at-the-boundary.md). The uncomfortable part is
recorded there too: this is the one place the server touches file bytes, and `TECH/07` said it
does not.

### Checked before committing to the gate

Whether the installed sharp can decode HEIC. It can (0.35.3 / libvips 8.18.3, `heif` input
`true`), which matters more than it looks: the gate makes HEIC support load-bearing for *uploads*
rather than only for thumbnails. A build without libheif would reject every iPhone photo outright
instead of merely failing to derive one. Noted as a follow-up if the base image ever changes.

### What the tests were hiding

`simulateUpload` wrote zero-filled buffers and completed them as `image/jpeg`, so the whole media
suite uploaded things no image library would accept. A comment in the derivation test said so
outright - "Sharp cannot resize bytes that are not an image" - and hand-wrote the variants row
instead of deriving it. The helper now encodes a real 64px image per format and declares its
actual length, and that test derives for real.

Both halves were mutation-tested: removing the boundary refusal fails exactly the boundary test,
and rethrowing instead of recording in `deriveVariants` fails exactly the parking test. A third
test guards the other direction, that the gate is not simply refusing everything.

### Verified on the real row, not just in tests

Rather than hand-patching row 49 to `processed`, its `attempts` were reset to 0 and the running
worker drove it through the new path: `media does not decode, derivation abandoned`, event
processed, `derive_error` recorded on the media object, parked count 0.

Then live through the running API with a real account and a real presigned PUT: the truncated PNG
returns `422 {"error":"undecodable"}` and its row stays `pending`; the same image intact returns
200, goes `ready`, and the worker derives both variants.

### Left undone, deliberately

The broken message is still in the channel. The media object is recorded as underivable and
nothing surfaces that to a client, so it still renders as a broken image - deleting somebody's
message is theirs to do. A viewer placeholder for `derive_error` is noted as follow-up in the ADR.

---

## 2026-08-03 (close) - Four gaps closed, and the security audit written down before it is run

The day started with "the features are in, how is the architecture" and ended with the four
operational gaps closed: error monitoring, HTTP rate limiting, sync reconciliation, retention. The
structural decisions all held - authorization as function calls with a matrix asserted cell by
cell, a monotonic `seq` on the channel log, the outbox as the transactional boundary. **Everything
missing was about running the thing rather than about how it was built.**

### The security audit is planned, not started

Scope is in `PRD/17` under "Security audit: the planned scope". It is deliberately a reading
exercise before it is a fixing one, and it is bounded by one fact worth restating: this product
will include minors and it has private one-to-one conversations in it, which is what raises the
stakes on authorization and safety relative to everything else.

**Three findings exist already, from writing the plan rather than running it**, and they are
recorded there rather than held back - a plan that hides what it already knows is worse than no
plan:

- `.env.bak` is tracked in git. It holds one placeholder, so nothing real has leaked, and the
  finding is the pattern: `.gitignore` covers `.env`, `.env.local` and `.env.*.local`, and
  `.env.bak` matches none of them. The next backup taken beside a production value would be
  committed identically.
- Every secret in `.env` is still its development placeholder, which is fine until the first
  deploy and blocking at it.
- No security headers anywhere, and `trustProxy` unconfigured - which interacts directly with the
  rate limiting added today, because behind a proxy the per-IP sign-in bucket becomes one bucket
  for the whole internet.

### The thing worth remembering from today

Two of the four tasks were misdiagnosed confidently before they were fixed correctly, and in both
cases the correction came from checking whether the fix was doing anything rather than from the
suite going green. The notification spinner was blamed on the focus effect when the socket's
`revision` bump was the real caller. The container flake was blamed on a timeout that could not
possibly have affected it, twice, while the failing message named the function the whole time.

**A green suite is not evidence that the thing you changed is what made it green.** That sentence
cost two wrong entries in this log, one of which had already been pushed.

---

## 2026-08-03 (fifth) - Deleting what nobody will read again, and refusing to delete one thing

The last of the four operational gaps, and the smallest: `notifications` and `outbox` both grew
without limit and had no archival path (`PRD/17` debt 10). `runRetentionSweep` follows `runMediaGc`
exactly - same nightly slot, same bounded batches, same absorbed failure - because a second shape
for "housekeeping" would be a second thing to reason about for no gain.

### The interesting decision was what NOT to delete

Two windows for notifications rather than one, and the difference is the point: **deleting an
unread row silently decrements somebody's badge for something they never saw.** Read rows go at 90
days, unread at 180. Keeping unread forever was the other option and leaks - an abandoned account
accumulates them with nothing that will ever clear it.

The outbox rule is `processed_at IS NOT NULL`, which leaves **parked events untouched forever**.

> A parked event is the only durable evidence that an effect never ran. Three of them sat parked
> for the entire life of the Eboard space and nothing said so, which is why `effect-coverage.test.ts`
> exists at all. A sweep that removed them on a timer would delete the record of an unfixed bug on
> a schedule, and nothing downstream could notice it had.

They are rare by construction, and if they ever stop being rare then the table growing is the least
of the problem.

### One parked event, found by looking

Checking the sweep against real data turned one up: `media.uploaded`, five attempts, `vipspng:
libpng read error`, parked since 2026-07-30. A corrupt PNG - bad input rather than a code defect,
and the thumbnail derivation correctly gave up. It had been sitting there for four days with
nothing that would ever have mentioned it.

That exposed a loose end in the first version of this work: `parkedEventCount` was exported and
nothing called it. **A count nobody reads is not monitoring**, so the sweep now reports it every
hour, on its own line rather than folded into a row count - a sweep that deleted nothing still has
to be able to say this, and a sweep that deleted thousands must not bury it.

### Verified

709 tests, 7 of them new, and the two that matter assert what the sweep **refuses** to remove: a
parked event ten years old, and an unprocessed row still within its retry budget. A retention bug
deletes something and leaves nothing behind to notice with, so the assertions that earn their place
are the ones pointing the other way.

Checked against the development database: 411 notifications, 657 outbox rows, one parked.

---

## 2026-08-03 (fourth) - A delete that only reached the people already watching

The third operational gap, and the only one of the four with a user-facing consequence: **a
message deleted while a device was offline stayed on that device, with its text, forever.** Same
for a pin and a reaction. `PRD/17` item 14, open since 2026-08-01.

### Why it survived every test

Sync asked for `seq > <the client's local max>`. Deleting message 12 does not create message 51 -
it changes an old row, and an old row is below the mark by definition. So there was nothing
"newer" to hand over and the tombstone simply never arrived.

**Both halves were individually correct**, which is why nothing caught it. The live `msg.update`
frame carried the change to everybody connected. Sync correctly returned everything new. No test
asked the question that spans them: what happens to a change that arrives while nobody is
listening. The client's own comment had even been corrected once to admit the loss was not
self-healing - the behaviour just had no test.

### Two counters, because one cannot answer two questions

`last_seq` says where a message sits and must stay gapless. A second counter, `last_rev`, says
what has changed - bumped by an append AND by every later mutation.

> **Reusing `seq` was the obvious move and is wrong.** Bumping a message's seq when somebody
> pinned it would move that message to the end of the conversation and punch a hole where it had
> been - the phantom gap the gapless design exists to make unrepresentable.

Because an append allocates a revision too, **one watermark covers both halves**: a new message and
a changed message become the same question. That turned out simpler than the design it replaced -
no second cursor, no merging two result sets.

An integer rather than a timestamp, for the reason `seq` is one: two transactions committing out
of order around a wall-clock watermark can both land on the wrong side of it, and the row that
slips past is missed **permanently** rather than late. `TECH/00` made this argument for ordering;
it applies unchanged to "what have I not seen change".

### The mutation that changes nothing

Three sites allocate a revision inside the transaction that makes the change, so a tombstone can
never exist without the revision advertising it. The fourth is the interesting one.

**A reaction lives in another table.** Not one column of the message row changes - and yet what
every reader renders is the envelope, and the envelope carries its reactions. So the message HAS
changed, and the row has to be touched to say so. That is exactly why reactions were among the
three things being lost, and it is the case a schema-shaped fix would have missed.

### The backfill was not optional

Both columns default to 0 and sync asks for `rev > 0`. Deployed without a backfill, **every
message already in the table would have been invisible to every sync forever** - the one row shape
the new watermark cannot express is "changed at revision zero". `rev = seq` for existing history,
since seq is already monotonic per channel and already at least 1 by check constraint. Verified
against the development database rather than reasoned about: 0 of 267 rows left at zero.

### Verified

702 server tests, 7 of them new, plus typecheck across four workspaces, `db:prove` against the
changed schema, and both lints. The new tests fail against the old code, which is the property
that matters - and the last of them pins the pre-revision path deliberately, because a client that
has not updated sends no mark and must keep working exactly as before. A mixed fleet gets
correct-but-incomplete reconciliation rather than a broken one.

Backfill checked against real data. Live stack healthy, Metro bundling 1663 modules.

---

## 2026-08-03 (last, again) - Making failure visible, and finding out the suite had been lying about why it was red

The MVP feature set is in, so the question turned to what the architecture is actually missing.
Reading the plan against the code gave a short answer worth recording: **the structural decisions
held, and every real gap is operational.**

Authorization is function calls with a matrix asserted cell by cell; the channel log has its
monotonic `seq`; the outbox is the transactional boundary. Those were the whole point of the
remaster and they are intact. 123 routes in 2,374 lines over 8,946 lines of domain is thin
transport and thick domain, which is the healthy direction. The skipped Kafka phase is a correct
call at ~50 writes/sec, not debt.

What was missing was everything about running it.

### Nothing was watching

`TECH/15` asked for error monitoring "in the error path from the first commit" and there was none,
which `PRD/17` listed under blocking a release: **a crash or failed load in real use was
invisible.** Worse than absent - the API had no `setErrorHandler` at all, so a 500 was logged by
pino and reached nobody.

`monitoring.ts` now holds three properties, each a way this is usually built wrong:

 1. **Reporting cannot make an outage worse.** `capture` never throws, and the local log is written
    BEFORE the remote send is attempted - the copy that cannot fail happens first.
 2. **No DSN is a supported state, not a degraded one.** Without one it still reports, to the
    process logger. Every capture path therefore runs on every dev run and in CI; a no-op stub
    would mean these lines first executed for real in production, which is the one place nobody is
    watching them.
 3. **Reports name their commit**, or a stack trace is a puzzle against unknown source.

Wired where failures had nowhere to go: 5xx only on the API (a 4xx is the API working, and would
drown the signal); the outbox **park**, which means an effect will now never run; the drain tick,
because a drain failing every time looks exactly like an empty outbox; socket frames, which have no
status code to carry a failure; and the gateway's rate limiter failing open - correct behaviour,
but "open" means unlimited sends, and a security control switching itself off must never be only a
log line.

### The catch that answered a plausible lie

Three join-request commands caught **everything** and returned `already_pending`. A lost connection
was reported to the member as "you have already asked": a believable, wrong answer that no monitor
could ever have seen, because as far as the API was concerned nothing failed. They narrow to
`isUniqueViolation` now - the helper this codebase already had, and which `races.ts` was already
using correctly two hundred lines away from one of them.

### One default beats twelve exceptions

`SEND_RATE_*` covered the gateway. The other 123 routes were unlimited, including the ones that
mint presigned S3 URLs and the ones that put a row in a stranger's inbox.

The shape that matters is **a default on the scope plus named overrides**, not a list of limited
routes: the same structural argument the session hook is built on. A route added next month is
limited without anybody remembering, and forgetting is precisely how the gap opened.

Two orderings are load-bearing and both are tested. The limiter runs **after** authentication -
in front, it would key on something an unauthenticated caller controls, and an attacker could
exhaust a stranger's bucket by guessing their id. And `/health` is deliberately unlimited, because
a rate-limited health check reports the service down for the one reason it is not.

### The suite had been telling the truth, and then it was misdiagnosed twice

Container startup timeouts had been failing a different test file on nearly every run all day. Each
retry passed, so each was written off as contention and re-run. Adding a 26th container-starting
file made it consistent: three files, every run.

**The first diagnosis was that the suite had outgrown a 10 second startup timeout, and it was
wrong.** `withStartupTimeout` was raised to 120s, the suite went green, and the number was written
down as the cause. It is inert against that error: testcontainers binds ports in
`inspectContainerUntilPortsExposed`, whose timeout is a **hardcoded 10 second default parameter**
never passed from the caller. `withStartupTimeout` governs the wait strategy that runs afterwards -
a different clock entirely. The suite went green because load eased.

**The second wrong claim shipped in the same breath**: that serialising the files had made it
worse. `fileParallelism: false` was already in `vitest.config.ts` and had been for a long time, so
the experiment changed nothing and the observation was noise.

Both were found only by going back to check whether the fix was even being applied - reading the
library rather than the passing suite.

The measured cause: **Docker takes ~4.3 seconds to bind a port for a single container on this
machine with nothing else running**, against a hardcoded 10 second ceiling, 27 times per run, on a
machine also hosting the dev stack. Thin margin, crossed occasionally. The standing fix is one
container for the suite instead of one per file, recorded in `PRD/17`.

The lesson is not the number, and it is not even the habit of re-running until green, though that
is real. It is that **a green suite is not evidence that the thing you changed is what made it
green.** Two plausible causes were stated confidently, neither was tested against the library's
actual behaviour, and both were wrong. The failing message named the function the whole time.

### Verified

810 tests, typecheck, `lint:emdash`, `check:runtime`. 21 new: 5 pinning the reporter contract,
12 pinning limit policy as pure arithmetic, and 4 proving the hook is actually installed - a policy
nothing consults is indistinguishable from one that always allows.

Exercised against the running server rather than only in tests: eleven sign-in attempts, nine 401s
then `429` with `Retry-After: 5`.

Caught by the founder's `--watch` restart and not by the suite: the pino instance was first passed
to Fastify's `logger` option, which in Fastify 5 takes configuration and rejects an instance. The
server refused to start while **every test stayed green**, because tests build down the other
branch. There is a comment at that line saying so.

---

## 2026-08-03 (last) - A back button that moved every time and changed nothing

One video, three defects, all of them about a control that was present and not usable.

### The conversation was on the stack twice

Creating a poll, event or meeting from chat's "+" menu left the back arrow apparently dead: it
could be tapped forever and the screen never changed.

It was working perfectly. The "+" menu **pushes** the composer, and the composer **replaced**
itself with the conversation when it was done - and a replace swaps the top entry rather than
removing it:

```
[.., chat, composer]  --replace-->  [.., chat, chat]
```

**Back popped one copy and revealed the other, which is the same conversation.** A stack with a
duplicate in it is indistinguishable, from the outside, from a button that does nothing.

The choice of `replace` had been reasoned about and written down - *"the composer is spent, and
leaving it on the stack means back from chat walks into an empty form rather than out of the
conversation"* - which correctly rules out `push` and does not notice that replace leaves the
duplicate. The answer is neither: **unwind to the entry already down there** rather than
navigating to a new copy of it. That is `dismissTo`, which removes the composer and leaves exactly
one conversation, and it is now `useReturnTo` in `nav.tsx` across all six call sites.

The Chats tab had reached the same conclusion months earlier for the same reason, and its comment
says so: `replace` there gave `[list, list]` and drew a back arrow on what looked like the root.
Two independent discoveries of one rule is what turned it into a hook.

`dismissTo` maps to React Navigation's `popTo`, which PUSHES the target when it is not on the
stack - so a composer reached by deep link rather than from chat still lands somewhere sensible
instead of throwing.

### Three composers, three copies of a header, no inset

The New poll header drew its title over the clock and its back arrow half-buried under the status
bar, which is why that arrow "didn't click properly" - its hit area was behind the system's.

**A screen that opts out of the navigator's header inherits the navigator's inset job**, and none
of the three composers did it. This is the third time the same omission has shipped here: the
chats list and chat itself both lost the same inset, and both say so in their own comments. A
browser has no notch, so it looks perfect right up until somebody holds a phone.

The three headers were byte-identical apart from the title, so the fix went into `ComposerHeader`
in `ui.tsx` rather than into three files - otherwise this would have been the fourth and fifth
copies of the same fix.

### A 24pt target for a control that votes

The eye on a poll option is a 16pt glyph in `xs` padding, well under the 44pt minimum. It worked;
it had to be hit exactly. `hitSlop` rather than padding, because widening the control itself pushes
the vote bar in.

Worth stating why this one is not cosmetic: **the eye sits directly beside the option row, so a
miss does not do nothing - it casts or withdraws a vote.** A small target next to a destructive
neighbour is a different problem from a small target in open space.

### The thing worth remembering

None of the three was a broken control. The back button navigated correctly every time, the arrow
rendered, the eye responded. What was wrong in each case was the space around them: a stack with a
duplicate, a header under the status bar, a hit area smaller than a fingertip. **A control can be
correct and unusable, and only the second of those is visible from the code.**

### Verified

789 tests, typecheck, `lint:emdash`, `check:runtime`. Confirmed on the device by the founder,
which is the only place any of these three could have been found - a duplicated stack entry, an
inset and a hit target are all invisible to a test and to a browser.

---

## 2026-08-03 (later) - A screen kept alive by its own back button, and four navigations that did not check where they were

A device video and four follow-ups. The reports came in as separate complaints and were mostly one
mistake wearing different clothes: **navigating without asking where you already are, or when you
are allowed to go.**

### The inbox spun its refresh control at rest, and the first fix was aimed at the wrong caller

Reported as the notifications tab loading "unusually" on tab switch. The focus effect called
`load.reload()`, which announces a load, so switching to the tab fired the pull spinner over
content that was already correct. That got changed to `refresh()` - and the spinner stayed.

Because the focus effect was never the main caller. The screen reads
`useLoad(() => inboxApi.page(), [revision])`, and **the socket bumps `revision` for everything it
hears about**, so the inbox re-read whenever any message landed in any chat. Tab switching was
simply the trigger that could be reproduced on demand.

The chat list had already solved this with a `pulling` flag held beside the loader; the inbox had
never been given one. That rule is now `usePullToRefresh` in `use-load.ts`, next to the
`reload`/`refresh` split it is the visible half of, and both screens use it. **A refresh spinner
answers "did you ask for this?", not "is a request in flight".**

### A standalone Messages list, reachable only from the back button that pointed at it

Backing out of a new DM landed on the old Messages list rather than the chat list, and that screen
showed names with no avatars. Both dissolved into one fact: `PRD/15` had already recorded that
nothing navigated to it except a DM chat's back-fallback, "which is the only reason it has not been
deleted". Every job it had - search, a DMs filter, the person+ button - moved into the Chats
destination when that absorbed every conversation.

So it is gone, and a DM's declared parent is `/clubs`. The avatar bug went with it, having only
ever existed on the one screen nobody could reach on purpose.

Worth noting how it survived: **the back control was the last thing keeping it alive, and a back
control is exactly what nobody audits for reachability.** It pointed somewhere, that somewhere
rendered, and the screen stayed in the tree long after the product had replaced it.

### One option, two opposite journeys

Leaving a chat animated as though you were entering one - the mirror of yesterday's race and
Eboard bug. `app/_layout.tsx` declared `animationTypeForReplace: 'push'` on `(tabs)`, correct for
signing in, and entering a DM replaces the whole `(tabs)` entry - so there is no history to pop and
the back control replaces its way back in, inheriting the option meant for the other journey.

The `arrived=forward` marker existed for exactly this and could not be read here:

> **A group route is not handed the leaf's params, it is handed the route TO the leaf.** `(tabs)`
> sees `{ screen: '(main)', params: { screen: 'clubs/index', params: { arrived: 'forward' } } }`,
> so `params.arrived` is undefined one level above where the answer lives.

`arrived.ts` walks that chain. `(tabs)` now defaults to `pop` - a replace that says nothing is a
way out - and the two journeys that enter the app mark themselves.

### Signing out navigated before it had signed out

Reported as "pop push at same time". The button did `void signOut()` and then `router.replace('/sign-in')`
on the next line, so the replace ran while the session was still signed IN - and sign-in's own
guard, which exists so a signed-in reader never sits on it, bounced straight back to `/clubs` as a
forward push. Then the sign-out landed and the guards popped to sign-in.

The button now clears the session and navigates nowhere; the screen's guard is what moves. Delete
account had the same second copy - it did await, so it never raced - and lost it too. **One rule,
one implementation: the guard already says a signed-out reader belongs on sign-in, and a replace
sitting next to it is a duplicate waiting to disagree.**

### Tapping CHATS while on Chats

It fell through to `replace('/clubs')`, which swaps the screen for an identical copy of itself and
animates the swap, so spamming the tab played a pop per tap over a page that never changed. It now
scrolls the list to the top instead, which is what a tab bar is expected to do.

The interesting part is why the obvious fix would have been wrong. `preventDefault()` was the
handler's first line, and `useScrollToTop` **checks `defaultPrevented` and declines to run when
anything claimed the event** - so an early `return` after preventing would have killed the pop and
the scroll together. The handler now claims the press only on the paths that actually move, and
lets the "already here" press through untouched.

### The thing worth remembering

Four of the six were a navigation that did not check its own preconditions: going where you already
are, going before the state you depend on has changed, or arriving somewhere that serves two
journeys and assuming yours. None of them were reachable by reading the code for correctness,
because each is individually correct - they are wrong only relative to where the user was standing
when they fired.

### Verified

789 tests, typecheck, `lint:emdash`, `check:runtime`. `arrived.ts` is new and pure, with the
nested-navigator case, a self-referencing params cycle, and the unmarked default all pinned - the
default matters most, because it is what makes an unmarked replace read as a way out.

Sign out, sign in and the DM back transition were confirmed on the device by the founder, which is
the only place a native stack animation can be judged.

The server suite failed three times during this work with
`Timed out after 10000ms while waiting for container ports to be bound to the host`, on a different
file each time, and passed 672/672 either side. No server code changed in this session. It is
Docker contention between the running dev stack and the suite's throwaway containers, not a defect,
and serialising the files made it worse rather than better.

---

## 2026-08-03 - The calendar marked the day and then showed nothing on it

Reported from the device, and precisely: today is the 3rd, the 3rd has events, the grid draws the
ring and the filled marker on the 3rd - and the page under it is empty until the 3rd is tapped.
The screen was drawing a marker that said "there is something here" and then declining to say what.

### The default that was never written

`CalendarView` opened with `selected = null` and rendered the day list only `if (selected !== null)`.
Nothing ever selected today. Every other part of the feature was correct: the buckets were per-day,
the marker logic was right, tapping worked. The screen simply had no opinion about which day it
was showing when you arrived, and null is an opinion.

The fix is one line of intent and three of care, because the two obvious versions are both wrong:

 1. **Selecting today on mount reads an empty map.** The feed has not loaded on the first render,
    so "does today carry anything" answers no, permanently.
 2. **An effect that selects today whenever nothing is selected makes today untappable.** Tapping
    the open day collapses it, the effect reopens it on the next render, and the day cannot be
    closed.

So the open day is **derived, not stored**: `null` means the reader has not chosen yet, which is a
different value from having chosen nothing, and only the first falls back to today. The default
re-evaluates for free when the data lands and stops applying the moment the reader expresses a
preference. Paging a month produces "chosen nothing", so returning to the current month does not
resurrect today.

Today only opens when it actually carries something, which is the rule the grid already applied to
the gesture. Without that, an empty calendar greets you with a heading over "Nothing on this day"
that no tap can dismiss, because the cell under it is disabled.

### The bug underneath it, which nothing in the data had yet triggered

The buckets were keyed on `at.slice(0, 10)`. That is the **UTC** date, and the grid's cells are
**local** dates. West of Greenwich a 9pm event has tomorrow's UTC date, so it was marked and listed
one square late with the correct time printed under it. Every event on the calendar had been
created before 8pm, which is the only reason it looked right.

Keying on the reader's local day is the fix and it could not be applied, because the server had
already destroyed the distinction it needs. A race's `race_date` is a DATE, and it was being pushed
through `new Date(...).toISOString()` to match the other three branches - turning `2027-01-01` into
`2027-01-01T00:00:00.000Z`, an instant at UTC midnight. Asking that instant which local day it is
on answers December 31, so the naive client fix would have moved every race a day earlier while
fixing evening events.

`FeedItem` therefore carries `allDay`, emitted per UNION branch rather than inferred downstream
from the kind, and a race keeps the date it already had. The client asks the local-day question of
instants and never parses an all-day value, which is the rule `dates.ts` opens with, applied at the
one place that had quietly opted out of it.

That also removed something nobody had reported: the day list printed `formatTimeOfDay(item.at)`
under every race, and UTC midnight read in New York is **7:00 PM the evening before**. Every race
carried a confident time it did not have.

### The thing worth remembering

The reported bug was a missing default. The bug found while fixing it was a type confusion two
layers away, in a server file the report had nothing to do with, and it was only reachable because
the fix required asking "which day is this item on" in a timezone-aware way for the first time.
A date and an instant are different things, and the moment one is normalised into the other the
question becomes unanswerable rather than merely wrong.

### Verified

783 tests across the workspaces, typecheck, `lint:emdash`, `check:runtime`. `calendar-days.ts` is
new and holds both rules as pure functions, extracted for the reason `chat-rows.ts` was: inside a
component the only way to exercise them is to open the app and look. Its tests assert the two
regressions a fix invites - reopening a day the reader closed, and moving an all-day value earlier
by parsing it - and express the evening case through `toDateKey` so it holds in whatever zone the
suite runs in. On the server, a race's `at` is pinned to `2026-04-12` and an event's to
`2026-04-15T18:00:00.000Z` in the same assertion, since the bug was the two becoming one shape.

`/calendar/markers` still keys by UTC day. It is left alone deliberately: no screen calls it, and
the server cannot know the reader's timezone, so the honest fix there is the client's.

---

## 2026-08-02 (evening) - One motion everywhere, and a landing screen that was the real problem

The ask was simple: going deeper slides right to left, coming back slides the other way, everywhere.
Most of it already worked, because a stack push and pop do exactly that on iOS. What follows is the
part that did not, and the two attempts it took to find out why.

### What was actually inconsistent

No animation was configured anywhere, so the app was inheriting the platform default - right on
iOS, different on Android. Declaring it makes the rule true rather than lucky. Tabs stay instant:
the four destinations are siblings rather than depth, and a gesture that means two things means
neither. Swipe-from-the-edge is on, since it is the same motion under a thumb.

The real inconsistency was `replace`, used 29 times and carrying no direction of its own. Most are
a way **out** - a back control with no history to pop, an edit that saved, a club deleted, a sign
out - so the stack's default treats a replace as a pop. The few that are a way **in** say so with a
route param: creating a club and landing on it is going in, even though the form must not be left
behind. Signing in is the same shape and was caught before it was reported.

### Two wrong attempts at the Eboard and race, and what they were wrong about

Reported from the device: club main chat felt right, entering a race or the Eboard did not, both
ways. The first fix marked the redirect into chat as motionless, reasoning that an unseen landing
screen needs no transition. **It did nothing**, and the video showed why - for a replace the
DIRECTION option decides, and the stack's `pop` default was still running, so entering a race slid
the conversation in from the left. Going in animated as coming back out.

The second fix set the direction as well. Better, and still not right, which is when the useful
question got asked: **why does it work for one and not the other two?**

Because club main chat has no landing screen. The hub links straight to the channel - one push,
nothing else. A race and an Eboard space each push a landing screen that immediately redirects,
so one tap costs a push plus a cross-navigator replace. **Two transitions for one act cannot be
tuned into feeling like one**, and both attempts were tuning the second transition rather than
noticing there was one.

So the hub now opens all three conversations directly, which makes the working case the only case.
`RaceListItem.channelId` already existed and is null exactly when there is no roster row;
`ClubDetail` gained `eboardChannelId` on the same terms as `eboardId`, which is what stops it
becoming the one field that leaks a space an ordinary member has no visibility of.

The landing screens stay, and still redirect. A notification, a direct URL and a non-member all
still arrive that way and still need the decision they make. Only the hub stopped going through
them.

### The thing worth remembering

Three attempts, and the first two were competent work on the wrong layer. The report that unlocked
it was not a better description of the symptom - it was **"why does it work for one and not the
other two?"**, which is a question about the difference rather than about the defect. The
difference was structural and had been visible in the routing the whole time.

### Verified

774 tests, 82 constraint assertions, every gate. Confirmed working on the device by the founder,
which is the only place a native stack animation can be judged - a browser does not animate one.
`hub-entry.test.ts` pins the two fields the hub now navigates on, because the consequence of a
regression changed: a leaked channel id used to be a wrong badge and is now a tap into a
conversation the server will refuse. Ungating the Eboard channel fails two of its three cases.

---

## 2026-08-02 (last, again) - The same bug one row over, a race nobody lost, and a spinner I added

Three more from the phone, and the pattern across all three is that each was a **second instance
of something already fixed once**. Worth keeping together for that reason rather than for the
fixes, which are small.

### The split I built for the Eboard and never carried to races

"The message split is not working for the race group." Correct, and it is the identical defect to
the Eboard one from an hour earlier: a club row totals every channel of the club the viewer can
reach, races included, and the race rows on the hub showed a pin, a lock and no number. So a
race's share of the total was real and unfindable.

The galling part is that `unreadForScope` was written **for this**, in the same change, and wired
to the Eboard row alone. A helper built for two callers and given one is a fix that only looks
finished, and the tests could not see it because they assert what the server returns rather than
what a row draws.

Badged per row rather than as a total on the section header, which is a deliberate choice with a
known hole: the hub previews about five races, so unread in a race outside that preview still
shows nothing until "See all". Recorded rather than papered over.

### The badge was racing the thing that should have preceded it

"If I click notification and then switch to chat, everything other than unread messages should be
gone, but it is gone only when I come back to notifications."

Precisely observed, and the mechanism is a race rather than a delay. Leaving the inbox marks it
read **fire-and-forget**, and the badge re-reads on navigation - which is the same instant. The
read usually won and fetched the count from before the mark landed, and nothing told it
afterwards, so it sat wrong until the next navigation. Coming back to the inbox was simply the
next navigation.

The badge is now told after the write settles, through a `notifyChanged` the session exposes for
exactly this: an HTTP call that changes notification state server-side raises no socket frame, so
there is no other door. Doing it beside the write would have been the same race with more steps.

Note the shape it shares with this morning's report of counts not clearing: **the state was
correct in Postgres both times, and the client never asked again.** Two different bugs, one
lesson, and the lesson is not about unread arithmetic.

### And a spinner I added this morning

"The chats is getting reloaded again and again when I go inside a club and come out - weird and
seeable, which kinda creeps." Mine, from the focus refetch added to fix the counts. `useLoad.reload`
moves the state to `loading`, the list binds its `RefreshControl` to that state, and so returning
to the screen fired a pull-to-refresh spinner every single time.

`useLoad` gained `refresh()` - read again without announcing a load. A background refresh is not a
first load and must not claim to be one: the screen keeps its content, and a failed background
read keeps the last good answer rather than replacing working content with a retry button. The
spinner is now driven by a flag only an actual pull sets, and cleared when the read settles, since
a flag left true would make the *next* background refresh spin.

### Verified

770 tests and every gate. Live: a race with two unread badges 2 on the hub while the club row
reads 6 and splits 3 main + 1 Eboard + 2 race; and leaving the inbox with a real unread
notification in it dropped the badge from 5 to 4 immediately, the 4 being the chat-unread
contribution that correctly never clears from that screen.

The spinner fix is verified structurally rather than by watching it - the control is now bound to
a flag no background path sets - which is the weakest of the three and worth saying.

---

## 2026-08-02 (last) - Three reports from one screenshot, and a count that told nobody

A photograph of the chat list on a real phone, and three separate faults in it. Worth keeping
together because only one was a coding mistake in the usual sense.

### The header was under the status bar, and that one is mine from this morning

Making the list draw its own "Chats" title meant turning off the stack header, which also turned
off the inset it was applying. The title rendered over the clock and both buttons behind the
battery. **A browser has no notch**, so every check I ran was clean - the same reason chat lost
this exact inset on 2026-08-01, in a file whose sibling had had it since it was written.

The padding is the safe-area inset at the call site rather than a constant, because a notch is
59pt on one phone and 20 on another and a guess is wrong on both.

### Reading a chat told nobody, which is why counts never cleared

The report was "I read the messages and the number is still there", and the instinct is to
suspect the cursor. The cursor was right the whole time, committed to Postgres, and the server
would have answered correctly to anybody who asked. Nobody asked.

`ChatClient.markRead` advanced its own copy and sent the frame, and **never called `onChange`**.
That is the only thing that bumps `revision`, and `revision` is the only dependency the chat
list's loader has. So the list, the club hub and the badge all kept whatever they had loaded -
which for a session open a while meant the counts as they stood at sign-in.

Two fixes rather than one, because they cover different failures. `markRead` now notifies, but
only when the mark actually moved - opening an already-read chat should not refetch every list.
And the list re-reads **on focus**, which is the one that cannot be reasoned wrong: a count can
also move because another device read the conversation, or a push was opened, or the socket was
down while somebody wrote.

### A number that could not be found

"It says nine and I do not know where they are." The club row counted its **main chat only**, so
messages waiting in the Eboard space were invisible - not in the list, not on the hub, nowhere.
Reported as a mystery number, and it was really a missing one.

A club row now totals every channel of that club the viewer can **reach**, and the hub badges
each of those separately, so the total always resolves to a place. A race they have no roster row
for contributes nothing: authority is not access, and a number they could never open would be the
same failure pointing the other way.

The total is a CTE rather than a correlated subquery, for one specific reason: the access
fragment in `channel-access.ts` is documented as assuming the table is aliased `c`, and that
convention is what stops a fifth hand-written copy of the membership join existing. Inside the
CTE the alias is `c` and the fragment applies untouched.

`ChannelState` gained `scopeId` so a screen holding an Eboard or race id can find its channel's
count - without it the hub could badge its main chat and nothing else, which is how the count
became unfindable in the first place. The hub also stopped reading the session's channel copy,
which is filled at sign-in and never replaced.

### What the tests are shaped around

Nine cases about the number's relationship to reality rather than about any screen: what a club
row covers, that it excludes a race the viewer cannot reach, that reading one channel clears that
one and **not** the rest, that a new message brings it back, and that the badge counts
conversations while the row counts messages - so asserting they are equal would be asserting the
wrong design. Reverting the total to main-chat-only fails three of them.

Two of the nine failed first time on my own bad setup rather than on the code, and both are worth
recording. A club membership inserted **directly** does not auto-join the Eboard - promotion does
that, and a raw insert is not a promotion - so the second admin was correctly refused. And
**creating a race auto-adds its creator to the roster**, so the actor I picked to prove "a race
you cannot reach is not counted" could reach it, and the assertion proved nothing. That is
exactly the negative-assertion trap recorded on 2026-08-01, hit again while writing tests about
something else.

### Verified

770 tests, 82 constraint assertions, typecheck and both gates. Live: reading a DM cleared its row
and dropped the badge from 3 to 2 while the other rows kept their counts, and a message posted
into a club's Eboard took that club's row from 3 to 4 with the per-channel read showing where -
eboard 1, club 3.

**Not verified on the device.** The phone was locked when this finished, so the safe-area fix and
the tab label have been proved in a browser that has neither a notch nor the device's font
metrics - which is precisely the gap that produced two of these three reports.

---

## 2026-08-02 (later) - A conversation gets a profile, a pin, and a delete that deletes nothing

Four things asked for on the DM screen: shared clubs, a gallery, a pin that keeps somebody at the
top of the list, and a three-dot menu of exactly Pin, Block and Delete chat. Two of them were
already built and only needed a way in. One of them was a day's work hiding behind one word.

### "Delete chat" is a visibility rule, not a deletion

The word collides with two settled rules - a message is soft-deleted with a tombstone and never
removed (invariant 7), and a DM thread goes read-only rather than being deleted (PRD/14 rule 3) -
so it was worth asking what it should mean rather than guessing. Settled as **clear it for me
only**: the other participant keeps every message, is never told, and nothing is destroyed. One
person's floor into a shared log moves up.

That is the only per-user "delete" expressible against one row per message, and it is what the
word means to anybody arriving from another messenger. It also has a bill, which was stated
before it was agreed: **six reads return messages and every one has to honour the floor.** History,
the jump window, sync, the gallery, both Highlights queries and the conversation row's
last-message join. A floor honoured by five of six is not a partial feature, it is a leak - and
the specific shape it takes is "I deleted that chat and the photographs are still one tap away".

So the floor is loaded into the access context beside `dmThreads` and `blockedEither`, asked
through one `clearedFloor()`, and - the part that actually prevents the bug - **the reads that
return messages now take an access context as a required argument**. `readHistory(db, channelId)`
became `readHistory(db, ctx, channelId)`. Forgetting the floor is a type error rather than a
silent leak, and the compiler found all eighteen call sites the moment the signature changed.

Two mutation tests hold it: neutralising the shared fragment fails the history and read-path
tests, and neutralising the raw-SQL copy in the list's LATERAL fails exactly the one test about
the row dropping out. The second exists because that one is not covered by the fragment - it is
the copy, and a copy needs its own proof.

Clearing also advances the read cursor in the same transaction. Without it the conversation shows
nothing and simultaneously claims three unread, which the reader cannot resolve, because the only
thing that clears an unread count is opening a chat and there would be nothing in it to open.

And the client half, which is the same class of bug one layer over: the phone renders from SQLite
before any network call resolves, so a server-side clear with no local wipe leaves the messages
fully visible on the device. `ChatClient.forgetChannel` drops them.

### A pin, and the word it collides with

Pinning a conversation and pinning a message share a word and nothing else. A message pin is an
act of authority in a shared room - `canPinInChannel` gates it and everybody sees it. A
conversation pin is a fact about one person's list that nobody else can observe, needing no
permission beyond being able to read the channel. So `canPinChannel` is its own predicate with a
one-word body, which is AGENTS.md failure mode 10 applied deliberately: the day somebody
restricts message pinning, this must not move with it.

Pinned rows sort above every unpinned one **as the primary sort key rather than a tiebreak**,
because defeating recency is the entire reason to pin something. The test pins the least recent
conversation and asserts it leads.

### The screen the DM header used to not have

Tapping a person's name in a DM did nothing, and the code said why: every other scope has a space
behind it, so linking to the club would have been the wrong screen with the right person on it.
That screen exists now, and it is the *conversation's* profile rather than the person's - which is
why it is not `/users/:id`. A member profile is reachable from any roster where no conversation
need exist, and "Delete chat" there would be a control over nothing.

Shared clubs are **listed rather than counted behind a chevron**, departing from the design: you
will share one or two, not nine, so a whole screen to show one row is a tap for nothing, and each
row opens that club, which a count could not. They are also only clubs the viewer is already in -
a DM must not become a window onto somebody's whole membership.

### Verified

761 tests, typecheck, `db:prove` at 82 assertions, `check:runtime`, the em-dash gate. Then live,
with two seeded accounts:

- Pinning the **least recent** conversation moved it to the top with a pin glyph, above two more
  recent ones.
- Delete chat, through the confirmation that says whose copy goes: the thread left her list
  entirely, and her history read empty.
- **His view was untouched** - his message still there, and he was told nothing.
- He wrote again, and her thread came back carrying **only the new message**, at unread 1. The
  one she cleared did not return.

One mistake worth recording because it is in AGENTS.md already: a backtick inside a `sql` template
literal ends the string. I put one in a SQL comment and got three parse errors pointing at the
wrong lines. Same trap, second time, now with a note in the comment that caused it.

---

## 2026-08-02 - One list instead of two, and a web client that had stopped booting

The founder asked for the landing screen to work the way GroupMe's does: every conversation in
one list, clubs and DMs together, newest first, with filter chips over the top and the last
message on each row. Four questions were worth asking before building any of it, and three of
the four answers narrowed the work rather than widening it.

### What the questions were for

**Search.** The field in the design says "Search chats and messages", and message search is on
`PRD/17`'s "deliberately deferred - do not fix" list, reaffirmed on 2026-07-30 when a Stitch
design showing a search screen was deliberately not built. Searching chat *names* is a filter
over a list already in memory; searching *messages* is a full-text index, an endpoint that scopes
hits to readable channels, paging, and jump-to-message. Settled at names only, deferral intact.

**Which scopes.** A race and an Eboard space each have a real channel with a real unread count.
Including them makes the list complete and long; excluding them makes it the conversations
somebody thinks of as theirs. Settled at club chats and DMs only - and the thing that makes that
safe is that `readInbox` and `badgeCount` scope themselves with `accessibleChannelPredicate` and
know nothing about this screen, so race unread still reaches the member through the Notifications
tab and the badge. Verified rather than assumed before answering.

**Where a club row goes.** GroupMe opens the group chat; a ClubChat club also has a hub carrying
News, Races, the Eboard space and the calendar. Settled at chat first, on the argument that a row
previewing a message and then opening something else is a broken tap - then **changed to the hub
within the hour, on seeing it running**. The argument that won is the one the mockup could not
show: a club is not a conversation, it is a place with a conversation in it, and opening straight
into chat puts everything else about the club a back-press behind you. The DM row still opens the
conversation, because a DM *is* one.

The inconsistency the first decision was avoiding is real and now shipped deliberately: a club row
shows a message and opens a hub. What keeps it honest is that the hub's chat row carries the same
unread count, so the number is repeated rather than swallowed - checked before making the change
rather than assumed.

Worth recording that both answers came from the same person a few minutes apart, and the second
one is better. **Seeing it beat reasoning about it**, which is this repo's standing lesson about
bugs and turns out to apply to product decisions too.

**The landing filter.** The founder said both "show them all" and "unread is the entering page",
which are different screens. Their own screenshot settles it - no chip is highlighted in the
first image, and the list mixes a club with a DM - and the practical argument is stronger than
the reference: landing on Unread means opening the app to an empty screen on every day you are
caught up, which is most days. Settled at no filter, chips optional. The empty state that would
have been the landing is now only reachable deliberately, and says "You're all caught up".

### The read

`listConversations` is `listDmThreads` generalised from one scope to two, and it is deliberately
built on `channel-access.ts` rather than on a membership join written out again. That module
exists because this exact question was restated four times with every copy missing the race
scope; a fifth copy is the one thing this function must not be. The display-name and
display-image fragments came with it, so the two traps documented there - the COALESCE order that
titled every race chat with its club's name, and the CASE-not-COALESCE that dressed a race in its
club's face - were solved before this screen existed.

Two mutation tests, because a check that cannot fail is worse than no check. Widening
`CONVERSATION_SCOPES` to all four scopes fails the exclusion test **and** the ordering test.
Passing the channel id where `canPostInChannel` wants `scope_id` fails exactly one test, with
`expected false to be true` - a healthy DM reading as read-only, which looks like a permissions
bug and is a join bug.

### Two defects found on the way, neither of them in this work

**The web client had not booted since 2026-08-01.** `photo-viewer.tsx` statically imports
`expo-media-library`, which has no web implementation, so evaluating the module throws
`Cannot find native module 'ExpoMediaLibraryNext'` - and a static import is evaluated when the
bundle loads. Not a broken Download button: a blank screen on every route, including sign-in.
That is failure mode 8 exactly, one package over from the `expo-sqlite` wasm case, and it shipped
because the photo viewer was verified on a device and never in a browser. The import is now
deferred into the handler behind a `Platform.OS === 'web'` guard that says saving is not a web
capability. **Note what this cost beyond itself**: for a day, the surface this project does most
of its verification on was unavailable, and nothing reported it.

**`TECH/10` documented the WebSocket payloads in snake_case and the schemas are camelCase.**
Found by writing a client straight from the table to seed test data and watching it answer
`auth.err {"code":"malformed"}` before anything else happened. Harmless while every caller is
in-repo and imports the schemas; actively misleading to anybody working from the document, which
is what it is for. Both directions corrected.

### The screens

The chat list replaced the My Clubs list at the same route, so no URL changed. The destination is
now **Chats**, with `forum` - the icon the vocabulary already assigns to chat, applied to a
destination that became one, rather than a new meaning invented for it.

Three smaller things, each because the alternative was a forked copy: `Tabs` gained `active:
T | null` so "no filter" is a real state rather than a fourth chip called All; the row timestamp
became `formatConversationTimestamp` in `dates.ts` with six tests rather than arithmetic inside a
list row, per pitfall 34; and `conversationSummaryText` sits in `packages/shared` so a document
row saying its filename and a tombstone saying "Message deleted" are one function.

`searchDmCandidates` was projecting a name and no picture, so the new-message search would have
shown letters while the profile one tap later showed a face - the 2026-08-01 avatar class, caught
by looking rather than by anything failing. Fixed, with a case added to `avatars-on-reads.test.ts`,
which is shaped around exactly this.

### Verified

752 tests green across the four workspaces (650 server, 52 client, 25 shared, 25 client-core),
typecheck, `check:runtime` over 61 modules, and the em-dash gate. Then in the running app against
a real API, gateway, worker and Postgres, with two seeded accounts:

- The list mixes a club chat and a DM, ordered by last activity, with the sender prefixed on each
  preview - and **no prefix on a system message**, since the sender there is the system actor.
- Unread rows tint and carry counts (1, 3, 1); the Notifications badge reads 3 alongside.
- Each chip filters, and tapping the active one clears it. Unread with nothing unread says
  "You're all caught up" rather than going blank.
- Search matches case-insensitively on the name.
- A club row lands on the club hub, with News, the races list, the Eboard space and the calendar
  where they have always been; the hub's chat row repeats the unread count. A DM row opens the
  conversation.
- The person+ search lists only people sharing a club, a result opens their profile, and **Send
  message** there opens the thread. The new empty conversation then appears at the **top** of the
  list saying "No messages yet", which is the `COALESCE(last_message, created_at)` sort doing what
  it was written for.
- Zero console errors throughout, including on the gallery route that transitively imports the
  photo viewer.

**Not verified:** the phone rendered the list and called the endpoint, but the screenshots above
are react-native-web at phone width. The iPhone loaded the new bundle and `/conversations`
answered 200; nobody has looked at the result on the device itself.

---

## 2026-08-01 (evening) - A device session: four surfaces, and three bugs that were never going to be found by reading

Everything below came out of one evening on the founder's phone. Worth saying up front, because
it is the pattern rather than the coincidence: **the two worst bugs were in code that was
complete at both ends and joined in the middle by nothing**, and no test failed for either.

### The Eboard's events had no consumer, and nobody had noticed

`eboard.join_requested`, `eboard.membership_decided` and `eboard.member_departed` were written to
the outbox from the day the space was built. Nothing handled them. `dispatch` throws on an unknown
type - correct, it routes the event through retry and parking where it is visible - and the drain
absorbs a handler failure into the `attempts` column rather than rethrowing, which is also correct
for a queue. Together they mean the event retried five times, parked, and produced nothing anybody
would see. Requesting Eboard access notified nobody. Approving or denying told the requester
nothing. Being added told you nothing.

Everything else already existed: the notification type declared in shared, its params schema,
`audience.ts` resolving it to the current members and deliberately not to the club's admin tier,
and the inbox clearing it when the Eboard roster opens. Only the line that writes the row was
missing. Failure mode 11 - both ends complete, nothing joining them.

**The worse half is that losing Eboard access never ended it.** The gateway's own contract says
access is checked at subscribe time and never rechecked per message, so removing somebody from a
club, a race roster *or the Eboard* has to force-unsubscribe their sockets. Club departure, race
departure and both deletions all did. Neither Eboard path did: departure had no handler at all,
and demotion deleted the `eboard_memberships` row inside `changeRole` and revoked nothing. A
demoted admin kept reading the board's private chat until they happened to reconnect.

The test fake for the bus was `publish: async () => 1`, which discarded every publish - so the
half that matters was untestable by construction. It records them now.
`effect-coverage.test.ts` scans the producer source for `eventType` literals and asserts each is
claimed, because a runtime test only reaches the flows some test already triggers and the gap was
in the three flows nothing triggered. Mutation-tested by deleting a handler.

### "Last read" marked messages that had not been sent yet

Shipped in the afternoon, reported from the phone the same evening: open a chat you are caught up
on, type anything, and the rule appeared above your own message.

The read cursor is captured once on arrival, which is right. The list was then compared against it
on every render, which is a different rule wearing the same clothes - a message sent a minute
after you arrive has a higher `seq` than a cursor frozen before it existed. **Unread is a fact
about a moment, not a property a message carries.** The anchor is a decision now, taken once, and
null means "no rule this visit" rather than "no rule yet".

Both bugs in this arithmetic shipped for the same reason: it lived in a memo inside a 3,400 line
screen, where the only way to exercise it was to open a chat on a phone and look at it. It is
`src/chat-rows.ts` with ten tests now, two of which are the reported case exactly.

### Three more surfaces, each finishing something half-built

**Car groups** gained the delete v1 had and the remaster never got, plus a search instead of a
wall of every eligible name, and avatars the read was already required to carry. **The photo
viewer** was listed in `PRD/13` as unbuilt; it is one component serving chat and the gallery, and
the interesting part is that saving has to download the `original` because derived variants are
WebP, Photos will not take WebP, and iOS decides what it is holding from the file extension - so
the resolve hop now returns the object's `mime`, since the key has no extension to read one from.
**Create club** collected a name and a sport and silently defaulted every club to `open`, leaving
the description unreachable from the product though the column, the route and the client API all
carried it; `PRD/04` rule 1 names four inputs and the form was the only missing link.

### The chat header's menu had never been anchored

It opened over the status bar and cut the header in half, because it was positioned `absolute`
with `right` and `zIndex` and no `top` - so it laid out at the top of the *screen* rather than
under the header. The comment above it already claimed it was anchored under the header; the
anchor itself was never written. Nothing failed, because a menu in the wrong place still renders
and still works.

---

## 2026-08-01 (last, corrected) - Reporting, scope by scope

The notification below shipped with the audience wrong in one scope, and the founder walked
through what was actually wanted the moment it landed. The corrected rules:

| Scope | Reporting | Notified |
|---|---|---|
| club | yes | the admin tier: Owner and admins |
| race | yes | admins **on that race's roster**. A club Owner not in the race hears nothing |
| **eboard** | **no - removed entirely** | nobody |
| dm | untouched for now | platform moderators |

Two of the three already matched. **Race was already right**, which is worth stating because it
is the one with a trap in it: "club admin" and "on the roster" are different questions, and taking
either alone is wrong in a different direction. **Eboard was wrong** - every member was being
notified, when reporting should not exist there at all: everyone in that space is admin-tier, so a
report would be filed by the same people who would review it, and they can delete directly.

Removed at the policy, not in the screen. `canReportInChannel` is a new predicate - the
channel-level half of `canReportMessage` - so the server refuses a report in Eboard by any route,
`canReadReports` returns false there so the tab is **absent rather than empty**, and the channel
meta carries `canReport` so the message menu asks rather than restating the scope rule.

### Two tests that passed for the wrong reason

Both were caught by mutation-testing, and neither would have been caught by reading:

- **The Eboard test had the Owner reporting their own message.** Nobody may report their own
  message in any scope, so it was refused by that rule and proved nothing about Eboard. Removing
  the Eboard guard entirely still passed. It needs a second Eboard member, and now has one.
- **The race test asserted a club admin was not notified without checking they were an admin.**
  If the promotion had silently failed they would have been an ordinary member, excluded for a
  boring reason, and the assertion would have passed while proving nothing. The promotion is now
  asserted before the thing it enables.

The lesson is the same in both: **a negative assertion is only as strong as the setup that makes
the positive case possible.** Mutation-testing is what distinguishes them, and it is why "the
tests pass" was not enough here.

---

## 2026-08-01 (last) - Reporting told nobody

"I didn't get any notification when a member reported."

Correct, and it had never told anybody. `reportMessage` wrote a row into `message_reports` and
stopped. The Reports tab showed it faithfully to whoever thought to open a tab they had no reason
to suspect had anything in it.

The comment on that function had already named both the omission and the reason it was left:

> There is no `message_reported` notification type in the catalogue, and adding one would need an
> audience rule for platform moderators, who are not members of any club.

That is exactly what it needed. **The audience is not "the club's admins"**, and each scope
disagrees in a way that matters:

| Scope | Who reviews a report |
|---|---|
| club | the club's admin tier - owner **and** admin |
| eboard | every member, because membership there is admin-tier by construction |
| race | on the roster **and** a club admin. Either alone is the wrong answer |
| **dm** | **platform moderators**, who belong to no club and no membership query can find |

`channelModerationAudienceById` is the list form of `isChannelAdmin`, plus the case that predicate
answers `false` to - and the two must agree, because this decides who is *told* and that decides
who may *read*. Somebody notified about a queue they cannot open would be worse than silence.

The event is written in the same transaction as the report row, so a report can never sit in the
queue with nobody told, and only a report that was actually created emits one - otherwise tapping
Report twice would let one member buzz every admin as often as they liked.

The notification names the reporter and the channel, and **nothing else**. Not the reported
member, not the text. It can land on a lock screen before anybody has looked at it, and an
accusation is not a thing to broadcast at that point; the content stays behind the audited read
the queue performs.

Three bugs while building it, all found by the tests rather than by reading:

- **Backticks inside a `sql` template literal end the string.** Twice, in SQL comments. The second
  time it took a bundler parse error at a line 15 above the actual mistake to place it.
- **`FROM a, b JOIN c ON ...` cannot see `a` from the ON clause.** A comma is a cross join and
  binds looser than JOIN, so the race branch's reference to the channel's club id was an "invalid
  reference to FROM-clause entry". Rewritten as explicit joins starting from the channel.
- **Role literals in SQL.** The first version typed `IN ('owner', 'admin')`, which is precisely
  the bug that shipped four times in v1 - a bare `admin` filter excludes a club whose only
  admin-tier member is its Owner, which is every new club. It binds `ADMIN_TIER` now, like the
  worker's audience module does.

Mutation-tested: removing the platform-moderator branch fails the DM case, and notifying on a
duplicate report fails the idempotency case. Verified live end to end - a second member reported a
message and the club owner's inbox returned "Reporter Rita reported a message for review",
targeted at that channel's Reports tab.

**The platform queue has no screen yet.** A moderator gets the notification and it deliberately
navigates nowhere, because expo-router answers an unknown path with "Unmatched Route" and that is
worse than not moving. Building that screen is the outstanding half.

---

## 2026-08-01 (later still) - The list that chased its own bottom

A founder report: "whenever I come to any chat it should take me directly to the bottom, and I
don't want to see the scrolling thing."

Measured before touching anything, by sampling the scroll offset every frame while a channel
opened. It was worse than described:

| t | offset | content height |
|---|---|---|
| 71ms | 0 | 890 |
| 90ms | **302** | 1144 |
| 125ms | **302** | 3177 |

The list mounted at the top, jumped to what was "the end" while it was still rendering, and then
**stayed there while the content grew to 3177** - so the reader watched it scroll and did not
arrive at the bottom either. The scroll it performed itself fired `onScroll`, which computed
`fromBottom` against the half-built list, decided the reader had left the tail, and switched off
follow-the-tail for the rest of the session.

**The list is now inverted.** Offset 0 IS the newest message, so arriving needs no scroll at all,
and a message arriving while somebody is up in history extends the list away from them rather
than moving them. That deletes the whole `atTailRef` heuristic and the `scrollToEnd` chase with
it - the same machinery that caused the yanking bug fixed in `a2fb32f`. Re-measured after: offset
stays 0 for the entire mount while the content grows 1249 to 3177.

Then a second requirement, which sharpened the first: **who caused the movement decides whether
there is any.** Somebody else's message must never move you - it is announced by a "3 new
messages" control instead, and tapping that lands on the FIRST of them so you read forward. Your
own action always does move you: send, attach, or create a poll/event/meeting and you are taken
to the newest message to watch it land. And entering a chat lands on the first unread if there is
one, which is what `SPEC/PRD/05` rule 3 already said and nothing had ever implemented.

Three bugs came out of building it:

**A store-wide write lock.** `cannot start a transaction within a transaction`, live, from
expo-sqlite. The client serializes message application per channel - correct, because gap
detection is a read-then-write of that channel's local max - but **a transaction belongs to the
connection, not the channel**, so two different channels writing at once collide anyway. The
first attempt put the lock in the client and was wrong twice over: wrong layer, and
`syncChannel` is awaited from inside `applyIncoming`, so taking the same per-channel lock would
have deadlocked. The gap backfill moved out from under the lock (it is a network round trip and
had no business holding one), and the real lock now lives in the SQLite store, where the single
connection does.

**A read cursor that was always "nothing unread".** Opening a chat is what marks it read, so
anything asking "what had I read when I opened this?" has to ask before that runs - effects run
in declaration order, and that ordering is now load-bearing. `markRead` also advances the
client's own copy of the cursor, which it never did: `channels` is only replaced wholesale at
`auth.ok`, so a second entry in the same session read a cursor the server had moved past hours
ago.

**A placement that clamped to the bottom.** The first-unread landing resolved the right target -
instrumented and confirmed, `lastRead: 10` to `firstUnread: 11` - and still left the list at
offset 0, because the four cards below the target were empty shells at that instant. Putting the
target at the top needed more content than existed, so it clamped. The placement is now
re-applied as the content settles, bounded to eight attempts and abandoned the moment the reader
touches the list. That bound is the difference between this and the unbounded content-size chase
it replaces.

**What is verified and what is not.** Opening with no motion, arrival not moving the reader, the
count appearing with the right number, and tapping it - all confirmed in the browser with
measurements. The first-unread placement is confirmed to *choose* correctly and is **not**
confirmed to hold on screen: every attempt needed a message to arrive while the tab sat idle, and
the automated browser is throttled between steps, so the gateway reaped the socket at 90 seconds
each time and the message never arrived. That one needs a device.

---

## 2026-08-01 (later) - Replies, and a four-second frame

Four things, and the two that mattered most were not the feature.

### The chat row was rebuilt on every screen render

`renderItem` was a ~400-line inline closure, so **every row's whole subtree** - the gradient, the
mention splitting, two `toLocaleTimeString` calls, the reaction summary - was rebuilt whenever the
screen re-rendered, for reasons no row cared about: a notice appearing, the pinned strip fading,
a long press selecting some other message. The device log reported the JS thread blocked for
nearly four seconds between scroll events, which is also the likeliest reason the app kept losing
its Metro connection all day: a four-second block drops the dev-server socket, and
"unsanitized script URL = null" is what that looks like from the outside.

Extracted into `MessageRow` and `PendingRow`, both `memo`ized, with every callback hoisted to a
`useCallback` that takes a `seq` and closes over nothing per-row. The memo is worthless without
that half - stable props are the whole mechanism.

**Found on the way: hooks running after an early return.** `selectedMessage` and `mentionMatches`
sat *below* `if (authState === "checking") return ...`, so a render during auth-checking ran two
fewer hooks than the render after it - "rendered more hooks than during the previous render",
waiting for the first route that stops guarding this screen. Every hook now sits above both exits.

### Replies: one integer stored, a whole quote read back

`messages.reply_to_seq`, and nothing else about what a message answers. The quote box's contents -
name, preview, thumbnail, filename, deleted-or-not - are **joined on every read**.

> **Deletion is what decides this.** A snapshot of the quoted text taken at send time survives the
> original being deleted, so the words an admin removed would live on inside every reply quoting
> them - visible in the conversation, out of reach of the delete meant to remove them. Joining
> makes one delete change every quote at once, for the same reason `sender_name` is joined.

The reference is a `seq` rather than a message id so the foreign key can be **composite and
self-referencing**: `(channel_id, reply_to_seq) → (channel_id, seq)`. `channel_id` appears on both
sides, so "the quoted message is in this channel" is enforced by the reference instead of being
re-checked by every read that draws a quote. A `CHECK (reply_to_seq < seq)` rules out quoting the
future, and with it a message quoting itself - which the FK alone accepts, because a
self-referencing key is satisfied by the row being inserted. Both proved in
`constraint-proof.sql` by attempting the violation.

Three joins in the read path became one `selectMessages(db)` used by all four reads, because the
second time a `JOIN` clause is written out is when it starts diverging silently (failure mode 9).

**The client cache had to grow a rule.** `syncChannel` pulls strictly above the local max, so a
cached row is never fetched again - which means a delete has to reach the quotes held locally or
they keep the deleted text forever. `MessageStore.patch` now strikes the message out of every
quote of it, in both implementations, and the SQLite cache keeps `reply_to_seq` as its own column
purely so that write can find those rows by index.

### The gap that fell out of that

`msg.update` is only self-healing **while connected**. Sync never re-reads a cached row, so a pin,
a tombstone or a reaction missed while offline is missed permanently - a client disconnected when
a message is deleted shows that message, with its text, indefinitely. The protocol doc claimed
otherwise. Recorded as roadmap item 14 rather than patched: the fix is a changed-since watermark
in the sync contract, not a line in the client.

### Cards can be held on native and deliberately not on web

Failure mode 17 said a card bubble must never be long-pressable. That reading was too broad, and
the two platforms differ:

- **Native negotiates.** The responder system hands the touch to the deepest view that wants it,
  so a finger on a poll option votes and never reaches the bubble, while a finger on the card's
  body does. Exactly the wanted behaviour, for free.
- **Web bubbles.** Events reach the wrapper on the way up regardless, so holding a vote button for
  400ms would vote *and* open the menu.

So the gesture is attached everywhere except web.

The dots that used to sit in every card's corner are **gone on native**, removed at the founder's
request once holding a card was confirmed working on a physical iPhone: a visible control doing
what the gesture already does is clutter, and it sits in the corner of a card whose own controls
are the reason the card exists. Web keeps them, because the gesture is deliberately not attached
there and without them a card would be the one message nobody could react to, report or reply to.

Both facts now read from one constant, `CARDS_ARE_LONG_PRESSABLE`. Asked as two separate platform
checks they would eventually drift into a card that can be held AND carries a redundant button, or
one with neither.

### Verification, and the process that nearly reported a lie

The reply sent from the browser drew its quote correctly and stored `reply_to_seq = NULL`. The
cause: **both API and gateway had been running for 21 hours with no `--watch`**, so zod silently
stripped the `replyToSeq` it did not know about, and the quote on screen was the sender's own
optimistic copy. The same stale process explains a `/mentionable` 404 that looked like a bug in a
route written a session ago.

That is failure mode 15 wearing different clothes - and note the direction it fails in: the
feature *looked* like it worked. Restarted properly, the whole path was verified against a live
server: `reply_to_seq = 9` in the database, `replyTo` fully resolved in the API's own response,
the quote surviving a reload, tapping it scrolling the list and highlighting exactly one row, and
deleting the original turning its quote into "This message was deleted" **live** - with the
quoted text gone from the page entirely.

### "I cannot create a poll or an event", and the field that was not there

Reported from the phone while the rest of this was being written, and worth the whole section
because the symptom pointed nowhere near the cause. Creating a poll or an event appeared to do
nothing: back in chat, no card, and an `Uncaught (in promise, id: 0)` toast at the bottom of the
screen. Expanding it gave the answer:

```
SQLiteErrorException: Error code 19: NOT NULL constraint failed: messages.mentions
```

The local cache wrote `JSON.stringify(message.mentions)` into a `NOT NULL` column, and
**`JSON.stringify(undefined)` returns `undefined` rather than a string** - so an envelope with no
`mentions` bound SQL NULL, the insert died, and the card was never cached.

Why only cards, and why only sometimes:

- **Cards are the one kind of message published by the worker**; everything else is published by
  the gateway. The worker process had been up for 22 hours - since before `mentions` existed on
  the envelope at all - so its `msg.new` frames carried no such field and every other message was
  fine. "Creating a poll is broken" was really "one publisher is old".
- **A reload made the card appear**, because the same message then arrived through `/sync`, whose
  envelopes are built in `reads.ts` and do set `mentions`. That is what made it read as a realtime
  bug rather than a missing field, and it is why the earlier browser check - where the card also
  failed to arrive live - was written off as the throttled socket reaping the connection.

Two fixes, because there were two faults. The worker was restarted, and `jsonListColumn` now
coerces an absent list to the `[]` that `MessageEnvelope` already declares as its default -
scoped deliberately to the two columns where a default is defined by the contract, and not to the
identity columns, where inventing a value would turn a loud failure into a corrupt row. Proved by
creating a poll and watching the card arrive **live**, with three tests including one that asserts
the raw `JSON.stringify` still throws. Recorded as failure mode 18.

The deeper cause is failure mode 16 again: `msg.new` is `frame.d as unknown as MessageEnvelope`, a
cast rather than a parse, so nothing checks that an arriving payload matches the contract it
claims to satisfy.

### Then the class, rather than the instance

The card bug's root was not the missing field, it was that **nothing checked**. Three separate
casts sat on the socket path, all typechecking perfectly, none of them knowledge:

- the gateway declared its send handler's payload by hand instead of importing `MsgSendFrame`
- the client read every field as `frame.d['x'] as T`
- the gateway relayed whatever `JSON.parse` returned from Redis under a `ServerFrame` annotation

All three are gone. `ClientFrame` was already parsed on the way in; `ServerFrame` is now parsed on
the way back, and the gateway parses each payload it relays.

**Parsing repairs rather than rejects, and that is why the gateway does it too.** The schema's own
defaults fill in what an older producer omitted, so a rolling restart stays safe - and an app build
already on somebody's phone cannot be fixed retroactively, while the server in front of it can.

The client's policy for a frame it still cannot read: drop it and pay one `syncAll`, since sync is
the authoritative path and a dropped `msg.new` then costs a round trip rather than a message.
**The handshake is the exception** - an unreadable `auth.ok` fails the connection instead, because
nothing further arrives to prompt a retry and dropping it silently is the forever-spinner PRD/03
forbids. That failure has shipped here once already, from `crypto.randomUUID` throwing in
`chat-provider`.

Two things fell out of it. The client's frame switch is now exhaustive by construction - a new
frame type that nobody handles is a type error, because `frame` narrows to `never` in the default
branch. And **every fixture in `chat-client.test.ts` turned out to be invalid against the
contract**: no `displayName`, `'club'` as a club id, `'someone-else'` as a sender, `'u-1'` as a
reactor. Twelve tests had been passing over payloads no server could produce. They were fixed
rather than the schema loosened.

Mutation-tested at both ends: removing the client's parse fails the three new wire tests, and
removing the gateway's fails the relay test with the production symptom verbatim - `expected
undefined to deeply equal []`. That relay test reads the raw bytes off a bare socket rather than
going through `ChatClient`, because the client parses too and would otherwise repair the frame
and pass either way, which a first attempt did.

Also renamed migrations 0012 to 0015, which drizzle-kit had christened `0015_hard_zarda` and
similar. Renaming the file and its `tag` together is safe because `__drizzle_migrations` records a
content hash and the journal's `when`, never the filename - confirmed by re-running the migrator
and counting 17 rows before and after. `AGENTS.md` now says to pass `--name`.

Tests: 677 to 700. `replies.test.ts` (10) and `store.test.ts` (5) were mutation-tested - nulling
the read join fails 7, nulling the append envelope's quote fails exactly the one case that guards
`msg.new`, hardcoding `deleted: false` fails exactly the deletion case, and skipping the
strike-quotes branch fails 3.

---

## 2026-08-01 - The first session run on real hardware, and what only hardware found

Started as one screen: the member profile did not look like v1's. Ended as the session that put
the app on a physical iPhone for the first time and found that **it had never run on one at all**.

The through-line is uncomfortable and worth stating plainly. Every check the repo had was green
throughout. Typecheck, 638 tests, the em-dash gate, the runtime-import gate, and a browser the
work had been verified in all the way. None of them could see any of the four defects below,
because all four live in a runtime nothing had ever executed.

### The member profile, and one field deliberately not restored

v1's screen is a centred 96px avatar, the name under it, then label-over-value details. The
remaster had an avatar-and-name row jammed left with the details boxed in a card. Rebuilt to v1's
shape, with `DetailLine` gaining a `labelCase` prop rather than being forked - design-system rule
5, since a second copy is how the two drift.

**The date of birth stays gone**, and that is a product decision rather than an omission. v1 showed
every member every other member's birthday; `readProfile` withholds `dob` from everybody but its
owner, so it is absent from the response rather than hidden in the markup. PRD/03 lists public
profiles as an explicitly rejected alternative - "clubs are small and often include minors".

The `Avatar` initial also stopped being a fixed 17px and became `size * 0.42`, which is the ratio
the 40px default already had. At 96px it had been a speck adrift in a circle.

### Avatars were written and almost never read

The upload had worked since the phase it shipped in. **Two reads out of nine projected the
column.** Own profile let you set a picture and then drew your initial forever; the club roster,
chat, news, polls, the add-member search and every join-request queue did the same.

Half the fix was client-only - the payload already carried `image` and the screen dropped it. The
other half was five server reads that never selected the column, plus `senderImage` on the shared
`MessageEnvelope` (joined at read time beside `senderName`, for that field's reasons), a
`sender_image` column in the client's SQLite cache, and `displayImage` on `auth.ok` so a sender's
own optimistic bubble draws their face rather than being the one letter in the conversation.

The `sender_image` migration deliberately does **not** wipe the cache the way `sender_name` did. A
null there draws the letter placeholder, which is what shipped before and is correct anyway for
anybody with no picture, so a full backfill would cost every user a refetch to replace something
that already looks right.

### A moderation screen that had never worked

Found while wiring an avatar into it. `ReportRow` in the client described **a response the server
has never sent**: it declared `reportId`, `reporterName` and a nested `message` object, where
`GET /channels/:id/reports` returns `messageId`, a `reporters` array and the message's fields
inline. Every field the Reports tab read was `undefined`, so every card rendered "Unknown sender"
over "This message was deleted", and Dismiss posted to `/moderation/reports/undefined/dismiss` and
404'd - silently, since the screen reloads either way.

It typechecked perfectly for its entire life, because the client restated the shape instead of
being handed it. Failure mode 12, and the reason the new tests assert field *names*.

`deletedAt` was added to the payload at the same time: `body` alone cannot distinguish a deleted
message from a photo, so a reported photo was being labelled as one an admin had already dealt
with.

### The app did not run on iOS. At all.

`crypto.randomUUID()` at `chat-provider.tsx:73`, building the `ChatClient` during sign-in.
**Hermes has no `crypto`.** The call threw, `start()` rejected, auth never resolved, and the app
sat on its loading spinner forever - PRD/03's "never hang on a spinner", violated on the primary
platform. A second call site generated `clientMsgId` for every send.

Neither was new and neither was touched by this session's work. Web has the global, so every
browser check passed. It took a simulator to see, and one screenshot to diagnose.

`randomUuid` is now a **required** `ChatClientOptions` field rather than optional-with-a-default,
following `createSocket`'s precedent. A default reaching for the global would keep working on web
and keep failing on native, which is the bug restated rather than repaired.

### Four bugs that only a physical device could produce

The simulator shares the Mac's network stack, so it hid an entire class of problem. On a real
phone `localhost` means the phone.

| Symptom | Cause | Fix |
|---|---|---|
| "Could not connect to the server" | `EXPO_PUBLIC_API_URL` inlined by whichever Metro serves the bundle, and that one had defaults | Metro restarted with the LAN address |
| "Photo unavailable" everywhere | `MEDIA_CDN_BASE_URL` / `S3_ENDPOINT` on `localhost:9000` | pointed at the LAN address |
| Status bar sitting on the chat header | `chat/[channelId].tsx` had **no** `useSafeAreaInsets` at all | inset added |
| Attachments refused | see below | file streamed instead of a blob |

The header one is worth noting: `highlights.tsx`, the screen chat's header is deliberately styled
to match, has had the inset since it was written. Chat is the copy that lost it, and neither web
nor the simulator could show it.

### "The upload did not arrive intact" - four attempts, three wrong

The one that cost the most, and the one with the most to learn from.

Attaching a photo failed with `mismatch`: `completeUpload` HEADs the object and compares its
length against what was declared with **no tolerance**, by design.

1. **In-memory blob.** Reasoning: the blob is file-backed, so it measures one thing and sends
   another. React Native's `Blob` constructor rejects an `ArrayBuffer` outright and threw before
   the upload intent was even requested, which made things worse rather than different.
2. **`expo-blob`.** The runtime's own warning recommends it: RN's Blob "reads it back through
   base64 encoding". Installed it, rebuilt the native app. `Response.blob()` kept using RN's
   implementation regardless and the byte count did not move.
3. **Filesystem size.** Declare `File(uri).size` instead of `blob.size`. They turned out to be
   the same number, which was itself the useful result: nothing was being mis-measured.
4. **Stream the file.** `UploadTask` with `BINARY_CONTENT` PUTs the file "as-is in the request
   body", no blob anywhere. This worked.

> **The diagnosis underneath attempts 1 to 3 was built on a measurement error, and it is the
> lesson worth keeping.**
>
> The whole "96 extra bytes" theory came from comparing the declared size against MinIO's
> `part.1` on disk. That file is **not the object** - it carries MinIO's own block header, which
> is also the "binary junk before the PNG signature" that looked so much like corruption. The
> successful upload has exactly the same +96 on disk. Every number in that chain of reasoning was
> real; the thing being measured was not the thing that mattered.

Two changes went in close together, so **which one fixed it is not established**: the S3 client
also gained `requestChecksumCalculation: 'WHEN_REQUIRED'`. That change is defensible on its own -
the SDK's default signs `x-amz-checksum-crc32` over a body that does not exist yet when
presigning, and the URLs carried the CRC32 of nothing - but it should not be recorded as the fix.

### Tests, and what they are worth

`npm test` went from 638 to 654, and both new files were **mutation-tested rather than trusted**:
reverting each fix was confirmed to fail the test that covers it.

- `avatars-on-reads.test.ts` - one case per read that returns a name, asserting the picture rides
  along. Reverting the join-request and report projections failed exactly the right two, with
  `expected undefined to be '<media id>'`, the symptom the real bug produced.
- `sqlite-schema.test.ts` - the client cache's migrations against Node's built-in SQLite, from
  every prior schema shape including a half-applied one. This needed the SQL split out of
  `sqlite-store.ts`, which imports `expo-sqlite` and therefore could never be tested. Deleting the
  `sender_image` step - the "works on every new install, breaks every upgrade" mistake - fails
  four of them.

`apps/mobile` had no test runner before this; it has vitest now, picked up by the root `npm test`
through `--workspaces --if-present`. The migration was **also** verified on the device itself: the
on-device table was forced back to its pre-`sender_image` shape with a row in it, the app
relaunched, and the column came back appended at the end - `ALTER TABLE`, not a recreate - with
the cached row intact.

### The standing lesson

`AGENTS.md` already says to verify on each platform separately. This session is the receipt.
**Every defect above except the profile layout was invisible to a green suite and a working
browser**, and the two that stop the product dead - no iOS launch, no attachments - needed a real
phone on a real network to produce at all.

---

## 2026-07-30 - Reading v1 for the things a screenshot cannot show

A session spent porting v1's shared screens, which turned into a session spent reading v1's
*navigation* - because four of the five things the founder flagged were structural rather than
visual, and none of them is visible in a screenshot.

### Three founder corrections, and what each one actually was

**"It is not Alerts, it is Notifications."** One word in the tab bar, and behind it a real defect.
The read model was inverted: the inbox marked rows read on **focus**, so every row flipped to its
read style before the reader could perceive that any of them were new. The unread state existed
and was never once visible. It now marks on **blur**, so rows stay unread for the whole visit and
are light the next time. The founder also specified the chat-unread rule precisely - those rows
stay dark and their count does not come down until the chat itself is opened - which the server
had implemented correctly since Phase 1 and the client had never expressed. Only the client was
wrong, which is the useful shape here: a correct server does not make a correct product.

The visual treatment was wrong too, and for the same reason. Unread was a small "New" badge on the
right of the row; v1 tints the entire row, fills the icon well with the accent, darkens the body
text and adds a dot. At a glance down a long list a corner badge is invisible, which is another way
of saying the unread state was not communicating.

**"Note how the navigation bar shows up and where it won't."** v1's rule turned out to be exactly
one line, in `ChatScreen.tsx`: hide the tab bar on mount, restore it on unmount. So the tab bar is
present on **every** signed-in screen except chat - club hub, rosters, polls, races, highlights,
gallery - and chat is the sole exception because it owns both edges of the screen, a translucent
header at the top and a composer at the bottom. The remaster had every non-destination screen as a
sibling of the tab group, so a club, a race and a poll each hid the four destinations too.

`PRD/05` rule 14 already said "chat is full-screen - the bottom tab bar is hidden while in a
conversation", which is a rule about *chat*, and it had been implemented as a rule about
everything below a destination. The spec was right and unread.

The fix moved 26 route files into `app/(tabs)/(main)/`. **Not one URL changed**, because both
`(tabs)` and `(main)` are route groups and a parenthesised segment contributes nothing to a path -
which is the whole reason the tab is a group rather than a folder named `main` or `clubs`. A
folder named `clubs` would have turned `/polls/:id` into `/clubs/polls/:id`.

It also produced a defect worth recording because the diagnosis was initially wrong. After the
move, every nested screen showed a "Clubs" bar above its own header, and this was first read as
*the tab bar now rendering* - the desired outcome. It was a **double header**: `(main)` had become
a tab screen supplying its own stack headers while the tab navigator still drew one of its own.
The tab bar was not visible at all, because the session was signed out and the layout hides it in
that state. **The lesson is about the evidence, not the bug**: "a bar appeared where I wanted a bar"
is not a verification, and the screenshot supported either reading equally well.

**"The grid in chat has separate features per scope, and so does the add button, and admin and
member are not the same."** Read off v1's three chat call sites. The header grid is quick-nav and
is **not** role-gated - every member sees the same entries, because reaching a screen is not acting
on it. The "+" menu is gated on two independent axes that are easy to conflate: *which* create
actions exist is a fact about the scope (Event is club-only, Meeting is Eboard-only), and *whether
this person gets them* is a fact about their authority. Neither absence is a permission.

The subtle part is that "admin" resolves to a different predicate per scope: club admin in club
chat, a roster member who is also a club admin in race chat, and **every member** in Eboard chat,
where membership is admin-tier by construction. One predicate already answers all three - the
channel-admin question asked of the channel - so the screen asks it once rather than restating
three role rules.

### Two subsystems that were complete on both ends and joined by nothing

Failure mode 11, twice in one session.

**Chat had no pin, no delete and no announcement toggle.** `canPin` was on the channel meta,
`setPinned` and `deleteMessage` were in the client's API module, the routes existed, and the
server had enforced the announcement rule since Phase 2. Nothing in the app could reach any of it.
Two things blocked it: `client-core`'s send-type union was `'text' | 'photo' | 'document'`, so an
announcement was **unrepresentable in the outbox** and the control could not have been built; and
the channel meta exposed only `canPin`, whose own doc comment warns against deriving other
capabilities from it. Added `canAnnounce` and `canDeleteAnyMessage` as their own fields, and
`canDeleteOthersMessages` as its own predicate.

The DM case is what makes those separate fields load-bearing rather than tidy, and it is what the
new test pins: **both participants can pin, and neither can announce or delete**, because a DM has
no admin. Any implementation deriving announce or delete from `canPin` offers both to both people
in every DM in the product, and no other scope would reveal it.

**The add-member search had no search.** `POST /clubs/:id/members` takes a user id and nothing in
the product could turn a name into one - so `PRD/04` rules 12 and 14 were unmet by a subsystem that
looked finished. The founder scoped the fix away from v1's behaviour deliberately: v1 used a
global user directory, and the remaster keeps `searchDmCandidates`' rule that there is no such
thing, so the pool is people the caller already shares a club with. A stranger is reached with the
invite link, which ADR-0010 already makes the only front door.

The three candidate reads are authorized by **the same predicate as their own `add`**, not a
similar one. A search anybody could run leaks a roster by exclusion: ask for every candidate, and
whoever is missing is a member. The Eboard pool is narrower again - the club's admin tier only -
because `addEboardMember` refuses anybody else, and offering a plain member there would be a
search result that fails on tap.

### The poll list card could not be drawn

v1's poll card shows a vote tally and a countdown. `listPolls` returned `{id, question, closed,
votedByMe}`, and a client cannot derive either from that. Added both, which pulled in two rules
this repo has already paid for: `COALESCE` around the `SUM`, because a poll with no votes returns
null rather than zero and would render an empty badge; and `isoUtc()` rather than `::text`, because
Postgres renders a timestamptz as `2026-07-30 08:42:41.123+00`, which `new Date()` parses happily
and a strict validator refuses. The test asserts the ISO shape rather than trusting it.

`voteCount` is votes **cast**, not people - a multi-select poll counts one member several times.
That is what v1 counted and what "42 VOTES" means on the card.

### Three roster screens became one

The club, race and Eboard rosters were three forked implementations of the same screen. They are
now one `MembersScreen` parametrised by rows, sections and a per-row action list, which is
design-system rule 5. The action list is a **function of the row** rather than a flag set, because
the answer genuinely differs per row: an Owner cannot be removed, an Admin only by the Owner.

It is also called for the caller's **own** row, which was a correction: the first version refused
self-actions blanket-style and silently dropped the race roster's "Leave this race". Leaving is a
real action a member performs on themselves, so whether the own row gets a menu belongs to the
caller, where the rule actually lives.

### The five screens themselves

Highlights, Gallery, Calendar and the events list, after Members. Three details worth keeping:

**The calendar reads once, not twice.** The grid needs to know which days carry something and the
tapped day needs its items, and the obvious build asks the markers endpoint for the first and a
paged feed for the second - two answers to the same question, free to disagree. One `when: 'all'`
read grouped by day cannot. The two v1 grid rules came with it: always six weeks of cells, so
paging never changes the grid's height; and a filler day from an adjacent month is never marked
and never tappable, because a solid marker on a greyed-out day reads as a prominent control that
does nothing.

**The gallery is the one screen with no page margin.** Photographs are the content rather than
something sitting inside content, so the tiles touch across a 2px gutter instead of sitting in
rounded cards behind a 16px gutter. The full-screen viewer inverts the surface, which is the only
place `inverseSurface` is the right token.

**A poll gets no date bib in the events list.** Its `at` is a closing deadline rather than a day it
happens on, and an open-ended poll has none at all - a day chip would state something untrue. It
gets a ballot glyph instead.

### Operational

Three self-inflicted, all recorded because they cost time and would recur.

**Metro served a stale module graph** after the 26-file move, reporting resolution failures against
file contents that no longer existed. Restarting Expo with `--clear` fixed it. The trap is that the
browser console *retains* those errors: they kept reappearing with their original timestamps long
after the restart, which reads as "still broken" when the timestamp is the thing that proves
otherwise.

**`pkill -f "watch src/api/main.ts"` killed the founder's dev server.** Two ClubChat stacks run
side by side and `npm run dev:api` produces byte-identical command lines for both - the port is the
only thing that distinguishes them, and a command-line pattern cannot see a port. Kill by the PID
that owns the port.

**A restarted API served the wrong client.** The port variable is `API_PORT`, not `PORT`, so a
`PORT=3100` restart tried to bind 3000 and refused - which failed safely. Then CORS blocked the
agent's client on `:8082`, and the app reports that as **"You appear to be offline"**, which reads
like a dead server rather than a misconfigured one.

That one had a second layer. `CLIENT_ORIGIN=... npm run dev:api` does not work here: `.env` pins
`CLIENT_ORIGIN` to `:8081` and `--env-file` wins over the shell, so the override was silently
discarded. `API_PORT` had appeared to work only because `.env` does not mention it. The fix is a
**second** `--env-file` after the first, since later files win; a shell variable never does.

Before all of that, a stale API had been answering with two-phase-old code - failure mode 15
arriving exactly as advertised. The new routes 404'd identically to a bogus route, and the running
process turned out to have no `--watch` flag at all.

---

## 2026-07-30 - The design system: Stitch, v1, and which one is the truth

The designs live in a Google Stitch project, reached over MCP. Registering it with
`claude mcp add` worked and **its tools do not load**: `tools fetch failed - can't resolve
reference #/$defs/ScreenInstance`, a broken `$ref` in Stitch's own schema. Server-side and not
fixable here, so the project was read by speaking JSON-RPC to the endpoint with `curl` - which also
sidesteps MCP tools only attaching at session start. All 15 tools work that way.

### I "corrected" the tokens to the wrong thing, then corrected them back

The live Stitch project's theme is **warm peach** - background `#fff8f6`, chrome `#ffe9e3`, text
`#281712`. `SPEC/TECH/13`'s table said **cool grey** - `#f7f9fb`, `#f2f4f6`, `#191c1e`. The accent,
the error and the tertiary matched in both.

I assumed the live project was authoritative and the table had drifted, rewrote both the token
module and the spec to the warm ramp, and said so in this file. **That was backwards.** v1's
`constants/theme.ts` carries the cool grey set verbatim from the Stitch export's DESIGN.md
frontmatter, and v1 is what shipped and ran with real clubs - the Stitch project has simply moved on
since. Both are now restored from v1.

The rule that comes out of it, recorded in `TECH/13` because more designs will arrive: **v1 is
ground truth for what the product looks like, because it is the thing that actually ran.** A live
design tool is a working document. Read it for screens the product does not have yet; do not let it
overrule the shipped appearance of the ones it does.

The near miss underneath is worth naming too. Nobody eyeballs a background colour against a spec
table, so a wrong neutral family would have survived indefinitely - and it was only caught because
the founder said, in passing, that v1's UI was fine and the backend was the problem. That sentence
was the actual bug report.

### The fonts were specified and had no implementation

`TECH/13` rule 3 says a typography role is a complete family/size/line-height triple, and rule 4
says the whole app is gated on fonts being loaded so no screen flashes a system face. The families
were in neither the token module nor the app: every role carried a size and a weight and no
`fontFamily`, so the app rendered in the platform default at the right sizes - which looks
deliberate enough to survive a casual look and is not the design.

Anton, Archivo Narrow and Inter are now loaded behind a `FontGate` that holds the app, wired into
the roles, and **Anton is on every header title** as the rule says - it had been Archivo Narrow
bold, the body face, which made every header read as a heavy paragraph.

Two things worth keeping from doing it:

- **The gate fails open.** If the faces cannot load, the app renders anyway. A missing font is a
  visual regression; a permanent spinner is a dead app, and `PRD/03` names the spinner-forever
  failure specifically.
- **The family names are tokens and live in `theme.ts`.** Putting them next to the loader made
  `theme` import `fonts` import `theme`, which failed at runtime with "Cannot access 'color' before
  initialization" - the module graph saying the dependency pointed the wrong way. The token module
  imports nothing; everything imports it.

### Four designs that asked for things the product does not have

The project carries 67 screens. Several show data and features that exist nowhere in the schema or
the PRD, and all four were settled the same way - **take the visual language, not the implied
scope**:

| The design shows | Decided |
|---|---|
| "MILES LOGGED 42.1K / Goal: 50K", "MEMBERS 1,248 / +12% this month" | Dropped. Member count is real; mileage, goals and growth-over-time are a domain that does not exist |
| A Message Search screen | Stays deferred, per `PRD/17`'s "do not fix" list |
| An Appearance & Dark Mode screen | Light only for now; the flat token module is already the seam |
| A hero cover image per club | Skipped. Clubs carry no media at all today |

Recorded in `TECH/13` with the rule they share, because more designs will arrive: **a design is a
specification of appearance, not of scope.** Where one implies data the product does not hold, the
gap gets raised, never quietly invented inside a component.

### Where the re-skin actually is

Done: the colour ramp and type scale restored from v1 verbatim, the three typefaces behind a
loading gate, Anton on every header title, the chevron affordance on navigable rows, and the four
tab icons v1 shipped (`groups`, `calendar-month`, `notifications`, `person` - MaterialIcons, the
same set). That is four files - `theme.ts`, `fonts.tsx`, `ui.tsx` and the two layouts - landing on
all thirty-odd screens at once, which was the entire point of building behind that seam.

Not done: **v1's screens have not been read individually.** Its `components/` directory holds
`ChatScreen`, `PollsListScreen`, `MembersScreen`, `HighlightsScreen`, `GalleryScreen`,
`CalendarScreen` and `EventsListScreen` - the same shared-screen shapes this build converged on
independently, which is a good sign and also means there is a lot of proven layout detail in there
to take. Icons on rows and section headers are not wired. And the surfaces v1 never had - direct
messages, blocking, the moderation queue - have no design to copy and will need one built in the
same language.

---

## 2026-07-30 - Phase 3.75b: the screens

The client went from six files to roughly thirty-five. Not finished - what is missing is listed at
the end - but the shell, the shared vocabulary and most of the screens exist and the app runs.

### Three decisions made before writing any screen

Each is the difference between forty screens and forty copies.

**A real tab group.** There was no tab bar at all: Messages hung off the bottom of the club list as
a button, and Calendar, Notifications and Profile had nowhere to be. `PRD/15` opens with four
destinations and a badge on one of them, so that is what the `(tabs)` group is. Everything below a
destination is a sibling of the group on the root stack, which is what makes a club or a chat cover
the tab bar rather than nest inside one tab's history. Messages stays out of the tab bar
deliberately: group chat is the product and DMs are additive, and `PRD/15` lists four, not five.

**One three-state loader.** `useLoad` owns the state machine and `<DataScreen>` owns what each state
looks like. `PRD/16` rules 1 and 2 are requirements rather than polish, and forty hand-written copies
of a three-state fetch is how one of them ends up blank on a 500. Same argument as the policy module,
one layer up.

**Shared screens, not forked copies.** Polls, Highlights and the Calendar are each one implementation
parametrised by scope. The scope arrives as two strings and changes nothing about behaviour - if a
`switch (scope)` ever appears inside them, the abstraction that survived intact through the whole
server has been broken in the client.

### Three defects, all found by running it

**Every screen entered by direct URL had no back control.** Caught by opening
`/clubs/:id/members` in a fresh tab: the header rendered its title and nothing else. The layout had
declared titles and left `headerLeft` to the navigator, which renders a back button only when history
exists - `PRD/15` rule 3, for the **third** time in this project. The fix is a `parented()` helper so
every nested screen builds its back target from its own route params: a screen inside a club goes
back to that club, not to the clubs list. Worth noting how invisible it is to clicking through -
every one of those screens looked correct when reached from its parent.

**The invite link pointed at the API.** `/join/:token` is a client route, and the club profile built
the link from `config.apiUrl` - so the link an admin copied and shared would have sent whoever tapped
it to a server with no such path. Now `Linking.createURL`, which resolves to the site origin on web
and the registered scheme on a device.

**The inbox crashed on its first real row.** `Cannot read properties of undefined (reading
'approved')`. The client's `InboxRow` type was a guess - a `params` bag, a nullable body, `readAt` -
and the real shape is a discriminated union carrying a `NotificationTarget`. Exactly the hazard the
top of `api-types.ts` warns about: a hand-written type over somebody else's response is an assertion,
not a check. `NotificationTarget` is now **imported from `@clubchat/shared`** rather than restated,
which buys something real - the server derives targets exhaustively over the notification types, and
the client's routing switch is now exhaustive over the same union, so a new target kind is a compile
error rather than a row that navigates nowhere.

Also fixed on sight, per the pixel-perfection standard: every tab rendered two stray chevrons
because the navigator fills an empty icon slot with a placeholder, and the club, race and Eboard
headers said "Club", "Race" and "Eboard & Council" instead of the actual name - the Eboard one
mattering most, since that name is per-club data and "Eboard & Council" is only its default.

### Three more defects, all the same family

Found by walking the remaining screens with a seeded club that had real content on every one. Every
single one was a hand-written client type disagreeing with the server - which is the hazard written
at the top of `api-types.ts`, now demonstrated four times in one phase.

**The gallery crashed on load.** Its type said `{ items, hasMore }`; the server returns
`{ entries, nextCursor }`. The more interesting half: each entry also carries `url` and `thumbUrl`,
and **a web client cannot use either**. They point at `GET /media/:id`, which answers 302 behind an
`Authorization` header - the exact thing the Phase 3 entry above records as unusable for an
`<img src>`, because react-native-web renders every `Image` as one. The gallery renders from
`mediaId` through the JSON sibling instead, and the type now says so where somebody would otherwise
reach for the convenient-looking field.

**Every news post read as "edited".** The marker was `updatedAt !== null`, and both timestamp columns
default to `now()` - so a post was labelled edited from the instant it was posted. It is
`updatedAt !== createdAt`, and the client type no longer claims the column is nullable.

**A plain member was offered the Reports tab.** It would always have errored, because reports reach
only that space's admins. The fix is a new field rather than a client-side guess:
`readChannelMeta` now returns `canReadReports`. Guessing from `canPin` would have looked equivalent
and been wrong in the one case that matters - a DM, where the reader is a platform moderator and not
either participant.

### The two loose ends, closed

**Jump-to-message.** Chat now reads the `?around=seq` that Highlights, the pinned strip and mention
notifications hand it: it fetches the window from `/channels/:id/messages/around`, writes it into the
local store so it is cached like any other page, scrolls the target to the middle of the viewport and
marks the row with a left rule. Two details were load-bearing - the scroll-to-end that chat does on
every content change has to be suppressed while a jump is in effect, or it immediately undoes it; and
`onScrollToIndexFailed` has to be handled, because a row far from the tail has not been measured yet
and that is precisely the case a jump hits.

**News photos.** Uploaded against the club's **main channel**, which is not a workaround: an upload
intent for a photo requires a channel because the channel's access rules govern the object, a news
post has none of its own, and news and the main channel have exactly the same audience. The
alternative was a news-shaped branch in the media pipeline - a second answer to a question that
already had a correct one.

`RemoteImage` came out of this: the chat bubble, the gallery tile and the news photo all needed
"turn this id into an image, and say so honestly when it will not load", which is the third caller
and therefore the point to extract.

### Verified by walking it

Three actors against a real API, gateway, worker and Postgres, with a seeded club carrying a race,
a roster, a car group, four polls, two meetings, two events, workouts and a news post.

- **Every screen renders, and every screen entered by direct URL with no history has a back
  control.** That was the whole reason the gate said so.
- A race member opening `/races/:id` lands in **race chat**; chat's back goes to Clubs and never to
  the hub, so there is no bounce. The quick-nav carries exactly the race scope's entries.
- The poll card posted itself into race chat on creation.
- Voting **cast, moved and withdrew** on the same gesture - 1 vote, 2, moved back to 1 and 1, then 0
  - and opening the voter list cast nothing.
- A deadline-less poll sat in Upcoming, sorted last among dated rows, and never fell into Past.
- The **admin with no roster row** got the preview, the "You manage this" badge, Meet Information
  with its per-field empty states (hotel hidden, photos and results reading "Stay tuned"), and a
  route into the roster and nothing else.
- That same admin was refused the **race poll by direct URL** and the car groups - each a retryable
  "Not found" with a back control, never a blank page.
- The **Eboard row was absent entirely** for a plain member, and its URL refused them.
- A member saw the roster ordered owner, admin, member with no role or removal controls at all.
- An invalid invite link said so plainly and offered search, disclosing nothing about which clubs
  exist.

**Still owed:** the acceptance checklist run end to end on all three platforms. Everything above is
react-native-web in Chrome, and the simulator has still never been run in this project.

One process note worth keeping. `npx expo start` refuses the port when a dev server already owns it
and then, in non-interactive mode, **skips starting anything** - and the API had a `CLIENT_ORIGIN`
pinned to the other port, so the first sign-up attempt died on CORS rather than on anything real.
Same family as AGENTS.md failure mode 15: confirm the process you are talking to is the one you
started.

---

## 2026-07-30 - Phase 3.75a: the HTTP surface

Phase 3.75 was created and split on the way in. The proposal that existed said "wire the 32
handlers to routes, nothing here needs new domain logic or new schema", and both halves of that
turned out to be wrong, so the phase was re-scoped before any code was written.

### What the audit had missed, and why

The earlier audit compared the **handler list** against the router. That can only find handlers
nobody routed; a capability that was never written at all appears in neither list and survives
the comparison. Reading `TECH/10`'s REST sketch and `PRD/15`'s screen map against the router
instead found two further classes:

1. **Six capabilities with no function of any kind** - club search, invite-token rotation,
   account deletion, profile editing, and both Highlights queries. Four of them sit on columns
   that already exist, which is why the v1 table-by-table check had passed them: it proved the
   schema complete, and the schema was not the gap.
2. **The 34 handlers are all commands.** There is no read function for the club roster, the race
   list, a race, the race roster, the car groups, the news feed, the meetings list, or another
   member's profile. A route needs something to return, so ten or so queries were missing too.

The lesson is recorded in `TECH/16` rather than only here: **audit against the spec, not against
the code's own inventory.** The code cannot list what it never had.

### The router became a directory before it doubled

`api/app.ts` was 959 lines of plumbing plus 45 routes, and this phase roughly doubles the route
count. Split first, so the split is mechanical rather than a rewrite of a 2,000-line file later:
route groups now live in `api/routes/*.ts`, grouped by **path** rather than by domain module, and
`app.ts` is composition. The shared pieces - `authorizeChannel`, `refusalStatus`,
`mediaConfigOf`, `AppDeps` - moved to `api/plumbing.ts`.

One structural guarantee came out of it that the single file only had by habit: groups are
handed the `protectedRoutes` scope rather than the root instance, so an unauthenticated route
cannot be added by forgetting the hook. It can only be added by editing `app.ts`.

Verified as a pure refactor before anything was built on it: 531 tests, same counts, and
`check:runtime` loading every module the way production does.

### Races: twelve commands routed, four reads written

Sixteen routes, and four query functions that did not exist. One new predicate,
`canReadRaceRoster`, because the roster is the single race read where management authority does
grant sight - `PRD/09` rule 5 gives a manager with no roster row exactly one thing, a way into
the roster to manage others. It is the only union of `isRaceMember` and `isRaceManager` in the
policy module, so it gets a name rather than a caller reaching for whichever looks close.

`pendingRequests` comes back as `null` rather than `[]` for a non-manager, so a client cannot
read "not allowed to see this" as "nobody is waiting".

The tests deliberately sit at a different altitude from `policy/matrix.test.ts`: sixteen cases,
every one through `app.inject` with a real session token against a real database. A matrix over
pure functions cannot tell whether anything calls them, which is exactly how Phase 2 passed its
gate with no surface at all.

### Two defects in shipped code, found by the first test that crossed the middle

**Account revocation had never worked.** The HTTP hook and the gateway both checked
`session.user.signinBlockedAt`, and better-auth returns only the columns declared in
`user.additionalFields` - which those two lifecycle columns are not. So the property was absent
rather than false, both checks read `undefined`, and **a blocked or deleted account kept working
until its session expired**, in both entry points, since Phase 0. The comment above each check
described precisely the protection it was failing to provide.

Proved before fixing, by asserting on the session object: it carries eleven keys and
`signinBlockedAt` is not among them, while the database column is set. The fix moves the answer
to where it always lived - our own `users` row, loaded into the access context, asked through
one predicate `isSessionUsable`, consulted by both entry points. The API now loads the context
*before* deciding, which costs a query the request was going to make anyway.

**An untargeted `ON CONFLICT DO NOTHING` swallowed invariant 5.** `assignToCarGroup` inserted
with a bare `onConflictDoNothing()`, which absorbs every unique violation on the table -
including `car_group_members_one_per_race`. So assigning somebody already in a different car
answered `{ assigned: true }` and did nothing, and the `catch` written to turn that collision
into a refusal was unreachable because nothing ever threw. Now targeted at the primary key, so
re-adding to the same group stays idempotent and a second group raises; and the catch checks the
pg code through the cause chain rather than treating any failure as "already in a group".

`isUniqueViolation` moved out of `append-message.ts` into `db/errors.ts` on the way, since the
second caller is the point at which a copy would have been made.

Both defects were invisible to 531 passing tests, a full permission matrix, and 62 constraint
assertions. Neither is a race bug. Both were found because a test finally called the code over
HTTP the way a client will, which is the argument for the phase gate being what it is.

### The rest of the surface

Races were the first slice and the pattern for the rest. In order after that: the club roster and
club detail reads, polls in three scopes, the content group (meetings, events, routines, news), the
calendar, pin and soft delete, Highlights and jump-to-message, then the four capabilities that had
no function of any kind.

Final shape: **45 routes became 111**, with roughly twenty new query and command functions, one new
table, one new check constraint, and 76 route-level test cases. The gate is checked in as
`scripts/surface-gate.sh` and passes 73 checks against a running server.

Three route-shape decisions worth keeping:

- **The scope is in the path, never in the body.** `POST /races/:id/polls` rather than `POST /polls`
  with a scope triple. See the security note below - this is not a matter of taste.
- **Pin and soft delete are two narrow routes, not a PATCH over the message.** A single partial
  update is exactly the shape that reintroduces the trap they exist to prevent: a caller who may
  delete would be sending a payload that could also carry `pinned`.
- **Voting is addressed by option** (`POST /poll-options/:id/vote`), because the option already
  identifies its poll. A `/polls/:id/votes` route taking `{ optionId }` accepts a pair that can
  disagree, and there is nothing sensible to do with a disagreement.

### Three more defects in shipped code

On top of the two found with races.

**A malformed id was a 500 on every id-addressed route.** `/channels/undefined/messages` put the
string straight into a `uuid` column, Postgres refused to parse it, and the driver error surfaced as
an unhandled failure with a stack trace in the log - the wrong status, and more than a caller should
learn. Found by a test that built a path from an undefined variable, which is how a client will hit
it. Fixed with one hook over the whole protected scope rather than sixty parse calls: every `:id`
and `:uid` in this API is a UUID, and anything else is 404. `seq` and `token` are deliberately
outside it.

**`news_reactions.emoji` was unconstrained text.** PRD/06 rule 4 says news reactions use the same
emoji set as chat; `message_reactions` has a check constraint saying exactly that and this table had
none. It held only because nothing could write to the column - and this phase was about to add the
writer. Now constrained identically, with four assertions in `constraint-proof.sql`, because a
column that renders directly into every client must not depend on a route remembering.

**A two-part authorization check could have been satisfied against two different clubs.** Never
exploitable, because no route existed - but it is the reason the poll routes take no `clubId`.
`canCreatePoll` for a race asks for a roster row on the race *and* club-admin on the club, and it
cannot tell whether its two arguments describe the same race. A caller sending both could pair a
race they are merely on the roster of with a club they happen to administer and pass both halves of
a check meant to be one question. The owning club is now resolved server-side by `domain/scopes.ts`,
which `createMeeting` and `deleteMeeting` use for the same reason - a wrong `clubId` there routes a
notification and a chat card into the wrong club.

### Two mistakes of my own, both worth the entry

**`::text` on a `timestamptz` is not ISO 8601.** It renders Postgres's own format, with a space and
a two-digit offset. A browser parses it, so a response looks fine; a strict validator does not.
Found when a paging cursor this API emitted was rejected by the same API's own `before` parameter.
There is now an `isoUtc()` helper and a rule: plain `::text` for a `date`, `isoUtc` for a timestamp.

**The gate reported 46 failures against code that was correct.** `npm run dev:api` had exited with
`EADDRINUSE` because a server from an earlier session still owned port 3000, so every request went
to a process that predated the whole phase. Races and polls answered; everything newer 404'd. The
tell was that the *pattern* of failure matched the age of the code rather than anything structural.
Recorded as AGENTS.md failure mode 15, and the script now says so in its own header. Note which
direction it fails in: it called new work broken, which wastes an hour. The inverse - a stale
process confirming a fix that never deployed - is the one to actually fear.

### One product question this phase could not answer

**What should deleting an account do when the caller still owns a club?** Three rules collide:
deletion is unconditional and self-service (PRD/03 rule 11), an Owner cannot leave and transfer is
their only path out (PRD/04), and exactly one Owner must exist per club because an ownerless club
has no recovery path (invariant 1). Deleting the memberships would produce exactly that: the partial
unique index enforces *at most* one owner, so nothing would have stopped it.

Built as a refusal - `409 owns_clubs` - which preserves both the invariant and the other members'
club, and keeps deletion self-service since the client can offer transfer-or-delete per club. It
does make deletion conditional, which rule 11 says it is not, so it is recorded as an open question
in PRD/17 with the fourth option named: auto-promote the longest-serving admin.

### Verification

- **Typecheck** clean, **`check:runtime`** loads all 57 modules the way Node runs them.
- **607 tests** passing, up from 531. Zero failures, zero flakes.
- **`db:prove`** at 70 assertions, exit 0.
- **`npm run gate:surface`**: 73 checks over TCP against a real server and a real Postgres, all
  passing, roughly half of them refusals - including every direct-URL case the acceptance
  checklist names.
- **Not verified**: nothing was exercised from the Expo client, because the screens do not exist
  yet. That is Phase 3.75b, and it is the honest limit of this phase.

---

## 2026-07-30 - Completing Phase 3: attachments actually reachable from the app

Phase 3's two gate conditions were met back when it shipped - a private Eboard photo provably
unreachable without membership, chat readable in airplane mode - and the phase was **not
finished**: the client could neither attach a photo nor render one. Closed now, before starting
Phase 4. Suite total 531, `db:prove` at 62, all green.

What was missing turned out to be considerably more than a picker.

### The envelope carried no media at all

Phase 3 added `media_id`, `document_name` and `document_size` to `messages` and never put them on
the `MessageEnvelope`. So a client receiving a photo knew only that its `type` was `'photo'` - no
id, and therefore no way to fetch the bytes. The upload half and the render half were each
unreachable from the other, and every server test passed because each end was exercised against a
fixture and nothing crossed the middle.

Now on the envelope, populated at every construction site, persisted in the local SQLite cache, and
carried through the send outbox so an optimistic bubble renders the photo the sender just picked
rather than an empty square. The ack path needed two fixes of its own: it fabricated
`type: 'text'` for every send, so a photo was stored locally as a text message until the next
sync overwrote it, and it had no way to know the attachment - both now read from the outbox entry.

### The signed URL only works behind a CDN

The bigger one. The hour-aligned `exp`/`sig` scheme is validated by **the CDN edge**, not by the
object store - that is what buys debt 7's fix, one byte-identical URL per window and therefore one
shared cache entry instead of N origin fetches. Point that same URL straight at a bucket with no
CDN in front of it and the store has never heard of `exp` or `sig`, so it is an unauthenticated GET
on private content, correctly refused with 403.

Development has no CDN. So **every photo in the app was unreachable while every server test
passed**, because the tests exercise the signing function rather than fetching the bytes. Found by
loading the app and seeing "Photo unavailable", then curling the URL the API handed out.

Now explicit configuration - `MEDIA_URL_MODE` of `cdn` (default, production) or `presign` - with
the object store signing when nothing else will. **The hour alignment survives both modes**, which
took one non-obvious step: a presigned URL embeds its signing timestamp, so signing with "now"
produces a different URL per request and destroys the cache-sharing property. The signing date is
pinned to the **floor of the current hour** and the expiry carried as the distance from that floor
to the aligned expiry, which makes the presigned URL byte-identical within the window exactly as
the CDN one is. Verified by resolving twice and comparing the strings, and by confirming an
unsigned GET is still 403.

### A 302 behind an Authorization header cannot be an image source

`GET /media/:id` answers with a redirect and requires a header. `<img src>` sends no custom
headers, and react-native-web renders every `Image` as an `<img>` - so the native path (`Image`
with `{uri, headers}`, which follows the redirect itself) has no web equivalent, and media was
unreachable on the surface this project develops and tests on.

Hence a JSON sibling, `GET /media/:id/url`, same function and same predicate re-evaluated on every
request. It grants nothing the redirect does not; it just answers in a shape a header-bearing
client can use. A token in the query string was not an option: credentials never go in a URL.

Their cache headers differ deliberately, and that came out of a false alarm worth recording. The
first browser test after switching signing modes still failed, and the cause was **my own
`max-age=600`** serving a JSON response from before the restart. Harmless in itself, but it made
the point: the client already memoizes the resolved URL for the life of its window, so an HTTP
cache in front of that route saves nothing and costs something - a member who lost access would
keep resolving successfully for up to ten more minutes. The JSON route is now `no-store`. The
redirect keeps `private, max-age=600`, because an `<img src>` hits it on every render with no memo
in front of it.

### Two defects found by actually running it

**A corrupt test fixture, which proved the retry path.** My first hand-built PNG was invalid, and
`sharp` refused it with `vipspng: libpng read error`. The worker retried five times and parked the
event, exactly as designed - so the fixture was the bug and the pipeline's failure handling was the
evidence. A properly CRC'd 64x64 PNG then derived thumb and display webp variants on the first
attempt. The corrupt one is still in the conversation showing "Photo unavailable", which is the
honest failure state doing its job.

**Nested pressables.** The document bubble rendered a `Pressable` inside the message bubble's own
`Pressable`, which is a `<button>` inside a `<button>` - invalid HTML that React reports as a
hydration error, and on native would swallow the outer long-press that reacts and reports. Caught
by reading the browser console, which is the only place it surfaces: it typechecks, it renders and
it looks right. Both media bubbles are now plain `View`s, and any tap behaviour they grow belongs
to the enclosing bubble.

### Verification

Everything below is against the running app and real MinIO, not a fake:

- **Intent, presigned PUT, complete** for a 7,858-byte PNG: 200 on the PUT, and complete HEADed the
  object and confirmed the byte count.
- **Real derivation**: `sharp` produced `.thumb.webp` and `.display.webp`, and `?variant=thumb`
  resolves to the derived key rather than falling back to the original.
- **Uploaded from the UI's own picker**, twice - a photo through "+ → Photos" and a text document
  through "+ → Document" - both landing `ready` with variants where applicable, both owned by their
  message so the nightly GC can find them, and both rendering: the photo in its bubble, the
  document as "meet-schedule.txt / 54 B".
- **Zero console errors** after the nested-pressable fix.
- The store-signed URL is byte-identical across two resolves in the same window, and the same
  object unsigned is still 403.

### Not done

The **Gallery grid** and the **full-screen viewer** - `PRD/13`'s remaining client surface. The
server endpoint behind the grid has been complete and paginated since Phase 3. Until the viewer
exists, tapping a photo does nothing, deliberately rather than via a nested control. Recorded in
`PRD/13` and in `PRD/05`'s acceptance list rather than left implied.

Verified on **web only**. There is no simulator in this environment, and the upload path resolves
bytes through `fetch`, which reads a `blob:` URI on web and a `file:` URI in React Native - one
path rather than an unverified platform branch, but the native side is untested.

---

## 2026-07-30 - Message reactions, and three gaps they uncovered

Requested directly after Phase 3.5 closed, from the "not done" list: reactions had been specified
since Phase 0 - in scope in `PRD/05`, a `message_reactions` table in `TECH/09` - and never built,
which made `PRD/14` rule 5's promise that reactions work identically in a DM true only vacuously.
Built with the fixed six-emoji set. 15 new server tests, 5 new client tests, 5 new constraint
assertions. Suite total 528, all green, `db:prove` at 62 and exit 0.

### The full emoji picker

The request came with a caveat: the founder wants the whole emoji list from a popup, "like
WhatsApp", not the fixed six - and, in the same breath, "note it down for now, do it with fixed
emoji". So the fixed set shipped and the picker is recorded.

Worth being precise about, because `PRD/05` lists "a full emoji picker" under **rejected**
alternatives, so this looks like re-litigating a settled decision. It is not. The rejected
alternative was a picker *replacing* the quick row, and its objection - fast tap targets beat
completeness - still stands. WhatsApp ships both: six quick taps plus a "+" into the full grid.
The ask is for the second thing and leaves the first alone, which makes it a new proposal rather
than a reversal. Recorded in `PRD/05` as a costed open question: the closeable set becomes
uncloseable, "is this string an emoji" is genuinely hard (grapheme clusters, ZWJ sequences,
skin-tone and regional-indicator pairs, variation selectors), byte-different encodings of one
emoji must normalise to one reaction or the same emoji appears twice with a count of one each, and
the pill row stops being bounded at six.

The current shape is deliberately friendly to it. The emoji is a string end to end, one reaction
per emoji per member per message needs no revisiting, and `reactionSummary` already renders an
arbitrary set - so the fixed order is the only rule that has to change.

**The check constraint is the interesting decision.** Enforcing "one of six" in the database means
widening the set starts with a migration that drops it. That is the point rather than the cost: a
handler-only rule would let the picker ship with no validation at all and nobody would notice,
whereas dropping a constraint forces whoever does it to confront what replaces it, at exactly the
moment they should.

### Reactions ride on the envelope, and updates carry full sets

Two design questions, and they interact. ADR-0017 records both.

**Where reactions live on the way to a client.** On the `MessageEnvelope`, not behind their own
endpoint. A separate fetch would need its own sync path, its own cache and its own offline story,
all parallel to the ones messages already have - and Phase 3's gate was chat being readable in
airplane mode, so reactions that vanished there would be a half-feature. The local SQLite cache
stores them as a JSON column on the message row.

**What a change frame carries.** The full set for that message, never a delta. A delta is the
smaller and more obvious payload, and it is wrong here for a reason that is a property of the
transport rather than of reactions: messages can afford delta-shaped delivery because they carry
`seq`, and the gap rule turns a lost or reordered frame into a detected hole and a sync. **A
reaction delta has no sequence of its own.** One dropped frame would leave a client permanently
believing the wrong people reacted, with nothing able to detect it - the exact class of silent
divergence the channel log exists to prevent, reintroduced through a side door. A full set is
idempotent and self-healing, so the worker's handler re-reads the set at publish time and a
redelivered event republishes current truth rather than an old snapshot.

`userIds` travels rather than a count, which is what lets one viewer-agnostic publish serve
everybody: each client derives its own "did I react" through `reactionSummary`. Publishing
`{emoji, count}` would have needed a second per-viewer request per message to render pills, which
is the same shape as the media problem ADR-0007 exists to avoid.

### Three gaps that had nothing to do with reactions

**1. `msg.update` had no producer at all.** The frame was declared in `TECH/10` from Phase 0 with
`pinned` and `deleted_at`, nothing ever sent one, and the client's handler was literally
`case 'msg.update': break;`. So **a pin and a soft delete never reached an open client** - both
were visible only after a refresh, despite `PRD/05` rule 7 describing the pinned strip appearing
and rule 9 describing a tombstone every other member sees. Reactions gave the mechanism its first
user; pins and deletes now travel on it too, and the reactions suite asserts a pin publishes.

**2. Nothing cleared reactions on soft delete.** `PRD/05` rule 9 has required it since Phase 0
alongside pin state. Vacuously satisfied while reactions did not exist, and a real defect the
instant they did - a tombstone that still carried six laughing reactions is a verdict on content
nobody can read. The delete path now clears them and the published update carries the empty set
explicitly, so clients drop the pills rather than holding them until a refresh.

**3. The local SQLite cache had no migration path.** `CREATE TABLE IF NOT EXISTS` does nothing to
a table that already exists, so any device carrying an earlier build would have failed every write
the moment the new column was referenced - the client equivalent of an unapplied migration, with
no numbered migrations to notice it. The store now migrates additively, driven by
`PRAGMA table_info` rather than a stored version number, so a database in any prior state
converges including one a half-finished earlier run left behind.

### The predicate that was not an alias, on purpose

`canReactInChannel` is `canPostInChannel` and is still its own named predicate, one phase after
AGENTS.md failure mode 10 was written about exactly this. Reacting is a write into the conversation
that everyone can see, so a blocked DM participant may read a message and may not react to it -
`PRD/14`'s matrix groups "React, attach media, mention" on one row for that reason. The body being
one call is not an argument for aliasing it; an alias is a claim that two capabilities will never
diverge, and the last two times that claim was made in this codebase it turned out to be false.

### Verification

**The toggle is a keyed delete-or-insert, not a read-then-write.** A read-then-write passes every
single-tap test and leaves a double row under two fast taps, so the suite fires two concurrent
toggles of the same emoji and asserts at most one row survives - the primary key is the backstop
and the statement order is the design.

**Live, in the running app**, with the services restarted onto the new code:

- Long-pressing a message opened the sheet with all six emoji and a Report action, anchored to the
  right bubble. Tapping 🔥 rendered a pill labelled "Remove your 🔥 reaction, 1 total".
- Bob then reacted from the server side, and **Alice's open browser updated with no refresh** -
  🔥 went 1 to 2 while still reading "Remove your", and a new 🎉 pill appeared reading "React
  with", which is `reactionSummary` deriving `mine` differently per pill from one payload. That is
  the first time a `msg.update` frame has travelled end to end in this project.
- The pills rendered in canonical order (🔥 then 🎉) rather than insertion order, so the row does
  not reshuffle as counts change.
- Tapping the pill again removed only Alice's reaction: the label flipped to "React with 🔥, 1
  total" and the database held Bob's two rows and none of hers.
- An emoji outside the set returned 400 at the route, and `db:prove` confirms the column rejects
  both `🦄` and the plain text `lgtm`.

**Not done, still.** The Expo client cannot attach a photo in any scope - server pipeline and
gallery endpoint complete since Phase 3, picker UI unbuilt. Rate limiting on reactions is Phase
4's with the rest, and `TECH/05` already listed reactions among the endpoints v1 left unthrottled.

---

## 2026-07-30 - Phase 3.5: direct messages, blocking, mute and the moderation queue

**All three clauses of the gate are met, proved in the suite and again in the running app.** A
blocked member can neither open a thread nor send into an existing one, in either direction; a DM
report reaches platform moderators and reaches no club admin; a muted conversation produces no
push while its unread count keeps climbing. 33 new tests in the phase suite, 44 new cells in the
permission matrix, 11 new constraint assertions. Suite total 507, all green, plus `db:prove` at 57
assertions and exit 0.

### The abstraction test held, and its estimate was wrong

`PRD/01` sets the test for a fourth channel scope: one membership predicate, one admin predicate,
one poll-access predicate, one notification-audience branch, thin screens. The important half held
completely - **chat was not forked**, and sequencing, sync, cursors, unread counts, the send
outbox, mentions, the gallery, the media pipeline and push fan-out all carried over untouched.

The predicate count did not. It was five, not two, and both extras were places the estimate's own
wording would have produced a defect:

- **`canPostInChannel` was an alias of `isChannelMember`.** In every existing scope, reading and
  posting are one question. A DM makes them two: a participant loses the right to send when
  blocked, or when the pair's last shared club goes, and **both leave history fully readable**.
  Leaving posting aliased to reading lets a blocked member send. Revoking membership to stop them
  hides history that `PRD/14` rules 3 and 6 require to stay visible. There was no third option; the
  predicate had to split.
- **`canPinInChannel` was an alias of `isChannelAdmin`.** `PRD/14` rule 4 says a DM has no admins
  *and* that either participant may pin a message for reference. Both are true only because
  `PRD/05` rule 6 already separates a pin from an announcement: "no admins" removes
  pinning-as-*authority*. Left aliased, the scope would have silently lost a documented
  capability, and nothing would have reported it - `isChannelAdmin` returning false looks correct
  at every call site.

The narrow lesson, now in `AGENTS.md` as failure mode 10: **an alias is invisible to an audit that
counts predicates.** The abstraction test counts predicates whose scope branch changes, and it
cannot count one that does not exist yet because it is currently spelled as another one.

### A requirement collision, again

`PRD/12` is explicit that an ordinary message notifies nobody - no row, and the unread count is
computed from the log. Its 18-type catalogue contains nothing for "somebody messaged you". `PRD/14`
rule 8 then says a muted conversation produces no push while the unread count still accrues, and
`TECH/16` makes that the exit gate.

Read across unchanged, a DM pushes nothing, so muting one is a control over nothing and the gate is
unfalsifiable. Read the other way, every DM writes an inbox row per message, flooding the feed with
exactly the per-message noise the computed-unread design exists to remove.

Both documents were right about their own scope. What neither said is that "an ordinary message
notifies nobody" is a statement about **rooms**, and a DM is not a room - it is the one scope where
a message is inherently addressed to one person, which is the whole reason the feature exists
rather than leaving those exchanges in SMS. So the catalogue gains a nineteenth type, `dm_message`,
which is **push-only and never becomes a row**: ADR-0015. Its params fix `clubId` at `z.null()`
rather than nullable, so a handler that invented a club for a DM fails the write, and its target
deliberately carries no `seq` - chat already opens on the first unread message, and pinning the
deep link to the seq the push was built from lands above anything that arrived since.

### Two defects in code shipped earlier, neither of them about DMs

**1. The race scope was never wired into four of the five places it belongs.** "Which channels can
this user reach" had been written out by hand four times - `listAccessibleChannels`, the
chat-unread rows, the badge count, and the notification audience - and Phase 2 shipped races with
real chat channels while updating **none** of them. A race member's chat appeared in no channel
list, produced no unread count and no badge, and an announcement in race chat notified nobody. The
worst property of it: every copy was individually self-consistent, so there was no type error and
no failing test to find. Found only because this phase had to add a `dm` branch to the same four
places, and adding it four times was obviously the same mistake a second time.

There is now one `channel-access.ts` holding the predicate and its inverse, and the display-name
COALESCE that goes with them - which turned up a third instance of the same class: a race and an
Eboard channel both carry a `club_id`, so putting the club first in the COALESCE titled every race
chat with the club's name.

**2. Notification idempotency keys could collide across handlers.** Most events produce one
notification and keyed on the raw outbox id. The message handler produces two and keyed the second
on `event.id * 2 + 1`. Those sequences overlap - a mention on event 3 and an announcement on event
7 both key as 7 - and since both `notifications_idempotency` and the `push_deliveries` ledger key
on `(outbox_event_id, recipient/device)`, a collision reads as "already handled" and silently drops
a real notification **and** a real push. Adding a third kind made it unavoidable to notice. Every
key is now `notificationKey(eventId, slot)` = `eventId * 4 + slot`, which bands each event into its
own block and is injective by construction rather than by arithmetic luck. Synthetic keys stay
negative and unbanded, since real outbox ids are a positive bigserial and the two spaces cannot
meet.

### Decisions worth their own record

**Writability is evaluated, never stored (ADR-0016).** The obvious schema is
`dm_conversations.read_only_at`, set when a pair's last shared club goes away. It is wrong for the
same reason `polls.is_closed` was wrong: nothing owns that moment. It happens when either person
leaves any club, is removed from any club, or has a club deleted under them, and it *un-happens*
when either joins a club the other is in - so four write paths would each have to recompute it for
every thread the member holds, and the join path would have to clear it. A stored flag is wrong
between maintenance runs by construction. It is now an `EXISTS` resolved once per context load, and
the suite asserts the round trip: leave the club, watch the thread go read-only for both parties,
re-join, watch it become writable with nothing backfilled.

**The blocking-visibility open question, resolved without disclosing the block.** `PRD/14` asks
whether blocking should be reciprocal-visible or silent, while its own edge-case table requires a
disabled composer to state its reason. Those looked contradictory. They are not, because the reason
does not have to identify the cause: the blocker sees "You blocked this person. Unblock them to
send messages"; the blocked party and someone who has merely lost the last shared club see the same
sentence as each other, word for word. `postDeniedReason` therefore has two values and not three,
and the asymmetric "did *I* block them" fact is read in the metadata query rather than added to the
access context - so it can never reach a predicate, where symmetry is load-bearing.

**Every refusal from `openDm` is `not_found`.** Nonexistent, ineligible and blocked are
indistinguishable from outside, because a distinguishable code makes a block detectable by anyone
willing to call the endpoint. Asserted by comparing the blocked refusal against a stranger's, for
equality, rather than by checking each is a 404.

**`member_blocks`, not `blocks`.** `TECH/09` specified the shorter name; the same file already
argues that an unqualified "blocked" is ambiguous in this schema, because `users.signin_blocked_at`
means something entirely different. Applied that reasoning to the new table and corrected the spec.

### The moderation queue, and what a moderator can actually see

`TECH/05` grants a platform moderator the reported message and its immediate context, and requires
the read to be audit-logged. Implementing that raised a question the rule does not answer: does the
**queue listing** carry message bodies?

It cannot. If it did, either every refresh of the list writes a log row per report, or content is
read with no log at all - the second silently defeats the rule and the first fills the log with
noise until nobody reads it. So the queue is metadata (who reported what, and when), and
`readReportedContext` is the single logged door to content: five messages either side, a window the
caller has no parameter to widen, and a `moderation_reads` row written in the same transaction as
the read. There is also no door at all without a report - the context read resolves through
`message_reports`, so a moderator cannot reach a conversation nobody complained about.

In a group scope the same endpoint writes no log row, deliberately: an admin can already read every
message in their own space by scrolling, so logging that read would only dilute the log that
matters.

### Verification

**The gate, all three clauses, in the running app** - API, gateway and worker restarted onto the
current code, two real accounts sharing a club, Chrome driving one side and the gateway driving the
other:

- Alice found Bob in the new-message search and **did not** find a real user who shares no club
  with her: "Nobody found", which is the eligibility rule rather than an empty database.
- Bob's reply arrived in Alice's open chat with no refresh, at seq 2.
- After Alice blocked Bob: **both** sends refused with `forbidden` over the gateway and the message
  count stayed at 2; Bob's `openDm` against Alice returned exactly the 404 a stranger returns; Alice
  vanished from Bob's search; both still read the full history; Bob's composer said the neutral
  sentence and Alice's said hers, with `blockedByMe` false for Bob and true for Alice.
- Alice's block list showed Bob. **Bob's showed nothing**, which is the half that matters.
- Alice reported Bob's message through the UI - while being the blocker, which is the case that
  proves reporting is gated on reading rather than posting. The strip said "Report this to ClubChat
  moderators?", not "the admins of this space".
- **Carol, a club admin of the club both participants are in and not a participant, got 404 from
  all five paths**: the DM queue, the reports tab on that channel, the context read, the message
  history, and the channel metadata.
- The moderator's context read returned seqs 1-7 around the reported seq 2, clamped at the start of
  the log, and wrote the audit row with the window actually served.
- Mute: the unmuted control push reached the real Expo transport (which rejected the fake token and
  invalidated the device - proof the request genuinely left the process rather than being stubbed).
  After muting, the worker reported `suppressedByMute: 1, pushed: 0` and the unread count went 3 to
  4. Unmuting restored the push.

**Two mutation checks** on the blocking clause, both asserting the mutant says yes where the real
predicate says no: dropping the block check from `canPostInDm`, and reading the block set
one-directionally the way a naive loader would. The second is the more useful of the two, because a
one-directional block passes every test written from the blocker's point of view.

**A UI defect found by the smoke test and fixed.** `/dm` rendered a back control when reached from
Clubs and **none at all** when its URL was entered directly, because the navigator only renders its
own back button when history exists. That is exactly the class `PRD/15` rules 3 and 4 warn about,
and the rule needed sharpening: declaring an explicit *parent* is not enough for a screen using the
shared header, it has to declare an explicit *control*. Fixed with a `headerLeft`, and then fixed
again a minute later - the label sat flush against the viewport edge with no gutter until it got the
screen's own horizontal padding. Verified on web only; there is no simulator in this environment,
which is worth saying plainly given the standing rule about verifying cross-platform work on each
platform separately.

Blocking deliberately **does not** revoke gateway subscriptions, which is the opposite of what the
gateway's own comment anticipated. Read access survives a block by design, so the subscription is
still justified - and since neither party can send, there is nothing left for it to deliver.
Comment corrected rather than code changed.

### Not done

The Expo client still cannot attach a photo, in any scope. Server pipeline and gallery endpoint
have been complete and tested since Phase 3; there is no picker UI, so DMs inherit exactly as much
photo support as club chat has, which is none at the client. The per-sender,
per-new-conversation rate limit `TECH/05` calls for is Phase 4's, with every other rate limit; what
bounds the surface meanwhile is that a thread can only be opened with somebody the sender already
shares a club with. Message reactions remain unbuilt in every scope - `TECH/09` specifies
`message_reactions` and `PRD/05` lists them in scope, and neither has ever been implemented, so
`PRD/14` rule 5's promise that reactions work identically in a DM is true only vacuously.

---

## 2026-07-30 - Phase 3: media and offline

**Both halves of the gate are met.** A private Eboard photo is provably unreachable without
membership, and chat is readable in airplane mode. 423 tests, 46 constraint assertions.

### The private-photo half, proved four ways

"Provably" is the word in the gate, so a test showing that a member *can* see the photo is not
enough - that passes against a build with no authorization at all. The denials are:

- a plain club member, who is not in the Eboard space
- **a club admin outside the space**, which is the sharpest case: being an admin is not being a
  member of the space, and the test has to remove their auto-joined Eboard row to construct it
- a complete outsider
- an unsigned fetch of the raw object, which MinIO itself refuses with 403

Then mutation-tested. Removing the membership check from the download hop fails exactly the
three denial tests. All refusals return `not_found` rather than `forbidden`, because confirming
an object exists is itself a disclosure.

### The hour-aligned URL, which is the whole point of the download design

Roadmap debt 7: a signed URL minted per fetch changes its query string every time, the query
string is part of every cache key, so every layer misses and 300 viewers means 300 origin
fetches. Aligning the expiry to the top of the hour makes the URL **byte-identical** for every
viewer in the window, so one CDN entry serves the club.

Mutating it back to `now + 1 hour` fails two tests: the byte-identical one and - less obviously -
the one asserting at least an hour of remaining validity, which catches the related bug where a
URL issued at 10:59 would expire sixty seconds later.

### What the fake could not have verified

The integration path runs against **MinIO**, not the in-memory fake, and that distinction earned
its keep: a fake will happily accept a presigned-PUT flow that a real bucket rejects. Verified
end to end against real storage - buckets ensured, a genuinely signed PUT accepted with 200,
HEAD reporting the true size and type, an unsigned read refused with 403, a real `sharp`
thumbnail derived, and GC removal confirmed.

### Limits, which v1 had none of

Debt 9 records that v1 had no size or MIME limits on any bucket. Now enforced at intent **and
re-verified at complete**, because a presigned PUT constrains where the bytes go and what
Content-Type rides along, and constrains nothing about how many bytes there are. A client that
declares 1 KB and uploads 5 MB is caught, and its row stays `pending` so no message can
reference it. Mutating the size check away fails exactly that test.

Two attacks the send path refuses: attaching **somebody else's** upload, and moving an object
from a channel you can read into one you cannot - which would launder it past the download
authorization entirely.

### The requirement collision worth recording

`PRD/03` says a hung auth check falls back to signed-out. Phase 3 says chat must be readable in
airplane mode. **Implemented naively, those contradict**: offline becomes signed-out becomes no
chat, and a member is locked out of history already on their device.

The resolution is that "the server said no" and "I could not reach the server" are different
facts. Only a server that answered and rejected the token is grounds to sign somebody out; being
unable to reach one means carrying on with what we know and re-verifying later. The check is now
three-way - `valid` / `invalid` / `unreachable` - and a 500 counts as unreachable too, since the
server's problem is not the token's. `PRD/03` has been corrected, because the two-way version was
actively wrong once offline existed.

That also required caching the user id alongside the token: without it an offline launch cannot
tell which stored messages are its own, and every bubble renders as received.

### Verified in a browser with the backend actually dead

Not simulated. API, gateway and worker all killed, confirmed unreachable, then a cold page load:
the offline banner appeared, all three cached messages rendered from SQLite, and a new message
typed offline queued as "Sending" rather than failing. Restoring the backend flushed it **exactly
once**, at seq 4, with no duplicates - `client_msg_id` idempotency holding across a real network
outage rather than a mocked one.

Worth noting the messages survived a full page reload with no backend, and no "SQLite
unavailable" fallback warning appeared - so this is genuine OPFS persistence on web, not the
in-memory fallback quietly standing in.

### Decisions recorded in the specs

- `msg.err` gained `media_not_ready`, deliberately distinct from `forbidden`: the client's
  correct response is to finish the upload and retry the same `client_msg_id`, not give up.
  Collapsing it into a generic failure would turn a recoverable state into a lost message.
  `TECH/10` and `TECH/07` updated.
- Media is validated **before** the send, never inside it. The sequence-allocating transaction
  holds a row lock until commit, so a `HEAD` in there would serialize the entire channel behind
  an object-storage round trip.
- `PRD/16`'s offline section, which described an online-only build, is rewritten as four
  behaviour rules. `PRD/17` marks the offline debt done - and done at the "ideally" level (a send
  outbox with optimistic messages) rather than the stated minimum.

### Still open

The Expo client has no UI for picking or displaying media - the server pipeline and the gallery
endpoint are complete and tested, but the app cannot yet attach a photo. Phase 3.5 is direct
messages with their safety tooling, which inherits this media pipeline wholesale.

---

## 2026-07-29 - Phase 2 completion, and a spec reconciliation that was overdue

### The spec debt, admitted and paid

Phase 0 and Phase 1 updated the specs alongside the code. **Phase 2 did not** - it wrote
`HISTORY.md` entries and left `SPEC/` describing a schema that no longer matched. That is a
failure of the standing rule ("where a doc disagrees with the repo, the repo is right and the
doc is the bug - fix it in the same change"), so the divergences were audited by diffing the
live database against `TECH/09` rather than from memory.

What the audit found, now corrected:

- **`TECH/09` gave every scope owner a `channel_id` column** - `races.channel_id`,
  `eboard_channels.channel_id`, `dm_conversations.channel_id` - and none of them were built.
  That is not an omission but a decision, and a structural one affecting four tables, so it is
  now [ADR-0014](SPEC/decisions/0014-channels-reference-their-scope-one-way.md): a channel
  references its scope and the scope never references the channel. Storing the relationship in
  both directions gives it two sources of truth with nothing keeping them honest, and
  `UNIQUE (scope, scope_id)` already makes the lookup unambiguous.
- **`PRD/01` listed `is_closed` on the Poll entity.** There is no such column: closed-ness is
  evaluated at read time so a passed deadline reads as closed everywhere without anyone having
  acted. Corrected in the PRD.
- **`poll_votes` gained `allow_multiple` plus a composite FK** - the same trick as
  `car_group_members`, and the thing that makes single-choice vote-moving a database guarantee
  rather than a handler convention. `TECH/09` documented the pattern for one table and not the
  other; both are now documented.
- Smaller ones: `created_by` on events and workouts (audit only - any admin edits any of
  them, unlike `meetings.creator_id` which IS the authorization subject), `updated_at` and the
  not-empty check on news posts, the `car_groups` unique being a CONSTRAINT rather than an
  index for FK-ordering reasons, and the omitted `avatar_media_id` columns which arrive with
  media in Phase 3.
- **`PRD/09` rule 18 gained its exception**: when the Incharge leaves the whole club the
  Incharge is cleared but no notification fires, because one per affected group on top of
  "X left the club" would bury what admins need to see. That was a judgement call sitting only
  in `HISTORY`; it is product behaviour and belongs in the PRD.

### Card removal, which was the last Phase 2 loose end

`TECH/09` specifies `linked_poll_id`, `linked_event_id` and `linked_meeting_id` on messages.
Phase 0 never created them, so "deleting the underlying object removes its chat card" had been
logging instead of working. Added with partial indexes and a check that a card links to at most
one thing.

The card is **soft-deleted like any other message** rather than removed outright. A message
vanishing mid-conversation makes the replies around it unreadable, and that reasoning does not
stop applying because the message happens to be a card - what the reader sees is the ordinary
tombstone.

Mutation-tested both ways, and the first mutation is the interesting one: replacing the
tombstone with a hard `DELETE` is caught by the **gapless-seq assertion**, not by the card
assertion. The tombstone rule and the sequence rule turn out to reinforce each other, which is
worth knowing - a future change that removed a message row would fail a test about ordering
rather than one about deletion, and that is the more likely place to look.

### A test bug worth recording, because it is a recurring shape

The card test failed in the full file and **passed in isolation**. The final assertion counted
live cards across every club, and other tests in the file legitimately create events and
meetings they never delete - `messages` is not truncated between tests, only `notifications`
and `outbox` are. Scoped the query to the two objects under test, and added a guard asserting
those two cards existed in the first place so the narrowed assertion cannot pass vacuously by
counting nothing.

That is the third time this session an assertion has been too broad rather than the code being
wrong. The lesson is not "scope your queries" so much as: **when a test fails, check whether it
passes alone before believing the product is broken** - and when it does pass alone, the
assertion is usually measuring something wider than the thing it names.

---

## 2026-07-29 - Phase 2 (part 2): the command handlers

Races, polls, meetings, calendar, routines and news now have working commands on top of the
schema and authorization that part 1 delivered. 383 tests green, 46 constraint assertions, all
three server processes boot with the scheduler running alongside the drain.

### What the tests pin that the matrix cannot

The permission matrix covers authorization as pure functions. These needed a real database:

**The Incharge asymmetry**, which is the subtlest rule in the phase. If a group's Incharge
leaves, the Incharge is cleared and every club admin is notified that the group needs a new
one - while the rest of the group is untouched and the group is not dissolved. **A plain member
leaving their car is a non-event and notifies nobody.** Mutation-tested in both directions:
making every departure notify fails exactly the silence test, and making none notify fails
exactly the alert test. One test each, no collateral, so the asymmetry is pinned rather than
half-pinned.

**Vote moving.** On a single-choice poll, tapping a different option moves the vote rather than
adding a second - verified as one vote total on the new option, not two. On a multi-select poll
the same gesture adds. The database guarantees the moving part via the composite-FK trick from
part 1, so the handler deletes explicitly rather than relying on an upsert that would race.

**Closed at read time.** A poll created already past its deadline reads as closed and refuses a
vote, with nobody having closed it. And the scheduled job **does not close polls** - there is a
test asserting a poll with a live deadline is still open after a tick, because a job that
flipped a boolean would become a second source of truth for something a comparison answers.

**The closing-soon reminder includes the creator.** That is the single exception to "creation
notifications exclude the actor", and `resolveAudience` knows it from the notification type
rather than from a flag passed at the call site, so the exception lives in one place. Fires once
per poll ever - the second tick sends nothing.

**Private polls leak counts but not identity.** A non-creator sees the count, sees their own
vote, and gets `null` for voters - which is deliberately distinguishable from an empty list.

**The routine silence.** Seven workouts authored in one sitting produce zero notifications and
zero chat cards. The mechanism is the absence of an outbox write, not a flag.

**The completed cascade.** Leaving a club now removes race roster rows and car assignments for
**all** races in it, not just upcoming ones, and clears any Incharge the departing member held.
Part 1 left that as a marked comment; it is now four statements in the same transaction.

### A judgement call worth recording

When someone leaves the whole club while holding an Incharge, the Incharge is cleared but **no
"group needs a new Incharge" notification fires**. Leaving a club is a bigger event than
vacating a car seat, and firing one notification per affected group on top of "X left the club"
would bury the thing admins actually need to see. The groups show as having no Incharge, which
the car-groups screen states plainly. Noted here because it is a deliberate difference from the
single-group departure path, not an inconsistency.

### Bugs found while building

1. **`listPolls` passed `clubId: ''` to the access predicate**, so club-scoped polls would
   never have listed - the club branch checks membership against that id. Caught by reading the
   call rather than by a test, which would not have existed yet. Also restructured: the
   predicate is now checked once before the query rather than per row, since access to a poll
   depends only on its scope and every poll in one scope is visible to the same people.

2. **Six test failures that were fixture leaks, not product bugs.** Adding a club member
   legitimately notifies them, and adding a race member legitimately notifies them - and the
   fixtures drained those effects without clearing them, so every test inherited extra rows and
   the "notifies nobody" assertions looked broken. Fixed with one `settleFixture` helper rather
   than by loosening the assertions, because an unfiltered "no notifications at all" check is
   the stronger form: a filtered query cannot catch a notification sent to the wrong person.

### Still open

Routes for the Phase 2 commands are not wired into the API yet - the handlers and their tests
exist, and exposing them is mechanical. The Expo client has no screens for any of this. Card
removal on delete (`event.deleted`, `poll.deleted`, `meeting.deleted`) logs rather than removing
the chat card, which needs the `linked_*_id` columns on messages that the data model specifies
and Phase 0 did not create.

---

## 2026-07-29 - Phase 2 (part 1): the domain schema and the permission-matrix gate

**The Phase 2 gate is met.** `TECH/16` gates this phase on the permission-matrix suite
covering every cell of the three matrices in `PRD/02`, and it now does: 340 tests total, 148
of them in the matrix file alone, with both directions asserted in every cell.

Note the spec says "three matrices" while `PRD/02` has four table sections - Club and Club
content are one matrix split across two tables. Coverage is Club (14 rows, from Phase 0),
Club content (7), Race (14 rows across 5 actor columns), and Eboard (10 rows across 4). A
completeness guard asserts the total cell count so the suite cannot quietly shrink when
someone deletes a row or an actor column.

### Two invariants moved from handler code into the database

Both use the same trick, and the migration checklist already lists it as the house pattern
for this shape: denormalise the parent's discriminator onto the child, then add a **composite
foreign key** back to the parent so the copy cannot drift.

- **A person is in at most one car group per race** (domain invariant 5). Needs `race_id` on
  `car_group_members`, which a generated column cannot supply - Postgres generated columns may
  only reference columns in their own row, and `race_id` lives on `car_groups`. So the value
  is stored and the composite FK to `car_groups (id, race_id)` proves it consistent. Without
  the FK the unique index would be guarding a lie: a handler could write a mismatched
  `race_id` and slip a second group past it. Proved by attempting exactly that.
- **Single-choice polls move a vote rather than adding one.** `allow_multiple` is
  denormalised onto each vote with a composite FK to `polls (id, allow_multiple)`, making the
  partial unique index meaningful. A vote cannot lie about its poll's setting to escape the
  index - also proved by attempting it.

46 constraint assertions now, up from 32.

### A bug in the migration itself

The first generated migration failed to apply: `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN
KEY` ran before the `CREATE UNIQUE INDEX` it referenced, because drizzle-kit emits every
foreign key before every index. The fix was a real UNIQUE **constraint** rather than a unique
index - a table constraint is emitted inline with `CREATE TABLE`, so it exists by the time the
FK is added. Caught by applying the migration rather than by reading it.

Also fixed: several invented UUID literals in the constraint proof contained `g`, `p` and `o`,
which are not hex digits. Postgres rejected them outright, which is the good version of that
mistake.

### The rule the matrix exists to protect

`isRaceMember` reads the roster set and nothing else. Mutating it to fall back on
`isClubAdmin` - the exact v1 substitution that was wrong in five separate places -
fails 7 cells, including the property test asserting that every access-gated race capability
is denied to a manager off the roster while the same manager on the roster is allowed, and the
test stating how Eboard deliberately differs from Race. That asymmetry is the whole design:
for a race, authority and access are separate; for the Eboard they are the same thing.

The converse is tested too, because it is the trap on the other side: a naive "require a
roster row for everything" would cost a manager the management they legitimately hold.

### Scope, honestly

Delivered: the full Phase 2 schema (races with Meet Information, roster, join requests,
personal pins, car groups, meetings, polls with options and votes, calendar events, routine
workouts, news posts and reactions), `raceRoster` populated in the access context so every
race predicate is live, the race/poll/meeting/content predicates, and the gate.

**Not yet delivered: the command handlers and routes for those features.** The schema and the
authorization exist; creating a race, managing car groups, voting in a poll, scheduling a
meeting, and posting news are the next step. The scheduled closing-soon job also waits on the
poll commands, and the membership cascade's race-roster branch is still the marked comment
Phase 1 left.

---

## 2026-07-29 - Phase 1 completion: membership commands and revocation

Closes the gap left open earlier in the phase. 192 tests green, 32 constraint assertions.

**What was added.** Join by policy (open admits instantly, request files a pending row),
invite-link redemption, approve/deny, add directly, promote/demote, transfer ownership,
leave, remove, delete club, and the join-policy flip. Each posts its system message and
notifies the people affected. `club_join_requests` turned out to be documented in `TECH/09`
but never actually created in Phase 0 - confirmed against the live database rather than
assumed - so it arrived with this work.

**The revocation obligation is now met, and verified over a real gateway.** ADR-0007's cost
is that a subscription is authorized once at subscribe time and never rechecked per message,
so a removed member's socket keeps receiving until they reconnect. The hook existed as a
stub since Phase 0 but nothing called it, and it could not be called: the worker is a
different process from the gateways. It now crosses that boundary over a Redis control topic
that every gateway subscribes to for its whole life - a gateway that only listened while
holding a relevant socket would let a removed member keep reading.

The live test is worth describing, because disabling revocation produced a result that
explains the whole design. With it off, the removed member's socket **received the next
message** while the REST path correctly returned 404. Every request-scoped check was still
right; only the socket leaked. That is exactly the silent failure ADR-0007 warns about, and
it is invisible to anything except watching the socket.

**Ordering rules, mutation-tested rather than trusted.** Inverting the transfer to promote
before demote fails on `club_memberships_one_owner` - the database refuses, which is the
entire argument for enforcing that invariant as a constraint rather than in a handler. Also
verified: an ownership transfer posts ONE system message rather than two (mechanically two
role changes, socially one event, which is why transfer emits its own event type); switching
`request` to `open` auto-approves everyone pending rather than stranding them with no
approval step left in the product; and two admins racing on Approve produce exactly one
membership, with exactly one of them believing they decided it.

**Still deferred to Phase 2, and stated rather than implied.** The cascade currently reaches
Eboard membership and resolves outstanding requests; race rosters and car-group assignments
are two more statements in the same transaction once those tables exist. The remaining
notification types are in the same position - each is one call into machinery that now
exists.

---

## 2026-07-29 - Phase 1: effects, notifications and push

**The gate passes.** An announcement in club chat reaches a backgrounded phone as a push that
deep-links to the right message, asserted through a `RecordingPushSender` that captures the
payload and its target - the only way to check the deep link carries the correct `seq` rather
than merely opening the conversation.

164 tests green across four packages. 28 constraint assertions, all proved by attempting the
violation in SQL.

### Decisions taken

**ADR-0013: notifications store `(type, params)` and render at read time.** `TECH/09` and
`PRD/01` both specified a stored English `body` and a stored `target` route string, inherited
from v1. Two recorded defects trace to that shape: pitfall 8 (a stored route left approvals
permanently unresolved for eight migrations) and debt 11 (a stored body is unlocalizable, and
retrofitting means rewriting every historical row - with an explicit instruction to design it in
now). Dropping both columns closes both, and Phase 1 was the last moment it was cheap. The
rejected alternative worth naming is storing params *and* a rendered body: two representations
of one string, which drift the moment a renderer changes, and which answer "which is
authoritative?" with "whichever the reader used".

Params are a jsonb column, so the contract has no database-level shape. Each type declares a Zod
schema, validated at write time, which is the compensating control for having dropped the
rendered column: a malformed param fails the write rather than surfacing as broken text in
somebody's inbox months later.

**A `push_deliveries` ledger, outliving the outbox.** `TECH/06` says to dedupe on
`(outbox_event_id, device_id)` without saying where that record lives. It needs its own table,
and it must survive the nightly outbox prune - otherwise pruning makes an already-sent push
re-sendable. The asymmetry is the reason: a duplicated database row can be cleaned up, a
duplicated push has already buzzed a phone.

### Bugs hit, with root causes

1. **`bigserial` where a reference belonged.** `notifications.outbox_event_id` and the ledger's
   were declared `bigserial`, which attaches a sequence default - so an insert that forgot to
   supply the id would silently receive a sequence number and defeat the very idempotency index
   it sits in. Caught by reading the generated SQL before applying it. Corrected to `bigint` by
   regenerating, which was legitimate because the migration had not yet been applied; had it
   been, this would have needed a corrective migration instead.

2. **`db.execute` does not apply Drizzle's column type coercion.** A typed `select()` returns a
   `Date` for a timestamptz; raw `execute()` returns the driver's **string**. The hand-written
   row type said `Date`, TypeScript agreed, and the failure surfaced as
   `row.created_at.toISOString is not a function` at the call site rather than at the lie.
   Probed the actual runtime type rather than patching defensively, then made the types say
   `string`. Grepped for the same mistake elsewhere: contained to the one file. Recorded as
   `AGENTS.md` 5.3 entry 7.

3. **Test isolation, not a product bug.** Four gate tests failed with 27 rows where 1 was
   expected, because they share one container and several assertions query `notifications`
   unfiltered. The unfiltered form is the stronger assertion - a filtered query cannot catch a
   notification sent to the *wrong* person - so the fix was to truncate between tests rather
   than to weaken them.

### Verification worth noting

Three behaviours were mutation-tested, on the standing principle that a check which cannot fail
is worse than no check:

- **Cursor suppression** (ADR-0008). Disabling it - reverting to the liveness-based design that
  ADR rejects - fails exactly the three suppression tests and nothing else.
- **The pending-request clearing exception.** Replacing the filter with the naive "opening the
  inbox marks everything read" - one line of SQL that passes any badge-only test - fails exactly
  the exception-1 test. This is the rule the founder lost real join requests to.
- **The notification renderer.** Exhaustive over the type union and swept by iterating
  `notificationTypes` rather than a hand-written list, with a guard asserting the fixture map
  covers every type. A hand-written list is precisely what would omit the next type someone adds.

Worth recording that **exception 2 survives the mutation**, and that is not a gap. Chat-unread
rows are *derived* from `last_seq - last_read_seq` rather than stored, so there is nothing for
`markInboxRead` to clear even if it tried. That exception is enforced by the data model rather
than by a filter, which is the stronger of the two.

### Scope, honestly

Delivered: the notification catalogue as typed contracts, the audience function (with the
admin-tier and race-roster invariants enforced by construction), announcements and pinning with
the column-level authority split, mentions, the push pipeline with cursor suppression and the
8-second deferral, the device registry, the inbox with its merged feed and badge, and both
clearing exceptions.

**Not delivered: the membership commands.** Join by policy, approve/deny, add, remove,
promote/demote, transfer ownership, leave and delete-club are the triggers most of the remaining
catalogue hangs off, along with the cascades and the force-unsubscribe that ADR-0007 obliges.
The machinery they need now exists; they are the next task rather than a redesign.

**A spec ordering inconsistency was found and recorded rather than silently worked around.**
`TECH/16` listed "the scheduled job" in Phase 1, but that job is poll closing-soon and polls
arrive in Phase 2, so it had nothing to select. Most of the 18 notification types are in the
same position - a race-created notification needs races. Phase 1 therefore delivers the
mechanism plus the events Phase 0's surface can actually raise. `TECH/16` now says so.

---

## 2026-07-29 - Phase 0: skeleton and the vertical slice

Built the monorepo, the channel log, the policy module, the API, the gateway, the worker, the
Expo client, and the Phase 0 exit drill. The phase is complete and verified end to end.

**What exists.** `packages/shared` (wire contract and domain vocabulary, imported by both
sides so neither can drift), `packages/client-core` (local store, send outbox, sync engine),
`packages/server` (three entrypoints in one codebase: api, gateway, worker), `apps/mobile`.
Postgres 17 and Redis 8 in Docker for development. All tests green; every package typechecks
clean under strict TypeScript 6.

**The exit drill passes.** Gateway killed mid-send with both clients forced to reconnect:
41 server messages (40 acked sends plus the `club.created` system message), both clients hold
all 41, zero holes on the server or on either client, 12 syncs run. The drill drives the real
`@clubchat/client-core` rather than a stand-in, so what it proves is what ships.

### Decisions taken

**TypeScript pinned to 6.0.3, not 7.** TS 7 is npm `latest` and is the native Go compiler, and
the TS team recommends it for new projects. Rejected anyway: Expo 57's own TypeScript template
pins `~6.0.3`, and running two TS majors across one workspace to save nothing was not worth it.
TS 6 is also explicitly the release designed to prepare a codebase for 7, so the eventual move
is a version bump rather than a migration. Recorded in `AGENTS.md` 5.1 rather than as an ADR:
it is a tooling pin, not an architectural decision.

**The outbox column is `processed_at` in Phase 0, not `published_at`.** ADR-0006 defines
`published_at` as meaning "handed to Kafka, NOT effect performed". Phase 0 has no Kafka - the
worker drains the outbox directly with `FOR UPDATE SKIP LOCKED` - so there the column genuinely
does mean "effect performed", and using the Kafka-era name for a non-Kafka meaning is exactly
the drift that ADR warns about. Phase 1.5 renames it, which is one migration and is already
budgeted in the ADR's own exit ramp.

**Kafka deferred to Phase 1.5 as planned, not skipped.** The drain loop's shape is deliberately
the same one ADR-0006's exit ramp describes as the fallback if Kafka is ever dropped. That is
the property which keeps the decision cheap to reverse: the outbox already works without it.

### Bugs hit, with root causes

Seven, and the split matters: the first four were caught by tests, the last three only by
running the real thing.

1. **The idempotent-retry path never fired.** A concurrent double-send of the same
   `client_msg_id` surfaced as an unhandled unique-violation instead of returning the original
   `seq`. Root cause: Drizzle wraps driver errors, so the pg error code `23505` is on `.cause`
   and not on the thrown object; `error.code === '23505'` matched nothing, silently. Found by
   the concurrency test, not by reading the function - which is the whole point, because the
   check looked correct. Fixed by walking the cause chain. Recorded as `AGENTS.md` 5.3 entry 1.

2. **Sign-up died on `null value in column "id"`.** better-auth's Drizzle adapter emits
   `default` for `id` columns and relies on the database to produce one; its
   `advanced.database.generateId: 'uuid'` setting does not fill these in. Fixed with a new
   migration (`0002`, never an edit to the applied `0000`) giving all four better-auth-owned
   tables `DEFAULT gen_random_uuid()`, which works regardless of the library's id strategy.
   Recorded as `AGENTS.md` 5.3 entry 2.

3. **Client gap detection was racy.** Two in-order messages delivered in the same tick caused a
   spurious sync: `applyIncoming` reads the local max then writes it, and both frames read the
   pre-write value, so the second concluded a hole existed. Harmless in effect but corrosive in
   principle - a gap signal has to *mean* a gap. Fixed by serializing frame application per
   channel. Recorded as `AGENTS.md` 5.3 entry 3.

4. **`TS6059 not under rootDir`,** because TypeScript 6 stopped inferring `rootDir` from the
   source files and `drizzle.config.ts` sits at a package root. Also had to state `types`
   explicitly, since 6.0 stopped auto-discovering `@types`. Recorded as `AGENTS.md` 5.3 entry 4.

### The live smoke test, and what only it could find

The four bugs above were found by tests. The three below were found only by starting the real
processes and driving the real app in a real browser, and every one of them was invisible to
both typecheck and the full suite:

5. **All three server processes died at startup** with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,
   on a **parameter property** (`constructor(readonly x: T)`). Vitest transforms with esbuild,
   which accepts the full TypeScript grammar; Node runs `.ts` by stripping types, which accepts
   strictly less. A green suite was therefore not evidence the server could boot. Fixed, and
   closed permanently with `npm run check:runtime`, which imports every module the way
   production does - verified to exit 1 with the bug present while the suite still passed 16/16,
   which is the whole argument for its existence.

6. **Sync silently failed on web** with "Failed to execute 'fetch' on 'Window': Illegal
   invocation". A getter returned the bare global `fetch`, so calling `this.fetch(...)` invoked
   it with `this` set to the ChatClient. Node's fetch does not check its receiver; a browser
   does. Doubly quiet because the caller logs and continues on the principle that realtime is
   an enhancement, so the app looked fine while its reconciliation path was dead.

7. **The web app hung forever on a spinner** after sign-up, because `expo-sqlite`'s web build
   imports a `.wasm` binary Metro does not resolve by default and the entire bundle failed. The
   in-memory fallback inside `openMessageStore` could never have helped: a static import fails
   before any of our code runs. Fixed with `metro.config.js`. Worth noting the symptom is
   exactly the one `SPEC/PRD/03` calls out - a hung check reads as an app that never loads.

Also fixed on sight, per the pixel-perfection standard: messages were top-anchored, leaving a
screen of empty space above the composer instead of sitting just above it.

**better-auth's CSRF check needed a real answer rather than a switch.** Sign-up from a native
client failed with `MISSING_OR_NULL_ORIGIN`, because a native client sends no `Origin` and
better-auth treats that as a CSRF risk. `advanced.disableCSRFCheck` would have silenced it by
removing the protection for every caller including browsers. Instead the app's own scheme is
listed in `trustedOrigins` and the client sends it explicitly. Verified both directions:
`Origin: clubchat://` returns 200, `Origin: http://evil.example` returns `INVALID_ORIGIN`.

### What was verified live, end to end

With Postgres, Redis, the API, the gateway, the worker and the Expo web client all running:

- Sign-up, then session persistence across a reload, with `/` routing an authenticated user
  into the app and an unauthenticated one to sign-in.
- Club creation producing, in one transaction: one club channel, one Eboard channel, one Eboard
  space, exactly one owner, and the owner inside the Eboard. Confirmed by querying Postgres.
- The worker's `club.created` effect posting "Riley Parks created Hillside Running Club" as
  seq 1, authored by the seeded system actor rather than `NULL`.
- A message sent from the UI committing at seq 2 and surviving a page refresh.
- **Realtime cross-user delivery:** a second club member sending over a separate socket, whose
  message appeared in the browser at seq 3 with no refresh.
- **Idempotency under live conditions:** 30 sends of one `client_msg_id` produced exactly one
  row. The rate limiter then fired at exactly burst 30, as configured.
- Direct URL entry into chat with no history, where the back control renders and works.
- An unauthorized channel returning 404 (nothing back, not even confirmation it exists), and an
  unauthenticated request returning 401.

### Verification worth noting

Three checks were themselves verified to be capable of failing, on the principle that a check
which cannot fail is worse than no check because it reports success:

- **`db:prove`** attempts to violate all 20 domain constraints in SQL and asserts each is
  rejected. Confirmed to exit 3 when handed an assertion that should not hold, and 0 otherwise.
- **The permission matrix** was mutation-tested by reintroducing the v1 "admin excludes owner"
  bug. 10 tests failed, including the property test asserting that anything an Admin may do the
  Owner may also do. Restored to green.
- **The `msg.ack` gap test** was mutation-tested by bypassing the gap check on the ack path,
  which is the exact defect `SPEC/TECH/08` warns about. Exactly that one test failed.

A weakness in the first draft of the exit drill was also found and fixed: an unconditional
`syncAll()` at the end would have backfilled any hole, turning the drill into a test of "sync
works" rather than of the state reconnect actually leaves behind.

### Spec repairs made in the same change

The 2026-07-28 split of `Old.md` and `ARCHITECTURE.md` into `SPEC/` left a systematic defect:
its cross-reference rewriter mapped section-number citations onto files by number, so roughly a
dozen links pointed at the wrong document. Nine resolved to `07-media-pipeline.md` for content
that lives in `14-engineering-pitfalls.md`. Every link *target* existed, which is why a plain
link checker passed them - they were silently wrong rather than broken. All corrected, along
with six dead intra-document anchors, `17-diagrams.md` still framing itself as an annex to the
deleted `ARCHITECTURE.md`, and a 30s-versus-60s contradiction about the poll closing-soon job
between `TECH/04` and `TECH/12` (settled at 30s, specified once).

`TECH/09-data-model.md` was updated to match what got built rather than what was planned: the
`users` table carries better-auth's required columns, `sessions` has better-auth's shape rather
than the drafted `(device_id, refresh_token_hash)`, and `accounts`/`verifications` exist. Per
the standing rule, the implementation is the fact and the spec was the bug.

`AGENTS.md` section 5 was entirely placeholder and is now filled in: real commands, the repo
map, the branch policy (recorded from observed practice - every commit in this repo is on
`main`), and the four failure modes above.
