# 5. Build plan

Seven steps, on branch `clubby` in its own worktree. Each step ends with the type check and the
full suite green and a commit on the branch. A fresh agent verifies each step from the builder's
`HANDOFF: INTENT` paragraph (see [`CLAUDE.md`](CLAUDE.md) section 5).

## Step 1: upgrade better-auth, alone

- Move `better-auth` and every `@better-auth/*` package from 1.6.25 to 1.7.10 in
  `packages/server`. Read the 1.7 changelog first for anything touching sessions, the bearer plugin,
  the Drizzle adapter or `additionalFields`.
- Nothing else in the diff, because it sits under every request.
- **Done when:** `npm run verify` and `gate:surface` (against the worktree's own API port) are
  green, and sign-up, sign-in, sign-out and password reset work in the iOS Simulator against the
  worktree's own stack.

## Step 2: the two refactors

- `authorizeChannels` takes an `AccessContext`; the calendar filter-and-sort moves into
  `domain/calendar.ts`. See [`03-tools.md`](03-tools.md) section 3.3.
- **Done when:** existing tests unchanged and green; no behaviour change visible to the app.

## Step 3: the authorization server

- Add `oauthProvider`, `jwt` and `cimd` to `auth.ts`. One migration for their tables
  (`--name=oauth_provider`, ids `defaultRandom()`, claim the number first). Constraint proofs for
  any uniqueness the tables declare.
- The two well-known metadata documents. Advertise `client_id_metadata_document_supported: true`
  and `none` in `token_endpoint_auth_methods_supported`, or Claude falls back to Dynamic Client
  Registration; enable that too, since the spec keeps it for compatibility.
- The sign-in and Allow pages: plain HTML served by the API, in the app's design tokens, saying
  plainly what Clubby can and cannot do and that what it reads goes to Anthropic.
- Accept Claude's callback `https://claude.ai/api/mcp/auth_callback`, and loopback redirects on any
  port for Claude Code and the MCP Inspector. PKCE S256 required. The token endpoint accepts
  form-urlencoded bodies and answers within Claude's 10 second limit.
- **Done when:** the MCP Inspector completes the whole browser flow against the local API and ends
  holding a token, and proofs 5, 7 and 8 in [`04-security-and-privacy.md`](04-security-and-privacy.md)
  pass.

## Step 4: `/mcp` with one tool, all the way to the phone

- The `/mcp` scope (token check, then the shared account check and limiter) and `list_my_clubs`.
- Locally: Claude Code connects with a loopback redirect and calls the tool.
- **Then stop and ask the founder** to deploy (give him the exact commands: Fly deploy, and the
  migration against production). After the deploy, give him the steps to add
  `https://api.clubchatapp.com/mcp` at claude.ai. He asks "what clubs am I in?" from the Claude
  phone app twice: once with the dictation mic, once in hands-free voice mode.
- **Done when:** the answer reaches his phone. Record whether hands-free voice mode used the tool.

## Step 5: the other twelve tools

- One at a time, each starting with a failing test against the seeded Binghamton Running Club (the
  dev database has it; see the founder's notes on building fixtures for DMs and photos).
- The pure formatting in `mcp/speak.ts` is unit tested on its own.
- **Done when:** all 13 tools answer through a real MCP client, and every row of the table in
  [`01-product.md`](01-product.md) has been asked once.

## Step 6: prove the locks

- Every proof in [`04-security-and-privacy.md`](04-security-and-privacy.md) as a test, each seen to
  fail first. Proofs 1 to 4 added to `gate:surface`.
- **Done when:** all twelve pass, and `gate:surface` is green in both directions.

## Step 7: write it down

- A PRD page for Clubby under `SPEC/PRD/`, a TECH page under `SPEC/TECH/`, and `SPEC/README.md`
  updated to index both.
- ADRs: "Clubby is an MCP server inside the API" (D1, D7), "Assistants sign in through OAuth with
  one read scope" (D2, D3), "An assistant reads but never marks read" (D5), "Direct messages are
  readable by the member's assistant" (D6).
- The privacy policy line. A `HISTORY.md` entry with the full narrative. A `BUGS.md` row and a
  `bugs/` file for anything that reached a running app.
- **Done when:** the spec describes what shipped, and this folder can be deleted.
