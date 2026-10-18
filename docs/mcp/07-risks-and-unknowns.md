# 7. Risks and unknowns

Each with how it gets settled. If one comes out differently from what the plan assumes, stop and
ask the founder ([`CLAUDE.md`](CLAUDE.md) section 4).

| # | Unknown or risk | How it gets settled | If it goes wrong |
|---|---|---|---|
| 1 | **Whether hands-free voice mode in the Claude app calls custom connectors.** Anthropic's docs do not say. | Build step 4, on the founder's phone | Clubby still works by typing or dictation. Record it and move on |
| 2 | **The better-auth 1.6 to 1.7 upgrade changes something the app relies on**: sessions, the bearer plugin the gateway uses, the Drizzle adapter, `additionalFields`. | Step 1 on its own, with the full suite, `gate:surface` and a Simulator sign-in | Fix it in step 1 before anything else lands |
| 3 | **The OAuth plugin's well-known paths, consent flow or Client ID Metadata Document support differ from what its docs say.** | Step 3, proved with the MCP Inspector | Ask before working around it |
| 4 | **The MCP SDK v2 API differs from the readme examples** (it split into several packages this year). | Read the installed `.d.ts` files before writing (non-negotiable 1) | Follow the installed types, not this plan |
| 5 | **The `/mcp` scope accidentally accepts an app session, or a REST route accepts a Clubby token.** | Proofs 7 and 8 | It is a security defect; fix before anything ships |
| 6 | **Claude's 10 second limits** on discovery, registration and token calls, against a cold Fly machine or a slow Neon wake. | Measure in step 4 against production | Keep a machine warm, or look at the cold path |
| 7 | **Menu names for adding a custom connector at claude.ai** are from documentation, not from looking. | The founder does it in step 4 | Update [`01-product.md`](01-product.md) with what he actually saw |
| 8 | **Prompt injection through chat text** once other connectors are switched on. | Out of ClubChat's control in stage one; see [`04-security-and-privacy.md`](04-security-and-privacy.md) 4.3 | The reason stage two needs its own plan |
| 9 | **The privacy policy needs a processor named** before real members connect. | Step 7 | Do not invite members to connect before it is published |
