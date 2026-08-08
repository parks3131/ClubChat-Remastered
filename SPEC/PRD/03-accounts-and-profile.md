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
8a. **A profile is visible only to people who share a club with its owner, or who already hold a
    conversation with them.** Anybody else gets nothing back, including no confirmation that the
    account exists. This is the same eligibility rule that governs direct messages
    ([Direct messages](14-direct-messages.md) rule 1) and the reason there is no global member
    search; the conversation clause exists because rule 3 there keeps a thread's history readable
    after the last shared club goes, so a name in that history must stay tappable. **A block does
    not hide a profile** - it stops messages and hides the pair from each other's search, but two
    people still in the same club see each other on every roster anyway, so withholding the card
    alone would conceal nothing. *(Stated 2026-08-08. It had been asserted in three places and
    enforced in none: every profile was readable by every signed-in account.)*
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
13. **A forgotten password is self-service, from sign-in.** Email and password is the only way in
    (TECH/15), so without this the only recovery is asking a human, and there is no human. Sign-in
    offers "Forgot password?", which takes an email and sends a link.
14. **The request always answers the same way, whether or not the address is registered.** "If
    that email is registered, we have sent a link" and nothing more - a different answer for a
    known address turns the form into a test for whether somebody has an account here, and clubs
    include minors. The screen never reveals which case it was, and the user is told to check
    their inbox rather than left on a silent success.
15. **A reset link expires after an hour, works once, and signs every other device out.** The
    first two are what stops a forwarded or leaked email being a standing key. The third is the
    point of the whole feature: reset is the path somebody takes *because* they think their
    account is compromised, and leaving the attacker's session alive would defeat it.
16. **Setting a new password lands on sign-in, not in the app.** Rule 15 revoked the sessions,
    so there is nothing to land in; signing in once with the new password is also the only
    confirmation that it is really set.

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
| Reset requested for an address with no account | The same confirmation as a registered one, and nothing is sent. Rule 14 |
| Reset requested for a **deleted** account | Nothing is sent, and no rule is needed for it: deletion released the address (rule 11), so there is no account under it to find |
| Reset link expired, already used, or tampered with | One message covering all three - "this link has expired or has already been used" - and a way back to request another. Distinguishing them would report whether a token was ever real |
| Reset link opened while already signed in | The reset screen still opens and still works. Somebody resetting a password on a device that is signed in is the ordinary case of "I am changing it because I do not trust it", and bouncing them into the app would be the one moment the app refuses to help |
| Same address asked to reset repeatedly | Refused per address, not only per IP, so one sender cannot use the form to flood somebody else's inbox |
| **Auth check hangs on a slow network** | **Never hang on a spinner.** Race the session check against a timeout - a hung check previously presented as an app that never loaded. But the outcome is **three-way, not two-way**, and the distinction is load-bearing: a server that answered and rejected the token means sign out; being unable to *reach* a server means carry on with the stored session, read from the local cache, and re-verify when the network returns. *(Clarified 2026-07-30, when offline chat made the two-way version wrong: falling back to signed-out on a network failure makes "no signal" indistinguishable from "you have been logged out", and locks a member out of history already on their device.)* |
| **Launched with no network at all** | The app opens signed in, reads chat from the local cache, and **says it is offline** rather than looking broken. Sends queue in the outbox and flush on reconnect. |

**Rejected alternatives.** Hard-deleting a user and their content (tears holes in every
conversation). Admin-mediated deletion (app-store requirement plus the right default).
Emailing a temporary password rather than a link (a live credential in cleartext, valid until
somebody remembers to change it). Security questions (a second secret to forget, and one whose
answers a clubmate often knows). Owner-mediated reset (hands a club officer a way into a
member's account, which is a larger power than any role in this product has). Public profiles
(clubs are small and often include minors). Usernames separate from full
names (clubs use real names). Aggressive session expiry (this is a club chat, not a bank).
