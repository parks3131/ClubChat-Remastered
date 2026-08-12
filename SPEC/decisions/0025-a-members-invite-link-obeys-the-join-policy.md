# ADR-0025: A club has two invite links, and a member's obeys the join policy

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-12 |
| Deciders | parks3131 |
| Supersedes | [ADR-0024](0024-every-member-holds-the-clubs-invite-link.md) in part - every member still holds a link, and what a member's link *does* is narrowed here |

## Context

[ADR-0024](0024-every-member-holds-the-clubs-invite-link.md) gave every member the club's invite
link, on the reasoning that a club grows by its members bringing people. It recorded the cost
honestly and then left it standing: *"Any of a club's members can hand out instant-join access,
including to a `request`-policy club, where the link deliberately bypasses approval."*

That is the cost the founder would not accept, and the objection is exact: **a `request` club has
chosen that an admin decides who gets in.** A member who can hand out a link that bypasses that has
been given the admin's authority by the back door - and the club has no way to notice, because a
link arriving is indistinguishable from a link an admin sent. "Members can then easily add"
describes the failure precisely: not that the member did something forbidden, but that the club's
own policy stopped meaning anything.

An `open` club has nothing to bypass, so nothing about it needs to change.

The mechanical difficulty is that **the link is a bare bearer string, and the server cannot see who
shared it.** One token cannot answer two questions.

## Decision

We will give each club **two invite tokens**. The admin link joins instantly, whatever the join
policy says. The member link obeys the policy: instant on an `open` club, a pending request on a
`request` one. `readClub` returns whichever belongs to the viewer's tier, so no screen chooses and
no member ever learns the admin string. Rotation replaces **both** at once.

## Consequences

| | |
|---|---|
| Positive | A `request` club's policy means what it says, from every direction into it. A member can still bring somebody - the invitation happens at the moment they meet, which is what ADR-0024 was for - and an admin still decides. The rule is one sentence in the product's own words: *your link does what you are allowed to do.* |
| Negative | Two secrets per club rather than one, and a bearer string is still a bearer string: an admin's link, once shared, keeps joining people instantly for anybody it is forwarded to. That is unchanged and unavoidable for any link-based invite. |
| Follow-up needed | None. The pending row an admin approves is the same one the search path files, through the same function, so nothing new appears in the roster. |

**One-way comparison, deliberately.** Redeem compares the token against the *admin* one and treats
everything else as the member case. A future third link is then a request by default: a capability
is granted by naming it, never by failing to match something else.

## Alternatives considered

| Alternative | Why not |
|---|---|
| One token, plus a signed marker of who shared it | A link gets pasted, forwarded, screenshotted and shortened. Anything travelling *beside* the token can be stripped or lost, and the safe fallback - treat a missing marker as a request - would then quietly break every legitimate admin link that lost its query string. Two opaque strings cannot be separated from their own meaning. |
| A member's link always files a request, in every club | Simpler to state, and wrong for an `open` club, where anybody can join by searching anyway. It would make the link *worse* than the public path it exists to shortcut. |
| Keep ADR-0024 as it stood | Leaves a member able to grant what only an admin may grant, in exactly the clubs that have said an admin must decide. |
| Let each club configure who may invite | A settings knob for a question with one right answer, and every club that gets it wrong finds out when somebody was let in who should not have been. |
