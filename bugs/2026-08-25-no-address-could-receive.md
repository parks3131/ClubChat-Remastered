# Every address at clubchatapp.com bounced, including the published support contact

**Found** 2026-08-25, by accident, while giving DMARC an address to send reports to.
**Live since the domain moved to Cloudflare nameservers**, which predates the deploy.

## What broke

```
support@clubchatapp.com   ->  550 5.1.1 Address does not exist
noreply@clubchatapp.com   ->  550 5.1.1 Address does not exist
dmarc@clubchatapp.com     ->  550 5.1.1 Address does not exist
```

`support@clubchatapp.com` appears 22 times in this repo. It is printed in the Privacy Policy, the
Terms and the Profile screen, and it is the published contact Apple's App Review guideline 1.2
requires for an app carrying user-generated content. Anybody who wrote to it got a bounce. A member
trying to report something serious got a bounce.

## Why

The apex MX records pointed at `eforward1-5.registrar-servers.com`, the registrar's email
forwarding service. That service only forwards for domains using the **registrar's own
nameservers**. This domain uses Cloudflare's, because Cloudflare serves the CDN and the apex site,
and it is not going to stop.

So the MX records were present, well formed, and permanently inert. The mail server they name
answered `250` to `MAIL FROM` for the domain and `550` to `RCPT TO` for every address, because it
had no configuration for the domain at all.

**Same shape as the invented Sentry DSN found the same morning: present is not valid.** Both were
well-formed configuration that could never have worked, and in both cases nothing in the system
was capable of noticing.

## The fix

Cloudflare Email Routing on the apex: MX at `route1/2/3.mx.cloudflare.net`, a `cf2024-1._domainkey`
DKIM record for forwarded mail, `v=spf1 include:_spf.mx.cloudflare.net ~all`, and routing rules for
`support@` and `dmarc@` to the founder's inbox.

`send.clubchatapp.com` was untouched throughout, which is why sending never broke: Resend's
envelope, SPF and bounce path all live on that subdomain rather than the apex.

## What went wrong while fixing it

**The first check said it worked, and it did not.** A test message was sent to `dmarc@` and a
screenshot of it appearing under "to dmarc" was read as proof of delivery. Gmail shows your own
sent message whether or not it is ever delivered. The bounce arrived afterwards. **A message in
Sent is not evidence.** What settled it was an SMTP `RCPT TO` against the domain's MX, reading the
response code.

**The order of the SPF swap mattered and nearly went the other way.** Cloudflare offers to add its
SPF record while the old one is still present. Two `v=spf1` records on one domain are read by
receivers as no SPF at all, which degrades mail silently while every send still reports success -
a trap already recorded in this repo from the Resend setup. The old record was deleted first and
the replacement added second, and the result verified with
`dig +short clubchatapp.com TXT | grep -c spf1` returning 1.

**A premature diagnosis was avoided by polling instead of concluding.** After the routing rules
went live, `dmarc@` returned `250` and `support@` returned `550` on all three Cloudflare nodes.
That looked like a broken rule, and the advice about to be given was to check the address for a
typo and recreate it. A monitor polling every twenty seconds showed it accepting within a minute:
it was propagation, and the rule was never wrong.
