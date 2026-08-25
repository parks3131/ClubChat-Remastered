# Bugs

Every bug that reached a running app - the phone, the deployed API, the web build - one row each.
Newest first.

**This file is the index and stays short.** Read it whole in under a minute or it stops being read.
The detail lives in [`bugs/`](bugs/), one file per bug, opened only when you are chasing that one.

**Three columns, and the third is the point.** What broke, what fixed it, and what went wrong
*while* fixing it. Columns one and two can be reconstructed from the commit later. Column three -
the wrong first diagnosis, the test that should have caught it, the unrelated file that had to
change - cannot be recovered by anyone once the session is over.

| Bug | Fix | What went wrong while fixing |
|---|---|---|
| **2026-08-25** · Every **5xx since launch** reached Sentry with no `where` tag, no route, no method and no user id, so every 500 in production grouped into one issue. `@sentry/node` 10 captures Fastify errors itself before the app's handler runs, and Dedupe dropped ours as the duplicate. [Detail](bugs/2026-08-25-every-5xx-arrived-anonymous.md) | `Sentry.fastifyIntegration({ shouldHandleError: () => false })`. The SDK's tracing stays; only its error capture goes. Server-side, so no app rebuild. | Found by accident while enabling tracing, not by looking for it. Nothing failed: `capture` ran and returned an event id, and the symptom was an absence on a page nobody opens. The drill's first version printed `flush completed`, which reads as delivery and cannot mean it. Needed a real client with a real transport to assert at all. |
| **2026-08-25** · A nudge told a club **"18:00 at null"** with every form field filled in. The notification read `meetups.location`, uncollected since ADR-0037 ten days earlier, and `String(null)` is a valid string so nothing refused it. [Detail](bugs/2026-08-25-nudge-said-null.md) | Nudge reads `title` (`NOT NULL`). Dropped `location`, `map_lat`, `map_lng` - [ADR-0049](SPEC/decisions/0049-a-meetup-says-where-with-a-link-and-nothing-else.md). Server-side, so no app rebuild. | First diagnosis blamed the user for a field the form does not have; the proof was already in the screenshot. Claimed a resolver "was never built" after grepping a stale comment. `calendar.ts` had to change or every `/calendar` 500s. The test asserting no `"undefined"` passed throughout - now refuses `"null"` too. **The drop then crashed the shipped app** minutes after deploying: the read stopped returning the `location` *key*, and `DetailLine` guards `value === null` before calling `value.trim()`, so absent throws where null is handled. Broke [TECH/21](SPEC/TECH/21-deployment.md) rule 4 *and* rule 5. I had checked this and said it would "degrade gracefully" - from the comment above the call site, never having opened the component. |
