# ADR-0019: Outbound mail is a port, and the provider behind it is chosen later

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-06 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

Password reset is the first thing this product has ever needed to send an email for. Until now
there was no mail anywhere: no dependency, no API key, no sender address, no code path. `TECH/15`
and `ADR-0011` both name it as work we own - "self-hosting auth means owning password reset and
email deliverability" - and neither picked a provider, because until there was something to send
there was nothing to decide between.

Two facts shaped this, and they pull in opposite directions.

**Choosing a provider is not a code change, it is a DNS change.** Resend, Postmark and SES all
want a verified sending domain with SPF, DKIM and DMARC records published, and that verification
is measured in hours. SES adds a sandbox that refuses unverified recipients until a separate
support request is approved. None of that is work you can finish in an afternoon, and all of it
is work about a domain this project does not yet have in production.

**Every one of them is one function.** `send(to, subject, body)` over HTTPS with an API key. The
part that differs between providers is the part that never appears in a caller: retries,
suppression lists, bounce webhooks, and the shape of the error when a send fails.

Waiting for the first would have blocked a feature that is otherwise complete. Skipping the
question and calling a provider SDK directly from `sendResetPassword` would have made the reset
flow untestable - fifteen test files construct `createAuth(...)`, and none of them may send mail.

## Decision

**Outbound mail is a `Mailer` port with two implementations in the tree, and the production
transport is added when there is a domain to send from.**

Concretely:

- `packages/server/src/mail.ts` defines `Mailer` - one method, `send(message)` - alongside
  `LoggingMailer` and `RecordingMailer`. The same shape as `MediaStore`/`FakeMediaStore` and
  `Monitor`/`silentMonitor()`, which is deliberate: a reader who has met one has met all three.
- `LoggingMailer` is what development runs. It writes the whole message to the process logger
  **including the reset URL**, so the flow is exercisable end to end on a laptop with no provider
  account, no DNS, and no network. That is not a stub - it is the transport that makes the
  feature testable by a human.
- `RecordingMailer` collects sent messages in an array. It is what the tests assert against, and
  it is why "did the reset mail go to the right person, once, with a working token" is a unit
  test rather than something you find out in production.
- The mailer is injected into `createAuth`, not imported by it. An auth module that reached for a
  transport itself would be an auth module no test could build without one.
- **The provider decision is deferred, not avoided.** It becomes real when the app has a sending
  domain. Adding it is one class in `mail.ts` and one branch in the entrypoint; nothing that
  calls `send` changes.

## Consequences

| | |
|---|---|
| Positive | The reset flow ships complete and tested today rather than waiting on a DNS record. Development and CI exercise the real send path on every run, which is the same argument `SENTRY_DSN` being optional already makes in `config.ts`: a code path that only ever runs in production is a code path nobody has watched work. The provider stays a swap rather than a migration. |
| Negative | **There is no production transport, so password reset does not work in production yet, and that is a real gap rather than a technicality.** Until the provider lands, a deployed build would log reset URLs to the process logger instead of mailing them - which is worse than not having the feature, because it puts live credentials-in-effect into a log stream. The entrypoint must refuse to boot with `LoggingMailer` once `NODE_ENV=production`, and that guard is the load-bearing part of this decision. `better-auth` calls `sendResetPassword` through `runInBackgroundOrAwait`, so a send that throws never reaches the requester - correctly, since `PRD/03` rule 14 gives them the same answer either way, but it means a dead provider is invisible unless the call site says so. It is logged there rather than left to a promise nobody is holding. |
| Follow-up needed | Pick the provider and verify a sending domain. Then: bounce and complaint handling, which none of this addresses - a hard bounce on a member's address means their reset link went nowhere and nothing in the product knows. Rate limiting is per-address at the API (`PRD/03` rule 14's neighbour), but a provider will have its own limits, and exceeding them is a failure mode this port currently renders as one log line. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Pick Resend now and wire it | Almost certainly the eventual answer - best DX, a free tier that covers a club app. But the key and the verified domain are prerequisites we do not have today, and adopting it now means the flow is written against an integration nobody can run. The port makes this a later swap that costs one file. |
| Pick SES, to match the Fly/R2 cost posture | Cheapest at scale and the most setup by a wide margin: the sandbox refuses any unverified recipient until a support request is approved, so it is the one provider that cannot be smoke-tested the day you sign up. |
| Call the provider SDK directly from `sendResetPassword` | Fewer files, and it makes fifteen existing test suites either send real mail or need network stubbing. The fake is not overhead here; it is the only reason the reset flow has assertions. |
| SMTP through nodemailer, so any provider works unchanged | Genuinely provider-agnostic, and it buys the wrong agnosticism: deliverability for transactional mail is about the reputation of the sending infrastructure, not the protocol, and SMTP gives up the per-message IDs and bounce webhooks that the HTTP APIs return. It also means credentials for a long-lived connection rather than a scoped key. |
| Ship reset without email - a code shown on screen, or an in-app flow | There is no second channel to prove identity over. A code shown to whoever is holding the phone proves nothing, which is the whole reason reset goes through the address on the account. |
| Defer the feature until the provider exists | The feature is a week of product work and the provider is a DNS wait. Sequencing them serially means neither is done; running them in parallel is what the port is for. |
