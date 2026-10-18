# 6. Decisions

Each with the rejected alternative, per standing instruction 3. When Clubby ships, the
architectural ones become ADRs (build step 7). Until then, changing one means asking the founder.

**D0. Stage one is a connector, not an assistant inside the app.** *Founder, 2026-10-18.* An
assistant inside ClubChat means ClubChat pays an AI provider for every question, and there is no
budget for that. A connector is paid for by the member's own Claude plan. *Rejected for now:*
Clubby inside the app, which is still the goal and reuses these tools when it comes.

**D1. The MCP server is a route group inside the API process.** Its tools call the domain read
functions directly and inherit the access context, account check, limiter and error reporting.
*Rejected:* a separate service calling our REST API with the member's token, which doubles every
hop, needs a second deploy, and is the token pass-through the MCP spec forbids. *Rejected:* a
fourth Fly app.

**D2. Sign-in is better-auth's OAuth provider plugin, after upgrading better-auth to 1.7.10.** It
supports Client ID Metadata Documents (which the MCP spec prefers) and Dynamic Client Registration
(deprecated by the spec, still used by Claude as a fallback). *Rejected:* the `mcp` plugin in the
installed 1.6.25, built on the older OIDC provider, with no Client ID Metadata Document support.
*Rejected:* a personal API key pasted into Claude; Claude's static-header option is a limited beta,
and a pasted key is a password that never expires.

**D3. One scope, short-lived JWT access tokens, and the account check on every call.** Scope
`clubchat.read`, audience `https://api.clubchatapp.com/mcp`, verified locally against our JWKS,
then `loadAccessContext` and `isSessionUsable` on every request. *Rejected:* opaque tokens with
introspection, a network round trip per call for nothing gained here. *Rejected:* trusting the
token alone, which is failure modes 12 and 20 again.

**D4. The API serves its own sign-in and Allow pages.** The web client has never been deployed
(`SPEC/TECH/21`). *Rejected:* deploying the Expo web app first, a large unrelated job on this
feature's critical path.

**D5. Reading through Clubby marks nothing as read.** The read cursor decides who gets a push
(ADR-0008). *Rejected:* advancing it when Clubby reads a chat aloud, which would silence
notifications for messages the member only half heard.

**D6. Direct messages are included.** *Founder, 2026-10-18.* A member asking about their own
conversations is the same as reading them on screen, and a DM is already an ordinary channel with
scope `dm` (ADR-0009), so the same authorization covers it. *Rejected:* club chats only, on the
grounds that the other person in a DM never agreed to an AI reading it. The cost is stated rather
than hidden: the Allow page and the privacy policy say DMs are sent to Anthropic when read.

**D7. Stateless MCP.** One server and transport per request, no session ids. *Rejected:* stateful
sessions, which need sticky routing on Fly and lose state on every deploy.

**D8. Answers are written to be spoken**, with ids carried separately in structured content.
*Rejected:* returning the REST responses as they are, which are shaped for a screen, full of ids,
and slow to read aloud.

**D9. The work happens in its own worktree on branch `clubby`.** *Founder, 2026-10-18.* *Rejected:*
the founder's own folder on `main`, where a broken sign-in upgrade would break his running app.
