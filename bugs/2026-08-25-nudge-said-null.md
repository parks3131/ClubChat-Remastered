# A nudge told a club "18:00 at null"

**2026-08-25** · Fixed in `ab80e02`, deployed same day · [ADR-0049](../SPEC/decisions/0049-a-meetup-says-where-with-a-link-and-nothing-else.md)

## What was seen

A notification on the founder's phone, five minutes after tapping Nudge:

```
Parks RPK nudged: 18:00 at null
```

Every field the composer offers had been filled in: a title ("Welcome Owen"), a date and time, a
pasted Google Maps link, location notes ("Owen runs around the box"), and a description.

## What it actually was

`meetups.location` was `NULL`, and the notification read it.

That column stopped being collected on 2026-08-15, when
[ADR-0037](../SPEC/decisions/0037-a-meetup-carries-a-name-and-a-pasted-map-link.md) replaced the
required free-text place with a name, a pasted map link and location notes. The column stayed,
nullable and unread.

Nudge shipped on **2026-08-14**, one day earlier, reading `meetup.location` into its notification
params. Nobody moved it when the ground shifted the next day.

The worker wraps every param in `String(...)`. **`String(null)` is the four-character text
`"null"`** - a perfectly valid string, so the Zod schema requiring `location: z.string()` accepted
it, the row stored it, and `renderNotification` printed it to the whole club.

### Three readers survived ADR-0037; only one broke

| Reader | Guard | Outcome |
|---|---|---|
| Meetup detail screen | `DetailLine` omits an empty row | The "Where" line silently vanished |
| `meetupHeadline` | `?.trim() ?? 'Meetup'` | Fell back cleanly |
| **The nudge** | none | Pushed `"null"` to every member |

The one without a guard is the only one that speaks to everybody at once.

## What went wrong while fixing it

**The first diagnosis was wrong, and it blamed the person holding the evidence.** Having found a
null, I reached for the cheapest explanation - "you left the place blank" - and wrote it up as a
finding. It was a guess. The form has no place field at all, so it was never possible.

The proof was already in the screenshots I had been given. The detail screen listed Description,
Who and Location notes and had **no "Where" row**, and the code that draws those rows hides empty
ones, with a comment saying so directly above the line. The absent row *was* the null. The
database was never needed.

**The second wrong claim was the same mistake repeated.** I reported that the short-link resolver
"was never built", having grepped for `resolveMapLink` - a name that appears only in a stale
comment. The real function is `resolveMapPoint`, it lives in `maps.ts`, and it is careful work:
host allowlist re-checked at every hop, five-hop limit, three-second timeout. The comment was
stale; the code was fine.

**A second finding, on the way.** `map_lat` / `map_lng` are `NULL` on every meetup any phone has
ever created - not through failure, but because a Google "share a place" link resolves to a place
name and a feature id, never to a point. ADR-0037 kept the pair so an embedded map could return
without a migration. It was reserving space nothing could ever fill.

**A file had to change for reasons unrelated to the bug.** `calendar.ts` selected
`COALESCE(NULLIF(mu.title,''), mu.location)`. Dropping the column turned **every `/calendar`
request into a 500** - 29 test failures - until it read `mu.title` alone. Worth knowing before
starting: dropping a column is never local to the feature that owns it.

**The test that should have caught this passed the whole time.** `notifications.test.ts` asserts
that no rendered body contains `"undefined"`. It passed on 2026-08-14 and every day after, because
the fixture supplied a place that production no longer had, and because the missing value arrived
through `String(null)` rather than as an absent key. It now refuses `"null"` as well.

**The migration broke a rule the repo had already written down.**
[`SPEC/TECH/21`](../SPEC/TECH/21-deployment.md) rule 4: *"Add columns. Never rename or drop one in
the same release as the code that stops using it. Expand, migrate, contract: three releases weeks
apart, not one."* Migration 0041 drops `location`, `map_lat` and `map_lng` in the same release as
the code that stopped reading them. I wrote it without opening that file.

Nobody caught it until a **peer session hit it at deploy time** and stopped to ask. The cost, had
it gone out unexamined: Fly runs `release_command` before swapping machines, so between the
migration applying and the new image serving, the old code queries columns that no longer exist.
That window covers `/calendar`, `GET /meetups/:id`, the meetup week read, and meetup create and
edit - the whole surface, reads and writes, not one endpoint.

**Shipped anyway, deliberately - and the reasoning was sound for the risk we had named.** One test
meetup, no club onboarded, the founder watching the rollout. Splitting the migration would not have
delivered the nudge fix any sooner, because that fix is code-only and the column drop is tidy-up.

We had named the wrong risk.

**The drop crashed the app on the founder's phone, minutes after the deploy.** Not in the sixty
second window both sessions were watching. The api was never wrong - `GET /meetups/:id` answered
200 in 27ms - and then the installed build stopped making requests at all, because it had thrown.

The read stopped returning the `location` **key**, not just its value, and to a build that already
exists **absent is not null**:

```js
// DetailLine, in the shipped binary
if ((value === null || value.trim().length === 0) && placeholder === undefined) return null;
```

`||` short-circuits. For `undefined`, `value === null` is false, so it evaluates `value.trim()` and
throws. The guard handles null and only null. A second one was latent and would have surfaced next
week looking like a fresh bug: `directionsUrl` guards `point !== null` then reads `point.lat`, so
an absent `mapPoint` throws the same way - but only on a meetup with **no** map link, because a
link returns one line earlier.

Both keys are back on `readMeetup` as always-null compatibility keys; the columns stay dropped. The
removal condition is written at the return site rather than remembered, because it is a fact about
which builds are installed on phones, not a fact about this repo. Nobody can query it today; once
`expo-updates` ships, it becomes checkable and these shims become deletable.

**`readMeetup` was the only unsafe surface, and the reason is the guard style rather than the
screen.** The week read omits both keys too and is fine, because its two touches are
`carried?.location ?? null` and `meetup.location?.trim() ?? 'Meetup'` - optional chaining, safe on
absent. `readMeetup` was the one place the value reached a `=== null` test standing in front of a
method call. When hunting for this class of break, look for the guards, not for the screens.

**And a name-based search would have found only half of it.** `location` is one column producing
one identically-named field, so grepping the app for it lands on the call site. `mapPoint` is
`toPoint(row.map_lat, row.map_lng)` - two columns feeding one differently-named key, and the
migration never says the word `mapPoint`. Grepping the shipped build for `map_lat`, `map_lng`,
`mapLat` and `mapLng` finds only the optional create-input fields, which are only ever sent, so the
honest conclusion is "nothing shipped reads these". The migration checklist now asks what a column
*feeds* before it asks what reads it, because the grep that would have found this is the one nobody
ran.

**This was the third rule in the same file, one level above where either session looked.** TECH/21
rule 4 is about the deploy window; **rule 5 - "a response may gain a field, it may never lose one"**
is the one that mattered, and it does not close on its own the way a rollout does.

**And I had explicitly checked this and got it wrong.** Before the deploy I reported that the old
binary would "degrade gracefully", because `DetailLine` "hides empty rows". I had read the comment
above the call site. I had never opened `DetailLine`. That is the fourth time in one session that a
comment was treated as the implementation - after blaming the founder for a field the form does not
have, after reporting a resolver "never built" that exists under another name, and after writing
"deployed" into a commit message on the strength of a message pasted into a different session's
dialog. **It is the first one that reached a real person's phone**, and the difference between the
first three and this one is only luck about which surface the mistake landed on.

**A second Fly app had to go out in the same window.** The worker is deployed separately and has
no `release_command`. Old worker code reads `event.payload['location']`; the new API writes
`title`. Deploying the API alone would have produced "nudged the club about **undefined**" - the
same bug in a new costume. The deploy dialog that caught rule 4 did not mention the worker at all.

**Two mistakes on a shared machine.** Started an API on port 3000 - the founder's port - which
failed with `EADDRINUSE` and went unread, so the surface gate unknowingly ran against his already
running instance. Then killed processes with `pgrep -f`, which took his dev API down with mine. Use
the agent ports, and kill by port PID.

## The fix

The nudge reads `title`, which is `NOT NULL`:

```
Binghamton Running Club
Parks RPK nudged the club about Welcome Owen, today at 18:00
```

`location`, `map_lat` and `map_lng` were dropped along with their two constraints, `maps.ts`, and
the parsing half of `map-link.ts`. `isMapLink` and its host allowlist stay - that one is a security
control, because a stored link becomes a Directions button every member taps.

"today" is true when the nudge is sent, which is where it is read, and ages in the Notifications
tab afterwards; the relative timestamp beside each row carries the correction. Naming the date is
not available, because `renderNotification` is pure and locale-free by design.

## The rule this leaves behind

**A field the form does not collect is a field the row must not have.** A column kept "in case" is
a column every future reader has to make a judgement about, and one of them will judge wrong
without anything failing.

**A null is a question, not an answer.** An empty field has two opposite causes - nobody typed
anything, or nobody *can* type anything any more. Telling them apart costs thirty seconds: look at
the form. If the field is not on it, "why is this empty" was never the question.
