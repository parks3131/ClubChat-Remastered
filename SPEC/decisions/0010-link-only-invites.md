# ADR-0010: Invite by share link only, with no typed invite code

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

v1 offered two ways into a club by invitation: a share link, and a short invite code a person
could type into a form. Both carried the same secret - the link simply embedded the code - so
they were one mechanism with two front doors.

The typed code forced two design compromises. It had to be short enough to type, and it had to
match case-insensitively because people type inconsistently. Both properties exist only to serve
manual entry, and both weaken the token.

## Decision

We will surface the invite token **only** inside a share link. There will be no code-entry
screen anywhere in the product, and the token becomes 32 bytes of CSPRNG output, base64url,
matched exactly and case-sensitively.

## Consequences

| | |
|---|---|
| Positive | One invite path instead of two. The token stops being enumerable, since the length and case-insensitivity that made it guessable existed only to make it typeable. One less screen, one less form, one less error state. |
| Negative | Loses the fallback for a deep link that fails to resolve - the classic case being tap link, app not installed, install, open, link context lost. Mitigated by a real web client: the link opens the club in a browser and the join completes there. **This must be verified deliberately on both platforms**, because a link that dead-ends on Android is now a total loss of the invite path rather than an inconvenience. |
| Follow-up needed | Link rotation is promoted from an open question to a requirement. The link is now the only way in, so a leaked one has no alternative and rotating the token is the sole remedy. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep both the link and the typed code | Two mechanisms sharing one secret, where the weaker one dictates the token's shape. The code forced a short, case-insensitive token on the link as well. |
| Keep a typed code as a hidden fallback for failed deep links | Keeps the entire code-entry surface - screen, validation, error states, case handling - to serve a case the web fallback already covers. |
| Longer typed code | Solves enumerability by making the code unusable for its only purpose. |
