# 35. A person is reported to platform moderators, and never to a club's admins

Date: 2026-08-15

## Status

Accepted. Extends the report routing in
[ADR-0009](0009-direct-messages-as-fourth-channel-scope.md) and
[ADR-0023](0023-a-moderator-may-remove-a-reported-message-and-suspend-an-account.md) to a second
noun, and does not change either.

## Context

Every report in the product is keyed by `message_id`. The `message_reports` primary key, the
per-space Reports tab, the platform DM queue, the audited context read, the removal and the
dismissal all resolve through one, and `moderation_actions` records the message that prompted an
action. That is deliberate and it works: a report points at evidence, and the evidence decides
who reviews it.

The [member card](../DESIGN/10-member-card.md) shipped on 2026-08-14 with Message, Remove and Ban,
and Report was agreed for the next pass. It has no message to point at. Somebody who wants to
report a person from a roster is not reporting a sentence; they are reporting an account, and
often they are reporting a pattern that no single message carries.

So the routing rule the product already has does not apply, because it routes by the reported
message's channel scope and there is no channel. The question is what replaces it.

Three facts constrain the answer:

- **[PRD/14](../PRD/14-direct-messages.md) rule 7 keeps a DM matter away from every club admin.**
  A card can be opened from a roster today and from a conversation later, and a rule that depends
  on which is a rule that changes what a report means depending on where the reporter was standing.
- **A club admin already holds the powers that answer a complaint about a member**: Remove and Ban
  are both on this card, both are theirs, and both are one tap away without any report at all.
- **A person report carries no evidence.** There is nothing to read, nothing to audit-log, and no
  window to open. Whoever receives it is being asked to weigh an accusation, not to judge a
  message.

## Decision

**A report about a person goes to platform moderators, always, and to nobody else.**

Concretely:

1. **One table, `user_reports`, shaped like `message_reports` one noun over.** The primary key is
   `(reporter_id, subject_id)`, which is the "reporting twice is a no-op" rule
   ([PRD/05](../PRD/05-chat.md) rule 10) expressed as data rather than as a check a handler could
   forget. Both columns are `NOT NULL`, so there is no NULL for Postgres to treat as distinct.
2. **No `club_id`, not even a nullable one.** `message_reports` routes on the reported message's
   channel scope; this has one destination, so a column that could only ever be null would be an
   invitation to route on it later.
3. **`canReadUserReports` is `isPlatformModerator` and has no scope switch**, unlike
   `canReadReports`. It is its own predicate rather than an alias, per
   [AGENTS.md](../../AGENTS.md) failure mode 10.
4. **Its own queue, beside the DM queue rather than merged into it.** The two lead somewhere
   different: one opens onto an audited window into a conversation, the other has no conversation
   to open. A single list would have to explain, per row, which of those it is.
5. **Grouped by the subject, and the reporter count is the evidence.** One person reporting
   somebody is an opinion; four is a pattern. Dismissal closes every open report about that
   person at once, because the decision is about the account.
6. **The notification names the reporter and never the subject.** `user_reported`'s params carry
   `actorName` and nothing else, so the rule is enforced by the schema rather than remembered by
   the writer. The row can reach a lock screen, and an accusation is not a thing to broadcast
   before anybody has looked at it.
7. **The reported member is never told**, which is [PRD/05](../PRD/05-chat.md) rule 10 and
   [PRD/14](../PRD/14-direct-messages.md) rule 7 unchanged.
8. **Reporting stays independent of blocking.** Blocking is the instant, self-service half of
   member safety and reporting is the reviewed half; a block in either direction does not close
   the reporting path, exactly as it does not for `canReportMessage`.

## Consequences

| | |
|---|---|
| Positive | One destination and one sentence to say about it, so the confirmation dialog can tell a member exactly who will see this and it stays true wherever the card was opened. A club officer cannot see, or act on, a report about one of their own members - which is what makes it safe to offer the control on a DM later. The moderator's existing tools already act on an account, so suspension and reinstatement needed no change at all. |
| Negative | **A club admin cannot act on a report about a member of their own club**, even though they hold Remove and Ban. That is the real cost of this decision and it is accepted rather than solved: the answer for a club matter is that those two controls are already on the same card, and a report is for what they do not cover. It also means every person report escalates to the platform, so the queue is only as useful as the number of people staffing it - which is a configuration list ([ADR-0022](0022-platform-moderators-are-appointed-in-configuration.md)) and not something the app can grow itself. |
| Follow-up needed | None for this pass. If the volume ever justifies it, the thing to add is a per-club queue **alongside** this one with its own predicate, not a `club_id` branch inside this one. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Route by where the card was opened**: a club roster to that club's admins, a DM to moderators | The exact mirror of how `message_reports` already routes, and the leading candidate. It fails on what the reporter is told: the confirmation has to say who will see this, and under this rule the answer changes depending on which screen they tapped from - so a member reporting the same person twice, once from each place, sends it to two different sets of people without being told that is what happened. It also puts a report filed about a private matter in front of a club officer as soon as the two people happen to share a roster. |
| **That club's admins only** | Keeps the routing rule the product already has ("a report goes to that space's admins") and needs no new reader. But the card is meant to grow a second entry point in a direct message, where there is no club to route to - so Report would have to be absent there, which is the one place a person report is most likely to be filed. |
| **Do not build it: make Report open the conversation and ask which message** | The position the DM profile screen took, and it is honest about the evidence problem. It cannot work from a roster, where there is nothing to point at - which is precisely where the card lives today. It also refuses the case the feature exists for, which is a pattern rather than a sentence. |
| **Attach the reporter's most recent message from that person as evidence** | Turns a person report back into a message report with an extra step, and picks the evidence on the reporter's behalf. The last thing somebody said is very often not the thing being complained about, and a queue that shows a moderator an innocent message beside a serious accusation is worse than showing them none. |
| **A free-text reason on the report** | [ADR-0021](0021-club-bans-are-harder-to-impose-than-to-lift.md) rejected prose in favour of evidence for the ban ladder, and the argument holds here with more force: there is no evidence to sit beside the prose, so the text would become the whole basis for suspending somebody. The reporter count is a weaker signal and a much harder one to abuse. |
| **Let a moderator read the pair's conversation from a person report** | It is the read the moderator most wants, and it is exactly the door [TECH/05](../TECH/05-authorization.md) refuses: the audited window resolves through `message_reports` so there is no way into a conversation nobody complained about. A person report would become that way in, with one tap and no message behind it. |
