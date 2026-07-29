# Stack and hosting

| Layer | Decision | Rationale |
|---|---|---|
| **Client** | Expo (React Native) + Expo Router, iOS / Android / web | Unchanged. [Screen map](../PRD/15-screen-map.md) and [Notifications and push](06-notifications-and-push.md) are real shipped work worth keeping. |
| **Local store** | `expo-sqlite` (OPFS on web) | Offline reads, outbox, cursors. |
| **Server language** | **TypeScript / Node 24** - *decided* | Shared types with the Expo client end-to-end. Node handles thousands of sockets comfortably at this scale. Elixir/Phoenix was the honest alternative (better under connection churn, the runtime WhatsApp itself uses); rejected because the transport we need is modest and the shared-contract win is daily. Revisit only if a load test disappoints. |
| **HTTP + WS** | Fastify (or Hono) + `ws` | Small, fast, no framework opinions to fight. |
| **Validation / contract** | Zod schemas shared between client and server | One definition per payload; the client cannot drift from the wire format. |
| **DB access** | Drizzle | SQL-shaped, typed, migrations as files. **A migration is never edited after being applied** (`Old.md` [Media pipeline](07-media-pipeline.md)). |
| **Database** | Postgres 17, managed (Neon / RDS / Fly Postgres) | Managed hosting was never the problem; putting logic in the DB was. |
| **Cache / bus** | Redis (Upstash or a managed instance) | Registry, pub/sub, rate limits. Never a source of truth. |
| **Event log** | Kafka, downstream of the outbox - *decided* | Durable replayable event log with independent consumer groups. Explicitly a learning goal, not a scaling requirement; recorded as such in [Effects engine](04-effects-engine.md). Redpanda or Kafka in Docker for local dev. **Hosted provider still open - see [decisions/](../decisions/).** |
| **Object storage** | S3-compatible (Cloudflare R2 recommended - zero egress) + CDN | Media egress is the dominant variable cost. |
| **Auth** | `better-auth`, self-hosted, in our Postgres - *decided* | Email/password only. Identity in our own Postgres keeps the entire domain in one transactional store, which matters most for account deletion: anonymise + block future sign-in becomes one transaction rather than a two-system dance. We own password reset and email deliverability (transactional email provider needed - see [decisions/](../decisions/)). |
| **Push** | Expo Push Service → APNs / FCM | One adapter, three platforms. |
| **Error monitoring** | Sentry, wired into the error path **from day one** | [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) lists its absence as release-blocking. |
| **Hosting** | Gateway + API + Worker on **Fly.io**; web client on Vercel - *decided* | The gateway holds long-lived connections and needs a long-running process. Postgres colocated on Fly (or Neon in the same region); Redis via Upstash. |
| **Testing** | Vitest; a table-driven permission-matrix suite; Testcontainers Postgres for handler tests | [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md): the matrix is hand-verified today. That ends. |
