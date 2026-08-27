# Accounts, auth, profile

**Purpose.** Lightweight identity that makes a member recognisable across a club's chats and
rosters, plus full self-service control of the account.

**Fields.** Avatar, full name, bio, city, date of birth, school. Email is auth-only and is
never shown to other members.

**Behaviour rules**

1. Sign-up takes a name, an email and a password. A consent line below the password field
   states the 18+ minimum and links to the Privacy Policy and the Terms of Service. **Both links
   open in the browser**, at `https://clubchatapp.com/privacy` and
   `https://clubchatapp.com/terms`; the app carries no copy of either text.
1a. **ClubChat is 18+, declared rather than verified.** The consent line is where the member
    declares it, and the Terms and the Privacy Policy both state it. There is no date-of-birth
    gate and no server-side check, deliberately: collecting every member's birthday to test
    something almost nobody misstates is the wrong trade for a club app. The declaration is what
    the store age rating rests on, and what keeps a one-to-one messaging surface out of the
    children's-privacy regimes. Settled 2026-08-12; see
    [ADR-0026](../decisions/0026-filter-hate-speech-not-profanity.md). *(Recorded here 2026-08-25.
    It had been settled in an ADR, stated on two screens and enforced nowhere, and this document -
    the one that governs sign-up - did not contain the word.)*
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
8b. **Another member's card names the clubs you are both in**, as a sentence naming one of them
    and a stack of the rest, opening onto the full list. It is the **intersection**, never their
    own membership: a club you are not in is not yours to learn about, and listing one would undo
    rule 8a. The overlap discloses nothing new - you are in those clubs and can already read the
    roster that names this person. Absent entirely when there is none, which is the state rule 8a's
    conversation clause creates.
8c. **A profile picture can be opened full size** by tapping it, on your own card and on anybody
    else's. The lettered fallback is not a picture and does not open.

    **It opens onto black with nothing else on the screen** - no close button, no menu - and a
    swipe in any direction, or a tap, goes back. **There is deliberately no way to save, share or
    export another member's profile picture.** A photograph somebody posts into a conversation
    carries all three, because that is content; a face is identity, and the absence of the menu is
    the enforcement rather than a styling choice.
9. Privacy Policy and Terms of Service are readable **both signed out and signed in**, and from
   outside the app entirely. They are web pages, rendered from `docs/legal/privacy-policy.md` and
   `docs/legal/terms-of-service.md`, which are the single copy of each text; sign-up and the
   Profile screen open them in the browser. *(Until 2026-08-25 they were two React Native
   screens, so the only copy of either document that existed anywhere was the one on the phone:
   an App Store listing had nothing to point at, and somebody who had not installed the app could
   not read what they were being asked to agree to.)*
9a. **The Privacy Policy states plainly that message content is readable by the service**, direct
    messages included. That is a standing obligation from
    [ADR-0005](../decisions/0005-no-end-to-end-encryption.md) rather than a wording preference:
    the product has no end-to-end encryption because the server composes system messages,
    notification bodies and moderation views, and the document has to say so where a member will
    read it. Discharged 2026-08-25, and pinned by a test so a rewrite cannot quietly soften it.
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
    known address turns the form into a test for whether any given person has an account here,
    which is a fact about somebody that is not the asker's to have. The screen never reveals which
    case it was, and the user is told to check their inbox rather than left on a silent success.
    *(The reason given here until 2026-08-25 was "clubs include minors". ADR-0026 settled the
    minimum age at 18, so that premise is gone; the rule is not, because the oracle is the
    problem.)*
15. **A reset link expires after an hour, works once, and signs every other device out.** The
    first two are what stops a forwarded or leaked email being a standing key. The third is the
    point of the whole feature: reset is the path somebody takes *because* they think their
    account is compromised, and leaving the attacker's session alive would defeat it.
16. **Setting a new password lands on sign-in, not in the app.** Rule 15 revoked the sessions,
    so there is nothing to land in; signing in once with the new password is also the only
    confirmation that it is really set.
17. **The Profile screen ends with which build the phone is holding, and which bundle it is
    running.** Two lines, quiet, below every control: the app version and build number, and then
    one sentence naming the update. Tapping them copies the long form - the full update id, the
    publish time, the channel and the runtime version - because those are the values that settle
    an argument and none of them can be read aloud off a screen.

    **Two lines rather than one, because two different things change.** The version and build
    number come from the installed binary and only a store release moves them. The update line
    comes from the JavaScript, which now arrives on its own in the background. Showing one without
    the other is how somebody concludes an update landed because the version looks new.

    *(Added 2026-08-27, and it is a diagnostic rather than a decoration. Nothing in the app showed
    a version until then, which was untidy while every change arrived through TestFlight and became
    a hole the day over-the-air updates started publishing: "did the update land?" had no answer
    from the device, and it has none anywhere else either - a publish aimed at the wrong runtime
    version reaches no phone and reports success. This line is the only place that question is
    answerable.)*

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
| **Suspended account tries to sign in** | **Refused at the form, and told plainly that the account is suspended**, with the support address to write to. No session is issued. The refusal comes *after* the password is checked, so a wrong password still answers "invalid email or password" and the form cannot be used to discover whether somebody is suspended - the same reasoning as rule 14. *(Until 2026-08-11 sign-in **succeeded** for a suspended account and every screen then answered 401, which reads as a broken app rather than as a suspension.)* |
| Suspended account already signed in on a device | Signed out. The suspension deletes their sessions, so the token is dead on the next request, and it publishes a revocation so an open socket stops receiving. The app returns to sign-in when it next verifies |
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
(a club is a small private group, and a member's face, school and city are not the internet's
business). Usernames separate from full
names (clubs use real names). Aggressive session expiry (this is a club chat, not a bank).
