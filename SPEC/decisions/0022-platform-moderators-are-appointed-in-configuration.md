# ADR-0022: Platform moderators are appointed in configuration, not from inside the app

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-11 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

[ADR-0009](0009-direct-messages-as-fourth-channel-scope.md) made a platform moderation queue a
condition of shipping direct messages, on the grounds that a private one-to-one channel with no
admin party to it and nowhere for a report to go is a materially different risk class in a product
that will include minors. Phase 3.5 built the queue; 2026-08-08 built its screens.

**Nothing ever built a way to appoint the moderator.** `users.is_platform_moderator` was read in
eight places and written in exactly one: a line of raw SQL inside a test file. In practice the flag
was set by hand against whichever database was in front of you, which has three problems and none
of them is tidiness.

- **It does not survive.** A `db:nuke`, a restore from backup, or a second environment starts with
  nobody holding it, and nothing anywhere says so. Reports are filed, the reporter is told they
  reached ClubChat moderators, and no human being can open them.
- **It has no inverse anybody remembers.** Removing a moderator means recalling that the flag
  exists and writing the opposite `UPDATE`.
- **It requires hand-editing production data**, which `AGENTS.md` non-negotiable 3 exists to
  discourage even against a development database.

Separately, [Apple's App Review guideline 1.2](https://developer.apple.com/app-store/review/guidelines/)
requires an app carrying user-generated content to act on objectionable-content reports **within 24
hours**. An unstaffed queue is not a slow response; it is no response, and it is a review blocker
rather than a nicety.

The question this raises is what kind of thing the capability is. Every other authority in the
product is earned inside it: you are an Owner because you created a club, an Eboard member because
somebody promoted you. `is_platform_moderator` is not like that, and the existing spec already says
so - it "is not a tier above Owner and confers no club, race or Eboard access at all".

## Decision

We will appoint platform moderators from a **`PLATFORM_MODERATORS` configuration value**, a
comma-separated list of email addresses, which the **API reconciles against
`users.is_platform_moderator` at boot**: named accounts are granted the flag, and accounts holding
it that are no longer named lose it.

**An empty or absent list never revokes anybody.** It logs a warning and changes nothing.

The database column stays and remains what every predicate reads. It becomes a cache of the
configured list rather than the original fact.

## Consequences

| | |
|---|---|
| Positive | The capability lives with the other facts about who runs the service - the mail transport, the proxy count, the media signer - and is held by the platform's secret store rather than typed into a database by hand. It is declarative, so it survives a restore, a nuke and a new environment without anybody remembering. Revoking is deleting a line rather than recalling an inverse command. The diff is a pure function, so the interesting half is tested without a database. And no operator ever runs SQL against production to change who moderates. |
| Negative | A boot-time write, which is a mildly surprising thing for an API process to do, and it means somebody named before they have signed up is not granted until the next restart. Configuration and data are coupled: the column is now derived, so editing it directly is overwritten on the next boot rather than respected. An address that matches no account grants nobody, which is why the reconcile names unmatched addresses in the log instead of passing silently. |
| Follow-up needed | The API is the only writer, deliberately; if the gateway or worker ever needs to grant this, that decision is revisited rather than copied. Nothing surfaces the audit trail of moderator actions in-app yet. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep setting the flag by hand in SQL | The status quo, and the defect. It does not survive a restore, has no inverse, leaves no record of who granted it, and means hand-editing production data to staff a safety function. |
| A management command - `npm run moderator:grant -- <email>` | Genuinely better than SQL and the pattern Django and Rails use, and it was the close second. Rejected because it is imperative: it grants once, and every environment reset silently loses it. The failure mode is an unstaffed queue that nothing reports, which is the exact thing being fixed. A declarative list is simply true again on the next boot. |
| The first account to sign up becomes a moderator | The self-hosted convention, and wrong for this product. The first account here is a club founder, not somebody who runs the service, and the two jobs are deliberately unrelated. It would also make the capability a race. |
| An existing moderator grants it in-app | Needs a seed moderator, so it does not remove the problem, it postpones it - and then adds a route, a screen, a predicate and its own audit trail to serve a team of one. It also makes the operator set changeable at runtime, which is what `canSuspendAccount` refusing to suspend a peer is currently protecting against. |
| A full admin console | Correct at a scale this product is nowhere near, and a large surface whose own authorization would need the same bootstrap question answered first. |
| Drop the queue and email DM reports to an operator instead | Simple, and it throws away the part worth keeping: the narrow, audit-logged context read. Metadata in an inbox with no bounded window and no log is a worse privacy posture than the queue, not a better one. |
| Let club admins read DM reports | Explicitly forbidden by [Direct messages](../PRD/14-direct-messages.md) rule 7. No club admin ever sees the contents of a DM, including between their own members. |
