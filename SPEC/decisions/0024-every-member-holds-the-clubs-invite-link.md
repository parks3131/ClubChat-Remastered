# ADR-0024: Every member holds the club's invite link, and only an admin can rotate it

| | |
|---|---|
| Status | Accepted; narrowed the same day by [ADR-0025](0025-a-members-invite-link-obeys-the-join-policy.md), which makes a member's link obey the club's join policy. The Negative column below - a member handing out instant-join access to a `request` club - is what 0025 answers. |
| Date | 2026-08-12 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

[ADR-0010](0010-link-only-invites.md) made the share link the only way to be invited into a club:
there is no typed code and no code-entry screen anywhere in the product. That decision made the
link load-bearing, and it left an unexamined inheritance from the build before it - `readClub`
returned `inviteToken` only to the admin tier, so an ordinary member had no way to invite anybody.

The two facts together describe a club that can only grow through its admins. That is not how the
founding case grows: a member meets somebody at a race, on campus, at a club fair, and the moment
to bring them in is that one. Asking an admin to send a link later is the same access with a person
and a day in the middle of it, and in practice it means the member asks the admin to *paste them
the link*, which is the identical secret with an extra step.

The question was forced by building a share surface with a QR code on it, since the code is aimed
squarely at somebody standing in front of you, and a member is who is usually standing there.

## Decision

We will return the club's invite token to **every member** of the club, and keep rotation to the
**admin tier alone**. Nothing changes for a non-member: `readClub` refuses them outright, and the
club-search projection carries no trace of the token.

## Consequences

| | |
|---|---|
| Positive | A club grows the way it actually grows. One rule instead of two - "the token belongs to the club's members" is easier to hold than a tier split whose only effect was to route the same secret through a slower path. |
| Negative | Any of a club's members can hand out instant-join access, including to a `request`-policy club, where the link deliberately bypasses approval ([PRD/04](../PRD/04-clubs-and-membership.md) rule 5). The blast radius of a careless member is now the same as that of a careless admin. |
| Follow-up needed | None in code. The remedy for a leaked link was already built and is unchanged: rotation, which stays admin-only precisely because it invalidates every link **other members** have already sent. |

The asymmetry is the point, and it is the same shape as
[ADR-0021](0021-club-bans-are-harder-to-impose-than-to-lift.md): the action that widens access is
available to everybody it concerns, and the action that revokes other people's work is not.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep it admin-only | It does not withhold the secret, it delays it - a member who wants to invite somebody asks an admin, who pastes them the same string. A rule that is routed around rather than obeyed is not a boundary, and it costs the club the invitation that was going to happen at the moment somebody was interested. |
| Give members a *different*, weaker token (single-use, or expiring) | Two secrets for one door, which is exactly the shape ADR-0010 removed. It also needs a redemption ledger, a second refusal state, and an answer for what "this link was already used" means to somebody who did not know they were second. |
| Members share, and members may also rotate | Rotation is destructive to everybody else's outstanding links. Handing that to 300 people means one person's tidiness silently breaks every invitation in flight. |
| A per-club setting for who may invite | A configuration knob for a question that has one right answer in this product, and every club that gets it wrong finds out only when somebody could not be invited. |
