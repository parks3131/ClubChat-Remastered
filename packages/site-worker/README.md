# `@clubchat/site-worker`

The Worker behind `https://clubchatapp.com`. The apex served nothing at all before it.

It exists because of one concrete defect. Invites are link only, and the link was
`clubchat://join/<token>`. A custom scheme is nothing whatsoever to a device that does not have the
app: a club QR code taped to a table, scanned by somebody who has never heard of ClubChat, produced
a blank camera, no prompt, no error and no page. There was nowhere for that person to land, because
the apex resolved to nothing.

The fix is one https URL doing two jobs. With the app installed, iOS and Android open it directly
through the two association files below and this Worker's page is never fetched. Without the app,
the same URL is a page that names the club, offers the deep link, and says how to get the app.

## What it serves, in the order the router matches

| Path | What it is | Cache |
|---|---|---|
| `/` | The landing page | `max-age=300` |
| `/styles.css` | The whole stylesheet, so no page carries an inline style | `max-age=86400` |
| `/robots.txt` | `Disallow: /join/` | `max-age=86400` |
| `/.well-known/apple-app-site-association` | iOS universal links | `max-age=3600` |
| `/.well-known/assetlinks.json` | Android app links | `max-age=3600` |
| `/__parity` | What this Worker is configured with | `no-store` |
| `/privacy`, `/terms` | `docs/legal/*.md`, rendered | `max-age=300` |
| `/join/:token` | The invite page | `no-store` |
| anything else | A 404 with a page on it | `no-store` |

Anything that is not `GET` or `HEAD` is a 405 with `Allow: GET, HEAD`, checked before the router
because it is true of every path.

## The join page, and its three answers

`GET /join/:token` is the only route that makes an outbound request. It calls
`GET /invites/:token/preview` on `API_ORIGIN`, which is public: no session, no cookie, no header. It
answers 200 with `{ club: { name, memberCount }, expiresAt }` and 404 for a token that is unknown,
expired or revoked.

| What the api said | What the page says | Status |
|---|---|---|
| 200 with a club name | Names the club, offers the deep link and whatever way in there is | 200 |
| 404 | "This invite link is not valid any more", no deep link | 404 |
| anything else, a timeout, a connection failure, an unparsable body | "We could not reach ClubChat just now", both links kept | 200 |

**The third row is the one that matters.** A timeout is not evidence that an invite is dead, and
telling somebody standing in front of a QR code that their link is expired, when it is not, is
worse than telling them nothing. The degraded page never names a club it could not confirm and
never claims the invite is invalid. It is a 200 because the page really is a complete and useful
answer.

A token that is not `[A-Za-z0-9_-]{16,128}` is answered as a dead invite **without the api being
called at all**, which is what guarantees the only caller-controlled part of the URL this Worker
builds is a checked token.

## The club name is untrusted, and it reaches five places

`club.name` is a string a member typed, and nothing between that row and this page sanitises it -
nothing should, because a club really can be called `Ben & Jerry's`. It is rendered into the
`<title>`, an `<h1>`, and the `content` attribute of three `<meta>` tags.

`test/escaping.test.ts` asserts all five separately rather than sampling one. That file also records
its own worst moment: the first version of its `metaContent` helper stopped at `content="([^"]*)"`,
which silently captured a truncated value when the escaping was broken, so three of the five context
tests passed against a page carrying a live `onmouseover` handler. The `">` now required at the end
of that pattern is what makes a leaked quote a failure rather than a shorter capture.

## Deploying

There is deliberately no `deploy` npm script. From this directory:

```
npx wrangler deploy
```

Before that, check what it will upload:

```
npm run deploy:dry-run
```

Around 55 KiB, 18 KiB gzipped, and about 30 KiB of that is the two legal documents. A sudden jump
means something got bundled that should not have been.

**The apex Custom Domain is attached by the deploy.** `wrangler.jsonc` carries
`{ "pattern": "clubchatapp.com", "custom_domain": true }`, and attaching it creates the apex DNS
record, which does not exist today. A route naming a zone the account does not hold fails
`wrangler deploy` outright rather than at request time, so that line is also the assertion that the
zone is held.

## There are no secrets in this Worker

Every value it holds is published in a file it serves, or is a hostname anyone can resolve. So they
are `vars` in `wrangler.jsonc` rather than `wrangler secret put`, **there is no `.dev.vars` and no
`.dev.vars.example` in this package**, and nothing here must be kept out of a log. That is the
opposite of `packages/cdn-worker`, whose one secret mints a valid URL for every object in both
buckets, and the difference is worth knowing before copying a pattern between the two.

| Var | What it is |
|---|---|
| `API_ORIGIN` | Where the join page reads the club name from |
| `IOS_APP_ID` | `TEAMID.BUNDLEID`, published in the AASA file |
| `IOS_INSTALL_URL` | Where the iPhone app can be installed from. **Empty: see below** |
| `ANDROID_PACKAGE_NAME` | The Android application id, published in `assetlinks.json` |
| `ANDROID_CERT_FINGERPRINTS` | Android signing SHA-256 fingerprints, comma separated |

`IOS_APP_ID` is `NT7NNC4FJC.com.parkstechusa.clubchat.remastered`, and the team id half of it
(`NT7NNC4FJC`) is the one value here that **cannot be derived from this repo**. `apps/mobile/ios` is
generated by Expo CNG and gitignored, its `project.pbxproj` carries no `DEVELOPMENT_TEAM`, and EAS
holds the signing credentials remotely. It was supplied by the founder on 2026-08-25 and is pinned
by `test/associations.test.ts` so that it cannot be changed without a test changing with it.

It matters more than it looks. A wrong team id produces an AASA file that is valid JSON, that Apple
fetches and parses, and that then fails the comparison against the entitlement on the phone: the
link opens in Safari, nothing is logged anywhere, and nobody is told. `/__parity` prints it because
there is no other way to see what is actually deployed.

## There is no App Store listing, and the pages say so

`IOS_INSTALL_URL` is **empty in the repo**, and that is the whole of the private-beta behaviour.

ClubChat has never been released. App Store Connect app id 6804458376 exists, and a record in App
Store Connect is not a listing: on 2026-08-25 `https://apps.apple.com/app/id6804458376` answered
`404` and `https://itunes.apple.com/lookup?id=6804458376` answered
`{"resultCount":0,"results":[]}`. Distribution is TestFlight internal only. The page used to build a
store link out of that id, which made the join page's primary call to action - the entire point of
the page - an Apple error page for somebody who had just scanned a QR code.

While the var is empty, every page:

- renders **no** download button, and no empty button row either, so nothing reads as half-finished,
- says plainly: *ClubChat is in private beta. It is not on the App Store, and the only way to get it
  is an invite from somebody already using it*, with one further sentence per page saying who to
  ask,
- keeps the `clubchat://` deep link on the join pages, which works for anybody who already has it.

**One value turns the button back on, everywhere, with no code change: `IOS_INSTALL_URL` in
`wrangler.jsonc`.** Set it and redeploy. It holds a URL rather than a store id so that both endings
fit the same var and the same button:

```
"IOS_INSTALL_URL": "https://apps.apple.com/app/id6804458376"      // a public App Store listing
"IOS_INSTALL_URL": "https://testflight.apple.com/join/XXXXXXXX"   // a public TestFlight link
```

The button reads "Get ClubChat for iPhone" either way, which is why the destination can change
without the copy changing. Anything that is not an `https:` URL is treated as unset - the private
beta page is shown rather than a broken link - and `/__parity` reports `installUrl: null` when that
happens, so a typo is visible in one request rather than by reading the pages.

## The Android fingerprint is not set, and that is visible rather than hidden

`ANDROID_CERT_FINGERPRINTS` is empty in the repo, because no Android build has been signed. While
it is empty, `/.well-known/assetlinks.json` answers `[]`.

That is a deliberate choice between three wrong-in-different-ways options. A placeholder fingerprint
would publish a claim that fails verification while the file looks correct, which is the failure
that takes longest to find. A 404 is indistinguishable from the file never having been deployed. An
empty statement list is a valid Digital Asset Links document that says, precisely, that no app is
currently associated with this domain.

Set it with one `wrangler.jsonc` edit and a redeploy. Expect **two** values once Play App Signing is
on - the upload key and the Play-held app signing key - comma separated. Publishing only one of them
verifies for exactly half the installs.

## The other half of universal links is in the app, and it is not in this package

These two files are necessary and not sufficient. Three things outside this package have to be true
as well, and two of them are not:

- **`apps/mobile/app.json` declares `ios.associatedDomains` of `["applinks:clubchatapp.com"]`** - no
  scheme inside the value, and the Android `intentFilters` entry for `https://clubchatapp.com/join`
  with `autoVerify: true` beside it. Both are present as of 2026-08-25.
- **A native rebuild has to ship.** `associatedDomains` becomes an entitlement compiled into the
  binary at prebuild, so it cannot arrive over `eas update`: it is an `eas build` and a new install.
  The build on the founder's phone predates the entry and will keep opening these links in Safari
  until it is replaced.
- **The Associated Domains capability has to be enabled on the Apple App ID** for team `NT7NNC4FJC`
  in the developer account. That is an account-side change, not a repo change; EAS turns it on when
  it manages credentials, and a build signed without it carries no entitlement no matter what
  `app.json` says.

Until all of that exists, an https invite link lands on this Worker's page and the visitor taps
through, which is the degraded behaviour this Worker was built to provide anyway. Nothing breaks in
the meantime; the link is simply one tap longer.

`/join/*` is the only path claimed. A component list is an allowlist, and `/privacy` and `/terms`
must open in a browser because the app itself links to them - an app that opened its own legal pages
by launching itself would be a loop.

## The legal text is bundled at build time

`docs/legal/privacy-policy.md` and `docs/legal/terms-of-service.md` are the only copy of that text
in the repo. The mobile app links out to `/privacy` and `/terms` rather than embedding anything.

The `Text` module rule in `wrangler.jsonc` turns those two files into strings at bundle time, so:

- what is served is pinned to a commit and cannot drift from the repo,
- **a change to the text is a redeploy of this Worker**,
- a missing file is a build failure, not a Worker that serves an empty privacy policy.

### The markdown subset the renderer supports

`src/markdown.ts` is hand-written and escapes first, then interprets a fixed grammar. Anything not
on this list renders as the literal text it is, which is a visible failure on the page rather than a
silent drop. **Whoever writes the legal text should stay inside it:**

headings `#` through `######`, paragraphs, `-`/`*`/`+` bullets, `1.`/`1)` numbers, `>` blockquotes,
`---` rules, fenced code blocks, GFM pipe tables, and inline `` `code` ``, `**bold**`, `*italic*`,
`_italic_`, `[text](url)`.

Not supported: raw HTML, reference links, images, footnotes, task lists, **nested lists**, setext
headings, autolinks, HTML entities. Write `&` rather than `&amp;` - the renderer treats the source
as text and would print the entity.

Both current documents render clean: no unrendered heading, bold, pipe, list marker or empty
element in either output.

## Checking a deployment

```
curl -s https://clubchatapp.com/__parity | jq
```

```json
{
  "apiOrigin": "https://api.clubchatapp.com",
  "iosAppId": "NT7NNC4FJC.com.parkstechusa.clubchat.remastered",
  "installUrl": null,
  "androidPackageName": "com.parkstechusa.clubchat.remastered",
  "androidFingerprints": 0,
  "legal": { "privacy": 19312, "terms": 10752 },
  "version": "..."
}
```

Every misconfiguration this Worker can have is silent and presents somewhere else, which is what
that route is for:

| Symptom | What it usually is | What `/__parity` shows |
|---|---|---|
| Every join page is the degraded one | `API_ORIGIN` wrong or cleared | `apiOrigin` |
| Universal links stop opening the app | `IOS_APP_ID` wrong | `iosAppId` |
| No download button on any page | `IOS_INSTALL_URL` unset, or not an https URL | `installUrl: null` |
| Android app links never verify | no fingerprint configured | `androidFingerprints: 0` |
| `/privacy` is an empty page | the markdown did not bundle | `legal.privacy: 0` |

The two association files, checked the way the platforms fetch them:

```
curl -si https://clubchatapp.com/.well-known/apple-app-site-association | head -20
curl -s  https://clubchatapp.com/.well-known/assetlinks.json | jq
```

`content-type: application/json` on the first one is the thing to look at. A `.json` extension on
the path is the classic way to serve a correct document where nothing looks for it.

## Running it locally

```
npx wrangler dev
```

No `.dev.vars` is needed - see above. The join page will call the real
`https://api.clubchatapp.com` unless `API_ORIGIN` is overridden, and with the api unreachable it
renders the degraded page, which is itself a useful thing to look at.

The tests do not need it:

```
npm test        # 149 tests, in workerd
npm run typecheck
```

## Two things about the test suite that are a major version newer than the material

Both are in `vitest.config.ts` and `test/harness.ts` in full. Short version:

1. **`@cloudflare/vitest-pool-workers/config` no longer exists in 0.22.** The pool is a Vite plugin.
   `defineWorkersConfig` and `defineWorkersProject` are gone.
2. **`fetchMock` is gone from `cloudflare:test`.** Every recipe still shows it, and the type
   declaration file still declares the whole `MockAgent` interface while exporting no instance of
   it - which is the worst shape a removal can have. The replacement is `vi.stubGlobal('fetch', ...)`,
   which reaches the Worker because the pool runs it in the same isolate as the test file.

## The accepted gap: nothing reports a Worker error

There is no Sentry DSN at the edge and no alert on a 5xx rate, exactly as `packages/cdn-worker`
records for itself. An exception here becomes a Cloudflare error page that nobody is counting, and
Workers Logs - `observability.enabled` in `wrangler.jsonc` - is the only place it is visible at all.

That is why the one thing that can plausibly fail on a well-formed request, the api call, is turned
into a page rather than left to throw.
