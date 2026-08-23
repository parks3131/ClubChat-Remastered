# Mission: backend cleaning

**A standing programme, not a phase.** 2.1 to 2.10 were found in one day, 2026-08-18, by watching
the app talk to its server while somebody used it. 2.11 came the next morning from the same method
against a screen that had already been looked at twice - which is the point of calling this a
programme rather than a sweep, and 2.12 came from the founder driving two accounts at once an hour
after that. None of it was visible any other way: every request succeeded, every test passed, no
error was ever logged, and nothing crashed. The app was simply asking for far more than it needed.

> **The one idea.** A wasted request comes back with the right answer. That is what makes this
> class of defect invisible, and it is why it survived from the day each line was written until
> somebody looked at the wire directly. Correctness tests cannot find it, because nothing is
> incorrect. It only becomes painful at the exact moment you can least afford it - real members,
> on real phones, on mobile networks.

The measured headline, opening one club chat:

| | before | after |
|---|---|---|
| requests | 78 | 39 |
| CORS preflights | 49 | 0 |
| **network trips** | **127** | **39** |

Per minute of ordinary use, roughly 110 requests became roughly 31 - and the "after" session
contained *more* activity than the "before" one.

---

## 1. How to measure this, so it can be repeated

Nothing below could have been found by reading code. Two of the ten findings were the opposite of
what the code's own comments claimed, and one was found by asking why a route appeared too FEW
times. The measurement is the method:

```
open http://localhost:3000/dev/trace          # the live page
rm -f .dev-trace/trace.jsonl                  # start a clean session
curl -s localhost:3000/dev/trace/recording    # is it still recording

# What each request cost BELOW the wire, added 2026-08-19 (2.15). Every http event carries
# `queries` and `dbMs`, and the row shows a badge that turns colour past 12 and past 30.
jq -r 'select(.kind=="http" and .queries != null)
       | "\(.queries)q \(.dbMs)ms  \(.method) \(.route)"' .dev-trace/trace.jsonl \
  | sort -rn | head -20                       # the most expensive answers, not the slowest
```

Every REST request, every socket frame in both directions, and every outbox effect, from all
three processes, joined into one feed and appended to a file. See
[`packages/server/src/dev/`](../../packages/server/src/dev/) and the commands in
[`AGENTS.md`](../../AGENTS.md).

**Five rules learned while measuring, each of which produced a wrong answer first:**

1. **Put both windows side by side; never watch from a background tab.** A backgrounded browser
   tab has its timers throttled and its rendering deferred, which invented two extra "waves" of
   requests that did not exist. Twenty minutes were spent on them.
2. **Check how many clients are connected before blaming the code.** `msg.new -> 1 socket` in the
   trace is what ruled out "two browser tabs open" as the explanation for duplicated requests. It
   is the first thing to check, not the last.
3. **The recording buffer in the page is 200 events.** A walk through the app is thousands. The
   file recorder exists because the first long session was analysed from its tail only.
4. **Ask the person driving what they were doing.** "I did a lot of scrolling" is what exposed
   2.8, which the numbers alone read as a `revision` problem and was not.
5. **Read the quiet routes too.** 2.10 was found by somebody asking why `GET /calendar` appeared
   once and never again. Every other technique here searches for excess and would have called that
   a success.

---

## 2. What was found, and what was done

Ordered by what a member on a phone would feel.

### 2.1 Catching up asked about one chat at a time

**The defect.** `GET /sync` has always read `channels[]` as an array, authorized each entry
independently and refused only at 201 of them. The client sent **one entry per request and
awaited each before starting the next**. A member of 23 channels paid 23 sequential round trips
on every connect, foreground and reconnect.

**Why it mattered.** A quarter of a second on a laptop. On a phone, where a round trip is nearer
200ms than 5, it is the several seconds somebody spends looking at the app before it is caught
up - and it grows with how many clubs a member joins, so the app got slower the better it did.

**The fix.** `syncAll` now sends every channel in one request; the paging loop moved up a level,
so the request count is the deepest channel's page count rather than the sum of everybody's. In
the ordinary case that is one. Writes still go through the per-channel queue a live frame uses.

**Measured.** 12 channels, 1 request, 21ms. For a few minutes both versions ran against the same
server at the same instant - one client issuing 23 requests 9ms apart while another asked once.

**Status: done.** `packages/client-core/src/chat-client.ts`.

### 2.2 The browser asked permission before nearly every request

**The defect.** Every call carries an `Authorization` header, which makes it non-simple, so the
browser sends a preflight `OPTIONS` first and only skips the next one if the answer says how long
to cache it. `@fastify/cors` was registered with no `maxAge`, so browsers fell back to their own
default - five seconds in Chromium - and re-asked before almost everything.

**Measured.** 92 preflights against 104 real requests. Close to half of all traffic was the client
asking whether it was allowed to speak.

**The fix.** `maxAge: 7200`, the ceiling Chromium honours. What is cached is the *shape* of the
permission, never an authorization decision; every request is still authenticated and
access-checked on arrival. Native clients never preflighted and are unaffected.

**Note for whoever reads the numbers next.** The browser caches per exact URL, so a route whose
URL differs every time still preflights every time. That is why fixing 2.7 also removed 49
preflights from one screen: fewer distinct URLs, fewer preflights.

**Status: done.** `packages/server/src/api/app.ts`.

### 2.3 One signal announced "something changed" five times per message

**The defect.** The session provider bumps `revision` for everything the socket hears about, and
**eight screens re-fetch when it changes**. Every screen a person has visited stays mounted behind
whatever they are looking at, so one announcement is not one request - it is one request per
loaded screen. Sending a single message announced four or five times on its own.

**Measured.** `/conversations`, `/notifications/badge` and `/polls/:id` all fired twice within
130ms of each other, from three different screens, because connecting and then finishing a sync
announced twice in a row.

**The fix.** The client's `onChange` is coalesced on a **leading edge**: the first change is still
instant, because a message arriving must appear as it arrives, and everything inside the next
400ms folds into one trailing announcement. Sign-in, sign-out and a rejected socket keep
announcing immediately - those are single lifecycle events, and delaying one would mean an app
that has signed out still drawing the previous member's screens.

**Status: done.** `apps/mobile/src/chat-provider.tsx`.

### 2.4 The chat screen re-read its own title and roster on every message

**The defect.** `loadMeta` was keyed on `revision`, so one send - optimistic bubble, `msg.ack`,
`msg.new`, read cursor - asked "what is this channel called" and "who can be mentioned here"
**six times each**. Neither answer can change because a message moved: one is a title and a
posting rule, the other is a roster.

**The fix.** Read on arrival, on return (`useRefreshOnReturn`), and after an action that changes
it. Not on `revision`.

**Status: done.** `apps/mobile/app/chat/[channelId].tsx`.

### 2.5 Three screens read twice to open

**The defect.** `useFocusEffect` **fires on mount as well as on return**. Three screens did
`useLoad(...)` *and* a focus effect that refreshed, so each asked twice to open, about 18ms
apart - and `useLoad`'s attempt counter discarded the first answer, so it cost a round trip and
showed nothing for it.

This is the exact defect `useRefreshOnReturn` was written for on 2026-08-17, and its doc comment
describes this symptom. **Three screens were never moved over.**

**The fix.** The chat list and a club's hub now use `useRefreshOnReturn`. The inbox needed a
hand-rolled guard, because its cleanup marks the inbox read on the way out and that has to keep
running on every blur.

**Status: done.** `clubs/index.tsx`, `clubs/[clubId]/index.tsx`, `notifications.tsx`.

### 2.6 The notification badge had two clocks

**The defect.** `GET /notifications/badge` arrived in pairs 20 to 30ms apart, on an idle app,
repeating at exactly 60.000s forever - which is two timers, not one firing twice. There is one
call site and no StrictMode in this build, so something renders `BadgedIcon` twice.

**The fix, and why it is not the obvious one.** Finding which copy was the wrong thing to reach
for. **This number is one fact about the whole app, not a property of an icon.** The count, the
timer and the request moved to module scope with the hook as a subscription, so any number of
copies share one of each. A deferring cooldown was added on top: a suppressed read is **deferred,
never dropped**, because a plain rate limit would put back the bug that "I accepted the request
and it still shows 1" describes.

**Status: done, cause unexplained.** See 3.2.

### 2.7 Every card on a screen fetched itself

**The defect.** A chat card reads its own poll so its tally is current, which is right. What was
wrong is that each card was also its own request, and `screens/polls.tsx` said in a comment that
"a conversation rarely has more than one". The trace found a conversation holding **twenty-six**,
plus ten event cards.

**Measured.** Opening one club chat: 78 requests and 49 preflights inside 958ms, of which 43 were
poll cards and 10 were event cards reading themselves.

**The fix.** New batch routes `GET /polls?ids=` and `GET /events?ids=`, and a batching reader on
the client that swaps in beneath `pollApi.detail` and `contentApi.event` - so no card, screen or
sheet had to change, and none of them can forget to.

**The rule the batch routes hold, and it is the important part.** Authorization is `readPoll` and
`readEvent` called **once per id, the same function the single-item routes call**. Not one query
with an `IN` clause and a predicate written a second time - the second copy is always the one that
forgets that a race poll is invisible to a club admin with no roster row. `batch-reads.test.ts`
asks the same question of both routes and demands the same answer, and asserts the refused id does
not appear anywhere in the response.

An id the caller may not read, or one that no longer exists, is **omitted** rather than an error,
so one stale card in old history fails alone instead of taking the other twenty-five with it. A
**malformed** id is a 400, because skipping it would hide a client bug behind a success - the
defect `/sync` spent months in.

**Status: done.** `routes/polls.ts`, `routes/content.ts`, `api/plumbing.ts`,
`apps/mobile/src/batch-reader.ts`.

### 2.8 Scrolling re-read every card it rebuilt

**The defect, and the one that needed the person driving.** After 2.7, cards were still being read
six to ten times each. The clue was that **event cards do not depend on `revision` at all and were
still read six times each** - so it could not be the announcement. The chat's `FlatList` unmounts
rows that leave the screen and rebuilds them on the way back, and a rebuilt card reads on mount.

**Measured.** 26 distinct polls fetched 261 times, and 12 distinct events fetched 81 times, in two
minutes.

**The fix, and a reversal worth recording.** The batch reader had been written to deliberately
*not* cache, on the grounds that a time-based cache would answer the re-read after a vote with the
tally from before it. **That reasoning was right about the danger and wrong about the conclusion:**
no amount of batching helps a read that happens a second later. An answer is now reused for 15
seconds, and **every write clears the whole map** - so your own vote is never answered from
memory, because casting it emptied the memory.

**Measured after.** 261 poll fetches became 53; 81 event fetches became 29. A vote is followed by
a re-read of exactly that one poll, 34 to 43ms later, and the other 25 are left alone.

**Status: done.** `apps/mobile/src/batch-reader.ts`, with the write paths in `api.ts` invalidating.

### 2.9 The same picture was requested three times at once

**The defect.** `resolveMedia` memoises a signed URL, but the memo fills in only once an answer
arrives - so everything wanting the same picture in the same instant missed it and asked too.

**Measured.** One thumbnail requested three times inside 40ms; nine such cases in a
seventeen-minute session.

**The fix.** An in-flight map beside the memo. They answer different questions: the memo says
"this URL is still good", the in-flight map says "somebody is already asking".

**Status: done.** `apps/mobile/src/api.ts`.

### 2.10 The calendar read itself once and never again

**The defect, and it runs the opposite way to every other entry here.** `calendar.tsx` reads on
mount and has no reload of any kind - no `revision`, no focus refresh, nothing. **A tab screen
stays mounted once it has been opened**, so switching to Chats and back re-runs nothing. The read
happened once per club for the whole life of a session.

What that costs: add an event from chat's "+" menu, from the club's own events screen, or from
another member's phone, then open the Calendar tab. It shows what it read the first time that tab
was ever opened, and nothing short of restarting the app corrects it.

This is the complaint [`use-load.ts`](../../apps/mobile/src/use-load.ts) already documents -
"coming back to a list and seeing what it said ten minutes ago" - and the calendar simply never
got the treatment the chat list and the club hub have.

**How it was found, which is the interesting part.** Not from a number being too big. Somebody
looked at the trace and asked why `GET /calendar` appeared **once** and never again. **The trace
finds too few requests as readily as too many, and only one of those two is a correctness bug.**
Nothing in section 2.1 to 2.9 would have surfaced this, because every technique there is a search
for excess.

**The fix.** `useRefreshOnReturn` on the calendar tab and on the club's events list, keyed by club.
The events list already reloaded after creating one itself; what it could not see was an event
created somewhere else.

**Status: done.** `app/(tabs)/calendar.tsx`, `app/(tabs)/(main)/clubs/[clubId]/events.tsx`.

### 2.11 A club's hub asked about every club, and every DM, to badge one club

**Found 2026-08-19, on a screen 2.5 had already been through.** `GET /channels` is the per-channel
sync state the hub badges from, and it took no argument: it answered with every channel the caller
can reach anywhere. The club hub then discarded all but the one club it was drawing.

**Measured.** Opening Binghamton: **23 rows returned, 5 used** - 4,302 bytes to need 956, so 78%
of the response was thrown away. Eight of the discarded rows were DMs, which that screen has
nowhere to draw at all.

**Why it is worse than 78%.** The waste is not a constant. It is `clubs joined + people talked to`,
paid on every hub open, while the useful part stays at "this club's channels". A member of ten
clubs with thirty DMs is sent about seventy rows to draw four. **The app got slower the better it
did**, which is the same shape as 2.1 and is the tell for this whole class.

**The fix.** `GET /channels?clubId=`, and the hub passes its own club.

**Why the parameter is optional, which is the part worth keeping.** The gateway shares this read
(`gateway/server.ts:330`) to build `auth.ok`, and that caller needs **every** channel: a list with
one club missing is a gap the client cannot know it has. So the filter is opt-in, and unfiltered
still means what it always meant. A required parameter would have made the handshake's correctness
depend on every future caller remembering to ask for everything.

**Narrowing adds no authorization surface, and that is why it is a query rather than a new
club-scoped route.** `accessibleChannelPredicate` has already decided what the caller may see; a
`club_id` filter can only return a subset of that. There is nothing to re-check and no second copy
of the access join to drift - which is the failure pitfall 9 names and the reason 2.7's batch
routes loop the single-item authorizer instead of writing an `IN` clause.

A malformed `clubId` is a **400**, on 2.7's rule: silently ignoring it would answer with every
channel the caller has and look like a success, hiding a client bug behind the fullest possible
response.

**One cost, recorded rather than buried.** The URL now differs per club, so the preflight cache
from 2.2 holds one entry per club instead of one in total - eight clubs means eight `204`s every
two hours rather than one. That is the same mechanism as the note under 2.2, running the other way,
and 13KB saved per open is worth seven empty round trips per two hours.

**Measured after, on the physical iPhone.** 5 rows, 956 bytes, scopes exactly
`club, eboard, race, race, race`. Verified against the running server that the scoped rows are
identical to the global read's rows for that club - the same `lastSeq` and `lastReadSeq` - so no
badge can change, which was the only real risk. An outsider passing a club id gets zero rows.

**Status: done.** `domain/reads.ts`, `routes/chat.ts`, `apps/mobile/src/api.ts`,
`clubs/[clubId]/index.tsx`.

### 2.12 Leaving the inbox broadcast to the whole app to update one number

**Found 2026-08-19 by the founder, driving two accounts at once.** The notifications tab marks
itself read on the way out, and then called `notifyChanged()` - the session-wide announcement that
**eight screens re-fetch on**. So closing the inbox re-read the chat list with every DM in it, a
club's name, its race list and its channels.

**Measured.** Eight follow-up requests per tab exit, every time, including `/conversations` and
`/channels` **twice each** and a badge re-read 690ms later. Reading your own inbox cannot rename a
club or change who you have DMs with.

**The part that makes it worth writing down: the answer was already in the response.**
`POST /notifications/read` returns `{ cleared, badge }`, the count recomputed by the same
`badgeCount` the GET route calls, after the mark. The client discarded it and announced to the
whole app so that one number could be fetched again. **A global broadcast to deliver a value that
had already arrived.**

**The fix.** `adoptBadgeCount(badge)` takes the count from the write. No announcement, and the
deferred re-read is cancelled because a count the server computed *after* the write is strictly
better than the one that read would have returned.

**A race the old code had, kept and closed.** The badge also re-reads on navigation, which happens
in the same instant as the write - so the read starts first, carries the count from BEFORE the
mark, and wins if it lands last. A generation counter now means the newer answer always wins.

**Measured after, one hour apart on the same server.** The phone, hot-reloaded with the fix: **1
to 2** requests per exit. The web tab, still on the old bundle: **7 to 8**, every time. The same
action, the same account state - the only variable was which bundle was running, which is as clean
a before/after as this mission has produced.

The `/conversations` still on the fixed exits is **correct** and not a leftover: it is the chat
list refreshing because it is the screen being navigated TO.

> **Two things that looked like defects and were not, both costing time before the real one was
> found.** The badge appeared to flicker between 0 and 1 in the trace; it was **two accounts**,
> each polling correctly on its own minute, and the `userId` column says so. And the badge stayed
> at 1 after the inbox was marked read, which is right: `badgeCount` is unread notifications
> **plus** channels with unread messages, and that 1 was a `chat_unread` row that only reading the
> chat can clear. Rule 2 of section 1 caught the first. The second is an argument for reading a
> route's own query before believing a number is stale.

**Status: done.** `apps/mobile/src/use-badge.ts`, `app/(tabs)/notifications.tsx`.

### 2.13 Two screens re-read themselves every time somebody else read a message

**This is 3.4's actionable half, closed.** The club hub keyed its club detail and race list on
`revision`, and the Profile tab keyed all three of its reads on it. `revision` is bumped for
everything the socket hears about, and the loudest of those is not a message arriving - it is
**`msg.read`**, somebody else's read cursor moving.

**Measured on the iPhone 2026-08-19.** Thirteen seconds of ordinary use, with the hub mounted
behind the chat: 4 reads of `/clubs/:id` and 4 of `/clubs/:id/races`, every answer identical. A
message being read cannot rename a club, add a race to it, change your email, or join you to
anything.

Profile matters more than it looks, because **a tab screen stays mounted once opened** (2.10) - so
that screen sat behind whatever was on top, answering socket traffic all day.

**The fix.** 2.4's, unchanged: read on arrival, on return via `useRefreshOnReturn`, and after an
action that changes it. `act` on the hub already refreshed both after anything done there.

**What `/channels` keeps, and why it is not an inconsistency.** The hub's unread read stays on
`revision` deliberately. Unread counts are exactly what a `msg.read` frame changes, so that one is
the signal doing its job rather than being misused - which is the whole distinction 3.4 was drawing
and had never been acted on.

**The trade, stated rather than discovered.** A rename or a new race made by somebody else reaches
a mounted hub on the next return rather than instantly. Same trade 2.4 made for the chat title.

**Measured after, on the device.** Six `msg.read` frames arrived; **zero** club or race reads
followed any of them. The two that remain in the window are an app start and the navigation into
the hub, both arrivals.

**Status: done.** `clubs/[clubId]/index.tsx`, `(tabs)/(profile)/profile/index.tsx`.

### 2.14 One request per picture

**The largest item this mission ever carried, and the last of the batching family.** Resolving a
signed URL was one request per picture. Nothing was duplicated, nothing was slow, and every answer
was correct - it simply was not batched, exactly like 2.1 before `/sync` took a list and 2.7 before
the cards did.

**Measured before.** A window on the device spent **50 of its 110 requests - 45% of all traffic -**
on 34 picture links: 39 resolves plus 11 preflights.

**The fix.** `GET /media/urls?ids=&variant=`, and a batch reader keyed by `id:variant` dropped in
beneath `resolveMedia`. Every picture in the app already went through that one function, so no
screen, card or sheet changed and none of them can forget to.

**Authorization is `resolveMediaRedirect` once per id, the same function the single route calls.**
2.7's rule, and it matters more here than it did for cards: a poll leaked from a batch is a row,
a signed URL leaked from a batch is **bytes**. `batch-reads.test.ts` asks the same question of the
single route and the batch, and asserts the refused id appears nowhere in the response.

**Keyed by `id:variant`, not by id**, because the route takes one variant per request and the same
picture is legitimately wanted at two sizes. A mixed batch becomes one request per variant, which
in practice is one.

**The memo stays the cache, and the batch reader is given `freshForMs: 0`.** The reader exists for
the collection window; `mediaUrlMemo` holds each URL until the hour-aligned expiry the server
actually signed it to, which is a better answer than a flat fifteen seconds. Two caches with
different expiries is a way to hand out a dead URL.

**Measured after, scrolling a picture-heavy chat on the device.** 29 distinct pictures, 33
picture-and-size pairs, **14 requests, 0 single-picture calls, 0 preflights**. Per picture:
**1.15 requests became 0.42**. The four pictures asked for twice were each asked at two sizes,
which is correct rather than waste.

> **Why the remaining 14 are not a tuning problem, since the obvious next move is to widen the
> window.** The gaps between them run from 200ms to 4.7 seconds across fourteen seconds of
> scrolling. A 400ms collection window would give 9 requests and an 800ms one 8, both at the cost
> of a placeholder a person can see. Pictures enter the viewport when they enter it; **a batch
> cannot collect what has not been asked for yet.** The one call carrying 12 ids is the window
> working, on the occasion when twelve cards did mount together.

**Status: done.** `routes/media.ts`, `apps/mobile/src/api.ts`, `test/batch-reads.test.ts`.

### 2.15 What the server does per request, measured for the first time

**Everything in 2.1 to 2.14 is about what the CLIENT asks for.** Nothing had ever looked at what
the server does to answer one question. The dev trace knew the wall time of every request and
nothing had exceeded 85ms, so there was no fire to follow - which is exactly the shape of this
whole mission, one layer down.

**The tool.** A counter in async context, opened by the API's `onRequest` hook and read back in
`onResponse`, with every pooled client wrapped so it reports each statement. `queries` and `dbMs`
now ride on every HTTP trace event and show on the dashboard row beside `ms`.

`AsyncLocalStorage` rather than a field on the request, because a query is run by `domain/` code
that has no idea a request exists - and that boundary is the point. Threading a counter through
every signature to measure something would leave the measurement one forgotten parameter away
from being quietly wrong.

**Three ways it was wrong before it was right, all found by its own test in the first hour.** They
are worth recording because each produced a plausible number:

| Attempt | Reported | Why |
|---|---|---|
| Wrapped `pool.query` **and** the client | **double** | `Pool.query` is not a separate path; it acquires a client and runs `client.query` |
| Wrapped only the promise form of `connect` | **zero** | `Pool.query` acquires through the CALLBACK form |
| Read the counter when the query **returned** | **zero, or somebody else's** | pg fires completion in its own async context, rooted where that pooled connection was first opened |

The fix for the third is the one worth keeping: **the counter is captured when a query is sent,
never when it comes back.** A query belongs to the code that asked for it.

> **A measuring instrument needs a test more than the code it measures does.** A number wrong in
> the flattering direction closes an investigation; one wrong the other way starts a hunt for a
> defect that is not there. The first numbers this tool produced were exactly twice the truth and
> looked entirely reasonable.

**Inert outside development.** `instrumentPool` is called from one place behind `devTraceEnabled()`,
like the tracer, so a production boot and every test get the plain pool.

**Status: done.** `dev/queries.ts`, `dev/queries.test.ts`, `api/app.ts`, `api/main.ts`,
`dev/trace.ts`, `dev/dashboard.html`.

### 2.16 The batch poll read was N+1 underneath, and 2.15 found it the day it existed

**Predicted, measured, fixed.** `GET /polls?ids=` looped `readPoll` once per id. That was right
about authorization and wrong about everything else: the chat screen from 2.7 holds **26 poll
cards**, so the request that replaced 26 requests ran **133 statements** to answer.

**Measured before.** `3 + 5n` round trips - 8 for one poll, 43 for eight.

| ids | before | after |
|---|---|---|
| 1 | 8 | **7** |
| 8 | 43 | **7** |
| 16 | 83 | **7** |

**Flat.** And the single route dropped from 8 to 7 with it, because `readPoll` had been fetching
the same poll row **twice** - once through `pollRef` for the access check, then again for its
contents. Nobody had counted, so nobody had noticed.

**What was NOT traded, and it is the whole point.** `canAccessPoll` still runs **once per id**.
It is a pure function over a preloaded context, so per-id authorization never cost anything -
what cost something was fetching each poll's DATA separately. The refusal now happens before a
single byte of poll content is fetched, and a race poll is still invisible to a club admin with
no roster row.

**`readPoll` delegates to `readPolls`** rather than keeping its own body, so the single and batch
routes cannot answer differently. That is the failure `batch-reads.test.ts` exists to catch,
removed by construction instead of asserted.

**Voter lists are fetched only for the polls whose voters this caller may see**, rather than
fetched and then dropped.

**The guard.** Two tests assert the batch costs the same for eight ids as for one, and that a
single read costs the same either way - read from the **traced query count**, the number the
dashboard shows, arriving by the path production uses. Written as "same as one" rather than a
fixed number, so adding a column does not fail it and only the per-id loop does. Proved by
putting the loop back: **35 against 7**, and the test failed.

**The picture route had the same defect and was fixed in the same session.**
`resolveMediaRedirect` ran **two statements per picture** - the media row, then the channel that
owns it - and a gallery is dozens of pictures in ONE channel, so that channel was re-read for
every photo in it. Measured by putting the loop back: **19 statements for eight pictures, 5 with
the fix**, and flat from there. `resolveMediaRedirect` now delegates to `resolveMediaRedirects`,
so the redirect hop and the batch route cannot authorize differently, and `isChannelMember` still
decides every id on its own.

**Status: done.** `domain/polls.ts`, `routes/polls.ts`, `media/pipeline.ts`, `routes/media.ts`,
`test/batch-reads.test.ts`.

### 2.17 Creating one poll re-read three screens nobody was on

**Reported from the phone**, in the words that turned out to be exactly right: creating a poll
"is calling the whole conversation pulling up, which is not required."

**Measured** on the phone 2026-08-19 at 22:46:52. One `POST /clubs/:id/polls` raised `msg.new` and
then three `msg.read` receipts from the creator's own device. The provider folded those into a
leading and a trailing announcement (2.3), and each announcement re-read three screens that were
mounted behind the poll screen: `/conversations`, `/channels?clubId=` and the badge. **Six requests
for one poll, none of them on a screen anybody could see.**

**Not the defect 3.4 was looking for.** That entry examined these same three reads and called them
correct, and it was right: a message genuinely changes a chat list, and a read receipt genuinely
changes an unread count. The keying was never wrong. What was missing is that a screen behind
another one cannot show anybody the difference, and the same read on return produces the same
answer - so the announcement should be deferred rather than ignored or obeyed.

`useFocusedValue` (2.10, written for the calendar the same evening) does exactly that, and the
three reads now key on `revision` **as of the last time the screen was looked at**. Live while in
front of a reader, once on the way back otherwise.

**One asymmetry is load-bearing and cost a wrong first attempt.** `useRefreshOnReturn` must key on
the LIVE revision where the read takes the deferred one. At focus time the deferred value has not
been adopted yet, so keying both on it lets the return refresh fire alongside the adopted read -
two requests where the change exists to remove them. The inbox rolls its own return guard on a
callback keyed to `[authState]`, so it reaches the live value through a ref for the same reason.

**Two batching numbers were measured wrong in 2.8 and corrected here.** The busy window was 150ms
against card arrivals 89 to 191ms apart, so cards flushed alone; the freshness window was 15s
against returns 17 to 56s apart, so it expired just before nearly every case it existed for. Now
400ms and 60s. Also in this entry: the chat screen's metadata re-read got a 30s floor on the return
path only, after three returns in thirty seconds cost six requests (22:41:07, 22:41:31, 22:41:37).

**Verified on the device.** The same action at 23:11:49: `/conversations` gone, `/channels?clubId=`
gone, badge down from two to one, and the cards arriving at **4.0 ids per request** against 1.0 for
most of the previous night.

**Status: done.** `use-load.ts`, `batch-reader.ts`, `chat/[channelId].tsx`, `clubs/index.tsx`,
`clubs/[clubId]/index.tsx`, `notifications.tsx`.

**What this does not fix:** cards that genuinely arrive seconds apart during a slow scroll still
cost a request each, and no window closes that without making a card visibly late.

---

## 3. Still open

Ranked by what it would cost a member.

### 3.2 `BadgedIcon` renders twice, and nobody knows why

The cost is gone (2.6) but the cause is not explained. There is one call site
(`app/(tabs)/_layout.tsx`, the `tabBarIcon` slot) and no StrictMode in this build. **Worth
explaining rather than leaving**: whatever renders that icon twice is presumably rendering its
siblings twice too, and the next component to own a timer will not have been written defensively.
Also tracked in [`TODO.md`](../../TODO.md).

### 3.3 Voting writes no event, so live tallies are a coincidence

`toggleVote` writes **zero outbox events**. Another member's vote raises no frame and bumps no
revision. The poll card's old comment claimed the opposite, and what actually happened was that an
unrelated message arriving triggered a re-read that happened to pick the vote up.

Two honest options, neither taken yet:

- **Accept it.** Cards now read on open and on return, which is what was chosen on 2026-08-18.
- **Make it real.** A vote writes an event, the worker fans it out, and cards refresh on something
  that actually happened. This is feature work, not cleanup, and it belongs with
  [PRD/11](../PRD/11-polls.md) rather than here.

### 3.4 Three reads still key on `revision`, and all three are correct

**Closed by 2.17.** Kept here rather than deleted, because the entry was right about the thing it
examined and wrong about the question to ask, and that is worth being able to find again.

| Screen | Read | Why it stays |
|---|---|---|
| The inbox | the notification page | a message genuinely changes an inbox |
| The chat list | `/conversations` | a message genuinely changes a chat list |
| A club's hub | `/channels` | a read receipt genuinely changes unread counts |

Every line of that table is still true, and all three still key on `revision`. The question it did
not ask is **when**: none of these screens is usually the one being looked at when the announcement
arrives, and a re-read nobody can see is a round trip spent on nothing. 2.17 defers them to focus
rather than removing the keying.

The five that could not be changed by socket traffic - a club's detail, its race list, and the
Profile tab's own profile, club list and identity - moved to arrival-and-return in 2.13.

The number this entry flagged as "correct in kind and probably not in quantity" - **6 reads of
`/conversations` for one message sent** - was half a coalescing problem (2.3) and half a visibility
one. Deferring took the six to zero without touching the window.

### 3.6 The iPhone has barely been measured

Every number in 2.1 to 2.10 is the web client. The phone runs the same code, so the fixes apply,
but almost nothing has been verified there - and the phone is where the round trips actually hurt.

**First device numbers came 2026-08-19** and are in 2.11 and 3.4: the scoped hub read confirmed at
5 rows, and the read-receipt churn found there rather than on the web. That is one screen. The
remaining surfaces are unmeasured on a device, and the phone has already produced one finding the
web session did not, which is the argument for doing the rest there.

---

## 4. Never checked at all

**52 of 145 routes have ever been exercised while anything was watching.** The three global fixes
(2.1, 2.2, 2.3) cover every screen including these. Anything screen-specific - a 2.4, a 2.5, a 2.7
- would still be sitting in them, undisturbed.

This is the checklist. Open [the trace page](http://localhost:3000/dev/trace), work down the
coverage column, and the percentage is the progress bar. **A second throwaway account is needed**
for anything with two sides: approvals, bans, join requests, DMs, ownership transfer.

> **Not every unexercised route is untested - some have no caller at all, and the coverage column
> cannot tell the difference.** `GET /calendar/markers` is the known example: `calendarApi.markers`
> exists in `api.ts` and **nothing in the app calls it**, deliberately, because `calendar.tsx`
> answers the grid and the day list from one feed read rather than two ("asking twice would make
> the dots and the list two answers to the same question"). It will therefore never light up, no
> matter how thoroughly anybody clicks.
>
> So a route that stays grey after a genuine attempt to reach it is **a finding, not a gap**, and
> it is one of three things:
>
>  1. **Unreachable by design**, like the markers route. Decide whether it stays: a route with no
>     caller is surface to authorize, test and keep working forever, for nobody.
>  2. **Reachable only from a surface that does not exist yet**, which is a roadmap item rather
>     than a defect.
>  3. **Reachable and simply not found**, which is a UX finding - the control is somewhere nobody
>     looks.
>
> Work through the list expecting all three. The first pass over these 93 is as much an audit of
> what the client actually uses as it is a performance sweep.

**Chat, the largest untouched surface** - reactions, editing, pinning, announcements, reporting,
deleting, muting, per-conversation pin, clearing, the gallery, jump-to-message, history paging:

```
GET    /channels/:id/messages            GET    /channels/:id/messages/around
GET    /channels/:id/gallery             GET    /channels/:id/messages/:seq/reactions
POST   /channels/:id/messages/:seq/reactions      POST /channels/:id/messages/:seq/body
POST   /channels/:id/messages/:seq/pinned         POST /channels/:id/messages/:seq/report
DELETE /channels/:id/messages/:seq       POST   /channels/:id/read
POST   /channels/:id/mute   | DELETE     POST   /channels/:id/pin  | DELETE
POST   /channels/:id/clear
```

**Races, entirely untouched** - the whole mini-club surface, including car groups:

```
POST   /clubs/:id/races                  PATCH  /races/:id
PATCH  /races/:id/meet-information       POST   /races/:id/pin
POST   /races/:id/members                DELETE /races/:id/members/:uid
GET    /races/:id/member-candidates      POST   /races/:id/join
POST   /races/:id/join-requests          POST   /race-join-requests/:id/approve | /deny
POST   /races/:id/car-groups             POST   /car-groups/:id/members
PATCH  /car-groups/:id/incharge          DELETE /car-groups/:id
DELETE /races/:id/car-group-members/:uid GET    /races/:id/polls
POST   /races/:id/polls                  DELETE /races/:id
```

**Membership and moderation** - the two-person flows, and the platform queue:

```
POST   /clubs/:id/join                   POST   /join-requests/:id/approve | /deny
POST   /invites/:token/redeem            POST   /clubs/:id/invite-token/rotate
POST   /clubs/:id/members                DELETE /clubs/:id/members/:uid
PATCH  /clubs/:id/members/:uid/role      POST   /clubs/:id/transfer-ownership
POST   /clubs/:id/bans | DELETE          POST   /clubs/:id/leave
GET    /clubs/search                     GET    /clubs/:id/member-candidates
PATCH  /clubs/:id                        DELETE /clubs/:id
POST   /users/:uid/report                POST   /moderation/users/:uid/suspended
GET    /moderation/reports/:id/context   POST   /moderation/reports/:id/dismiss | /remove
POST   /moderation/user-reports/:uid/dismiss      GET  /moderation/reads
```

**Direct messages and blocking, entirely untouched:**

```
GET    /dm/threads                       GET    /dm/candidates
POST   /dm/threads                       GET    /blocks
POST   /blocks                           DELETE /blocks/:uid
```

**The Eboard space:**

```
PATCH  /eboards/:id                      POST   /eboards/:id/members
DELETE /eboards/:id/members/:uid         GET    /eboards/:id/member-candidates
POST   /eboards/:id/join-requests        POST   /eboard-join-requests/:id/approve | /deny
POST   /eboards/:id/meetings             PATCH  /meetings/:id
DELETE /meetings/:id                     POST   /eboards/:id/polls
```

**Content and the rest:**

```
POST   /clubs/:id/news                   GET    /news/:id
PATCH  /news/:id                         DELETE /news/:id
GET    /clubs/:id/news/member-candidates
POST   /clubs/:id/meetups                PATCH  /meetups/:id
DELETE /meetups/:id                      POST   /meetups/:id/nudge
DELETE /events/:id                       POST   /polls/:id/closed
DELETE /polls/:id                        GET    /calendar/markers
PATCH  /me/profile                       DELETE /me
POST   /devices | DELETE                 GET    /media/:id
```

---

## 5. Rules that fall out of this

Four patterns produced all nine findings. They are worth reading as a checklist before writing
anything that reads data.

1. **If a screen can hold N of something, the read for it must take N ids.** Two independent
   defects (2.1, 2.7) and one still open (3.1) were the same mistake: a route that could answer
   for many, called once per one. **Ask "what happens at twenty?" of every per-item read.**
2. **A batch read authorizes per id, using the same function the single read uses.** Never a
   second predicate. The saving being bought is network round trips, not database work, and
   database work was never the expensive part at this size.
3. **`useFocusEffect` fires on mount.** Use `useRefreshOnReturn` unless you also need a cleanup,
   and then guard the first fire by hand.
4. **A signal every screen listens to is a signal that costs one request per mounted screen.**
   Before keying a read on `revision`, ask whether the thing being read can actually change
   because of what `revision` announces. For a title, a roster or a club's name, it cannot.

And two about method rather than code:

5. **Watch the wire before believing a comment.** Two of the nine findings contradicted the
   comment sitting directly above them - `screens/polls.tsx` on how many polls a conversation
   holds, and the same file on what makes a tally move. Both comments were written in good faith
   and both were wrong, and no test could have said so.
6. **Ask why something appears too FEW times, not only too many.** 2.10 was found by noticing a
   route that fired once and never again, which every other technique in this document would have
   read as a success. A screen that never re-reads is a correctness bug wearing the costume of a
   fast one.

---

## 6. What else could watch this, and what to build next

**Requested 2026-08-19, after the query counter found two N+1s on the day it was built.** This is
a survey, not a plan: nothing below is committed to. The counter is one technique out of about
eight, and it is deliberately the cheapest - roughly 120 lines, development only, no service to
run. The rest are what the industry actually uses, ordered by what would earn its keep here
first.

**The one honest caveat about all of it.** Every tool below tells you what a system DID. None of
them tells you what it should have done, which is the judgement each of the fourteen findings in
section 2 actually needed. Instrumentation shortens the search; it never ends it.

### 6.1 Sentry performance tracing - already paid for, not switched on

`@sentry/node` is **already a dependency** and already catching errors. Its performance half adds
distributed tracing: each request becomes a trace, each database call a span, with the tree and
the timings.

> **Correction, 2026-08-23: this is a CODE change, not a configuration change**, and the sentence
> that stood here said the opposite for four days. `tracesSampleRate: 0` is a **literal** in
> `packages/server/src/monitoring.ts`, and again in `apps/mobile/src/monitoring.ts`, each with its
> reason in a comment beside it. Nothing reads an environment variable for it. So setting
> `SENTRY_DSN`, which happened on 2026-08-23 and did switch error reporting on for all three
> roles, changed nothing whatever about tracing, and no amount of `fly secrets` or `[env]` ever
> will. The server half is an edit plus a `fly deploy`; the client half is an edit plus a build,
> or an over-the-air update once one exists. The wrong claim also reached
> [the roadmap](20-road-to-the-first-club.md) milestone 3 and is corrected there.

**Why it is first.** Everything measured in this document is a laptop against a database on the
same machine. The 133-statement poll read cost 12ms locally and would cost far more across a
network boundary on Fly.io - and **nothing currently measures production at all**. This is the
only entry that changes that without new infrastructure.

Costs: sampling rate has to be chosen (1-10% of traces is normal), and spans carrying query text
need the same redaction rule the dev tracer already applies.

> **Still off as of 2026-08-23, and no longer blocked.** The obstacle was never the sample rate.
> Until 2026-08-23 there was nowhere to send a trace FROM, so switching this on bought a laptop
> reporting on itself, which is the exact thing section 7 exists to stop counting as a
> measurement. Three roles now run in production and a DSN reaches all three, so that obstacle is
> gone and what is left is the two literals above. Section 8 records what is watching production
> while they stay at zero.

### 6.2 `pg_stat_statements` - what the database thinks is expensive

A Postgres extension that aggregates every statement it has ever run, normalised, with call
counts, total time and rows. `CREATE EXTENSION pg_stat_statements` and one config line.

**Why it complements the counter rather than repeating it.** The counter answers "what did THIS
request cost". This answers "what is this database spending its life on", across every process
including the worker and the gateway, with **no application instrumentation at all**. It is how
you find the query nobody suspected, rather than confirming the one you did.

It would have shown the poll N+1 as one statement with an absurd call count.

> **Done on 2026-08-21, on a laptop.** Preloaded in `docker-compose.yml` and in the test
> container, with `track=all` and `track_utility=off`. Section 7.3 is the first thing it answered
> - it put the whole cost of a concurrent send on the row lock, at two orders of magnitude clear
> of the next statement.
>
> **Done in production on 2026-08-23, and it was not before.** `CREATE EXTENSION
> pg_stat_statements` was run once against the production Neon database; it reports version
> **1.11** and answers queries. Neon already carries the library in `shared_preload_libraries`, so
> that single statement was the entire operation and no provider setting was touched. This is the
> first instrument in the project's history that watches something other than a development
> machine, and it is the reason 8.1 can say what it says about `curl`.
>
> **It is an operational step and deliberately NOT a migration. Do not "fix" that.** Two reasons,
> and the second is the one that decides it. `CREATE EXTENSION` wants rights the application role
> should not be assumed to have. And the library has to be preloaded before the statement can
> succeed at all, so a `CREATE EXTENSION` sitting in the migration chain fails on every
> environment that does not preload it - which breaks the one property migrations exist to have,
> that they replay cleanly from zero (`AGENTS.md` non-negotiable 2). A command run once by hand,
> recorded here, is the cheaper trade in both directions.

### 6.3 `EXPLAIN (ANALYZE, BUFFERS)` and `auto_explain` - why one query is slow

The counter says how MANY. This says why one of them is bad: a sequential scan where an index was
expected, a join blowing up, a sort spilling to disk. `auto_explain` logs the plan automatically
for anything over a threshold, so it catches the slow query nobody was watching for.

**Not yet needed here, and worth saying why.** No statement measured has been slow; the defect
was always their number. That changes the day the tables are large, and this is the tool for that
day rather than this one.

### 6.4 Query-count assertions in tests - built, and cheap to extend

`batch-reads.test.ts` now asserts that eight ids cost no more statements than one, read from the
same traced number the dashboard shows. **Both fixes in 2.16 were proved by putting the old loop
back and watching the test fail** - 35 against 7 for polls, 19 against 5 for pictures.

The pattern generalises to any route where cost should not scale with input, and it is the only
entry here that prevents a regression rather than reporting one after the fact. Cheapest next
step: extend it to the other list routes as they are touched.

### 6.5 Load and soak testing with realistic fixtures - the gap that let this survive

**This is the actual reason the N+1 lived so long.** Every test in this repo creates one or two
rows. The trace found the defects because a real account had 26 poll cards in one conversation;
no automated test has ever built a conversation like that.

A seeded "large" fixture - a club with hundreds of members, a chat with dozens of cards, a
gallery with fifty photos - run under `k6` or plain scripted load, would have made both N+1s
obvious without anybody watching. It is more work than everything above and it is the one that
finds this class *before* a person does.

> **Done on 2026-08-21**, and it found one on the day it existed: `/sync` costs two statements per
> channel, which is around 405 at the 200 the contract admits. `src/test/large-fixture.ts` builds
> it and `npm run load:test` drives the scripted load. Section 7 records what both measured.

### 6.6 RED metrics and histograms - Prometheus, or Fly's own

Rate, Errors, Duration per route, as **histograms rather than averages**. An average hides the
tail; p99 is where members actually live. Pairs with alerting: "p99 on `/sync` doubled" is a
statement a metric can make and a trace cannot.

Worth it once there are enough real members for a tail to exist. Not yet.

### 6.7 Continuous profiling - Pyroscope, or a hosted equivalent

CPU and heap by function, sampled continuously in production. Answers "what is this process
actually doing" when the answer is not the database at all - JSON serialisation, `sharp`, crypto
in the media signer. Nothing here has suggested a CPU problem, so this is the furthest away.

### 6.8 The client half - RUM, and what the dev trace already does better

Real User Monitoring reports what a real device experienced: time to first paint, request waterfalls
on real networks. For a mobile app this is Sentry's mobile SDK again.

Worth noting the dev trace already gives a **better** answer for development, because it joins
all three processes. What it cannot do is watch somebody else's phone in another country.

### Recommended order

1. **Turn on Sentry performance tracing** - already paid for, and it is the only production visibility.
2. **`pg_stat_statements`** - one statement per database, finds what nobody suspected.
3. **A large seeded fixture** - the thing that would have caught both N+1s automatically.

Everything after that waits for real load.

**Two and three are done, in development and now in production. One is still undone and is no
longer blocked.** Section 7 records what two and three measured on a laptop; section 8 records
what production has been able to say for itself since 2026-08-23.

---

## 7. Measured for real, 2026-08-21

**Everything above this line is a round-trip COUNT read from code, taken against a club of two
people, on a laptop with the database beside it.** This section is the first time any of it was
measured rather than counted, and it exists because a pilot club must not be the first real load
this system sees as well as the first measured one.
[The roadmap](20-road-to-the-first-club.md) milestone 3 is the spec; section 6's own recommended
order is what was executed.

### 7.1 What can now be measured, and with what

| Tool | Where | Answers |
|---|---|---|
| The per-request query counter | `dev/trace.ts`, since 2.15 | What did THIS request cost |
| A club-sized fixture | `src/test/large-fixture.ts` | The above, at a size a club reaches |
| Statement-count guards | `src/test/large-fixture-reads.test.ts` | Whether a cost scales with input |
| Plan assertions | `src/test/hot-path-plans.test.ts` | Whether one statement uses its index |
| `pg_stat_statements` | preloaded in `docker-compose.yml` and the test container, and installed on the production Neon database since 2026-08-23 | What the database spends its life on |
| The load test | `npm run load:test` | How fast, and how it behaves under contention |

**The fixture is 300 members, 20 polls with 3,600 votes, 20 events, 50 photos and 5,070 messages
in one channel.** Every one of those numbers is defended where it is declared: 300 is the largest
channel [Overview](00-overview.md) designs for, and 20 cards is just past the 26-poll conversation
the 2026-08-18 trace found on a real account. It is built through the real routes wherever the row
shape is subtle, so what it measures is a shape the application actually produces.

**What the fixture is not for.** A statement count answers "how many round trips"; it says nothing
about whether one of them uses the right index, and 5,000 rows is not enough for a planner to have
an opinion worth reading. That question belongs to `hot-path-plans.test.ts` at 20,000 rows per
table. Conflating the two is how `EXPLAIN` output from a 75-row table came to be presented as
evidence of a missing index during the 2026-08-19 review: below a few thousand rows Postgres scans
sequentially whether or not a usable index exists, so the plan proves nothing in either direction.

### 7.2 The counts, at club size

Statements per request, from the same traced number the dashboard shows.

| Route | 1 id | many, before | many, after | Verdict |
|---|---|---|---|---|
| `GET /polls?ids=` | 7 | 7 at 20 ids | 7 | Flat already. 2.16's fix holds at club size |
| `GET /media/urls?ids=` | 5 | 5 at 50 ids | 5 | Flat already. A fifty-photo gallery costs one read |
| `GET /events?ids=` | 4 | **23** at 20 ids | **4** | Was `3 + n`. Fixed 2026-08-21 |
| `GET /sync`, one channel | 7 | 7 from seq 0 over 5,000 messages | 7 | Flat in backlog, unchanged |
| `GET /sync`, per channel | 7 | **11, 15, 23** at 2, 3, 5 | **8, 9, 11** | Was `3 + 4n`, now `6 + n` |
| `subscribe` frame | 2 | **21** at 20 channels | **2** | Was `1 + n`, sequential. Fixed 2026-08-21 |

**Three of these were never measured before at all, and the second one was recorded wrong first.**

**`GET /events?ids=` was `3 + n`.** It looped `readEvent` once per id, precisely the shape 2.16
removed from `/polls`. `readEvents` is now the primary and `readEvent` delegates to it, the way
`readPolls`/`readPoll` already worked - so the single route and the batch cannot drift in cost or
in answer. The guard for it was written the day before, deliberately asserting the defect, so that
landing the fix had to come and invert it rather than leave a test that passed either way.

**`/sync` was `3 + 4n`, not the `5 + 2n` recorded here on 2026-08-20.** The first measurement is a
lesson in its own right: it synced one populated channel plus empty ones, and **an empty channel
skips the reaction and mention side loads entirely**. So it measured two statements per channel
where a channel a member actually reads costs four - the page, the authorization, and the two side
loads. A cold open is exactly the case where every channel has messages. The number to quote is
`3 + 4n`, and the fixture guard now seeds the extra channels rather than leaving them empty.

Three of those four are now paid once for the whole request: `authorizeChannels` fetches every
channel ref in one statement and applies `isChannelMember` per id in a loop, and `syncManySince`
pays the two side loads once across every channel in the response. **The page query stays one per
channel and that is deliberate.** Each channel has its own cursor, its own `LIMIT` and its own
`visibleToViewer` floor from that member's clears; collapsing them into a `LATERAL` over `unnest`
is possible and is a rewrite of the most correctness-critical read in the system, where being
subtly wrong means somebody sees a message they cleared or misses one they did not.

At the route's own 200-entry cap that is **803 statements down to 206**; at the 100 the real
client actually sends (`chat-client.ts`, `const BATCH = 100`) it is 403 down to 106. Worth stating
which limit is which, because the 2026-08-20 note conflated them: the 200 is hard-coded in the
`/sync` handler, and the `max(200)` in `packages/shared` is the gateway's `SubscribeFrame`.

**The gateway's `subscribe` frame was the same defect on a worse path**, and
[the roadmap](20-road-to-the-first-club.md) milestone 2 named it: "the connect path's per-channel
round trips". It awaited `getChannelRef` once per id **sequentially**, and the frame admits 200 -
so a client resubscribing after a reconnect serialized up to two hundred round trips inside one
frame, with that socket's queue holding everything behind it. The event that produces a great many
reconnects at once is a gateway restarting, so it was worst exactly when the system was already
unhappy. `getChannelRefs` serves both this and `/sync`; one function closed both.

### 7.3 The load test

`npm run load:test`. It starts its own Postgres, seeds, measures, and takes nothing shared - a load
test pointed at the development database would compete with the founder's phone for the same rows.
The two numbers are the ones [Build phases](16-build-phases.md) has named since the phase plan was
written, not two chosen here.

Ten times projected peak is **500 sends per second**, from
[Overview](00-overview.md)'s ~50 writes/sec. Two runs, on one laptop:

| | run 1 | run 2 |
|---|---|---|
| **`appendMessage` into ONE channel**, 2,000 sends, 20 concurrent | | |
| sustained throughput | 1,188 / sec | 1,143 / sec |
| p50 | 11.25 ms | 11.57 ms |
| p95 | 52.97 ms | 53.46 ms |
| p99 | 79.93 ms | 87.09 ms |
| gapless afterwards | yes | yes |
| **`loadAccessContext`**, busy account, 3,000 loads | | |
| sustained throughput | 12,105 / sec | 12,993 / sec |
| p50 | 1.40 ms | 1.30 ms |
| p99 | 5.27 ms | 5.42 ms |

**The row lock has 2.3x headroom, and the comparison is deliberately unfair to itself.** 1,143 per
second is what a SINGLE channel absorbs; 500 per second is the whole system's ten-times-peak write
rate. So the measured case is every send in the product landing in one conversation at once, which
is not a thing that happens - and it still clears the target twice over. `pg_stat_statements` puts
the cost where the design said it would be: `UPDATE channels SET last_seq = last_seq + 1` was the
top statement by total execution time at **30,170 ms across 2,000 calls, 15.085 ms mean**, against
239 ms for the next-largest statement in the same run - two orders of magnitude clear of
everything else. The wall clock for those 2,000 sends was 1.68 seconds, so that 15 ms mean is
almost entirely twenty senders waiting for each other rather than work being done. Which is what a
row lock is, and why it is the number to watch rather than a number to be alarmed by.

**Gaplessness held under 20-way contention**, which is the half a throughput figure cannot report.
2,000 sends produced 2,000 rows with 2,000 distinct seqs and a maximum of exactly 2,000. This is
the property that makes the lock worth its cost: a Postgres `SEQUENCE` would be faster and would
leak a gap on every rollback, and a phantom gap sends every client syncing forever after a hole
that does not exist.

**The access-context query is not a problem and now has a number saying so.** 26x headroom, p99
under 6 ms, for an account in 20 clubs, 5 eboards, 10 race rosters, 40 DM threads and 20 blocks -
a founder-shaped account rather than a typical one. Its nine-branch UNION was worth measuring
precisely because it is asked on every HTTP request and every socket handshake; the answer is that
it costs 0.08 ms mean and is nowhere near the top of anything.

### 7.4 What is still a laptop, and what is still not measured

**Said plainly, because a section headed "measured for real" that quietly leaves things out is
worse than no section.**

- **There is still no network boundary in any number above.** Postgres ran in a container beside
  the process. Production is Fly.io against Neon, where every round trip in section 7.2's counts
  gains real latency - which is exactly why those counts matter as much as these rates, and why
  `/sync` at 405 statements reads differently there than it does here.
- **Sentry performance tracing is still off** (`tracesSampleRate: 0` in `monitoring.ts`, and the
  same literal in the client's). Two things this bullet said on 2026-08-21 were wrong and are
  corrected in 6.1: it is a **code** change rather than a configuration one, and the thing it was
  blocked on - having anywhere to send a trace FROM - stopped being true on 2026-08-23. Section 8
  carries what that leaves unwatched.
- **Source maps and a symbolicated production error are three separate things**, not the one
  blocked row this bullet used to treat them as. [The roadmap](20-road-to-the-first-club.md)
  milestone 3 separates them and owns their standing.
- **The concurrent-connection half of ten-times-peak is not measured.** 30,000 sockets is a
  property of the gateway process and the host's file descriptors, not of these two queries, and a
  laptop reporting a number for it would be an invention wearing a number.
- **The iPhone is still barely measured** (3.6), unchanged.

Three of milestone 3's four exit criteria were met by the work in this section and the fourth was
not. **The standing itself is not restated here**, because it moved on 2026-08-23 and two
documents disagreeing about one milestone is exactly how one of them goes stale:
[the roadmap](20-road-to-the-first-club.md) milestone 3 owns it, criterion by criterion.

### 7.5 What measuring it found that counting it could not

**The fixture paid for itself the week it existed, and not in the way it was built for.** It was
built to catch a cost that scales with input, and it did - `/events` and `/sync` above. But two of
the four things it turned up are not costs at all:

- **A uuid has two spellings, and every batch read keyed a `Map` by one of them.** Postgres
  compares `id = 'D7E3...'` as a uuid and matches, then returns the row lower cased, so an upper
  case id was fetched, authorized and then silently dropped by a JS string comparison. Latent in
  `/polls` and `/media/urls` since they were written. The serious half is not the missing row:
  `AccessContext` keys `clearedFloors` the same way, so an upper case channel id read a cleared
  channel's floor as zero and handed back messages the member had cleared. `AGENTS.md` failure
  mode 36.
- **The correlation id on every frame was unbounded**, which quietly falsified the arithmetic
  choosing the gateway's 128 KiB frame ceiling: that constant's own comment says the largest frame
  the contract can produce is 56,075 bytes, and with an unbounded `id` the true answer was the
  whole 128 KiB. Capped at 128 characters, which is what makes the sentence true.

Neither is visible to a statement counter, a plan assertion or a load test. Both were found by an
adversarial review of the batching change - one agent proposing, another instructed to refuse it -
and the second one was found in code the change did not touch. The general lesson is the one
section 6 already states about instrumentation and is worth restating from the other end:
**measurement tells you what a system DID, and a reviewer told to disagree tells you what it will
do next.** The `/events` batching, written carefully and passing its own new guard, carried the
uuid regression into the gateway where no HTTP hook could have caught it.

---

## 8. What watches production, and what does not, 2026-08-23

**Section 7 measured a system nobody else could reach. This section is about the one real members
will.** The three roles first ran outside a laptop on 2026-08-23, which changes what can be
measured and, more usefully, changes what can be *missed*. It is deliberately thin on numbers and
thick on gaps, because after one day with four accounts the numbers are the least interesting thing
here.

Scope, so this does not grow into a second copy of two other files.
[Deployment](21-deployment.md) owns what is deployed and how it got there;
[the roadmap](20-road-to-the-first-club.md) owns which milestone each gap belongs to and the order
they get closed in. This section owns exactly one question: **if something broke right now, what
would say so.**

### 8.1 The first production numbers, and why four users is not a load test

Read off the running system on 2026-08-23:

| | |
|---|---|
| Database connections in use | **4**, against a ceiling of **450** |
| Database size | **11 MB** |
| Errors captured, across all three roles | **zero** |
| Outbox backlog | **zero unprocessed**, maximum `attempts` of **1** |
| `api /ready` from a laptop | **34 to 56 ms** wall clock, five samples |

**Every one of those is a healthy number and not one of them is evidence.** There are four accounts
on the system. The connection figure is under 1% of a ceiling nothing has approached, the 11 MB is
mostly schema, an outbox that never retried is an outbox nothing asked much of, and zero errors
across a quiet day is also what a dead system reports. Deploying did not retire section 7's caveat;
it added a second one alongside it. **Every load number this project has is still a laptop against
a database on the same machine, and every production number is a club of four people on one quiet
day.**

**The latency figure is worth reading as a method note rather than as a measurement, and it is the
argument for everything in 6.1 and 6.2.** `/ready` reaches Postgres; `/health` answers from process
memory and cannot fail. From this laptop the two are **indistinguishable** - both land between 34
and 58 ms, of which roughly 20 to 35 ms is the TLS handshake alone. So a wall-clock reading taken
from outside measures the network to `iad` and says nothing whatever about the round trip to Neon
that the endpoint exists to make. An earlier reading the same day put the same endpoint near 170 ms.
Both are honest readings of a laptop's network and neither is a reading of the server. **`curl`
cannot see inside the machine.** The two instruments that can are one `CREATE EXTENSION`, now run,
and two literals, not yet changed.

### 8.2 What is actually watching, role by role

| Role | Liveness | Errors reach | Note |
|---|---|---|---|
| `api` | Fly check on `/ready`, every 15s | Sentry, since `SENTRY_DSN` entered the `[env]` block on 2026-08-23 | The check gates traffic and deploy success |
| `gateway` | Fly check on `/ready`, every 15s | Sentry, same day | Same |
| `worker` | **Nothing**, by design: no ingress, so no endpoint to check | Sentry, same day | Its only boot signal is one log line |
| `cdn-worker` | Nothing | **Nothing.** Cloudflare's own logs only | An accepted gap, [ADR-0044](../decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md) and [Deployment](21-deployment.md) obligation 4 |

`initMonitoring` in `packages/server/src/monitoring.ts` is what puts a server failure through
Sentry, and the capture sites are already in the right places: a 5xx on the api, a **parked**
outbox event, a failed drain tick, a rejected socket frame, the rate limiter failing open. That
half is built and has been since 2026-08-03. Everything below is the half that is not.

### 8.3 The gaps, worst first

**1. Nothing turns a parked outbox event into a notification, and a parked event is the only
durable evidence an effect never ran.** First because of what missing it costs. An effect that
never runs is a notification nobody receives, a card that never appears, a photo that never reaches
a gallery - and the member's experience of it is not an error, it is silence.
`effect-coverage.test.ts` exists because three event types were parked for the entire life of the
Eboard space and nothing said so.

**The wiring here is better than "nothing is watching" and short of an alert.** `worker/drain.ts`
captures to Sentry at the park with `where: worker.outbox.parked`, deliberately at the eighth
attempt rather than on every retry, so a flaky push that succeeds on attempt two does not bury the
report that matters. What does not exist is the last hop: **no alert rule has been configured or
seen firing**, so whether a Sentry issue becomes something a human reads is unproved. The observable
symptom today is a member saying a photo never appeared.

Two shapes it does not cover at all, and they are the quiet ones. A parked event requires the drain
to have **run** and failed eight times, so **a worker that is wedged rather than failing produces no
parked events, because it attempts nothing** - and per 8.2 the worker is the one role with nothing
checking that it is alive. And a drain tick that fails every time is captured
(`worker.drain.tick`), but from outside it looks exactly like an empty outbox, which is what the
comment at that call site already says about itself.

**2. No real production error has ever reached Sentry.** Reporting is wired on all three roles as of
2026-08-23 and has never been exercised, so "errors reach a human" is a claim rather than a fact.
This project has already been wrong about exactly this shape twice in one week - the Resend domain
badge, read wrongly in both directions before a mail settled it, and `PLATFORM_MODERATORS`, where a
mistyped address produces the same successful import, the same healthy machine and the same
reassuring log line. One deliberately raised 5xx settles it in a minute, and until it is raised the
honest description is the one [Deployment](21-deployment.md) uses about the configuration: it reads
identically to a working one from every angle except the Sentry project itself.

**3. Performance tracing is off, so nothing records production latency at all.** Nothing per route,
nothing per query, nothing over time. 6.1 above, corrected: it is two literals and not a setting.
`pg_stat_statements` now answers the database's half of this question in production, which section 7
found to be the more useful half; the application's half has no answer of any kind.

**4. Nothing alerts on the api or the gateway being down.** Fly's check pulls an unhealthy machine
out of the proxy pool, and each role runs **one** machine, so "pulled from the pool" and "the role
is down" are the same event. Fly restarts a process that exits, which covers a crash and does not
cover a wedge - a process still answering `/health` from memory while `/ready` fails is depooled and
left running. Nothing external pings any hostname on any interval. An api that stopped answering
overnight reaches the founder when he next opens the app, or when a member tells him.

**5. Nothing pages on a CDN Worker exception.** Listed only so the table in 8.2 is not read as
coverage. It is an accepted gap recorded in ADR-0044 before the deployment and unchanged by it.
