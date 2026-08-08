# ADR-0021: A club ban is harder to impose than to lift

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-08 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

**Removing somebody from an open club does not remove them.** `joinClub` admits straight into a
club whose policy is `open`, with no check of any kind against a prior removal, and there is no ban
concept anywhere in the schema. So an admin ejects a member, the member taps Join, and they are
back. Removal is a request to leave that the person may decline.

It is worse on a request-policy club than it looks, too: the member can re-request indefinitely,
and an admin has to keep noticing and denying. And [Link-only invites](0010-link-only-invites.md)
removed the typed code, so **the share link is the only invite mechanism there is** - a link
already sitting in somebody's messages keeps working, and the only current remedy is rotation,
which invalidates every outstanding link for everybody in order to exclude one person.

This matters more than an ordinary gap because of what the product is. Clubs are small, often
include minors, and the moderation story rests on an admin being able to end somebody's access to
a space. That story is currently false wherever the club is open to join.

The complication, raised as the reason to think rather than as an objection: a ban is the most
durable power an admin would hold, and the obvious design hands it to anybody with the admin role.
An admin acting in bad faith, or simply wrongly, could bar a member the club wants. So the
question is not only whether to have bans. It is what stops one.

Two patterns already in this codebase answer that, and neither is new:

- **Asymmetric authority.** `canRemoveMember` lets any admin remove a Member, restricts removing an
  Admin to the Owner, and forbids removing the Owner at all. `canRemoveFromEboard` is stricter
  still, because mutual removal between admins was rejected outright as a governance problem.
- **Narration as the check on an open power.** `canCancelMeeting` is deliberately open to every
  Eboard member rather than to the meeting's creator, and what makes that safe is that cancelling
  posts "X cancelled Y" into board chat. The act is visible and attributed, so the power does not
  need to be narrow.

## Decision

We will add **club bans**, on these terms.

**A ban implies removal.** Banning somebody who is currently a member removes them through the
existing membership cascade rather than a second one, so race rosters, car groups, Eboard
membership and the socket revocations all happen exactly as they already do. There is no window
between removing and barring for the person to rejoin through.

**It bars every way back in**: joining an open club, redeeming an invite link, and raising a join
request. It also refuses `addMemberDirectly` rather than silently lifting the ban, so an admin who
did not know surfaces the ban instead of overriding it by accident.

**Imposing follows the removal ladder. Lifting does not.**

| | Who |
|---|---|
| Ban a Member | Any admin |
| Ban an Admin | The Owner alone |
| Ban the Owner | Nobody, ever |
| **Lift any ban** | **Any admin** |

That asymmetry is the decision. Every other authority in this product is symmetric - whoever may
do a thing may undo it - and this one deliberately is not, because the two directions carry
opposite risk. A wrongful ban is the failure worth engineering against, so reversing one must be
cheaper than performing one.

**Every ban is attributed twice.** It appears on a ban list all admins can read, with who imposed
it and when - and club chat is told, in the same voice a removal already speaks in:
`"<name> was banned by <actor>"`, beside the existing `"<name> was removed by <actor>"`. This is the
`canCancelMeeting` argument applied to a much heavier power: the check on an open authority is that
using it is visible, not that the authority is narrow. Narrating it to the whole club rather than
only to the admin list is the stronger form, and it is what makes the next decision affordable.

**A ban carries no written reason.** Considered and rejected: an admin-visible free-text field is a
place to write something damaging about a member who can never see it or answer it, and under
pressure a required one degrades into "spam" anyway. What replaces it is the narration above -
accountability comes from the club seeing who did it, not from the banning admin's own account of
why. If a reason field is ever added it should be visible to the banned person too, which is a
different feature.

**The person is told plainly** when they try to return: they cannot rejoin this club. There is no
in-app appeal path, deliberately - see Consequences.

**At the moment of the ban they receive the existing removal notification, unchanged** -
`"<Admin> removed you from <Club>"` - rather than one naming the ban. Softer, and it keeps one
notification type where two would mean almost the same thing.

> **The cost, stated because it is a known shape rather than a hypothetical.** Club chat says
> "banned" and the subject is told "removed", so the person the act is about is the only one who
> does not learn it was a ban until a Join button refuses them. That is the same asymmetry found on
> 2026-08-05, where a race removal was narrated to the entire roster except its subject. It is
> accepted here deliberately - naming a ban in a push is confrontational and the door tells them
> soon enough - but it is the first thing to revisit if members report being confused about why
> they cannot rejoin.

**A club ban does nothing to direct messages.** Banning is an organisational act and blocking is a
personal one, and an admin may not make a personal decision on a member's behalf. Where the banned
club was the pair's last shared one, existing threads become read-only through
[ADR-0016](0016-thread-writability-is-evaluated-never-stored.md) with nothing added.

### Why the safeguard holds

Worth stating explicitly, because it is the argument the whole design rests on and it is not
obvious from the table.

**A rogue admin cannot disable the people who would reverse them.** They may ban Members only;
banning an Admin is the Owner's alone. So every other admin, and the Owner, survives any campaign a
rogue admin can mount, and each of them can lift every ban with one action. Maximum damage is a set
of wrongly excluded members, reversible by several people, with the rogue's name attached to each
one.

**At the Owner tier the question does not arise**, which is why no safeguard is proposed there. An
Owner can already delete the club outright, so a ban grants them nothing they did not have.

## Consequences

| | |
|---|---|
| Positive | Removal becomes durable, which is the property the moderation story already assumed. The invite link stops being an unrevocable key, without punishing every other holder by rotating it. The rogue-admin case is contained by construction rather than by policy, and every ban carries a name. Nothing new is needed for the cascade, the revocations or the DM interaction - all three are existing machinery. |
| Negative | One more table and one more state a member can be in, which every join path must now consult. A wrongly banned member has no in-app route back and depends on knowing somebody in the club, which is a real cost accepted below. Ban and removal become two similar-looking admin actions, and a UI that blurs them would make bans routine, which they must not be. |
| Follow-up needed | Behaviour rules into [Clubs and membership](../PRD/04-clubs-and-membership.md), a row into the [Roles and permissions](../PRD/02-roles-and-permissions.md) matrix, the table into [Data model](../TECH/09-data-model.md), and the three predicates into [Authorization](../TECH/05-authorization.md). None written yet: this ADR is Proposed. |

**On the missing appeal path.** Naming an appeal contact in the refusal was considered and rejected
for now: it hands a determined harasser a specific person to pursue, which is the exact population
the feature exists to exclude. The cost is that a wrongly banned member sees only a refusal. That
cost is bearable *because* of the lifting rule above - a wrongful ban is expected to be reversed by
another admin noticing it on the list, not by the excluded person arguing their way back. If that
turns out not to happen in practice, an appeal path is the first thing to add, and it is recorded
as an open question rather than designed now.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Do nothing; rely on removal | Removal is not durable in an open club, which is most of them. This is the status quo and it is the defect. |
| Make removal itself permanent, with no separate ban | Conflates "not in this club right now" with "may never return". A member who leaves of their own accord would be barred from coming back, and `canLeaveClub` is a normal, blameless act. Two different facts need two different rows. |
| The Owner alone may ban | The strictest option and the wrong shape for a safety tool: an active harasser cannot be stopped until the Owner is awake and online. It also makes the Owner a single point of failure in a product where many clubs will have an inactive one. |
| Any admin bans, the Owner alone lifts | Backwards, and tempting. It makes a wrongful ban cheap to inflict and expensive to reverse, which maximises exactly the harm the safeguard is for. The asymmetry has to point the other way. |
| Two admins must agree before a ban takes effect | Useless in a brand-new club, where the Owner is the only admin, and it puts a delay in front of the one action that has to be immediate. Confirmation is the wrong tool: the answer to a bad ban is cheap reversal, not slow imposition. |
| Rotate the invite token instead of banning | Invalidates every outstanding link to exclude one person, and does nothing at all about a club whose policy is `open`. It is the remedy for a *leaked* link, not for a person. |
| A ban also blocks the person in DMs, for the banning admin or for everybody | Severs conversations on behalf of members who never asked and have no complaint. An admin who wants a personal block already has one, in one tap, as themselves. |
| A written reason on each ban, admin-visible | A field one admin fills in about a member who can never read it or answer it, and a required one degrades to "spam" under any pressure. The narration into club chat carries the accountability instead, and carries it further. |
| Narrate the ban only on the admin ban list, not in club chat | Halves the safeguard to keep the act quiet. Members notice somebody has gone regardless, and an admin tier policing itself in private is exactly the arrangement `canCancelMeeting` decided against. |
| Ban silently, so the club looks not to exist | A lie the person sees through the moment a friend opens the same link, and it produces a member tapping Join repeatedly at what looks like a broken app. Personal blocking is quiet because it is personal; an organisation excluding somebody is an administrative act and can say so. |

## Note

The shared rule with `canCancelMeeting`, worth naming because this is the second time it has
decided a design here: **an open power is made safe by being visible, not by being rare.** The
instinct with a heavy authority is to restrict who holds it, and that fails in the case that
matters - the Owner is asleep and a member is being harassed now. Attribution scales where scarcity
does not.
