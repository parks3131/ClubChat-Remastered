# ADR-0013: Store notifications as a type plus structured params, not a rendered body and route

| | |
|---|---|
| Status | Accepted |
| Date | 2026-07-29 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

v1 wrote each notification as a row carrying a **fully rendered English body** and a
**target route string**. [Data model](../TECH/09-data-model.md) and
[Domain model](../PRD/01-domain-model.md) both still described that shape when Phase 1 began,
because they were written from the v1 build.

Two separate recorded defects trace to it, and Phase 1 is the last moment either can be fixed
cheaply.

**The route string.** [Engineering pitfalls](../TECH/14-engineering-pitfalls.md) 8: *"Storing a
route string on a notification means every function that matches on that route must be updated
together. Changing one literal left approvals permanently unresolved for eight migrations."* A
stored route is a duplicated constant, spread across as many historical rows as the product has
ever sent, and every consumer that matches on it becomes coupled to a string nobody can safely
change.

**The rendered body.** [Build phases](../TECH/16-build-phases.md) debt 11 requires storing a
type plus structured params and rendering at read time, with an explicit instruction:
*"Design it in now - retrofitting means rewriting every historical row."* Notification bodies
are built server-side in English, which makes them unlocalizable and untestable from the client.
The table also grows unbounded, so the retrofit cost only ever increases.

The two problems have the same shape: a rendered artefact frozen into a row at write time, when
the information needed to produce it is available at read time.

## Decision

We will store `(type, params jsonb)` on each notification and **derive both the display text and
the navigation target at read time**. The `body` and `target` columns will not exist.

## Consequences

| | |
|---|---|
| Positive | Localisation becomes a client-side render over structured data rather than a migration over history, which is debt 11 closed rather than deferred. Changing a route becomes editing one mapping function, which is pitfall 8 made structurally impossible. Notification text becomes unit-testable per type. Rows get smaller, which matters for a table with no archival path yet. Push payloads render from the same one function as the inbox, so the two cannot disagree - a real risk when a push says one thing and the row it links to says another. |
| Negative | Reading a notification now costs a render, and a param whose referent was deleted must degrade to sensible text rather than crashing. That is required behaviour anyway: [Notifications](../PRD/12-notifications.md) rule 6 says tapping a row is always safe and a row pointing at something the user has lost access to must fail gracefully. The renderer is also a new place a missing case can hide, so it is exhaustive over the type union and its test asserts every type renders. |
| Follow-up needed | `params` is a schemaless column holding what is effectively a contract. Each type's params are declared as a Zod schema in `packages/shared` and validated when the notification is written, so a malformed param is caught at write time rather than surfacing as broken text in someone's inbox months later. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep v1's rendered `body` and `target`, as `TECH/09` described | Carries both recorded defects forward into a table that grows unbounded and has no archival path, so the cost of changing course rises every day. Debt 11 explicitly instructs designing this in now for exactly that reason. |
| Store `type` + `params` **and** a rendered `body` alongside them | Two representations of the same text, which will drift the moment a renderer changes and a historical row does not. It also answers "which one is authoritative?" with "whichever the reader happened to use". Drift between two definitions of one thing is the failure mode ADR-0002 exists to eliminate; reintroducing it here for convenience would be inconsistent. |
| Keep the route string but derive the body | Fixes the smaller half. The route is the one that actually shipped a bug lasting eight migrations. |
| Render at write time into the recipient's stored locale | Requires a locale on every user before any notification exists, re-renders nothing when someone changes language, and still rewrites history for a copy edit. It moves the retrofit rather than removing it. |
