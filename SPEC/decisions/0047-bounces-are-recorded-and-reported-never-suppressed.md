# ADR-0047: A bounce is recorded and reported, never suppressed

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-25 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

[ADR-0020](0020-resend-is-the-mail-provider.md) picked Resend and closed the sending half of
password reset. It left one thing open, in its own words:

> Bounce and complaint handling remains unaddressed, exactly as ADR-0019 left it: Resend has
> webhooks for both and nothing consumes them, so a hard bounce still means a reset link went
> nowhere and nothing in the product knows.

That sentence describes a specific, silent failure. A member asks to reset their password. The API
answers the same way it answers everybody, because
[Accounts and profile](../PRD/03-accounts-and-profile.md) rule 14 deliberately makes the response
identical whether or not the address exists. `ResendMailer` posts the message, Resend accepts it
for delivery and answers `200`, and the send is over as far as this product is concerned. Some
seconds later the recipient's mail server rejects it permanently, Resend emits `email.bounced`, and
that event arrives nowhere. The member is looking at a page telling them to check an inbox that
will never receive anything, and there is no row, no log line and no alert anywhere in ClubChat
that says so. The only record is in somebody else's dashboard.

`SPEC/templates/sending-domain-checklist.md` carries the same sentence, and until now both were
accurate.

Four facts shape what to build.

- **The scheme is Svix's, not Resend's own.** Resend delegates webhook signing and its
  documentation points at Svix for the algorithm. Every part of it is the kind of detail that is
  plausible and wrong from memory, so it was read from
  `https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests` and
  `https://docs.svix.com/receiving/verifying-payloads/how-manual` on 2026-08-25. Headers
  `svix-id` / `svix-timestamp` / `svix-signature`, with `webhook-` prefixed aliases documented for
  Professional and Enterprise accounts. HMAC-SHA256 over `${id}.${timestamp}.${body}`, base64. The
  key is the secret with `whsec_` stripped and the remainder **base64 decoded** - not the prefixed
  string and not the base64 text. The signature header is a space-delimited list of `v1,<base64>`
  entries, because a rotation puts two there.
- **This API has never retained a raw request body.** Nothing in `packages/server` calls
  `addContentTypeParser`, so Fastify's default parser consumes the stream and every handler sees
  the parsed object. Resend states the consequence plainly: "the cryptographic signature is
  sensitive to even the slightest change". A verifier built on `JSON.stringify(request.body)`
  refuses every genuine delivery with the correct secret, and presents as a wrong secret.
- **A public route is a deliberate edit to `app.ts`, and it gets no rate limiting for free.**
  Unauthenticated routes exist by being registered on the root instance rather than on the
  `protectedRoutes` scope; the only default limiter lives on that scope and keys on
  `request.userId`.
- **Resend already maintains a suppression list.** Their own documented bounce message reads "The
  recipient's email address is on the suppression list because it has a recent history of producing
  hard bounces", and `email.suppressed` and `suppression.added` are event types they publish. The
  provider is already refusing sends to addresses that hard bounce.

## Decision

**Consume `email.bounced`, `email.complained` and `email.failed` at a signature-verified public
endpoint; record each against the address; report the ones that matter through the existing
monitor. Build no suppression list.**

Concretely:

- **`POST /webhooks/resend`**, registered from `app.ts` on the root instance beside `/health`,
  `/ready` and `/__parity`, through `registerMailWebhook` in `packages/server/src/api/mail-webhook.ts`.
  It is handed `refuseTooMany` the way `registerDevDashboard` is handed its `log`, so the one 429
  shape this API uses is not copied into a second file.
- **The route brings its own content-type parser**, encapsulated in its own plugin scope, so
  `request.body` is the raw string for this route and the parsed object everywhere else. Two are
  registered - `application/json` to override the inherited default, and `*` for anything carrying
  a charset or an unexpected type - so the handler cannot be reached with anything but raw bytes.
- **Verification happens before anything in the body is read**, in
  `packages/server/src/mail-webhook.ts`, using `node:crypto` and no new dependency. Missing headers,
  a header sent twice, a non-numeric timestamp, a timestamp outside tolerance, an unknown version
  and a non-matching signature are each refused with `401`. The comparison is
  `crypto.timingSafeEqual`, guarded by a length check that is not an optimisation: `timingSafeEqual`
  throws `RangeError` on unequal lengths, so a two-character signature from a stranger would
  otherwise be an unhandled 500.
- **The tolerance is five minutes, in both directions.** Svix's page says to check the timestamp
  against "your tolerance" and names no number; five minutes is what Svix's own client libraries
  use. It is recorded here as a choice rather than inherited as a fact.
- **`mail_events`** (migration `0040`) holds one row per recipient per delivery:
  `provider_event_id`, `kind`, `email`, `bounce_type`, `detail`, `provider_message_id`,
  `occurred_at`. The unique index is on **`(provider_event_id, email)`** and the insert is
  `ON CONFLICT DO NOTHING` against it. Resend documents at-least-once delivery and retries at 5s,
  5m, 30m, 2h, 5h and 10h, so the same event will arrive twice; keying on the delivery id alone
  would record the first recipient of a multi-recipient event and silently drop the rest.
- **The write returns which addresses were new**, and only those raise an alarm. A hard bounce
  (`bounce.type === 'Permanent'`), a complaint and a send that never left each go to
  `monitor.capture` under `api.mail.bounced` / `api.mail.complained` / `api.mail.failed`. A
  transient bounce - a full mailbox, which clears on its own - is recorded and reported to nobody.
- **A payload that verifies and cannot be read IS reported**, under `api.mail.webhook`. Carrying
  our own signature, it means Resend changed their schema, which is otherwise silent in every
  direction: the deliveries keep arriving and the table keeps not growing.
- **A failed signature is logged and never captured.** Anybody who can reach the port can produce
  one, so capturing it would hand a stranger a way to fill the error tracker. The one cause that is
  genuinely ours - an unusable secret - is a boot failure instead: `RESEND_WEBHOOK_SECRET` is
  validated in `config.ts` and a value that does not base64-decode to at least 16 bytes refuses to
  start, naming the field.
- **With no secret configured the route answers `503` and reports itself once**, the way `/ready`
  reports a missing Redis once. It cannot recover on its own, so reporting per delivery would be
  the same message forever.
- **Its own bucket, `MAIL_WEBHOOK_BUCKET` (60 burst, 1/sec), against one constant key, consumed
  only after the signature verifies.** Keyed ahead of verification, anybody could empty it with
  unsigned junk and every genuine delivery would be refused until Resend gave up ten hours later. A
  429 is safe here in a way it is nowhere else in this API, because Resend retries.
- **A database failure is left to throw** into `setErrorHandler`, which answers 500 and captures
  it. The 500 is what makes Resend redeliver, and the unique index absorbs the duplicate if the
  write had in fact landed. Catching it here would turn a transient outage into a permanently lost
  bounce.
- **Body ceiling of 64KB**, two orders of magnitude above anything Resend sends, because the
  signature check is an HMAC over the whole body and an unbounded body is unbounded work for a
  caller who has proved nothing.

### And explicitly: no suppression list

The brief asked for this to be decided with reasons rather than assumed, so here it is decided.
**A hard bounced address is not suppressed from future sends.** Four reasons, and the second is
the one that settles it.

1. **Resend already suppresses.** A second list in our database can only diverge from theirs, and
   ours is the one that would be wrong - built from webhooks we might have missed during an outage,
   with no equivalent of their `suppression.removed` to correct it.
2. **Suppression cannot improve what the requester sees without becoming an oracle.** The password
   reset response is deliberately identical whether or not the address exists
   ([Accounts and profile](../PRD/03-accounts-and-profile.md) rule 14) and the per-address bucket is
   consumed before better-auth sees the request for exactly that reason. A suppressed address either
   gets the same answer as everybody - in which case suppression changed nothing a member can see -
   or a different one, in which case anybody can now test an address for deliverability, and by
   extension for existence. The only version that helps the member is the one that breaks the rule.
3. **The saving is one HTTP request.** This product sends one kind of mail, at the member's own
   request, limited to three per five minutes per address. The cost of attempting a send to a dead
   address is a round trip Resend refuses.
4. **Anything we built would need a way out, and getting that wrong locks somebody out of their own
   account.** Password reset is the only account-recovery path there is. A suppression that outlived
   its cause - one provider event, one mail server having a bad afternoon, one address that started
   working again - would take that path away on evidence we cannot re-check. The mechanism that can
   never do that is the mechanism that does not exist. This is also why nothing reads `mail_events`
   on the send path: it is a record and an alarm, not a gate, and there is no code for a future
   change to quietly turn into one.

What replaces suppression is the alarm. The founder is told which address bounced and why, and can
reach the member another way or correct the address - which is the thing that actually fixes it,
and which no automatic suppression would have done.

## Consequences

| | |
|---|---|
| Positive | The failure ADR-0020 recorded is closed: a reset link that went nowhere now produces a row and a Sentry issue naming the address, the bounce type and Resend's own words. The API gains its first raw-body route, scoped so nothing else changed shape. No new dependency - not `resend`, not `svix` - so the sending and receiving halves are both `node:crypto` and `fetch`, and there is nothing new to keep current. The signature suite is pinned against `openssl` vectors that share no code with the implementation, and three separate mutations of the verifier were confirmed to turn it red. |
| Negative | **The alarm carries a member's email address into Sentry**, and that is the one PII decision here. It is deliberate: a bounce report that does not say which address bounced is not actionable, and the only response to it would be a database query. The volume is a handful a month against a product sending single-digit mails a day, `mail_events` remains the system of record, and the capture can be reduced to the delivery id without touching anything else if that ever stops being acceptable. **The endpoint is public and writes to the database**, which is a shape this API has not had before; the signature check is the whole of its security, which is why it is asserted at length and why the rate limit sits behind it. **`RESEND_WEBHOOK_SECRET` is a third mail secret to hold and rotate**, and a rotation is briefly two secrets on Resend's side and one on ours - the multi-signature header is read for that reason, but our side accepts only one value, so a rotation should be done with the dashboard's own overlap rather than by editing the Fly secret first. **`mail_events` has no retention policy**, matching `notifications`, which the roadmap already records as debt. |
| Follow-up needed | Create the webhook in the Resend dashboard pointing at `https://api.clubchatapp.com/webhooks/resend`, subscribed to `email.bounced`, `email.complained` and `email.failed`, and set `RESEND_WEBHOOK_SECRET` on `clubchat-api` from the value it shows. Neither was done here: this task was built and proved locally and does not touch production. Until both are done the route is live, answers `503`, and reports itself once - which is the intended state rather than a broken one. Then send one deliberate bounce (Resend documents `bounced@resend.dev` for this) and confirm a row and an issue appear; that is the only proof that the deployed secret and the deployed code agree, and it is the same class of check `/__parity` exists for on the media side. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| A suppression list that blocks sends to a hard-bounced address | The main alternative, and rejected on the reasoning above. It duplicates a control Resend already applies, it cannot change what the requester sees without becoming a deliverability oracle, and every version of it needs an escape hatch whose failure mode is a member permanently unable to reset their password. |
| A suppression list with an expiry, so it can never be permanent | Answers the lock-out objection and none of the others. It still diverges from Resend's list, still cannot be surfaced to the requester, and adds a read on the send path, a clearing rule and a window length to pick - all to avoid one HTTP request that Resend was going to refuse anyway. |
| Marking the `users` row instead of writing an events table | Loses the address that belongs to nobody, which is the case this feature exists to surface: a mistyped address at sign-up bounces and there may be no account holding it. It also loses the history - two bounces a month apart and one bounce are different situations - and would need the migration anyway. |
| The `resend` or `svix` SDK for verification | Resend's documented path is `resend.webhooks.verify`, and Svix's is `new Webhook(secret).verify`. Either would add a dependency to keep current in exchange for one HMAC over a string that `node:crypto` already computes - the same argument ADR-0020 made for calling the send endpoint with `fetch`. The scheme was read from the docs rather than recalled, which is the part the SDK would actually have protected against. |
| A global raw-body parser, or a `preParsing` hook that stashes the raw bytes on every request | Both work and both change every route in the API to serve one. The encapsulated parser is the narrowest version: it exists inside the plugin that registers this one route, and a test asserts that `/api/auth/*` still receives a parsed object - which matters, because the per-address reset bucket reads `request.body.email` and would read `undefined` off a string. |
| Rate limiting the webhook before verifying, keyed on `request.ip` | Resend's egress addresses are shared and not published as stable, so an IP key is a key on nothing. And a limiter in front of the signature check turns an abuse ceiling into a denial of the signal: unsigned junk from anywhere empties the bucket, genuine deliveries 429, and Resend gives up after ten hours. |
| Answering `200` to a payload that cannot be read, to stop the retries | Tempting, and wrong in the direction that hides things. A payload carrying our own signature that we cannot parse is a schema change at the provider, and the retries plus the failure count in Resend's dashboard are the second place somebody would notice it. Refusing costs nothing - there is nothing to record - and the capture is what actually raises it. |
| Capturing failed signatures to the monitor as well | It would catch a wrong secret, which is the failure that looks exactly like internet noise. It would also let anybody who can reach the port fill the error tracker. The wrong-secret case is caught earlier and better, at boot, by validating `RESEND_WEBHOOK_SECRET` in `config.ts`. |
