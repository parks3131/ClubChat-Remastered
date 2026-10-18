# 4. Security and privacy

## 4.1 The rules

1. **Clubby acts as the member.** It sees exactly what they see in the app, through the same
   functions, and nothing more.
2. **Read-only, enforced twice.** There are no write tools, and the token's only scope is
   `clubchat.read`. When stage two adds `clubchat.write`, a stage-one connection still cannot write.
3. **The account check runs on every call**, not only at sign-in.
4. **Nothing is marked read.** The read cursor also decides who gets a push (ADR-0008); moving it
   from a car would silence notifications the member never saw.
5. **Direct messages are included**, the member's own only (decision D6).
6. **The member is told where their data goes.** The Allow page and the privacy policy both say that
   what Clubby reads, direct messages included, is sent to Anthropic to answer the member.

## 4.2 The proofs

Non-negotiable 7: each is a test that attempts the forbidden thing and watches it refused. Each is
seen to fail before the code that makes it pass.

| # | Attempt | Expected |
|---|---|---|
| 1 | Member A's token reads a club, chat, race, poll or news feed A is not in | "Not found", nothing leaked |
| 2 | Member A's token reads a direct message between B and C | "Not found" |
| 3 | A suspended account's still-valid token calls any tool | 401 on that call |
| 4 | A deleted account's still-valid token calls any tool | 401 on that call |
| 5 | A token with the wrong audience, a wrong issuer, an expired one, or one signed by another key | 401 |
| 6 | A token without `clubchat.read` | 403 with `error="insufficient_scope"` |
| 7 | An app session token (better-auth's bearer) sent to `/mcp` | 401: `/mcp` accepts only its own tokens |
| 8 | An `/mcp` OAuth access token sent to any REST route | 401: the app does not accept Clubby's token |
| 9 | Any tool, then the member's unread counts and notification read state | Unchanged |
| 10 | More calls than the per-user limit allows | Refused like any route |
| 11 | An upper-case uuid argument | Same answer as the lower-case one (failure mode 36) |
| 12 | `/mcp` with no token | 401 with `WWW-Authenticate` naming the resource metadata |

Proofs 1 to 4 also run over TCP in `gate:surface`, the same way every route is checked today.

## 4.3 What stage one cannot prevent

**Chat text reaches the model.** A message in a club chat or a DM can contain text written to steer
an AI ("ignore your instructions and..."). In stage one there is nothing in ClubChat for it to steer
Clubby into doing, because no tool writes. If the member has *other* connectors switched on in
Claude (email, files), a hostile message could try to push Claude toward those. Our part is to label
chat text in tool output as quoted member content; the boundary itself is Claude's. Read-only is
what keeps this from being a ClubChat problem in stage one, and it is the first thing stage two has
to design for, together with a read-back-and-confirm step before any send.

## 4.4 Privacy follow-ups

- A line in the privacy policy (`docs/legal/`) naming Anthropic as a processor when a member
  connects Clubby, and that direct messages are included.
- The Allow page says the same in plain words before the member presses Allow.
- A member disconnects from Claude's settings. A "connected apps" control inside ClubChat is a
  reasonable later addition, not part of stage one.
