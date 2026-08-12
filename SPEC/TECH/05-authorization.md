# Authorization

## Authorization

**This is the section that pays off the largest share of [Engineering pitfalls](14-engineering-pitfalls.md).**

### The guarantee is unchanged

> Every read and every write is access-checked on the server, not in the UI. Client-side gates
> are UX, never enforcement. A member who types a URL for a race chat, an Eboard poll, or
> another club's roster gets **nothing back**.

What changes is *where* it is enforced.

### One policy module

The predicate catalogue in the requirements below stops being row-level SQL policies and becomes pure
functions over a loaded access context:

```ts
// Loaded once per request. One query, not one per predicate.
type AccessContext = {
  userId: string
  clubRole: Map<ClubId, 'owner' | 'admin' | 'member'>
  raceRoster: Set<RaceId>
  eboardMember: Set<EboardId>
  // Per thread: the peer, and whether the pair still shares a club. NOT a bare Set - see below.
  dmThreads: Map<DmId, { otherUserId: UserId; sharesClub: boolean }>
  blockedEither: Set<UserId>      // blocked BY me, or blocking me - symmetric on purpose
  isPlatformModerator: boolean    // gates the DM report queue and nothing else
  signinBlocked: boolean          // account revoked; re-asked on EVERY request. See below
}

const isSessionUsable = (ctx) => !ctx.signinBlocked

const isClubMember  = (ctx, club) => ctx.clubRole.has(club)
const isClubAdmin   = (ctx, club) => ['owner','admin'].includes(ctx.clubRole.get(club))
const isClubOwner   = (ctx, club) => ctx.clubRole.get(club) === 'owner'
const isRaceMember  = (ctx, race) => ctx.raceRoster.has(race)          // roster row ONLY
// You run the races you are in. Was isClubAdmin alone until 2026-08-12; see below.
const isRaceManager = (ctx, race) => isRaceMember(ctx, race) && isClubAdmin(ctx, race.clubId)
const canCreateRace = (ctx, clubId) => isClubAdmin(ctx, clubId)        // a CLUB act, takes a club
const canPostInRace = (ctx, race) => isRaceMember(ctx, race)
const canPinInRace  = (ctx, race) => isRaceMember(ctx, race) && isClubAdmin(ctx, race.clubId)
const isEboardMember= (ctx, eb)   => ctx.eboardMember.has(eb)
const canAccessPoll = (ctx, poll) => …scope switch…

// direct messages
const isDmParticipant = (ctx, dm) => ctx.dmThreads.has(dm)
const isBlocked       = (ctx, other) => ctx.blockedEither.has(other)
const sharesAClub     = (ctx, other) => other.clubIds.some(c => ctx.clubRole.has(c))
const canOpenDm       = (ctx, other) => other.userId !== ctx.userId
                                     && sharesAClub(ctx, other) && !isBlocked(ctx, other.userId)
// Who may READ a profile card. Self, a clubmate, or somebody you already hold a thread with.
const canViewProfile  = (ctx, other) => other.userId === ctx.userId
                                     || sharesAClub(ctx, other)
                                     || dmThreadWith(ctx, other.userId) !== undefined
const canPostInDm     = (ctx, dm) => { const t = ctx.dmThreads.get(dm)
                                       return !!t && t.sharesClub && !isBlocked(ctx, t.otherUserId) }
const isChannelAdmin  = (ctx, ch) => ch.scope === 'dm' ? false : …existing…

// The two that could NOT be expressed through isChannelAdmin, plus the report reader.
const canPostInChannel = (ctx, ch) => isChannelMember(ctx, ch)
                                   && (ch.scope !== 'dm' || canPostInDm(ctx, ch.scopeId))
const canPinInChannel  = (ctx, ch) => ch.scope === 'dm'
                                    ? isDmParticipant(ctx, ch.scopeId) : isChannelAdmin(ctx, ch)
const canReadReports   = (ctx, ch) => ch.scope === 'dm'
                                    ? ctx.isPlatformModerator : isChannelAdmin(ctx, ch)

// Acting on a DM report - the two powers ADR-0023 adds. Both are the platform's rather than a
// participant's, and both are scoped to a message somebody actually reported.
const canRemoveReportedMessage = (ctx, ch) => ch.scope === 'dm' && ctx.isPlatformModerator
const canSuspendAccount   = (ctx, subject) => ctx.isPlatformModerator
                                           && subject.userId !== ctx.userId
                                           && subject.userId !== SYSTEM_ACTOR_ID
                                           && !subject.isPlatformModerator   // see below
                                           && !subject.isAnonymized
const canReinstateAccount = (ctx, subject) => ctx.isPlatformModerator
                                           && subject.userId !== SYSTEM_ACTOR_ID
                                           && !subject.isAnonymized
```

**Who holds `isPlatformModerator` is decided in configuration, not in the product.** The
`PLATFORM_MODERATORS` list is reconciled against the column when the API boots, so the flag is a
cache of an operator setting rather than something anybody earns by using ClubChat. An empty list
never revokes, because unstaffing the queue is the failure the whole subsystem exists to prevent.
See [ADR-0022](../decisions/0022-platform-moderators-are-appointed-in-configuration.md).

**Imposing follows a ladder and lifting does not**, which is
[ADR-0021](../decisions/0021-club-bans-are-harder-to-impose-than-to-lift.md)'s asymmetry one layer
up. Two of `canSuspendAccount`'s refusals are load-bearing rather than tidy: **the system actor**,
whose block is a security property (it authors every system message and nothing may ever
authenticate as it), and **another platform moderator**, because an operator who could shut off the
other operators could disable everybody able to reverse them. The operator set changes in
configuration and nowhere else.

**Sign-in itself is refused**, in a `session.create.before` database hook. That is not where it
would naturally go, and the position is the whole point: it runs **after** better-auth has verified
the password, so a caller who does not know the credential is told "invalid email or password" and
learns nothing - the form is not a suspension oracle. It refuses by throwing, so no session row is
created rather than one being cleaned up afterwards. And it reads `signin_blocked_at` from **our**
table rather than the adapter's user object, which returns only the columns declared in
`additionalFields` and would answer `undefined` forever (failure mode 12).

> Until 2026-08-11 there was no such hook and none of this was true: `/api/auth/sign-in/email` is
> better-auth's route and had never heard of the column, so a suspended account signed in normally,
> received a valid token, and met a 401 on every subsequent request.

**Suspension is not deletion**, and that is what makes it the right tool. It writes
`signin_blocked_at` and nothing else - no anonymisation, no dropped memberships - so ejecting a club
Owner leaves their club intact and breaches no invariant, and a wrong call is one action to undo.
Both halves of revocation are required: the column is what the next HTTP request and every
context-reloading gateway frame re-ask, and an `account.suspended` outbox event is what drops a
socket that is silently receiving and therefore re-asking nothing.

Every action is recorded in `moderation_actions` with the moderator, the subject and the report that
prompted it. There is deliberately no free-text reason.

**`canViewProfile` is the rule three documents asserted and no code enforced.** Added 2026-08-08,
by the security audit. `readProfile` took an access context and never consulted it, so **any
signed-in account could read any other account's name, bio, city, school and avatar** given only a
uuid - including an account that had just blocked them. ADR-0009 rejected global DMs partly because
they would "contradict the existing privacy rule that profiles are visible only to people who share
a club"; `sharesAClub` above says the same in its own comment; and
[Accounts and profile](../PRD/03-accounts-and-profile.md) lists public profiles as an explicitly
rejected alternative, because clubs are small and often include minors.

Two things about its shape are load-bearing:

- **The DM branch is not optional.** [Direct messages](../PRD/14-direct-messages.md) rule 3 keeps a
  thread's history readable after the pair's last shared club goes, and a name in readable history
  has to stay tappable. Gating on the shared club alone would 404 a card the product is still
  showing, which reads as a bug rather than as privacy. It is deliberately the same two-part shape
  as `canBlock`, because both answer "can these two reach each other at all" and the answer must not
  depend on which one is asking.
- **A block is deliberately NOT consulted.** Blocking stops messages and hides the pair from each
  other's search (rule 6); it does not erase somebody from a club they are both still in, where
  their name and face sit on every roster and beside every message they have sent. Withholding the
  card alone would conceal nothing and would break a roster the blocker can already see.

Note the shape of the gap, because it is the **inverse** of the alias trap in AGENTS.md failure
mode 10 rather than an instance of it. An alias hides a capability behind another one's name; here
the capability had **no predicate of any kind**, so an audit that counts predicates finds nothing
missing - the thing that was missing had never been spelled.

**`blockedEither` is deliberately symmetric.** A block is stored one-directionally
(`blocker → blocked`), but it is *evaluated* in both directions: neither party can message the
other, and neither appears in the other's DM-eligible search. A one-directional read would let
the blocked user keep opening the thread and sending into a void, which is worse than a clean
refusal for both.

**`dmThreads` is a Map rather than a Set, and `sharesClub` is resolved at load time.** Whether a
pair still shares a club is a join, and a predicate must stay a pure function. It is deliberately
not stored on the conversation, because a stored copy needs a job to maintain and is wrong between
runs ([ADR-0016](../decisions/0016-thread-writability-is-evaluated-never-stored.md)).

### The two predicates that were aliases, and had to stop being

> **Corrected 2026-07-30, while building Phase 3.5.** This section previously said
> `isChannelAdmin` returning false for `dm` was "the whole of the one admin predicate cost", and
> gave `canPostInDm` only participation and a block check. Both were wrong, and each would have
> shipped a defect.

**`canPostInChannel` was an alias of `isChannelMember`.** In club, race and Eboard chat, reading
and posting are one question with one answer. A DM makes them two: a participant loses the right
to send when blocked ([Direct messages](../PRD/14-direct-messages.md) rule 6) or when the pair's
last shared club goes (rule 3), and **both leave history fully readable**. Leaving posting aliased
to the read predicate would have let a blocked member send; taking membership away instead would
have hidden history the PRD requires to stay visible.

**`canPinInChannel` was an alias of `isChannelAdmin`.** [Direct messages](../PRD/14-direct-messages.md)
rule 4 says a DM has no admins *and* that either participant may pin an ordinary message for
reference. Both hold only because [Chat](../PRD/05-chat.md) rule 6 already separates a pin from an
announcement: what "no admins" removes is pinning-as-*authority*. Announcements stay gated on
`isChannelAdmin` and vanish from the scope; pinning does not.

**What `isChannelAdmin` returning false does still buy, for free:** announcements and poll
creation. Both were already gated on that one predicate and neither needed a scope branch, so that
half of the original claim held exactly as written.

The general lesson is worth keeping: **an alias is invisible until a scope needs the two sides to
differ.** [Domain model](../PRD/01-domain-model.md)'s abstraction test counts predicates whose
scope branch changes, and it cannot count a predicate that does not exist yet because it is
currently spelled as another one.

Properties that the old build could not have:

1. **`isClubAdmin` exists exactly once.** The "admin must also mean owner" bug ([Engineering pitfalls](14-engineering-pitfalls.md) 3,
   shipped **four** times, plus a fifth in a helper) becomes structurally impossible - there is
   one definition and one test for it.
2. **No recursion trap.** [Engineering pitfalls](14-engineering-pitfalls.md) 2 ("a read rule must never call a helper that re-queries
   the same table") was an artifact of policies evaluating inside queries. Functions over a
   pre-loaded context cannot recurse into a policy.
3. **No create-and-read-back trap.** [Engineering pitfalls](14-engineering-pitfalls.md) 1 - the repo's longest debugging session -
   disappears entirely. The handler authorized the write; it may obviously return what it wrote.
4. **Column-level authority is trivial.** [Engineering pitfalls](14-engineering-pitfalls.md) 4 needed a separate before-write trigger
   to stop a member pinning their own message and retro-flipping it into an announcement. Here
   it is an `if` in the update handler.
5. **The permission matrix becomes a test file.** [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) records that the matrix is
   "verified by hand" today. Every cell of the three matrices in [Roles and permissions](../PRD/02-roles-and-permissions.md) becomes a test
   case - a table-driven test asserting allow/deny for each (actor role, action, scope).

### Where authority stops - encoded, not remembered

The most-misunderstood rule in the product ([Roles and permissions](../PRD/02-roles-and-permissions.md): club admin → race chat) gets its own
named, documented predicates so the distinction cannot be accidentally collapsed:

```
isRaceMember      - a roster row. May read/post chat, vote in race polls, be in a car group
isRaceManager     - a roster row AND club admin. May approve, add, remove, edit Meet Info,
                    manage car groups, delete the race
canCreateRace     - club admin. Takes a CLUB id, because the race does not exist yet
canReadRaceRoster - a roster row OR club admin. Sees the members, never the pending queue
```

> **`isRaceManager` gained its `isRaceMember` term on 2026-08-12, and that inverted this whole
> section.** It used to be `isClubAdmin` alone, and this document's heading - "where authority
> stops" - described a boundary between *authority* and *access*: an admin ran every race in the
> club and could not read any of their chats. The rule is now simply **you run the races you are
> in**, so authority and access have the same gate and there is no boundary left to misplace.
>
> Nothing in the codebase may still write `isClubAdmin(ctx, race.clubId)` where a race capability
> is meant - the substitution that was wrong in five places in v1 is now wrong in a *second* way,
> because it no longer even grants management. The two places `isClubAdmin` is legitimately asked
> about a race are the two club acts: `canCreateRace` and the second arm of `canReadRaceRoster`.

`canReadRaceRoster` is the one race read an off-roster admin keeps, and **it is no longer the union
of its two neighbours**: writing it as `isRaceMember || isRaceManager` would silently delete it,
since the second term now implies the first. It has to spell `isClubAdmin` out. Its neighbour is the
counter-example worth keeping in view - the roster's **pending requests** go through
`canManageRace` instead, because who is waiting to be let in is decision-making data, and neither a
plain race member nor an off-roster admin has a decision to make.

`canPinInRace` now has a body identical to `isRaceManager` and keeps its own name regardless, per
failure mode 10: an alias is a claim that two capabilities will never diverge.

### Revocation is a per-request question

**Blocking an account does not invalidate a token it already holds.** So every entry point asks
`isSessionUsable`, and the answer is loaded from our own `users` row into the access context.

> That is a correction, not a description. Both sites previously read `signinBlockedAt` off
> better-auth's session user, which returns only the columns declared in its `additionalFields`
> and does not carry that one. The check therefore read `undefined` on every request and **never
> fired at all**, in both places, from Phase 0 until 2026-07-30. Never authorize against a field
> on a third-party object you did not put there; see AGENTS.md failure mode 12.

**"Every connection" was not enough, and this section said it was until 2026-08-08.** The HTTP hook
re-asks on every request; the gateway asked once, at the `auth` frame, and **a socket outlives that
answer indefinitely** because a client holds it open with heartbeat pings. The audit proved both
halves against a running server:

| | Before | Now |
|---|---|---|
| A shut-off account **sending** over its existing socket | `msg.ack`, and the row is in the channel log | `msg.err forbidden`, then the socket is closed |
| A self-deleted account **receiving** on its existing socket | Still delivered, in real time, indefinitely | Revoked before the next message |

So `isSessionUsable` is now asked on **every frame that reloads the access context** - `subscribe`
and `msg.send`, both of which already did the load - and not only at `auth`. The general rule: *a
revocation is only as good as its least frequent question.*

The receiving half needed something different, because a passive socket sends no frames and so
re-asks nothing. Its cause was a missing revocation: `deleteOwnAccount` dropped every membership row
in one transaction and **wrote no outbox event**, so nothing published. Every other removal path -
club departure, club deletion, race removal, Eboard demotion and Eboard departure - already
published one. Account lifecycle now emits `account.deleted` carrying the channel ids captured
before the delete, exactly as `club.deleted` does.

**Through the outbox rather than an immediate publish**, which is ADR-0006's argument rather than a
preference: the event commits in the same transaction as the deletion, so no crash can leave an
account deleted with its sockets still attached. An immediate Redis call has exactly that window.
The rejected alternative was publishing from the API, which is faster by one worker tick and loses
the guarantee that made the outbox worth having.

### Defense in depth

**Decided: deny-by-default at the role level, no per-row policies.**

Postgres RLS is not the enforcement layer any more. Concretely:

- The API connects as an application role. Every other role - including any future service,
  analytics job, or leaked credential - is denied by default at the grant level.
- **No per-row policies exist.** Enforcement lives in one layer, in one place, fully tested.

The rejected alternative was mirroring the app-layer predicates as RLS policies "for defence in
depth". That means two definitions of every rule that must be kept in sync - and drift between
two definitions of `isClubAdmin` is *literally how the original bugs happened*. A
half-maintained second enforcement layer is a liability, not a safety net.

The remaining backstop is the grant level, which needs no per-rule maintenance and therefore
cannot drift.

### Where a DM report goes

Every other scope answers "who sees a report?" with "that space's admins". A DM has none, so the
question needs its own answer rather than a fallback.

**Reports raised in a DM route to a platform moderation queue**, read by users carrying
`is_platform_moderator`. Mechanically it is the same `message_reports` row; only the *reader*
differs, selected by the reported message's channel scope:

| Channel scope | Report visible to |
|---|---|
| club / race / eboard | admins of that space, in the Highlights Reports tab |
| **dm** | **platform moderators, in a separate queue** |

Two rules that follow, and both matter for a product including minors:

1. **A platform moderator can read the reported message and its immediate context, and nothing
   else.** Moderation is not a licence to browse private conversations. The read is scoped to a
   window around the reported `seq` and is itself audit-logged.

   Built as **five messages either side**, in a `moderation_reads` table that records the window
   actually served rather than the one requested. Two consequences that fell out of implementing
   it, both worth stating because they are not obvious from the rule:

   - **The queue listing carries no message bodies.** If it did, either every refresh would have
     to write a log row per report, or content would be read with no log at all - the second
     silently defeats this rule and the first fills the log with noise. So the list is metadata
     (who reported what, and when) and the context read is the single logged door to content.
   - **There is no door at all without a report.** The context read resolves through
     `message_reports`, so a moderator cannot reach a conversation nobody complained about.
   - **The audit row and the read commit together.** A log written afterwards can be skipped by a
     failure between the two; one written beforehand records reads that never happened.

   In a group scope the same endpoint writes no log row, deliberately: an admin can already read
   every message in their own space by scrolling, so logging a read that conveys nothing new would
   only dilute the log that matters.
2. **[Chat](../PRD/05-chat.md) rule 10 - "reporting twice is a no-op" - still holds**, via the existing
   `UNIQUE (message_id, reporter_id)`. Nothing about the DM path relaxes it.

The blocking path is deliberately separate from the reporting path: **blocking is instant and
self-service, reporting is reviewed.** A member protecting themselves must never have to wait on
a moderator.

### Rate limiting

Requirement 12 below: token bucket, burst 30, refill 1/sec per sender, enforced before the insert.
Preserved, moved to the gateway (Redis `INCR` + TTL), and **extended to the endpoints the old
build left unthrottled**: reports, reactions, join requests, media presign requests.

**DMs need a second dimension the group scopes do not.** A per-sender bucket is sufficient in
club chat, where a spammer is visible to the whole club and removable by an admin. In DMs the
abuse pattern is one sender opening many threads, each individually under the per-sender limit.
So DMs additionally carry a **per-sender, per-new-conversation** limit: opening a thread with
someone who has never replied is throttled far harder than continuing an existing exchange.

> **Not built in Phase 3.5. Deferred to Phase 4 with every other rate limit**, and named here so
> it is not mistaken for done. What bounds the surface meanwhile is eligibility: a thread can only
> be opened with somebody the sender already shares a club with, so the reachable set is club
> membership rather than the user table, and blocking is instant and self-service.

**The per-IP bucket depends on `TRUST_PROXY`, and that is the only rate limit here which is a
security control rather than an abuse ceiling.** Sign-in and sign-up are keyed on `request.ip`
because there is no session yet to key on, so unlimited attempts is unlimited credential guessing.
`request.ip` is the socket's peer unless Fastify is told how many proxies sit in front - and behind
one without that, every caller on the internet shares the proxy's address and one bucket. It fails
closed rather than open, which is why nothing looked broken; it is also useless as protection,
which is why it was a finding.

Set to `false` by default, deliberately. The opposite mistake is worse: trusting `X-Forwarded-For`
on a process that is directly reachable lets any caller forge the header and take a fresh bucket
per request, which removes the limit rather than loosening it. `1` is the answer on Fly.io, where
the edge proxy is the only ingress.

### The content filter, and why it is not authorization

A second gate on the send path, and it answers a different question from everything above.
Authorization asks **who** is sending; this asks **what** is being sent. It lives in
`domain/content-filter.ts` as a pure function and is called from `sendMessage`, which is already
the single place the "may this person post this kind of message here" decision is made.

**Order: authorization first, filter second.** A member who may not post here is refused for that
reason and never learns anything about which of their words a filter dislikes. Reversing it would
leak a fact about the content rules to somebody with no standing in the channel.

**Before the append, so nothing is stored.** Guideline 1.2 asks for material to be filtered *from
being posted*, and a refusal after the insert would satisfy the sentence and not the requirement.
It also matters for the channel log: a refusal that had already allocated a `seq` would leave every
client's gap detection chasing a hole that will never be filled.

**No I/O, and that is a constraint rather than an accident.** The
[channel log](02-channel-log.md) invariant forbids I/O in the sequence-allocating transaction, and
the filter sits close enough to it that a network call here would serialize a channel behind a
round trip. It is a regex test over a string. This is the specific reason a language model cannot
be put on this path, whatever it costs.

Two verdicts, and the second is the one that keeps the first narrow. A refusal returns
`content_refused`, which is **terminal** - the client must not retry it, and the protocol note on
the code says why. A flag posts the message and files an ordinary report as the seeded system
actor, which is what lets the per-space Reports tab, the DM queue, dismissal, message removal and
suspension all work on it with no new reader. `fileReport` is the one mechanism both it and a
member's Report button go through.

See [ADR-0026](../decisions/0026-filter-hate-speech-not-profanity.md) for what the lists target,
what they knowingly do not catch, and why profanity is allowed.

### Club bans, and the one asymmetric authority

```ts
// Imposing follows the removal ladder. Lifting deliberately does not.
const canBanFromClub = (ctx, clubId, target) =>
  target.role !== 'owner' && target.userId !== ctx.userId &&
  (target.role === 'admin' ? isClubOwner(ctx, clubId) : isClubAdmin(ctx, clubId))
const canLiftClubBan  = isClubAdmin   // ANY admin, including one who did not impose it
const canReadClubBans = isClubAdmin
```

Every other authority in the product is symmetric. This one is not, and the asymmetry is the
safeguard rather than an oversight: a wrongful ban is the failure worth engineering against, so
reversing one must be cheaper than performing one. What makes it hold is that a rogue admin may
reach **Members only** - banning an Admin is the Owner's alone - so every other admin survives
anything they can do and any one of them can undo all of it.

`canLiftClubBan` and `canReadClubBans` are named rather than left as `isClubAdmin` at the call
site, per failure mode 10: "may impose" and "may lift" are two capabilities that are deliberately
different, and the difference is the entire point of the feature.

The ban check itself lives in `admit`, the one function every way into a club passes through -
open join, invite link, admin add, approved request - so it is one line rather than four places
that must remember. Asking to join does not pass through `admit`, so `fileJoinRequest` - the one
function every *request* passes through, since ADR-0025 gave it a second caller - carries its own.
See [ADR-0021](../decisions/0021-club-bans-are-harder-to-impose-than-to-lift.md).

### The two invite links

A club holds two tokens, and **which one is redeemed is an authorization decision made by the
string itself** ([ADR-0025](../decisions/0025-a-members-invite-link-obeys-the-join-policy.md)): the
admin token bypasses the join policy, the member token obeys it. Three properties keep that honest,
and each is the answer to a way it could rot.

- **`readClub` returns exactly one of them, chosen by tier.** Not both with a flag, and not the
  admin one hidden behind a client check - a field the client is trusted to ignore is a field that
  leaks the first time somebody logs a response.
- **The comparison is against the ADMIN token**, with everything else falling to the member case.
  A capability is granted by naming it; a future third link is therefore a request by default
  rather than an accidental bypass.
- **Rotation replaces both.** Whoever rotates cannot know which leaked, so replacing one would be
  the theatre that rotation exists to refuse.

Rotation itself stays admin-only through `canRotateInviteToken`, which is a distinct predicate from
"may share" for the reason failure mode 10 records: holding a link and being able to invalidate
everybody else's are two capabilities, and they now genuinely differ.

### Security headers

Set by one plugin on the whole instance rather than per route, for the structural reason the
session hook and the rate limiter are: a header applied route by route is a header the next route
forgets. **There were none at all until 2026-08-08** - no HSTS, no frame options, no
content-type-options, no CSP.

Three defaults are overridden, and each would otherwise be wrong here rather than merely strict:

| Setting | Why not the default |
|---|---|
| `Content-Security-Policy: default-src 'none'`, with `useDefaults: false` | This process serves JSON and one 302, never a document. Helmet's defaults merge in `script-src`, `style-src ... 'unsafe-inline'` and friends, which are not dangerous but describe a thing that does not exist. `frame-ancestors 'none'` is the directive doing real work |
| `X-Frame-Options: DENY` | Helmet defaults to `SAMEORIGIN`, which disagrees with `frame-ancestors 'none'` above. Two headers answering one question differently get resolved later by whichever a reader looks at first |
| `Cross-Origin-Resource-Policy: cross-origin` | The default is `same-origin`, and this API is deliberately read from another origin - the Expo web client on a different port in development and a different host in production. The default would refuse the browser while native kept working, which is a failure shape this project has shipped twice |

COEP stays off: it governs what a document may embed, and this serves none.

---

## Authorization requirements

The current build has **no application server**: the client talks to the database directly and
row-level security is the only access control that exists. A different architecture may put
this in a service layer instead. What must not change is the guarantee.

### The guarantee

> **Every read and every write is access-checked on the server, not in the UI.** Client-side
> gates (hidden buttons, `isAdmin` props) are UX, never enforcement. A member who types a URL
> for a race chat, an Eboard poll, or another club's roster gets **nothing back**.

### Rules that must hold in any architecture

1. **Every authorization check is centralised and reused, never re-derived inline per query.**
   The current build has a catalogue of membership/admin predicates (`is_club_member`,
   `is_club_admin`, `is_club_owner`, `is_channel_member`, `is_channel_admin`,
   `is_race_member`, `is_race_admin`, `is_eboard_member`, `can_access_poll`, plus poll
   creator/private/closed helpers). Whatever the stack, that list is the vocabulary.
2. **Multi-step flows are atomic and re-check authorization themselves.** Approving a join
   request updates the request **and** creates the membership row in one transaction, and
   re-checks the approver's authority in its own body.
3. **Decision endpoints are idempotent.** Two admins hitting Approve on the same request must
   produce one membership, one notification, and one recorded decider.
4. **A write that reads its own result back must also pass the read check.** If creating a row
   returns it, the read policy has to cover "I am the one who just created this," and that
   check should be bound to the row's own columns. *(current-stack detail: this exact trap
   produced this repo's longest debugging session, and creating a club is still only possible
   because the read rule includes an explicit "or I created it" clause.)*
5. **A read rule must never route through a helper that re-queries the same table by id.**
   Write the branch inline on the row's own columns.
6. **Column-level authority needs its own enforcement.** A rule that says "the sender or an
   admin may update this message" legitimately carries body edits and soft-deletes, so it
   cannot also gate the `pinned` and `message_type` columns. A separate before-write check
   rejects any change to those columns by a non-admin. **Without it, any member could pin
   their own message and retro-flip it into an announcement.** (This was a real, shipped
   defect, now closed.)
7. **Membership rows are the sole source of truth for access.** Never substitute an admin
   check for a roster row. This has been wrong in five separate places.
8. **The Owner role can only be written by the ownership-transfer path**, which **demotes the
   outgoing owner before promoting the new one** (the one-owner constraint is checked per
   statement, so the other order momentarily holds two owners and fails).
9. **Notifications have no client-writable path.**
10. **Cascade deletes must not be blocked by child-level permission rules.** Deleting a club
    really does remove the Owner's own membership row, even though nothing may delete it
    directly.
11. **Vote privacy is row-level; vote counts are not.** Counts must live somewhere every
    eligible viewer can read, because a rule that hides the voter rows also hides the count.
12. **Rate limiting belongs in the write path.** Message sends are throttled by a token bucket
    (burst 30, refill 1/sec per sender) enforced before the insert, returning a 429-equivalent.
    Still unthrottled: reports, reactions, join requests. Volumetric DDoS is deliberately out
    of scope for the application tier.
13. **Account deletion anonymises and blocks future sign-in.** Blocking a user does **not**
    invalidate an already-issued access token, so the client must sign out immediately after.

### New-surface checklist

For any new table/resource: enable enforcement → write the **read** rule first → write the
**create** rule so it implies the read rule → decide explicitly whether writes are
**any-admin** (news posts, races, routines, events, Meet Information) or **creator-only**
(meetings, polls) → **write the delete rule in the same change** (three tables shipped
without one) → prove the forbidden case is actually blocked by impersonating a
non-privileged user, not by reading the code.
