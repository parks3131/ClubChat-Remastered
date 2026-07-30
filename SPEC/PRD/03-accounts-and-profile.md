# Accounts, auth, profile

**Purpose.** Lightweight identity that makes a member recognisable across a club's chats and
rosters, plus full self-service control of the account.

**Fields.** Avatar, full name, bio, city, date of birth, school. Email is auth-only and is
never shown to other members.

**Behaviour rules**

1. Sign-up takes an email and a password. A consent line below the password field links to
   the Privacy Policy and the Terms.
2. Sign-up handles the "email confirmation required" case explicitly - the user is told to
   confirm, never left on a silent failure.
3. **The session persists across app restarts.** A returning user lands in the app, not on
   sign-in.
4. An unauthenticated user is always routed to sign-in; an authenticated one is always
   routed into the app, **including from the bare entry point** (`/`).
5. A profile is **self-editable only**. Nobody can edit another member's profile, including
   an Owner.
6. The avatar is uploaded from the profile screen, via an overlay control on the avatar
   itself.
7. "Your clubs" lists the user's clubs on their own profile, capped with a searchable
   "+N more" popup when there are many; each entry opens that club.
8. Another member's profile is **read-only**, reached by tapping their avatar in chat or
   their row on any roster.
9. Privacy Policy and Terms are readable **both signed out and signed in**.
10. Signing out returns to sign-in and clears the session.
11. **Account deletion is permanent, self-service, and confirmation-gated on every
    platform.** It anonymises the profile and permanently blocks future sign-in.
    **One precondition, decided 2026-07-30: an Owner must transfer or delete each club they own
    first, and deletion refuses until they have.** An ownerless club has no recovery path
    (invariant 1) and the Owner has no other way out, so the refusal is the only outcome that
    keeps both the invariant and the other members' club. The client turns it into
    transfer-or-delete per club, which keeps deletion self-service. Rejected alternatives are
    recorded in [Roadmap](17-roadmap-and-open-questions.md).
12. Deleting an account **does not delete the content they posted**. Their messages remain in
    their conversations, unattributed.

**Edge cases**

| State | Behaviour |
|---|---|
| Signed out, deep link into the app | Routed to sign-in first, then on to the target |
| Sign-in fails | Inline error; the form retains its input |
| Profile with no avatar | Letter-initial placeholder, used consistently in chat and rosters |
| Profile with no bio/city/school | Those rows are simply absent |
| Avatar upload fails | Surfaced; the old avatar is retained |
| User belongs to no clubs | "Your clubs" empty state |
| Deleted account's past messages | Remain in history, unattributed |
| Deleted account tries to sign in | Permanently blocked |
| **Auth check hangs on a slow network** | **Never hang on a spinner.** Race the session check against a timeout - a hung check previously presented as an app that never loaded. But the outcome is **three-way, not two-way**, and the distinction is load-bearing: a server that answered and rejected the token means sign out; being unable to *reach* a server means carry on with the stored session, read from the local cache, and re-verify when the network returns. *(Clarified 2026-07-30, when offline chat made the two-way version wrong: falling back to signed-out on a network failure makes "no signal" indistinguishable from "you have been logged out", and locks a member out of history already on their device.)* |
| **Launched with no network at all** | The app opens signed in, reads chat from the local cache, and **says it is offline** rather than looking broken. Sends queue in the outbox and flush on reconnect. |

**Rejected alternatives.** Hard-deleting a user and their content (tears holes in every
conversation). Admin-mediated deletion (app-store requirement plus the right default).
Public profiles (clubs are small and often include minors). Usernames separate from full
names (clubs use real names). Aggressive session expiry (this is a club chat, not a bank).
