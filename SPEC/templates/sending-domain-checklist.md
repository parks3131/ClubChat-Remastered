# Sending domain checklist

> **A provider that says "verified" is reporting a cached verdict, not a live check.** On
> 2026-08-07 `parkstechusa.com` read *verified* in Resend while publishing no SPF and no DKIM at
> all - every record had been lost in a nameserver move a month earlier, and mail kept being
> accepted the whole time. Delivery is not authentication. Verify in DNS and at the receiver,
> never in the provider's dashboard.

Use this when pointing outbound mail at a domain for the first time, or at a new one.
[ADR-0020](../decisions/0020-resend-is-the-mail-provider.md) is the provider decision;
[ADR-0019](../decisions/0019-outbound-mail-is-a-port-with-a-deferred-provider.md) is why the
transport is a port.

## Before touching DNS

- [ ] **Where do this domain's nameservers actually point?** The registrar's DNS panel is inert
      if `NS` points elsewhere. `dig +short NS <domain>` is the only answer that counts -
      `parkstechusa.com` is registered at a third party and served by Vercel, so its records live
      in Vercel and Namecheap's panel does nothing.
- [ ] **Is a domain slot free?** Resend's free tier allows exactly one domain. A second needs Pro
      ($20/mo, 10 domains), which also removes the 100/day cap that a club's signup evening will
      hit long before the 3,000/month one.
- [ ] **Do not name the sending subdomain `send`.** Resend puts its own bounce/Return-Path
      records at `send.<your-domain>`, so registering `send.example.com` produces
      `send.send.example.com`. Use `auth.` or `mail.`.
- [ ] Decide the subdomain deliberately. Isolating transactional mail from anything bulk means a
      future announcement blast cannot poison password-reset reputation, and moving later means
      re-verifying and rebuilding reputation from zero.

## The records

Take the exact values from the provider dashboard; the region and DKIM key are per-domain. Three
records for Resend, and **the host field is the subdomain only** in most panels - they append the
domain themselves.

- [ ] `TXT` at `resend._domainkey` - the DKIM public key. Safe to paste anywhere; it is public.
- [ ] `TXT` at `send` - SPF, `v=spf1 include:amazonses.com ~all`.
- [ ] `MX` at `send` priority 10 - the bounce/Return-Path domain.
- [ ] `TXT` at `_dmarc` - **not part of provider verification, and it will appear on no setup
      screen.** See below. One record at the apex covers every subdomain unless `sp=` overrides.

## Verify, in this order

Each step catches something the previous one cannot. Stopping early is how the failure above
survived a month.

- [ ] **Authoritative DNS**, not a cached resolver:
      `dig +short @<their-nameserver> TXT send.<domain>`. Empty output means the record is
      genuinely absent, whatever the dashboard says.
- [ ] **A public resolver** - `dig +short @8.8.8.8 ...` - to confirm it propagated off the
      origin.
- [ ] **The provider's own record status**, which is the weakest of the three and worth reading
      as a claim rather than a fact.
- [ ] **Send one real message and read the receiver's verdict.** In Gmail: open the message, the
      per-message ⋮ menu, *Show original*. `SPF: PASS` and `DKIM: PASS` are the goal, and DKIM's
      domain must match the `From:` domain or DMARC alignment fails later. **A provider reporting
      `delivered` proves only that the receiving server accepted the bytes.**

## DMARC

SPF proves the sending server is authorized for the envelope domain. DKIM proves the message was
signed and unaltered. **Neither looks at the `From:` header, which is the only address the
recipient sees** - so both can pass for an attacker's own domain while your name is displayed.
DMARC requires the domain that passed SPF or DKIM to *align* with the visible `From:`, and states
what a receiver should do when it does not.

Password reset is the highest-value phishing target this product will ever send, because a
spoofed one is convincing precisely by looking like the mail members were taught to expect.

- [ ] Publish SPF and DKIM **first**. A policy published while they fail is an instruction to
      reject your own mail.
- [ ] Start at `v=DMARC1; p=none` - it changes no delivery decision and clears the `DMARC: FAIL`
      that an absent record produces.
- [ ] Add `rua=mailto:...` for aggregate reports. **A report address at a different domain is
      dropped** unless that domain publishes an authorization record, which Gmail will not do for
      you - use an address on the sending domain, or a reporting service that provides one.
- [ ] Read reports for around two weeks, looking for legitimate senders that a strict policy
      would break.
- [ ] Tighten to `p=quarantine`, then `p=reject`.

## Wiring it up

- [ ] `RESEND_API_KEY` and `MAIL_FROM` both set, or neither. `config.ts` refuses to parse the
      half-configuration on purpose: a key with no From address produces a send the provider
      rejects, an exception better-auth discards in the background, and a member watching an
      inbox that will never receive anything.
- [ ] `MAIL_FROM`'s domain **is** the verified domain. The provider rejects anything else.
- [ ] Quote `MAIL_FROM` in `.env`. Node's `--env-file` does not need it, but the angle brackets
      in `Name <address>` are shell redirection to anything that sources the file.
- [ ] The API key is scoped to **sending only**. The transport only ever POSTs to `/emails`.
- [ ] Production secrets set with `fly secrets set`, never in the repo (non-negotiable 5).
- [ ] Prefer a replyable address over `noreply@`. Replies to a no-reply address vanish silently,
      and some receivers read the name itself as a bulk-mail signal.

## Afterwards

- [ ] Confirm the whole chain in a running app, not only the transport: request a reset, receive
      it, follow the link, and check the old password stops working. The unit tests cover the
      transport and `RecordingMailer` covers the flow; **only a live run covers the join.**
- [ ] Watch the API log for `[mail] not sent - no transport configured`. That line means it fell
      back to `LoggingMailer` and the integration was never exercised.
- [ ] Bounce and complaint webhooks remain unconsumed - see ADR-0020. Until they are, a hard
      bounce means a reset link went nowhere and nothing in the product knows.
