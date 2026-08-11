# ADR-0023: A platform moderator may remove a reported message and suspend an account

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-11 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

The direct-message report queue could be read and dismissed, and that was all. A moderator who
opened a genuinely abusive conversation had exactly two options: mark the report reviewed, or leave
it. Neither does anything to the message or to the person.

That was not an oversight so much as a boundary nobody had had cause to cross.
[Direct messages](../PRD/14-direct-messages.md) is explicit that **nobody deletes anybody else's
message in a DM** - moderation there "is blocking plus reporting, not deletion" - and
`dismissReport` says so in its own comment. And ejection had no mechanism at all:
`users.signin_blocked_at` existed, was respected by every entry point, and was written in exactly
one place in the entire codebase, `deleteOwnAccount`.

[Apple's App Review guideline 1.2](https://developer.apple.com/app-store/review/guidelines/) does
not leave room for that. An app carrying user-generated content must *"act on objectionable content
reports within 24 hours by removing the content and ejecting the user who provided the offending
content."* ClubChat could do neither, in the one scope with no admin to do it instead.

Two things made the decision harder than "add two buttons".

**The DM rule is real, not incidental.** It exists because a participant with deletion power over
the other's messages could rewrite a conversation they are party to. Relaxing it for participants
would be a genuine harm.

**Ejection has an obvious wrong implementation.** Deleting the account would breach domain invariant
1 the moment the person owns a club - an ownerless club has no recovery path - and it is
irreversible, which is the wrong shape for a judgement made in a hurry by one person.

## Decision

We will give a platform moderator exactly two new powers, both scoped as narrowly as the guideline
allows.

**Removing a reported message.** Addressed by the **report**, resolved through `message_reports`, so
there is no door to a conversation nobody complained about. `dm` scope only, because in every other
scope that space's own admins already hold the power and a platform moderator has no standing.
A soft delete with a tombstone like every other delete in the product, clearing reactions and pin
state, advancing the channel revision so an offline client learns.

**Suspending an account, reversibly.** Sets the same `signin_blocked_at` every entry point already
re-asks about, deletes the sessions, and publishes a revocation through the outbox so live sockets
drop. It deliberately **does not anonymise**: the profile, the memberships, the messages and any
Owner row survive untouched.

Imposing follows a ladder and lifting does not, which is
[ADR-0021](0021-club-bans-are-harder-to-impose-than-to-lift.md)'s asymmetry applied one layer up.
A moderator may not suspend themselves, another platform moderator, or the system actor. **Any**
moderator may lift any suspension.

Every action is recorded in `moderation_actions` with the moderator, the subject and the report that
prompted it. **There is no free-text reason**, for ADR-0021's argument: a note about somebody who
can never read it or answer it is a place to write something damaging, and the report it is tied to
is better evidence than prose.

## Consequences

| | |
|---|---|
| Positive | The queue becomes a place where something happens, which is what the report button has been promising members since Phase 3.5. Guideline 1.2's operative sentence becomes true, so the App Store submission stops depending on a reviewer not asking. Suspension is the *right* tool rather than a blunt one - because it does not delete, ejecting a club Owner damages no club and breaches no invariant, and a wrong call is one tap to reverse. Revocation reuses machinery already proved on 2026-08-08 rather than inventing a second path. |
| Negative | **A platform moderator can now delete a message in a conversation they are not part of**, which is a real power that did not exist yesterday, and the only protection against its misuse is that the operator set is small, configured rather than earned (ADR-0022), and every use is recorded. The subject of a suspension is not told why, and there is no appeal path - the same cost ADR-0021 accepted for bans, and the first thing to revisit if it bites. A suspended club Owner leaves their club with an Owner who cannot act; that is better than the alternatives but it is not nothing. |
| Follow-up needed | Nothing surfaces `moderation_actions` in-app, so the audit trail is queryable and not readable. Guideline 1.2's fourth requirement - a method for **filtering** objectionable material before it is posted - remains unbuilt and is deliberately not addressed here, because it is a product decision rather than a moderation one. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Leave it at dismiss, and rely on blocking | The status quo. Blocking is the member's own remedy and it is excellent, but it is per-person: it does nothing about somebody working through a club's roster, and it is not what the guideline asks for. A queue whose only verb is "reviewed" is a queue that watches. |
| Let the moderator delete the account instead of suspending it | Irreversible, breaches domain invariant 1 whenever the person owns a club, and destroys content the other participant is entitled to keep. Deletion is a thing an account does to itself. |
| Hard-delete the reported message | Contradicts domain invariant 7 and makes the surrounding replies unreadable, which is the reason every other delete in the product is a tombstone. It would also destroy the evidence the report is about. |
| Let the participants delete each other's messages in a DM | The rule `PRD/14` states, and it is right: a participant with that power can rewrite a conversation they are in. The platform power is deliberately not that power, and the matrix is unchanged for participants. |
| Let club admins act on DM reports | `PRD/14` rule 7 forbids a club admin from seeing DM contents at all, including their own members'. |
| Allow a moderator to suspend another moderator | Would let one operator disable everybody able to reverse them, which is precisely what ADR-0021's ladder exists to prevent. The operator set is changed in configuration and nowhere else. |
| A written reason on each action | Rejected for the same reasons as ADR-0021: unanswerable by its subject, and degrades to one word under pressure. The report that prompted the action carries more. |
| Notify the subject that they were suspended | They cannot sign in to read an inbox row, and naming it in a push is the confrontational shape ADR-0021 already rejected. The door tells them. |
| Auto-suspend on N reports | Abusable by a small group of reporters in a small trusted community - the same objection that already rejected auto-hiding reported messages - and it would make the 24-hour human review theatre. |
