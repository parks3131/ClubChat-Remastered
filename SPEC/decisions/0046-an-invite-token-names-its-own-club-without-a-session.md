# ADR-0046: An invite token names its own club, without a session

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-25 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

[ADR-0045](0045-the-apex-is-a-standalone-worker.md) puts a web page at
`https://clubchatapp.com/join/<token>` so that a stranger who scans a club's QR code is handed
something instead of a blank frame. That page has one job before it offers the app: **say which
club this is.** A page that reads "you have been invited to a club" and cannot name it is asking
somebody to install an app on the strength of a URL they found on a table.

The page cannot ask the way every other screen asks. `GET /clubs/:id` refuses a non-member outright
and takes a club id the page does not have; `readClub` needs an `AccessContext`; and the whole api
below `/api` sits inside a session hook by construction. **The person being greeted has no
account.** That is not an edge case, it is the entire population this page exists for - somebody
with an account and the app installed never sees it, because the universal link opens the app.

Three facts about the invite token decide the rest.

- **It is already a bearer credential.** `POST /invites/:token/redeem` takes a session and nothing
  else: holding the string is the whole of the authorization. Whoever holds it can be inside the
  club a second later, with the roster, the chat history and the gallery.
- **It is 32 bytes of CSPRNG as base64url** ([ADR-0010](0010-link-only-invites.md)), matched exactly
  and case-sensitively. Guessing one is not a thing that happens.
- **A club has two of them** ([ADR-0025](0025-a-members-invite-link-obeys-the-join-policy.md)), and
  which one a link carries decides what redeeming it does. That difference is a property of the
  string, and it is not a stranger's to learn.

The founder's rule for this api is that every read is access-checked on the server. This is the
first read that has no session to check against, so the check has to be the token itself, and the
question the ADR answers is what a token may buy without one.

## Decision

**`GET /invites/:token/preview` is public, and it discloses the club's name, its member count, and
nothing else.**

```
200  { "club": { "name": "Boat Club", "memberCount": 34 }, "expiresAt": null }
404  { "error": "invite_invalid" }
```

**The safety argument, stated once so it is not re-derived.** The token already grants membership
to whoever holds it. Telling that same holder the club's name discloses **strictly less than they
already have**. The endpoint is not a widening of what a token grants; it is a narrower use of it.
Anything that does not follow from that sentence is not in the response.

Six things are decided with it.

1. **The projection is enforced in SQL, not in the handler.** `domain/invite-preview.ts` selects
   the name and a `count(*)` and nothing else, so the row that comes back does not carry the club
   id, the description, the join policy, or either token. A handler that spread the row would still
   disclose nothing. A rule nobody has to remember is worth more than a careful handler.
2. **Nothing about a member, at all.** Not a name, not an id, not an avatar, not the owner. A count
   is a number about the club; a roster is a list of people who did not agree to be listed on a
   public page. Club search has answered exactly `(name, member count)` to a non-member since it
   was written, and this is the same projection reached by a different key.
3. **One refusal, so the endpoint is not an oracle.** Unknown, revoked, expired and malformed all
   return `null` from one function and 404 from one branch - same status, same body, same headers.
   A distinguishable "revoked" would confirm to a stranger that a club with that token once
   existed. This is reinforced by the data model rather than only by the code: rotation
   **overwrites** both columns in place, so nothing anywhere records that the old string was ever a
   token.
4. **`expiresAt` is answered and is always `null`.** A ClubChat invite token does not expire; it is
   valid until an admin rotates it. The field is in the shape so the join page reads one thing
   whatever happens, and it is typed as `null` rather than `string | null` so that adding an expiry
   later has to come past the type rather than quietly starting to carry a date.
5. **The two tokens answer identically.** Which one was used decides what redeeming it does, and
   two different previews would also hand anybody with a member link a way to test whether a second
   string is the admin one.
6. **It has a rate-limit bucket of its own, keyed on the caller's address.** The per-user limiter
   keys on `request.userId`, which a public caller does not have, so this route would otherwise be
   the only unlimited one in the api. `INVITE_PREVIEW_BUCKET` is 120 in reserve refilling at 5 a
   second. It is honestly a ceiling on database work and **not** what keeps a token secret - that
   is the token's own 256 bits, and a limit tight enough to matter against guessing would refuse
   real visitors for nothing.

**The route also carries `logLevel: 'warn'`, which is the one decision here that is about us rather
than about the caller.** Fastify logs `req.url` at info on every request, and on this route the url
IS the credential. Every other route carrying a token is behind a session; this is the one an
anonymous caller drives, and a log of it is a list of working invite links readable by anybody with
log access. The rate-limit warning still prints, naming the route pattern rather than the url, so
abuse is still visible.

## Consequences

| | |
|---|---|
| Positive | The join page can name the club, which is the difference between an invitation and a link. It needs no credential to do it, so there is no secret in the Worker, nothing to rotate, and nothing that could be stolen from the edge. The api gains no new authority: everything answered here was already implied by holding the token. The refusal is flat, so the endpoint tells a scanner nothing about which clubs exist. |
| Negative | The api now has a public read of club data, which is a category it did not have, and the argument that makes it safe is a sentence rather than a mechanism - somebody widening this response by one field is one careless commit away from disclosing a thing the token does not already grant. The exact-shape test is the guard, and it is a guard that has to be maintained. Keying the limit on `request.ip` is coarse for the expected caller: the apex Worker calls server-side, so a whole club fair arrives from a handful of shared Cloudflare egress addresses and shares one bucket. |
| Follow-up needed | None blocking. Two things are written down rather than fixed. **The token still reaches the development trace**, which records `request.url` verbatim; `dev/trace.ts` redacts by key name and a path parameter is not a key. It is development-only and gated three ways. And **a token still appears in the redeem route's request log**, unchanged and pre-existing - it is behind a session, which is why it was not moved in this change. |

**Why the count is exposed at all.** It is the one number that tells a stranger whether they are
being invited to a club or to an empty room, which is the question somebody standing in front of a
poster is actually asking. It says nothing about who is in it, and club search has answered it to
non-members since the beginning.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **The Worker holds an API credential and calls an authenticated endpoint** | This is the alternative that looks responsible and is worse in every direction. It puts a long-lived, non-user credential into a Cloudflare Worker's secret store, where it is one `wrangler secret list` and one compromised account away from being an api key with no user behind it - the first thing in this system that authenticates as nobody. It has to be rotated, and rotating it is a step in a runbook that will be wrong. It would need an authorization rule of its own, because a machine credential that can call `readClub` can read any club, which is precisely the disclosure this endpoint is designed not to make; the credential would therefore be *more* powerful than the anonymous route, not less. And it buys nothing: the token is the capability either way, so the endpoint would still answer anybody holding a token, with a secret added in front of it. A credential that gates nothing is a credential to lose. |
| Put the club's name in the link | A name in a URL is a name in every screenshot, every forwarded message and every scanner's history, and it is unverifiable - anybody can mint `clubchatapp.com/join/<token>?name=Anything`, which turns a phishing page into one that the real domain serves. The link also becomes ugly and long on a poster. |
| Serve the join page from the api and skip the endpoint | The api serves JSON and one 302, deliberately: `default-src 'none'` with `frame-ancestors 'none'`, no templating, no static files. Serving a document means a per-route CSP and a rendering layer in a process that has neither, and it puts the page's availability on the machine that holds the database. ADR-0045 decided the apex is a Worker for reasons that do not change here. |
| Answer 404 only for unknown, and something else for revoked | It is the more helpful page - "this club rotated its link, ask for a new one" - and it is an oracle. It confirms that a club with that token existed to whoever holds a string, which is a fact about somebody else's club. The mobile app already collapses the same three cases into one screen (`PRD/04`'s edge-case table), so nothing downstream wanted the distinction. |
| Return the club's avatar too | Tempting, and it is identity media rather than content, so it would not be an unreasonable third field. Left out because it needs a signed CDN url minted for an anonymous caller, and that is a second public surface to reason about for a picture. Revisit deliberately, with the media hop in the room, rather than by adding a field. |
| No limit, since guessing a token is infeasible anyway | True about guessing and irrelevant to the actual risk. An unauthenticated route is a way for anybody with a socket to spend the api's database connections, and "the data is safe" is not the same claim as "the service stays up". |
