# ADR-0027: Managing a race requires a roster row

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-12 |
| Deciders | parks3131 |
| Supersedes | none - it reverses a rule that predates the ADR log, recorded in [Roles and permissions](../PRD/02-roles-and-permissions.md) rather than in a decision |

## Context

From v1 until today, a club admin held **management authority over every race in their club from
outside it**: approve and deny join requests, add and remove roster members, edit Meet Information,
create and fill car groups, edit the race's identity, delete it. What they did **not** get was
access - chat, polls and a seat in a car all needed a real roster row.

[Roles and permissions](../PRD/02-roles-and-permissions.md) called that split "the
most-misunderstood part of the model, and it is deliberate", and it was the most-cited rule in the
spec: `isRaceManager` versus `isRaceMember` were named differently precisely so the distinction
could not be collapsed by accident, and substituting one for the other was recorded as having been
wrong in five separate places in v1.

The rule existed to solve a real problem, and the problem was **not** "admins should run
everything". It was the opposite: auto-joining every admin to every race was built in v1 and
reversed, because an admin auto-added to thirty races drowns in chat for races they are not
running. Splitting authority from access was the way to keep an admin able to help without putting
them in every room.

Two things made the split worth re-examining.

**The permission was already wider than the notification.** A race join request is sent to the
admins **on that race's roster** and to nobody else - narrowed deliberately on 2026-08-05, because
an owner running none of the club's races was being paged about every one of them. So an off-roster
admin could approve a request that nothing had told them about, and the roster's own admins were
the only people who knew it existed. The two halves described different sets of people and one of
them was wrong.

**The founder's model of the product was the roster.** Asked to describe it plainly: an admin
outside a race can see it, read its Meet Information and ask to join, and *cannot change any
detail, manage the roster, or write in it*. Authority comes from being in the race.

## Decision

**A club admin manages a race when they are on its roster, and not otherwise.**
`isRaceManager` becomes `isRaceMember && isClubAdmin`.

Two capabilities stay with the club, because each is a **club** act rather than a race act:

- **Creating a race.** A race that does not exist has no roster to be on, so this cannot be
  expressed by the roster-gated predicate at all. It takes a club id and asks `isClubAdmin`.
- **Reading a race's roster.** An admin fielding "who is driving to Cougars" can answer without
  joining a race they are not going to. Seeing who is going is not authority over them. They do
  **not** see the pending queue, which is decision-making data.

**The Owner has no exemption.** Their route into a race is the one that already existed for the
roster with no admin left on it: they may walk onto any roster with no request
([Races and Meets](../PRD/09-races-and-meets.md) rule 3a), and are then an ordinary race member who
also runs the club.

## Consequences

| | |
|---|---|
| Positive | One rule where there were two, and it is the rule people already had in their heads: you run the races you are in. The permission and the notification audience finally describe the same people. `PRD/02`'s "where authority does not propagate" table loses its hardest row - authority now propagates nowhere, which is easier to hold than a boundary whose exact shape had to be memorised. The race and the Eboard stop disagreeing about authority, leaving one difference between them rather than two. |
| Negative | **A race whose roster loses its last admin is unmanaged**, and the only way back is the Owner walking onto it. That is a real gap in a club whose Owner is inactive - members can still request, and nobody will answer. It is accepted below rather than papered over. The v1 concern also returns in a smaller form: an admin who wants to help with a race must now join it, and joining means its chat. |
| Follow-up needed | **None. Closed the same day, and the client defect was the opposite of the one predicted here.** This row originally read that the app would offer manage controls that now answer 404. It did not: those controls are gated on `viewer.isManager`, which the server computes, so they hid themselves the moment the predicate changed. What broke was the **inverse** - the hub's only link to the roster lived *inside* that manage block, so roster-gating management hid a capability this ADR deliberately keeps, and the server went on granting a read nothing could reach. Fixed by making `canReadRoster` its own field on the race payload rather than something the client infers from `isManager`. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep the split as it was | It is defensible in the abstract and it is not what the product means. It also leaves the permission wider than the audience that pages people about it, so the person who could act was not the person who was told. |
| Roster-gate management, but let the **Owner** keep it from outside | Tempting, because it removes the unmanaged-race gap entirely at the cost of one exception. Rejected because it keeps the old model alive for one person: the spec would describe two rules, and "where authority stops" would still need its own section explaining whose authority. The Owner already has a route in that needs nobody's approval, so the capability is not lost, only made explicit. |
| Roster-gate management, but let the **Owner delete** a race from outside | The narrow version of the above, aimed only at cleaning up an abandoned race. Rejected on the same ground, and because deleting a race is the single most destructive act available in that space - if any capability should require being in the room, it is that one. |
| Fall back to the whole admin tier when a roster has **no admin on it** | Solves the unmanaged-race gap directly, and puts the hole exactly where the rule is most likely to be tested: the moment a race is unattended is the moment "who is allowed here" stops being answerable by looking at the roster. It also reintroduces the audience-versus-permission mismatch this decision closes. |
| Auto-join admins to every race, as v1 did | Already built, already reversed. An admin on thirty rosters drowns in chat for races they are not running, and that is the reason the authority/access split existed in the first place. |
| Require a roster row for **everything**, including creating a race and reading its roster | The strict reading, and it breaks creation outright: there is no roster to join on a race that does not exist. Reading the roster was kept on the founder's explicit call, and it discloses nothing an admin cannot already learn by asking. |
