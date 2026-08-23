# `@clubchat/cdn-worker`

The Cloudflare Worker behind `cdn.clubchatapp.com`. It is the only thing between a signed media
URL and the two R2 buckets, and it does four things in this order:

1. **Verify** the `?exp=&sig=` signature, using `verifyMediaSignature` from
   `@clubchat/shared/media-signing`.
2. **Route** to a bucket with `bucketRoleForObjectKey`: `avatar/` to `clubchat-identity`, `photo/`
   and `document/` to `clubchat-content`, anything else a 404.
3. **Read** the object.
4. **Set cache headers** on the way out.

**It refuses before it reads.** An unsigned request, a tampered one, an expired one and a key
prefix this project never issues are all answered without an R2 call happening at all. That
ordering is the security property, not an optimisation: reading first would make the endpoint an
oracle for which object keys exist.

Nothing about the signing scheme lives in this package. `@clubchat/shared/media-signing` is the one
implementation, imported by subpath so that the emoji catalogue behind `@clubchat/shared`'s barrel
export stays out of the bundle. The api signs with it on Node and this Worker verifies with it on
`workerd`, which is why it is written on WebCrypto and has no `node:` imports.

| Status | Means |
|---|---|
| `200` | The whole object. `public, max-age=3600`, the object's stored `Content-Type`, its `ETag` |
| `206` | A `Range` that R2 applied, covering less than the whole object. Carries `Content-Range` |
| `304` | `If-None-Match` or `If-Modified-Since` says the caller's copy is current |
| `403` | The signature is missing, malformed, wrong, or expired. Which one is not disclosed |
| `404` | An unrecognised key prefix, or an object that is not there |
| `405` | A method other than `GET` or `HEAD` |
| `416` | Only if R2 itself throws `INVALID_RANGE`. **A `Range` header cannot produce this.** See below |

Every refusal carries `cache-control: no-store`. A cached 403 pins a failure for an hour, and the
failures this endpoint produces are almost all transient: a URL signed an hour ago, a rotation
halfway done, an upload that has not landed yet.

### What a `Range` header actually does

The Worker does not parse `Range` itself. It hands the request's own `Headers` to R2 as both
`onlyIf` and `range`, and R2 decides. What R2 decides is worth writing down, because it is not what
the status table alone would suggest:

- **A range R2 can satisfy** is applied, and the response is `206` with a `Content-Range`.
- **A range R2 cannot satisfy or cannot parse is IGNORED, and the whole object is served with a
  `200`.** That covers a range past the end of the object (`bytes=900-1000` on a ten byte file), a
  multi-range request (`bytes=0-1,5-6`), and outright junk (`kilobytes=1-2`). Each of those was
  observed coming back as the complete object. RFC 9110 requires exactly this: a server that ignores
  a `Range` responds `200`.
- **`Range: bytes=0-` for an entire object is a `200`**, not a `206`, because the response really is
  the whole representation. `Accept-Ranges: bytes` is still sent, so a client can still resume.

The status is decided from the extents R2 reports having served, never from whether the request
carried a `Range` header. Those are different questions, and the three ignored-range cases above are
where they give different answers.

**So the `416` row is insurance, not a live path.** The `catch` that produces it converts a thrown
R2 `INVALID_RANGE` (code `10039`) into an honest status instead of an uncaught exception, and it is
tested against a bucket that throws exactly that. But R2 only throws it for the explicit
`{offset, length}` option object, which this Worker never passes, so nothing a client can put in a
`Range` header reaches it today. It is kept because an uncaught throw at the edge is a `500` that
nothing reports, and because a future runtime may well throw where this one shrugs.

## Deploying

```bash
cd packages/cdn-worker
npx wrangler deploy
```

Check the bundle first if anything about the imports changed:

```bash
npx wrangler deploy --dry-run --outdir /tmp/cdnworker-dryrun
```

Wrangler prints two numbers and they are easy to confuse. As of 2026-08-21 it reports
`Total Upload: 6.64 KiB / gzip: 2.39 KiB`; **the first is the one to watch.**

**If it is materially larger, somebody imported `@clubchat/shared` instead of
`@clubchat/shared/media-signing`** and pulled a quarter of a megabyte of emoji data to the edge.
"Materially" means a jump of two orders of magnitude, not a few hundred bytes: adding a helper moves
this number by a KiB and that is ordinary. That is the only thing the size is worth watching for,
and it is worth watching.

`cdn.clubchatapp.com` was attached as a **Workers Custom Domain** on 2026-08-23, and
`wrangler.jsonc` declares it in the same change as a `routes` entry carrying `custom_domain: true`.
A route naming a zone the account does not hold fails `wrangler deploy` outright, so that entry
could not be written ahead of the domain, and now that it is there the line doubles as the assertion
that the zone is held.

**That hostname is the only one this Worker answers on, and keeping it that way took two explicit
settings.** `workers_dev` defaults to ON whenever a config declares no routes, which this one did
until the domain was attached, and `preview_urls` follows it - so a plain `wrangler deploy` would
also publish `clubchat-cdn.<subdomain>.workers.dev` plus a per-version preview URL. The signed
message is `${objectKey}:${exp}` and covers no host, so every URL the api mints would work verbatim
on those too: a second front door to both buckets, outside the `clubchatapp.com` zone and therefore
outside every WAF rule, rate limit and Access policy ever attached to it, with `/__parity` reachable
there as well. `wrangler.jsonc` sets both to `false` explicitly rather than leaving either to its
default, which is why adding the route entry changed nothing about them. If a deploy ever prints a
`workers.dev` URL, that is a regression, not a convenience.

There is a note in the collected values wanting workers.dev as somewhere to test before attaching
the custom hostname. It was not needed for that: the Fly apps went out on `MEDIA_URL_MODE=presign`,
so the Worker was deployed and exercised on `cdn.clubchatapp.com` while nothing depended on it yet.
Testing on the real hostname before anything uses it beats testing on a second hostname that then
stays open forever.

## What this Worker is caching, which is nothing

`public, max-age=3600` goes to browsers and to any downstream cache. **Cloudflare's own edge cache
holds nothing, so two members opening the same photo are two reads of R2**, not one read and one
cache hit. **Measured against the deployed Worker on 2026-08-23**, with the command and its result
at the foot of this section. Worth stating plainly because the opposite is the natural assumption
and an earlier version of this file asserted it.

The reasons, from Cloudflare's documentation rather than from inference:

- The Cache API page says, of Worker responses: "To cache responses from your Worker so that
  Cloudflare returns them without executing your Worker, use Workers Caching instead."
- **Workers Caching is opt in**, via `"cache": { "enabled": true }` in `wrangler.jsonc`, and this
  Worker does not set it. Its page scopes it to "HTTP invocations of the Worker's fetch handler",
  so if it were on it WOULD cover a response built here from R2 bytes.
- This Worker never calls `caches.default.put()` and never issues a `fetch()` subrequest.
  `bucket.get()` is a binding call and does not traverse the cache.
- R2's own docs say "Domain access through a custom domain allows you to use Cloudflare Cache to
  accelerate access to your R2 bucket". That is an **R2** Custom Domain pointed straight at a
  bucket, which is a different arrangement from a Worker reading a binding, and is probably where
  the belief came from.

What the hour-aligned expiry still buys is real and unchanged: every viewer in a window is issued
the byte-identical URL, so the cache key collapses instead of fanning out, a deleted photo stops
being visible within about an hour, and expiries stagger rather than dropping at once.

**Settled against the real deployment on 2026-08-23, the day of the first cutover:**

```bash
curl -sI '<a signed url>' | grep -i cf-cache-status
```

**The header is absent.** Not `DYNAMIC`, which is what this file used to predict, and not absent in
the sense of a request that failed: the response off `cdn.clubchatapp.com` carries
`cache-control: public, max-age=3600`, a content-type, a content-length and an etag, and no
`cf-cache-status` at all. A header Cloudflare does not emit is a request no Cloudflare cache ever
considered, so the consequence is the one written above, now observed rather than argued: **N
members opening one photo is N reads of R2.**
[ADR-0044](../../SPEC/decisions/0044-the-cdn-is-a-worker-that-validates-before-it-reads.md) named
both readings in advance, "`DYNAMIC` or an absent header confirms the above", so this **confirms**
it. A `HIT` or a `MISS` would have falsified it, and would have meant superseding that ADR rather
than editing a paragraph.

Turning Workers Caching on is still a live option with a real trade-off: one key,
`"cache": { "enabled": true }` in `wrangler.jsonc`, against the cache pollution ADR-0044 records,
since one signed URL has unlimited accepted spellings and each is its own cache key. What changed is
that it is no longer waiting on evidence, so it is a decision for the founder rather than a question.
The argument behind all of this lives beside the code it governs: the docblock on
`HIT_CACHE_CONTROL` in `src/index.ts`, and the comment on the absent key in `wrangler.jsonc`.

## Responses are hardened against the object itself

Every byte and every piece of metadata on a stored object arrived from a member's device through a
presigned PUT, so a response built from one is built from hostile input. Three things follow, none
of which is reachable today and all of which are here anyway:

- **`X-Content-Type-Options: nosniff`** on every response carrying a body, so nothing is rendered as
  a type it did not declare. `text/plain` and `text/csv` are on the allowlist and served inline
  today, which is the case that needs no allowlist change at all.
- **`Content-Security-Policy: default-src 'none'; sandbox`**, which is what neuters an explicitly
  `text/html` object should the allowlist ever widen. The app downloads documents to a file and
  hands them to the OS, which ignores CSP, so the only surface this touches is a document opened in
  a browser tab on the web client. If inline PDF viewing there is ever reported broken, drop the
  `sandbox` token first and keep `default-src 'none'`.
- **`Content-Disposition` is stripped**, not passed through. `writeHttpMetadata` replays whatever
  the uploader stored; nothing in this project ever writes one, and the filename a member sees is
  built on the device from the message envelope in `apps/mobile/src/document-name.ts`. It is
  uploader-controlled input that nothing consumes and that decides inline versus download.

`IMAGE_MIME_ALLOWLIST` and `DOCUMENT_MIME_ALLOWLIST` in `packages/server/src/media/store.ts` carry
no `text/html` and no `image/svg+xml`, which is why none of the above is load bearing yet. It is
here because that file calls widening the allowlist "a product decision", and whoever makes it will
be working in `packages/server` with no reason to think about the edge.

## The signing secret

```bash
cd packages/cdn-worker
echo -n 'the-secret-value' | npx wrangler secret put MEDIA_SIGNING_SECRET
```

**`-n` is not a style preference. A trailing newline is a different HMAC key.** The secret is used
as raw key bytes, so `secret` and `secret\n` produce completely different signatures over the same
message, and the failure is total: every photo, every avatar and every document 403s at once, while
both sides look correctly configured and neither logs anything useful. `printf %s 'the-secret-value'`
is the same thing without depending on the shell's `echo` supporting `-n`.

Typing the value at wrangler's interactive prompt is also safe, since the prompt does not keep the
newline. Piping a file is the trap: `wrangler secret put MEDIA_SIGNING_SECRET < secret.txt` sends
whatever the editor put at the end of that file.

The same value has to be on the api, and it must match byte for byte. **Do not put it in a
`fly secrets set` command line**: that writes the key that signs every media URL into your shell
history and into the process table. `flyctl secrets import` reads `NAME=VALUE` pairs from stdin
instead, so generate once into a shell variable and feed both sides from it:

```bash
V=$(openssl rand -base64 48)                                    # 64 chars, no '=' padding
printf 'MEDIA_SIGNING_SECRET=%s\n' "$V" | fly secrets import --app clubchat-api
printf '%s' "$V" | npx wrangler secret put MEDIA_SIGNING_SECRET   # note: no newline
unset V
```

The asymmetry is deliberate and is the whole trap in one place. `secrets import` is **line
oriented**, so the `\n` in that `printf` terminates the pair rather than becoming part of the
value; `wrangler secret put` takes **raw stdin**, so a `\n` there would become part of the key.
Hence `printf '%s'` on the second line and `\n` on the first.

**Do not take that on trust, including from this file.** The point of `/__parity` is that you do not
have to reason about whether the bytes matched: compare the two sides and find out. That check is
below, and it is the last step of any change to this secret.

## Checking the two sides agree

This is the single likeliest failure in the whole deployment, and it does not look like what it is:
every photo 403s, which reads as a broken Worker rather than as a mistyped password. So both sides
answer `GET /__parity`, unauthenticated, with the first eight base64url characters of an HMAC over a
constant that is printed in this repo:

```bash
curl -s https://api.clubchatapp.com/__parity
curl -s https://cdn.clubchatapp.com/__parity
```

```json
{ "parity": "AbCdEf12", "previousParity": null, "version": "9f1c8b2e" }
```

**`parity` must be identical on both sides.** If it is not, the secrets differ and nothing else is
worth investigating until they do not:

```bash
diff <(curl -sf https://api.clubchatapp.com/__parity  | jq -r .parity) \
     <(curl -sf https://cdn.clubchatapp.com/__parity | jq -r .parity) \
  && echo 'secrets match'
```

Eight characters is 48 bits of an HMAC-SHA256 over a public message, so recovering the key from it
is a full key search. What it does reveal is that the secret changed, which is the thing you want to
see.

Reading the other two fields:

- **`previousParity`** is always `null` on the api, which holds no previous key by design because it
  signs and never verifies. On the Worker it is non-null only during a rotation, and it is what
  tells you that URLs minted under the key the api was using an hour ago are still being accepted.
- **`version`** says which build answered: the Cloudflare version id here, `SENTRY_RELEASE` on the
  api. A parity mismatch immediately after a deploy usually means one side has not rolled yet.
- **`parity: null` on the Worker** means it has no `MEDIA_SIGNING_SECRET` at all. Every media
  request is 403ing because there is no key to verify with, and `secret put` is the whole fix.

## Rotating the signing secret

The previous key is configured **on the Worker only**. The api signs and never verifies, so a
`MEDIA_SIGNING_SECRET_PREVIOUS` on a Fly app would be an environment variable nothing reads, and an
unread secret reads as drift the next time somebody looks at `fly secrets list`.

```bash
cd packages/cdn-worker
OLD=$(...)              # whatever the current key is
NEW=$(openssl rand -base64 48)

printf '%s' "$OLD" | npx wrangler secret put MEDIA_SIGNING_SECRET_PREVIOUS
printf '%s' "$NEW" | npx wrangler secret put MEDIA_SIGNING_SECRET
printf 'MEDIA_SIGNING_SECRET=%s\n' "$NEW" | fly secrets import --app clubchat-api
unset OLD NEW
```

In that order. URLs already in clients keep resolving for the rest of their hour, because the Worker
tries the current key first and the previous one second. Once every URL minted under the old key has
aged out, which takes at most two hours, delete it:

```bash
npx wrangler secret delete MEDIA_SIGNING_SECRET_PREVIOUS
```

Confirm with `/__parity`: `previousParity` goes back to `null`.

## Running it locally

```bash
cd packages/cdn-worker
cp .dev.vars.example .dev.vars   # then put a real local value in it
npx wrangler dev
```

`.dev.vars` and `.wrangler/` are already in `.gitignore`.

## The accepted gap: nothing reports a Worker error

There is no Sentry DSN at the edge, no alert on a 5xx rate, and no counter anywhere that goes up
when this Worker throws. An exception here becomes a Cloudflare error page that nobody is watching.
That is deliberate for the first deployment and it is recorded in the ADR rather than left implicit,
but it has two consequences worth holding onto:

- **`observability` is enabled in `wrangler.jsonc`**, so Workers Logs in the dashboard is the only
  place an error here is visible at all. It is off by default on a new Worker, which would have made
  a silent gap silent twice over.
- **The two failures that can plausibly reach a well-formed request are turned into status codes
  rather than left to throw.** A missing signing secret verifies against an empty key list, which
  fails closed as a 403 instead of throwing inside `importKey`; a thrown `R2Error` for an
  unsatisfiable range becomes a 416 instead of an uncaught exception, though as the section on
  `Range` above explains, no `Range` header currently reaches it. Anything else from R2 is rethrown
  on purpose, so a real outage is not disguised as a client mistake.

The thing that actually tells you this Worker is broken is a member saying no photos are loading.
`/__parity` is the first command to run when that happens.
