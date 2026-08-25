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
| **2026-08-25** · A nudge told a club **"18:00 at null"** with every form field filled in. The notification read `meetups.location`, uncollected since ADR-0037 ten days earlier, and `String(null)` is a valid string so nothing refused it. [Detail](bugs/2026-08-25-nudge-said-null.md) | Nudge reads `title` (`NOT NULL`). Dropped `location`, `map_lat`, `map_lng` - [ADR-0049](SPEC/decisions/0049-a-meetup-says-where-with-a-link-and-nothing-else.md). Server-side, so no app rebuild. | First diagnosis blamed the user for a field the form does not have; the proof was already in the screenshot. Claimed a resolver "was never built" after grepping a stale comment. `calendar.ts` had to change or every `/calendar` 500s. The test asserting no `"undefined"` passed throughout - now refuses `"null"` too. |
