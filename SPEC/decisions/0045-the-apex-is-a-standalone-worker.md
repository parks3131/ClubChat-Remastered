# ADR-0045: The apex is a standalone Worker

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-25 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

[ADR-0010](0010-link-only-invites.md) made invites link only, and the link is
`clubchat://join/<token>`. A custom scheme is a private agreement between a URL and an app that is
already installed. To every other device it is nothing at all.

That produces a defect nobody has to be doing anything wrong to hit. A club prints a QR code and
tapes it to a table at a freshers' fair. Somebody who has never heard of ClubChat scans it with the
camera app. The camera finds a URL it cannot open, and shows a blank frame: no prompt, no error, no
page, no explanation, and no way to find the app. The person who was being invited is handed
nothing.

There was nowhere to land them, because **`clubchatapp.com` served nothing.** DNS is on Cloudflare
and three subdomains are live - `api.` and `ws.` grey-clouded in front of Fly, `cdn.` a Worker
([ADR-0044](0044-the-cdn-is-a-worker-that-validates-before-it-reads.md)) - and the apex itself
resolved to no record at all.

Four more facts shape the answer.

- **The same https URL can do both jobs.** Apple universal links and Android app links both work by
  the platform fetching a file from a domain, so `https://clubchatapp.com/join/<token>` opens the
  app when it is installed and opens a web page when it is not. That is one link to print on a
  poster, in a message, and inside a QR code, instead of a scheme that only works for people who do
  not need it.
- **Both platforms fetch their association file from the apex, on their own schedule.** They fetch
  it when the app is installed and periodically after that, unattended, and a failure is silent:
  the link simply opens in a browser and nothing is logged. Whatever serves those two files has to
  be up when nothing else is, and has to be up when there is nothing to say.
- **`apps/mobile/src/invite-link.ts` already anticipated this.** Its `tokenFromScan` matches on the
  path and never on the scheme, with a docblock naming "an `https://` form once the web join page
  exists (ADR-0010's recorded gap)". A scanned `https://clubchatapp.com/join/<token>` is parsed
  correctly today with no change to the app.
- **The join page needs the club's name, which means it needs a public read.** It is being served
  by `GET /invites/:token/preview` on the api: unauthenticated, `{ club: { name, memberCount },
  expiresAt }` or a 404, nothing about members.

## Decision

**The apex is served by a standalone Cloudflare Worker at `packages/site-worker`, a sibling of
`packages/cdn-worker` and the fifth workspace.** It is deployed by `wrangler` from that directory,
attached to `clubchatapp.com` as a Workers Custom Domain.

Seven things are decided with it.

1. **It serves `/join/:token` by calling the api's public preview endpoint**, and the api is the
   only thing it ever calls. Every other route answers with the api down.
2. **An unreachable api produces a degraded page, never a 5xx and never a refusal.** A timeout is
   not evidence that an invite is dead. Only a 404 from the api - which is unknown, expired and
   revoked collapsed into one answer by design - produces "this invite link is not valid any more".
   Everything else produces a page that names no club, claims nothing, and keeps both ways into the
   app.
3. **It renders `docs/legal/privacy-policy.md` and `docs/legal/terms-of-service.md` at `/privacy`
   and `/terms`, bundled at build time.** Those two files are the only copy of that text in the
   repo; the mobile app links out rather than embedding. A change to the words is a redeploy, which
   is the right trade for a document whose value is that it says what it said.
4. **It serves `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`**,
   claiming `/join/*` and nothing else. A component list is an allowlist, and the legal pages must
   open in a browser because the app links to them.
5. **There is no JavaScript on the site, and the CSP enforces it.** `default-src 'none'` with no
   `script-src` beside it, and `style-src 'self'` served from a route rather than an inline block,
   so no `unsafe-inline`, no nonce and no per-response hash.
6. **The markdown renderer is hand-written and escapes before it interprets.** A general renderer
   accepts raw HTML by default and its safety then rests on a sanitiser staying configured across
   upgrades. This one has a fixed grammar and no configuration that turns HTML back on.
7. **There are no secrets in this Worker.** Every value it holds is published in a file it serves.
   They are `vars`, there is no `.dev.vars`, and nothing here must be kept out of a log - which is
   the exact inverse of its sibling and is stated so nobody copies the wrong half of the pattern.

## Alternatives

### Extend `packages/cdn-worker` to also serve the apex

Rejected, and it is the alternative that looks cheapest.

That Worker is separately security reviewed under ADR-0044, and its whole posture is one sentence:
**verify the signature, then route to a bucket, then read, and refuse before touching R2.** Every
refusal it makes is empty-bodied and `no-store` so that nothing distinguishes a wrong signature from
an old one. Adding a second front door - HTML pages, an outbound `fetch` to the api, a CSP that
permits a stylesheet, a route that answers without a signature - is not an addition to that posture,
it is a different posture sharing an isolate with it.

Three specific costs:

- **The CSP is wrong in both directions.** The CDN sets `default-src 'none'; sandbox` on every
  object it serves, which drops a document into an opaque origin. A page needing a stylesheet cannot
  be served through that, and relaxing it weakens the hardening that exists because
  `IMAGE_MIME_ALLOWLIST` lives in another package and can be widened by somebody with no reason to
  think about the edge.
- **The two bucket bindings would be in scope for code that has no business near them.** A landing
  page and two R2 buckets holding private club media do not belong in one blast radius.
- **The review does not transfer.** Somebody signed off on that Worker's behaviour. Changing what it
  is invalidates that, and the next person reading ADR-0044 would be reading a description of a
  Worker that no longer exists.

### Serve the apex from the Fastify api

Rejected on four grounds, any one of which is enough.

- **Availability coupling.** The association files must be fetchable when the api is not. Serving
  them from the api means an api outage silently unverifies universal links for every install that
  happens to re-check during it, and the effect outlives the outage.
- **The api's helmet CSP is `default-src 'none'; frame-ancestors 'none'; base-uri 'none';
  form-action 'none'` with `frameguard: deny`,** and `app.ts` states why: "This process serves JSON
  and one 302, never a document." Serving HTML there means either a per-route CSP override or a page
  with no stylesheet. Both are a hole punched in a policy that is currently absolute.
- **Adding a public route to the api is deliberately expensive.** Unauthenticated routes are not a
  flag or a decorator: every route group is registered inside an encapsulated scope carrying the
  session hook, and `plumbing.ts` records that "an unauthenticated route cannot be added by
  forgetting something - it can only be added by editing this file". Five public HTML routes plus
  two well-known files means five more root-instance registrations, each outside the rate limiter,
  each needing its own limiting. That is a real erosion of a property worth keeping.
- **It costs the api's own capacity.** `clubchat-api` is one 1024MB Fly machine. Crawler traffic and
  poster scans on the apex would land on the process holding every member's session.

The api's involvement is exactly one endpoint, `GET /invites/:token/preview`, which is a read it
already knows how to authorize (by not needing to).

### An R2 bucket or Cloudflare Pages behind the apex

Rejected. The join page is dynamic - it names a club that a static file cannot know - so a static
host answers only three of the eight routes. It also cannot serve
`apple-app-site-association` with `content-type: application/json` and no extension without
per-object metadata, which is the single most common way that file is wrong.

### Keep `clubchat://` only, and print a "get the app first" instruction on the poster

Rejected. It moves the defect onto a piece of paper, it fails for a link pasted into a message, and
it does not survive somebody scanning the code with a camera rather than reading around it.

## Consequences

- **The apex now has a DNS record.** Attaching the Custom Domain creates it. Nothing was there
  before, so nothing is displaced, but it is a change to the zone and not only a deploy.
- **Universal links are half done until `apps/mobile/app.json` changes.** The app needs
  `ios.associatedDomains` of `["applinks:clubchatapp.com"]` and an Android `intentFilters` entry
  with `autoVerify`. Until then the https link lands on the page and the visitor taps through, which
  is exactly the behaviour this Worker exists to provide, so nothing is broken in the meantime.
- **Android app links do not verify at all yet**, because no Android build has been signed and there
  is no SHA-256 fingerprint to publish. `/.well-known/assetlinks.json` answers `[]`, which is a
  valid document stating that no app is associated - chosen over a placeholder, which would fail
  verification while looking correct, and over a 404, which is indistinguishable from never having
  deployed.
- **The club name is untrusted input rendered into HTML, in five places on one page.** That is a
  class of risk this project did not previously have anywhere: the app renders into React Native
  components, and the api serves JSON. It is confined to one escaping boundary and asserted per
  context.
- **A legal text change is a Worker deploy.** Accepted deliberately.
- **Nothing reports an error from this Worker**, the same accepted gap ADR-0044 records for its
  sibling. Workers Logs is the only place an exception is visible, which is why the one thing that
  can plausibly fail on a well-formed request is turned into a page rather than left to throw.
- **`www.clubchatapp.com` is still nothing.** Adding it here would mean two hostnames publishing the
  same association claim and two canonical URLs for one invite. If it is ever wanted, the right shape
  is a redirect rule on the zone.
