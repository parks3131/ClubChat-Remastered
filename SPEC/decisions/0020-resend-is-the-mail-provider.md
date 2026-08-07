# ADR-0020: Resend is the mail provider, called over `fetch` rather than its SDK

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-07 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

[ADR-0019](0019-outbound-mail-is-a-port-with-a-deferred-provider.md) made outbound mail a
`Mailer` port and deliberately left the provider unchosen, on the grounds that choosing one is a
DNS wait rather than a code change. It named the follow-up plainly: *pick the provider and verify
a sending domain*. That is now unblocked - `clubchatapp.com` was registered on 2026-08-07, and a
separate Resend account already holds a verified domain that the integration can be exercised
against today.

The shortlist was the one ADR-0019 drew up: Resend, Postmark, SES. Nothing has changed about the
code-level comparison - all three are one authenticated POST - so the decision rests on
deliverability, on what the free tier permits, and on how fast the thing can be proved to work.

Two facts about the tiers turned out to matter more than the marketing pages suggest.

**Postmark's free tier hard-stops at 100 emails per month with no overage.** For transactional
auth mail that is not a small budget, it is a cliff: the 101st password reset of the month does
not get sent, and the member is told to check their inbox anyway. Postmark also gates new
accounts behind a human approval step before they may send to arbitrary recipients.

**Resend's free tier is 3,000 per month but caps at 100 per day and one domain**, and the daily
cap is the one that bites a club: forty members signing up on the same evening is forty
verification mails in an hour. Its Pro tier ($20/mo) removes the daily cap, allows ten domains,
and prices overage at $0.90 per 1,000 rather than refusing the send.

## Decision

**Resend, called directly over `fetch`, with the sending identity in configuration rather than in
code.**

Concretely:

- `ResendMailer` in `packages/server/src/mail.ts` is the whole integration: `POST` to
  `https://api.resend.com/emails` with a bearer key, a JSON body of `from`/`to`/`subject`/`text`,
  and a 10-second abort. It joins `LoggingMailer` and `RecordingMailer` behind the same port;
  nothing that calls `send` changed.
- **No `resend` SDK.** The SDK's value is React Email templates and typed responses. This product
  sends one plain-text message and reads nothing back but the status, so the SDK would be a
  dependency to keep current in exchange for nothing. ADR-0019 already observed that every
  provider here is one function.
- `fetch` is injected into the constructor, defaulting to the global. That is what lets the
  request shape be asserted without a network, which matters more here than usual - see below.
- `RESEND_API_KEY` selects the transport and `MAIL_FROM` supplies the sending identity. Both are
  optional in `config.ts`, and **setting one without the other fails at startup**. A key with no
  From address would otherwise produce a send Resend rejects, an exception better-auth discards,
  and a member staring at an empty inbox.
- Keeping `MAIL_FROM` out of code is what makes the domain a runtime detail. The integration runs
  today against an already-verified domain and moves to `clubchatapp.com` by changing an
  environment variable, with no code change and no redeploy of a different build.

## Consequences

| | |
|---|---|
| Positive | Password reset works in production for the first time - the gap ADR-0019 recorded as its own headline negative is closed. The provider stayed a swap: one new class, two config fields, one branch in the entrypoint, and not one line changed in `auth.ts` or in any of the fifteen suites that build `createAuth`. Development still runs `LoggingMailer`, so the laptop flow is unchanged and needs no key. |
| Negative | **The free tier's 100-per-day cap is a real ceiling, and it is silent** - Resend refuses the send, the throw dies in better-auth's background task, and the member is told to check their inbox. `ResendMailer` surfaces the reason in the log line `auth.ts` writes, which is the only place it appears. Moving to Pro is the fix and it is a billing action, not a code one. The one-domain limit also means the account cannot hold `clubchatapp.com` alongside its existing verified domain until that upgrade. Choosing Resend over Postmark accepts marginally worse deliverability for a much better free tier and no approval wait; if inbox placement disappoints, the port makes reversing this cheap, though domain reputation would not transfer with the IPs. |
| Follow-up needed | Verify a `clubchatapp.com` sending subdomain and point `MAIL_FROM` at it. Publish SPF, DKIM and DMARC - Resend's verification requires the first two but **not** DMARC, which has to be added deliberately, starting at `p=none` with a `rua=` address. Bounce and complaint handling remains unaddressed, exactly as ADR-0019 left it: Resend has webhooks for both and nothing consumes them, so a hard bounce still means a reset link went nowhere and nothing in the product knows. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Postmark | The better deliverability reputation, and the stricter separation of transactional from bulk streams is genuinely the right model. Rejected on the free tier: 100 emails per *month* with no overage is a cliff rather than a budget, and it fails in the worst direction - silently, on auth mail. The new-account approval wait also means it cannot be smoke-tested the day you sign up. Worth revisiting if inbox placement ever disappoints. |
| SES | Cheapest at scale and already the infrastructure under Resend. Rejected for the same reason ADR-0019 gave: the sandbox refuses unverified recipients until a support request is approved, which is the most setup of the three for a product sending single-digit mails a day. |
| The `resend` SDK instead of `fetch` | Ergonomic if you want React Email or typed error unions. Here it would wrap one POST whose body has four fields, and add a dependency whose major versions must be tracked for a call that has not changed since the API was published. |
| A single `MAIL_FROM` baked in as a constant | Fewer moving parts, and it would have hard-coded a domain that is known to be temporary. The sending identity has to survive a domain change without a code change, because that change is already scheduled. |
| Wait for `clubchatapp.com` to be verified before wiring anything | The sequencing mistake ADR-0019 exists to avoid, in miniature. The DNS wait and the integration are independent, so running them in parallel means the transport is written and tested by the time the domain resolves. |
