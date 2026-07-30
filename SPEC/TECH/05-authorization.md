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
  dmThreads: Set<DmId>            // threads this user is a participant in
  blockedEither: Set<UserId>      // blocked BY me, or blocking me - symmetric on purpose
}

const isClubMember  = (ctx, club) => ctx.clubRole.has(club)
const isClubAdmin   = (ctx, club) => ['owner','admin'].includes(ctx.clubRole.get(club))
const isClubOwner   = (ctx, club) => ctx.clubRole.get(club) === 'owner'
const isRaceMember  = (ctx, race) => ctx.raceRoster.has(race)          // roster row ONLY
const isRaceManager = (ctx, race) => isClubAdmin(ctx, race.clubId)     // authority ≠ access
const canPostInRace = (ctx, race) => isRaceMember(ctx, race)
const canPinInRace  = (ctx, race) => isRaceMember(ctx, race) && isClubAdmin(ctx, race.clubId)
const isEboardMember= (ctx, eb)   => ctx.eboardMember.has(eb)
const canAccessPoll = (ctx, poll) => …scope switch…

// direct messages
const isDmParticipant = (ctx, dm) => ctx.dmThreads.has(dm)
const isBlocked       = (ctx, other) => ctx.blockedEither.has(other)
const sharesAClub     = (ctx, other) => …intersection of club membership…
const canOpenDm       = (ctx, other) => sharesAClub(ctx, other) && !isBlocked(ctx, other)
const canPostInDm     = (ctx, dm) => isDmParticipant(ctx, dm)
                                  && !isBlocked(ctx, dm.otherParticipant)
const isChannelAdmin  = (ctx, ch) => ch.scope === 'dm' ? false : …existing…
```

**`blockedEither` is deliberately symmetric.** A block is stored one-directionally
(`blocker → blocked`), but it is *evaluated* in both directions: neither party can message the
other, and neither appears in the other's DM-eligible search. A one-directional read would let
the blocked user keep opening the thread and sending into a void, which is worse than a clean
refusal for both.

**`isChannelAdmin` returning false for `dm` is the whole of the "one admin predicate" cost.**
Announcements, polls and admin-only pins fall out automatically, because every one of them is
already gated on that single predicate rather than on a per-scope branch.

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
isRaceManager  - may approve, add, remove, edit Meet Info, delete the race
isRaceMember   - may read/post chat, vote in race polls, be assigned to a car group
```

Nothing in the codebase is allowed to write `isClubAdmin(ctx, race.clubId)` where race *access*
is meant. Lint rule candidate; test coverage minimum.

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
