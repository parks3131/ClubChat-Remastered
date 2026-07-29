# ADR-0005: Do not implement end-to-end encryption

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

The reference architecture is end-to-end encrypted: the server cannot read message content, and
that is central to its design and its marketing.

ClubChat requires the opposite in several places that are not negotiable without removing
features. [Server event catalogue](../TECH/12-server-event-catalogue.md) requires the server to
compose system messages ("X was added by Y"), post poll, event and meeting cards into chat, and
render notification bodies. [Chat](../PRD/05-chat.md) requires reported messages to be readable
by admins in a Reports tab. [Direct messages](../PRD/14-direct-messages.md) requires reported DM
content to be readable by a platform moderator.

Every one of those needs server-side access to plaintext.

## Decision

We will encrypt in transit (TLS) and at rest, and we will not implement end-to-end encryption.

## Consequences

| | |
|---|---|
| Positive | The entire server-side event catalogue is possible. Moderation is possible, which matters for a product that will include minors. Multi-device works without key distribution, device verification, or the recovery problems that come with them. |
| Negative | **The service can read message content.** This is a real privacy cost, not a technicality. |
| Follow-up needed | **The Privacy Policy must state plainly that message content is readable by the service.** This is a release blocker, and it is easy to overlook because no code change forces it. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Full E2E encryption | Architecturally incompatible with the server event catalogue in its entirety, and with admin moderation. Adopting it would mean deleting features the product is built around, not merely working harder. |
| E2E for direct messages only, plaintext for group scopes | Superficially attractive, and wrong for the specific case that matters: a DM is exactly where moderation is most needed, since it is the only scope with no admin party to the conversation. It would encrypt the content a moderator must be able to review. |
| Client-side encryption with server-held keys | The security property of E2E is that the server cannot read the content. Holding the keys server-side gives the complexity without the property. |
