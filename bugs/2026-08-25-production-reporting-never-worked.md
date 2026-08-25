# Production error reporting never worked, and five layers said it did

**Found** 2026-08-25, while trying to prove a forced 5xx could reach a human. **Live since the
first deploy on 2026-08-23**, so every production error in that window was lost.

## What broke

Sentry refused every event sent from production:

```
HTTP 403  {"detail":"event submission rejected with_reason: ProjectId"}
```

`fly/{api,gateway,worker}.toml` all carried the key `f4737021a3d55097c56ff4c479b9cdaa`. The
project has exactly one client key and it is `f4737021da01d0ecb8922534cd123364`. The two share
their first eight characters and diverge completely after that, which is not chance: the value was
produced from the real one rather than copied from it.

## What made it invisible

Every layer reported success, which is the part worth keeping:

| Layer | What it said | Why it could not know |
|---|---|---|
| `loadConfig` | accepted | The value is present and shaped like a DSN |
| Config-completeness check | passed | It feeds `[env]` through the real `loadConfig`. Proves PRESENCE |
| `Sentry.init` | accepted | The SDK never validates a DSN against the server |
| The transport | delivered | Sentry accepted the CONNECTION and rejected the EVENT |
| `Sentry.flush()` | returned `true` | The queue drained. That is all it means |
| `Monitor.flush` | returns `void` | It swallows the SDK's flag by design, so a caller cannot fail on reporting |

The forced-5xx drill was run earlier the same day, reported `status=500` with the correct `where`
tag and route context, and looked exactly like a pass. It proved the error handler works. It could
not have proved delivery, because delivery is not observable from inside the process.

The only external signal was an absence: Sentry's environment picker offered `development` and
never `production`. That was read at first as "production has not errored", which was the wrong
half of a two-way ambiguity.

## The fix

The real DSN in all three tomls, redeployed. Then `scripts/drills/sentry-ingest-check.mjs`, which
POSTs one event and prints the HTTP status: 200 accepted, 403 wrong key, 429 rate limited, 401
disabled. Verified both ways before committing - 403 and exit 1 on the invented key, 200 and exit 0
on the real one. It tags itself `environment=dsn-check` so a configuration test never lands in a
real environment's history.

The mobile DSN in `eas.json` was checked at the same time and is valid.

## What went wrong while fixing it

**The first diagnosis was wrong and was mine.** Seeing the fallback logger print and `flush` return
`undefined`, I read it as "the DSN is missing". Both were normal: `capture` logs every time by
design, and `flush` returns `void` by design. Reading the code settled it in one look, and asserting
it first would have sent the whole investigation sideways.

**The second wrong turn was blaming a change made the same hour.** A `beforeSend` hook had just been
added for URL redaction, and a `beforeSend` that throws makes Sentry drop events silently. That was
a reasonable suspect and it was innocent. The raw-SDK probe, which bypassed the wrapper entirely,
is what cleared it.

**The thing that actually settled it was leaving the process.** Not the SDK, not the logs, not the
config: a `fetch` to the ingest endpoint printing a status code. There is no `curl` in the image,
which is worth knowing before reaching for one at 3am.
