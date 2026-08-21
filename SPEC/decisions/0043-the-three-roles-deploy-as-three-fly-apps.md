# ADR-0043: The three roles deploy as three Fly apps from one image

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-21 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

`packages/server` has three entrypoints over one dependency graph: `src/api/main.ts`,
`src/gateway/main.ts` and `src/worker/main.ts`. [Overview](../TECH/00-overview.md) and
[Deployment](../TECH/21-deployment.md) both record that the boundary that matters is the *code*
boundary, so how many deployables exist stays a deploy-time choice rather than a refactor.

[Deployment](../TECH/21-deployment.md) listed the choice itself as Open: three Fly apps, or one Fly
app with three process groups. Nothing had ever been deployed, so the question had never been
forced. It is forced now, because it decides the shape of every config file the first deploy needs.

Three facts about Fly settle it, and a fourth that looks decisive does not.

- **Fly Proxy selects a service by port, and has no hostname discriminator inside an app.** A
  shared IPv4 address picks the *app* by domain, but once inside one app there is nothing to route
  `api.<domain>` and `ws.<domain>` apart. Rule 8 requires both names, chosen once and never
  changed, because they are baked into every installed build.
- **`fly deploy` updates every process group as a group.** Restricting a release to one group means
  passing `--process-groups` on every single deploy, forever, without forgetting.
- **The Fly registry is scoped per organization rather than per app**, so one built image can be
  pushed once and deployed to several apps by digest.
- **The gateway does NOT require an L4 path on Fly, and this argument must not be reused.** The
  comment at the top of `gateway/main.ts` says the gateway sits behind an L4 balancer because
  balancers that terminate HTTP break the WebSocket upgrade. That is true of L7 balancers in
  general and false of Fly, whose HTTP handler proxies upgrades because an upgrade is HTTP/1.1.
  The claim was checked and refuted rather than inherited. It is recorded here because it is
  persuasive, wrong, and would otherwise be rediscovered and believed.

## Decision

We will deploy `api`, `gateway` and `worker` as **three Fly apps built from one image**, pushed
once and deployed to all three by digest, with each app's start command selecting the role.

We will additionally run both the api and the gateway as Fly `http_service`, not as raw TLS
services, because a raw TCP service can carry only a `tcp_check`, which proves a port is listening
and cannot distinguish that from working. That blind spot is the specific thing this deploy exists
to remove.

## Alternatives

| Option | Why not |
|---|---|
| One app, three process groups | Cannot give `api.` and `ws.` separate hostnames without running our own routing hop inside the app, and makes "an api deploy must not drop every live socket" an operator habit rather than a property of the system. |
| Three apps, three separate builds | Three images that can drift from one another, which contradicts the one-image note in [Overview](../TECH/00-overview.md) and removes the guarantee that all three roles are running the same commit. |
| Raw TLS service for the gateway | Only a TCP check is available, so a gateway that is listening but cannot reach Postgres would pass its check and take sockets. |

## Consequences

| | |
|---|---|
| Positive | `api.` and `ws.` are separate hostnames on separate apps, so a provider move stays a DNS change. The api can roll while the gateway holds connections, structurally rather than by remembering a flag. Each role gets its own metrics, scaling and release history. One digest across all three keeps "one image, three roles" literally true. |
| Negative | Three secret stores instead of one. `BETTER_AUTH_SECRET` must be byte-identical on the api and the gateway, and drift between them presents as "sign-in works but chat will not connect" rather than as an error. Set both from one source, never by hand twice. |
| Follow-up needed | Migrations run once per release as the api app's `release_command`, so the api is deployed first. The gateway's `idle_timeout` is set explicitly because the platform default is undocumented. The `gateway/main.ts` L4 comment is now misleading and is corrected in the same change as this ADR. |
