# ADR-0011: TypeScript on Node, hosted on Fly.io, with self-hosted auth

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-28 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

ADR-0002 introduced an application server, which raised three implementation choices at once:
what language it runs, where a process holding long-lived WebSocket connections lives, and who
owns identity. The client is Expo (iOS, Android, web), and the database is Neon Postgres.

## Decision

We will write the gateway, API and worker in **TypeScript on Node 24**, host them on
**Fly.io** (with the web client on Vercel), and handle authentication with **`better-auth`,
self-hosted in our own Postgres**.

## Consequences

| | |
|---|---|
| Positive | One language across client and server, with validation schemas shared end-to-end so the wire format cannot drift. A long-running container is the natural home for a connection registry. Identity in our own Postgres keeps the whole domain in one transactional store, which matters most for account deletion: anonymise and block future sign-in becomes one transaction rather than a two-system dance. |
| Negative | Node's concurrency ceiling is lower than the alternatives, though far above the ~3,000 concurrent connections targeted. Self-hosting auth means owning password reset and email deliverability. |
| Follow-up needed | A transactional email provider is now required and blocks sign-up. Revisit the runtime only if a load test genuinely disappoints, not on preference. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Elixir / Phoenix | Genuinely the better fit for this shape - Channels, PubSub and Presence supply much of the transport layer, on the runtime the reference architecture itself is built on, with better behaviour under connection churn. Rejected because the transport we actually need is modest, and shared types with the Expo client are a daily benefit against a second ecosystem to learn. The closest call in this document. |
| Go | Excellent socket performance and trivial deployment, but no shared types with the client and more boilerplate in the domain layer, which is where most of the code lives. |
| All-on-Vercel | Functions now support WebSockets, but a connection registry wants a long-lived process, and function lifecycle churn works against that. |
| Clerk (managed auth) | Handles reset flows and deliverability, at the cost of identity living with a vendor and account deletion spanning two systems. |
| Hand-rolled auth | Requirements are genuinely modest, but password reset and token rotation are exactly the code where a subtle bug is a security bug. |
