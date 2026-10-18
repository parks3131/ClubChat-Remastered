# Clubby: ClubChat as an MCP server

**Status: planned, not started.** Written 2026-10-18 against commit `bd53548` on `main`. The approach
was agreed with the founder in conversation the same day. No code exists yet, and nothing in this
folder has been run.

**If you are the agent picking this up, read [`CLAUDE.md`](CLAUDE.md) first.** It is your brief:
where to work, what to read, where to stop and ask. This README is the overview for everybody else.

---

## In one paragraph

Clubby is how a ClubChat member talks to their clubs through an AI. In stage one, Clubby is
**Claude plus a ClubChat connector**: we add an MCP server to the existing ClubChat API, the member
adds it once to their Claude account, and from then on they can ask the Claude app, typed or by
voice, things like "what's on my calendar this week?" or "did Sam message me?". Clubby reads what
that member can already read in the app, and **changes nothing**: no sending, no voting, nothing
marked as read. Doing things is stage two, deliberately much later.

## Why a connector and not an assistant inside the app

The founder's real goal is Clubby inside ClubChat: a mic button in the app. That needs ClubChat to
pay an AI provider for every question every member asks, and there is no budget for that today. A
connector costs ClubChat nothing per question, because the member's own Claude plan pays for the
AI. The tools built here are reused unchanged if the in-app Clubby is built later. See
[`06-decisions.md`](06-decisions.md), decision D0.

## Read in this order

| File | Answers |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | The implementing agent's brief: rules, stops, definition of done |
| [`01-product.md`](01-product.md) | What Clubby does for a member, and what it never does in stage one |
| [`02-architecture.md`](02-architecture.md) | Where it sits in the system, layer by layer, with diagrams |
| [`03-tools.md`](03-tools.md) | The 13 tools: inputs, outputs, and which existing function each calls |
| [`04-security-and-privacy.md`](04-security-and-privacy.md) | The rules, and the tests that prove each one |
| [`05-build-plan.md`](05-build-plan.md) | Seven steps, each with what "done" means |
| [`06-decisions.md`](06-decisions.md) | Every decision so far, with the rejected alternative |
| [`07-risks-and-unknowns.md`](07-risks-and-unknowns.md) | What is not known yet, and how each one gets settled |
| [`visual/clubby-connector.html`](visual/clubby-connector.html) | The diagrams as one page; open it in a browser |

The same page is published privately for the founder at
https://claude.ai/artifact/XdCzc1QwYTQjD4vw7SpW55. The copy in `visual/` is a snapshot of it.

## Where this folder lives, and what happens to it

`docs/` holds proposals that are not yet part of the spec (AGENTS.md section 3 gives every
document under `SPEC/` a job, and an unbuilt plan fits none of them). When Clubby ships, its lasting
truth moves into the spec in the same change: a PRD page, a TECH page and ADRs, as listed in
[`05-build-plan.md`](05-build-plan.md) step 7. After that this folder is history and can be deleted.

## Sources

Checked on 2026-10-18. Re-check before writing code: these move quickly (AGENTS.md non-negotiable 1).

- MCP authorization, spec revision 2026-07-28:
  https://modelcontextprotocol.io/specification/latest/basic/authorization
- better-auth OAuth provider plugin: https://www.better-auth.com/docs/plugins/oauth-provider
- Claude connector authentication (supported flows, callback URL, PKCE, refresh behaviour):
  https://www.claude.com/docs/connectors/building/authentication
- Custom connectors, plans and mobile: https://support.claude.com/en/articles/11175166 and
  https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers
- `@modelcontextprotocol/fastify` 2.0.1 readme, read with `npm view` (the stateless pattern)
- Package versions and peer requirements, read with `npm view`
