# 2. Architecture

The diagrams below are Mermaid, so they render on GitHub. The same pictures, drawn more carefully,
are in [`visual/clubby-connector.html`](visual/clubby-connector.html).

## 2.1 The three MCP roles, and which one we build

| MCP role | What it is here | Who builds it |
|---|---|---|
| **Host** | The Claude app on the member's phone or computer. Where they type or talk. | Anthropic |
| **Client** | Claude, running in Anthropic's cloud. Picks a tool and calls our server. | Anthropic |
| **Server** | `https://api.clubchatapp.com/mcp`, a new entrance on our API. | **Us** |

**We do not write an MCP client.** Claude is the client, and so is any other MCP-speaking app a
member might use. Remote connectors are called from Anthropic's servers, not from the phone, so our
server must be reachable on the public internet, which the API already is.

## 2.2 Where it fits in the system

```mermaid
flowchart LR
    subgraph PHONE["Member's phone"]
        APP["ClubChat app"]
        CAPP["Claude app"]
        BROWSER["Browser<br/>first sign-in only"]
    end

    subgraph ANTH["Anthropic's cloud"]
        CLAUDE["Claude<br/>the MCP client"]
    end

    subgraph FLY["ClubChat servers on Fly.io"]
        GW["Gateway<br/>live chat"]
        WK["Worker<br/>pushes, effects"]
        subgraph API["API"]
            REST["REST routes<br/>(existing)"]
            MCP["/mcp<br/>NEW: 13 read-only tools"]
            PAGES["Sign-in and Allow pages<br/>NEW"]
            CORE["Same core (existing)<br/>account check, rate limit,<br/>domain reads, policy rules"]
        end
    end

    PG[("Postgres<br/>Neon")]

    APP -->|WebSocket| GW
    APP -->|HTTPS| REST
    CAPP -->|voice or text| CLAUDE
    CLAUDE -->|"HTTPS + token"| MCP
    BROWSER -.->|"sign in, press Allow"| PAGES
    GW --> API
    REST --> CORE
    MCP --> CORE
    PAGES --> CORE
    CORE --> PG

    classDef new fill:#ffe3d8,stroke:#ff4d00,stroke-width:2px,color:#191c1e
    classDef ext fill:#e7edf3,stroke:#61778f,color:#191c1e
    class MCP,PAGES new
    class CAPP,CLAUDE ext
```

**What is new:** the `/mcp` route group, the sign-in and Allow pages, the OAuth metadata documents,
and the tables that hold OAuth clients and tokens. **What is unchanged:** the gateway, the worker,
Redis, R2, the CDN, the mobile app, every read function and every policy rule. No new Fly app and no
new database.

## 2.3 Inside the API: a new entrance, the same building

```mermaid
flowchart TB
    A1["ClubChat app"] --> R1["REST routes"]
    B1["Claude"] --> M1["/mcp entrance (NEW)"]
    R1 --> W1["Who are you?<br/>app session (better-auth)"]
    M1 --> W2["Who are you? (NEW)<br/>OAuth access token: audience /mcp,<br/>scope clubchat.read"]
    W1 --> AC["Account check<br/>loadAccessContext + isSessionUsable,<br/>on every request"]
    W2 --> AC
    AC --> RL["Rate limit<br/>the same per-person limiter"]
    RL --> H1["Route handler<br/>e.g. GET /calendar"]
    RL --> T1["Tool (NEW)<br/>e.g. my_calendar"]
    H1 --> D["Domain read<br/>e.g. readCalendarFeed: one function, both callers"]
    T1 --> D
    D --> P["Policy rules<br/>packages/server/src/policy"]
    P --> DB[("Postgres")]

    classDef new fill:#ffe3d8,stroke:#ff4d00,stroke-width:2px,color:#191c1e
    class M1,W2,T1 new
```

Today `packages/server/src/api/app.ts` (around lines 551 to 660) runs `authenticate()` (session,
then `loadAccessContext`, then `isSessionUsable`), then the per-user limiter, then the uuid hook,
inside one `protectedRoutes` scope. **`/mcp` must not be registered inside that scope**, because
that scope accepts an app session and `/mcp` must accept only its own OAuth tokens (the MCP spec:
a server "MUST only accept tokens that are valid for use with their own resources"). So `/mcp` gets
its own scope with its own first step, and then **reuses** the same account check and limiter.
Extract the shared half of `authenticate()` into one function both scopes call, rather than
restating it (failure mode 10).

## 2.4 Connecting for the first time

```mermaid
sequenceDiagram
    autonumber
    actor You as Member (phone and browser)
    participant C as Claude (Anthropic's cloud)
    participant A as ClubChat API

    You->>C: Add ClubChat as a custom connector (at claude.ai)
    C->>A: POST /mcp with no token
    A-->>C: 401, WWW-Authenticate points at protected-resource metadata
    C->>A: GET /.well-known/oauth-protected-resource
    C->>A: GET /.well-known/oauth-authorization-server
    Note over C,A: Claude registers itself: a Client ID Metadata Document if we advertise it,<br/>otherwise Dynamic Client Registration
    C->>You: Opens ClubChat's sign-in page (PKCE, resource = .../mcp)
    You->>A: Email and password, then Allow
    A-->>C: Redirect to https://claude.ai/api/mcp/auth_callback with a one-time code
    C->>A: Swap the code for tokens (token endpoint)
    A-->>C: Access token (short-lived JWT) and refresh token
    C->>A: POST /mcp with the token: connected
```

## 2.5 One question

```mermaid
sequenceDiagram
    autonumber
    actor You as Member
    participant C as Claude
    participant A as ClubChat API
    participant DB as Postgres

    You->>C: "What's on my calendar this week?"
    C->>A: tools/call my_calendar {when: upcoming}, Bearer token
    A->>A: verify token (signature, issuer, audience, expiry, scope)
    A->>DB: loadAccessContext(user), isSessionUsable
    A->>A: rate limit
    A->>DB: readCalendarFeed(ctx)
    A-->>C: "Tue 6 pm track practice (Running Club), Sat 8 am long run"
    C->>You: Says or shows the answer
```

Nothing is written. No read cursor moves, no notification is marked read.

## 2.6 The endpoints

| Path | Method | Who calls it | Purpose |
|---|---|---|---|
| `/mcp` | POST | Claude | MCP over Streamable HTTP, stateless. GET and DELETE answer 405 |
| `/.well-known/oauth-protected-resource` (and the `/mcp`-suffixed form) | GET | Claude | Says which authorization server issues tokens for `/mcp` (RFC 9728) |
| `/.well-known/oauth-authorization-server` | GET | Claude | Authorization server metadata (RFC 8414) |
| authorize, token, register, consent, JWKS | various | Claude, the browser | Provided by the better-auth OAuth provider plugin; exact paths from its docs |
| sign-in page, Allow page | GET, POST | The member's browser | Two plain HTML pages the API serves itself |

Confirm the exact well-known paths against the spec and the plugin at build time. The spec checks
both the root form and the path-suffixed form.

## 2.7 Packages

All server-side. Nothing in `apps/mobile` changes.

| Package | Version on 2026-10-18 | Why |
|---|---|---|
| `better-auth` (and `@better-auth/*`) | 1.6.25 installed, 1.7.10 needed | The OAuth plugins below require `^1.7.10` |
| `@better-auth/oauth-provider` | 1.7.10 | Makes ClubChat an OAuth 2.1 authorization server |
| `better-auth/plugins` `jwt` | with better-auth | Signs access tokens; publishes the JWKS |
| `@better-auth/cimd` | 1.7.10 | Client ID Metadata Documents, which the MCP spec prefers |
| `@modelcontextprotocol/server` | 2.3.1 | The MCP server SDK, v2 (depends on `zod ^4.2.0`; the server is on `^4.4.3`) |
| `@modelcontextprotocol/node` | 2.1.1 | `NodeStreamableHTTPServerTransport` |
| `@modelcontextprotocol/fastify` | 2.0.1 | Fastify helpers; peer `fastify ^5.2.0` (the server is on `^5.10.0`) |

Not used: better-auth's older `mcp` plugin (built on the OIDC provider, no Client ID Metadata
Document support). See [`06-decisions.md`](06-decisions.md) D2.

## 2.8 Proposed files

A proposal for the builder, not a requirement. Mirror the closest existing pattern (AGENTS.md 2.1).

| File | Holds |
|---|---|
| `packages/server/src/auth.ts` | Adds `oauthProvider`, `jwt` and `cimd` to the existing plugin list |
| `packages/server/src/api/routes/mcp.ts` | The `/mcp` scope: token check, shared account check and limiter, hand-off to the transport |
| `packages/server/src/api/routes/oauth-pages.ts` | The sign-in and Allow pages and their form posts |
| `packages/server/src/mcp/server.ts` | Builds an `McpServer` for one request and registers the tools |
| `packages/server/src/mcp/tools/*.ts` | One file per tool or per area, each a thin call into `domain/` |
| `packages/server/src/mcp/speak.ts` | Pure formatting: turning envelopes and feed items into short answers. Unit tested |
| `packages/server/src/db/migrations/00NN_oauth_provider.sql` | The plugin's tables; number claimed per AGENTS.md 2.5 item 7 |
| `packages/server/src/api/plumbing.ts` | `authorizeChannels` refactored to take an `AccessContext`; the HTTP wrapper keeps its signature |

## 2.9 Tokens

- **Access token**: a JWT signed by our JWKS, with `iss` = our auth base URL, `aud` =
  `https://api.clubchatapp.com/mcp`, `sub` = the user id, `scope` = `clubchat.read`. Verified
  locally on every request; no introspection round trip. Short-lived (minutes, not days).
- **Refresh token**: rotated on every use. Claude refreshes on a 401 and up to five minutes before
  expiry, and expects `invalid_grant` when a refresh token is dead.
- **Never trusted on its own**: after the signature, `/mcp` loads the access context and asks
  `isSessionUsable`, so a suspended or deleted account stops on its next call (failure modes 12, 20).
- **Not interchangeable with an app session**, in either direction. Both refusals are proofs in
  [`04-security-and-privacy.md`](04-security-and-privacy.md).

## 2.10 Stateless

One `McpServer` and one transport per request, no MCP session ids. That is the SDK v2 pattern for
a server like this one: it scales with the API machines Fly already runs, needs no sticky routing,
and holds nothing that a deploy could lose.
