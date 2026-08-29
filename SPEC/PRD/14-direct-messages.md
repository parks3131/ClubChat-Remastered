# Direct messages

**Added 2026-07-28.** A private one-to-one conversation between two members who share a club.

**Purpose.** The small coordination exchanges that do not belong in front of the whole club:
"can you pick me up on the way", "are you racing Saturday", a captain checking in on someone.
Today these leave the app entirely and happen over text message, which means they are invisible
to the product and the context is lost.

**Positioning, and the guardrail.** **Group chat is the product. DMs are additive.** The bet in
[Overview](00-overview.md) is that a club's coordination becomes *more* structured,
not that ClubChat becomes a general messenger. Any DM feature request that would pull activity
out of club, race, or Eboard chat and into private threads is working against the product, and
should be refused on those grounds.

**Behaviour rules**

1. **A DM exists only between members who share at least one club.** Discovery is a search over
   people the viewer already shares a club with. There is no global user search.

   **A search result opens that person's profile, and the conversation starts from a Send
   message action there** *(2026-08-02)*. Two reasons, and the second is the load-bearing one:
   looking somebody up should show you who they are rather than committing you to a thread with
   them, and it puts "message this person" in **one** place - so reaching a profile from a
   roster, from an avatar in chat or from the search offers the same action rather than three
   screens each growing their own. The action is absent on your own profile, since a
   conversation with yourself is refused anyway; every other refusal is only knowable by asking,
   so it surfaces after the tap.
2. **There is exactly one thread per pair of people, ever** - not one per shared club. Two
   people in three clubs together have one conversation.
3. **Losing the last shared club makes the thread read-only**, it does not delete it. History
   stays readable, consistent with a message never being hard-deleted.
4. **A DM has no admins.** No announcements, no pinning-as-authority, no polls, no system
   messages about roles. Either participant may pin an ordinary message for reference.
5. **Everything else in chat works identically**: text, photos, documents, reactions, mentions,
   the gallery, unread counts, opening on the first unread message, and paging backward.
   **A direct message also pushes**, which no ordinary message does in a group scope - a DM is
   the one place a message is addressed to a person rather than to a room, and rule 8 would
   otherwise be a control over nothing
   ([ADR-0015](../decisions/0015-a-direct-message-pushes-without-an-inbox-row.md)).
6. **Either participant can block the other.** Blocking is instant, self-service, and needs no
   review. A block prevents new messages in both directions, hides each party from the other's
   DM search, and stops notifications. Existing history remains visible to both.
7. **Either participant can report a message.** Because there is no admin in the conversation,
   a DM report goes to a **platform moderation queue** rather than to any club admin. No club
   admin ever sees the contents of a DM.
8. **A conversation can be muted** without blocking: no push notifications, unread count still
   accrues.
9. **A DM is never visible on the calendar, in Highlights, or in any club-scoped surface.**

10. **A conversation has a profile of its own**, reached by tapping the person's name in the
    chat header *(2026-08-02; it previously led nowhere, because a DM has no space behind it)*.
    It carries their picture and name, **the clubs the two of you share** - each tappable
    through to that club - and this conversation's **Gallery**. Everything on it is about the
    conversation rather than the person, which is why it is a different screen from the member
    profile a roster leads to: "Delete chat" on a screen reached from a roster would be a
    control over nothing.

    The clubs listed are only ones **the viewer is already in**. A DM must not become a window
    onto somebody's whole membership.

    **Its header carries the back arrow and the three-dot menu and no title** *(2026-08-29)*.
    The page opens on the person's picture and name, so a worded title above that named the
    category where the page already named the person.

11. **A conversation can be pinned to the top of your own chat list.** Personal and
    unobservable: the other participant cannot tell, and pinning needs no permission beyond
    being able to read the conversation. Pinned conversations sort above every unpinned one
    regardless of recency, which is the entire point of pinning one.

    **This is a different thing from pinning a message** ([Chat](05-chat.md) rules 5-7), which
    is an act of authority in a shared room that everybody sees. The two share a word and
    nothing else, and neither should ever be derived from the other.

12. **"Delete chat" clears the conversation for you, and only for you.** The other participant
    keeps every message and is never told. Nothing is destroyed: your own view starts higher up
    the same log, which is the only reading of "delete" compatible with
    [Domain model](01-domain-model.md) invariant 7 and with rule 3's promise that a thread is
    never deleted.

    The conversation **leaves your list** until they write again, and comes back carrying only
    what arrived after you cleared it. It is confirmation-gated, and the confirmation says
    whose copy goes and whose does not - "delete" reads as mutual, and somebody using it
    believing it reaches the other person would be badly misled.

    12a. **No longer a DM-only action, since 2026-08-06.** Club chat and race chat offer it from
    the same long-press menu, with the same personal meaning: everybody else keeps every message
    and nobody is told. The DM restriction was always a product decision rather than a technical
    one, and the confirmation wording is the only thing that differs by scope - naming the other
    person is right in a DM and wrong in a room. See [Screen map](15-screen-map.md) rule 8a.

    Offered on direct messages only. The mechanism is scope-agnostic and clubs simply do not
    offer it.

**Permissions**

| Action | Participant | The other participant | Anyone else |
|---|---|---|---|
| Read | ✅ | ✅ | ❌ |
| Post | ✅ | ✅ | ❌ |
| Pin a message | ✅ | ✅ | ❌ |
| React, attach media, mention | ✅ | ✅ | ❌ |
| Post an announcement, create a poll | ❌ | ❌ | ❌ |
| Delete own message | ✅ | ✅ | ❌ |
| Delete the other's message | ❌ | ❌ | ❌ |
| Report a message | ✅ (not one's own) | ✅ | ❌ |
| Block, unblock, mute | ✅ | ✅ | - |

Reactions were promised by rule 5 and did not exist in **any** scope until 2026-07-30. They do
now, and they sit on the **Post** row rather than the Read one: a blocked participant sees a
message and cannot react to it, because a reaction is a signal sent into a conversation they are
barred from writing to. Reporting is the deliberate opposite - see the edge cases.

**Read and Post are separate rows, and that is the structural cost of this scope.** In every
other scope they are one question with one answer. Here a participant keeps Read and loses Post
in two situations - blocked (rule 6) and no shared club left (rule 3) - and both leave the
conversation fully readable. A permission model that answered both with one membership check would
have to choose between hiding history and letting a blocked member send.

Note also the row that differs from every other scope: **no participant can delete someone else's
message in a DM**, because the admin who would hold that power in club chat does not exist here.
Between the two people in the conversation, moderation is blocking plus reporting, not deletion.
Pinning is the counter-example worth keeping straight: it survives the absence of admins, because
what "no admins" removes is pinning-as-*authority* and a pin is reference.

> **One person outside the conversation can remove a message in it, and only a reported one.**
> Added 2026-08-11. A platform moderator acting on a report may remove the reported message and
> suspend the account that sent it - the "removing the content and ejecting the user" that Apple's
> guideline 1.2 requires within 24 hours, in the one scope with no admin to do it. The matrix above
> is unchanged and still describes **participants**, which a platform moderator is not: the power
> is resolved through `message_reports`, so it cannot reach a conversation nobody complained about,
> and it leaves a tombstone like every other delete.
> See [ADR-0023](../decisions/0023-a-moderator-may-remove-a-reported-message-and-suspend-an-account.md).

**Edge cases**

| State | Behaviour |
|---|---|
| Both people leave their last shared club | Thread becomes read-only; neither can send |
| **Either one re-joins a club the other is in** | **Writable again immediately, with nothing to recompute.** Writability is evaluated, never stored ([ADR-0016](../decisions/0016-thread-writability-is-evaluated-never-stored.md)) |
| A blocked user opens the existing thread | History visible, composer disabled with the reason stated |
| A blocked user searches for the blocker | No result, indistinguishable from "no such member" |
| **A blocked user tries to open a thread with the blocker** | **The same refusal a stranger gets.** A distinguishable one would make the block detectable by anyone willing to call the endpoint |
| Blocking someone mid-conversation | Their queued but unsent messages never arrive |
| Unblocking | The thread becomes writable again; nothing is retroactively delivered |
| **A blocked participant reports a message** | **Allowed.** Reporting is gated on reading the conversation, not on posting in it - taking it away at the moment somebody blocks is taking it away when it is most needed |
| One participant deletes their account | Thread persists, their messages unattributed, as everywhere else |
| A DM report is filed | Reaches platform moderators only; the other participant is not told |
| **A platform moderator opens a report** | **They see the reported message and five either side, and the read is logged.** Moderation is not a licence to browse a private conversation |
| **A platform moderator acts on a report** | They may remove the reported message, leaving a tombstone for both participants, and suspend the sender's account. Both are recorded against their name, and neither reaches a message nobody reported |
| **A suspended account** | Signed out everywhere and unable to sign in. Their profile, clubs and messages are untouched, because a suspension is reversible and is not a deletion. Any moderator can lift it; they then sign in again with their password |

**Out of scope.** Group DMs of three or more people (that is what a club, race, or Eboard is
for). DM requests or acceptance flows. Disappearing messages. Voice notes, unless and until
they exist in group chat first. Read receipts and typing indicators, exactly as in every other
scope.

**Resolved, 2026-07-30: blocking is silent to the blocked party, and a disabled composer still
states a reason.** Those two looked contradictory - the edge case above requires the composer to
say why, and rule 6 keeps the block quiet everywhere else. They coexist because the stated reason
does not have to identify the *cause*:

| Who is looking | What the composer says |
|---|---|
| The person who blocked | "You blocked this person. Unblock them to send messages." Their own action, reported back, with the way out |
| The person who was blocked | "You can no longer send messages in this conversation." |
| A participant whose last shared club is gone | The same sentence, word for word |

The last two being **identical** is the point. The member learns they cannot send, which is what
they need in order to stop trying, and not that they were specifically blocked - which is the
disclosure rule 6 avoids in search and in notifications too. Anyone can distinguish the two cases
by other means if they try hard enough; the product does not hand it to them.

**Open questions.** Should a club admin be able to disable DMs for their club entirely, for a
team of minors? Should there be a cap on how many new conversations one member can open per
day beyond ordinary rate limiting? *(Still open. The per-sender, per-new-conversation limit
[Authorization](../TECH/05-authorization.md) calls for is Phase 4's, along with every other rate
limit; the abuse surface is bounded meanwhile by eligibility requiring a shared club.)*
