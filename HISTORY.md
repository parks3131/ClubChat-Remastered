# History

How we got here, bug by bug. The specs stay summary-level because they load into context every
session; the long narrative lives here (`AGENTS.md` section 2.4.2).

Newest first.

> **Picking this up again?** Read [`SPEC/TECH/16-build-phases.md`](SPEC/TECH/16-build-phases.md)
> first - its "Where we are" table is the phase-by-phase state, and it names the two things this
> log will not tell you at a glance: most of the product has no user interface, and Phase 1.5 was
> skipped. Outstanding work and unproved verification live in
> [`SPEC/PRD/17-roadmap-and-open-questions.md`](SPEC/PRD/17-roadmap-and-open-questions.md).

---

## 2026-08-08 (last) - Giving the ban a surface, and a dead end it would have shipped with

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

### Verification worth noting

Type check clean, `check:runtime` 68 modules, no em dashes, full suite green at **805 server**, 27
shared, 67 mobile. Three new server tests cover what the two surfaces are told they may do,
including the case above.

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
