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
2. **There is exactly one thread per pair of people, ever** - not one per shared club. Two
   people in three clubs together have one conversation.
3. **Losing the last shared club makes the thread read-only**, it does not delete it. History
   stays readable, consistent with a message never being hard-deleted.
4. **A DM has no admins.** No announcements, no pinning-as-authority, no polls, no system
   messages about roles. Either participant may pin an ordinary message for reference.
5. **Everything else in chat works identically**: text, photos, documents, reactions, mentions,
   the gallery, unread counts, opening on the first unread message, and paging backward.
6. **Either participant can block the other.** Blocking is instant, self-service, and needs no
   review. A block prevents new messages in both directions, hides each party from the other's
   DM search, and stops notifications. Existing history remains visible to both.
7. **Either participant can report a message.** Because there is no admin in the conversation,
   a DM report goes to a **platform moderation queue** rather than to any club admin. No club
   admin ever sees the contents of a DM.
8. **A conversation can be muted** without blocking: no push notifications, unread count still
   accrues.
9. **A DM is never visible on the calendar, in Highlights, or in any club-scoped surface.**

**Permissions**

| Action | Participant | The other participant | Anyone else |
|---|---|---|---|
| Read or post | ✅ | ✅ | ❌ |
| Pin a message | ✅ | ✅ | ❌ |
| React, attach media, mention | ✅ | ✅ | ❌ |
| Post an announcement, create a poll | ❌ | ❌ | ❌ |
| Delete own message | ✅ | ✅ | ❌ |
| Delete the other's message | ❌ | ❌ | ❌ |
| Report a message | ✅ (not one's own) | ✅ | ❌ |
| Block, unblock, mute | ✅ | ✅ | - |

Note the row that differs from every other scope: **nobody can delete someone else's message in
a DM**, because the admin who would hold that power in club chat does not exist here. Moderation
is blocking plus reporting, not deletion.

**Edge cases**

| State | Behaviour |
|---|---|
| Both people leave their last shared club | Thread becomes read-only; neither can send |
| A blocked user opens the existing thread | History visible, composer disabled with the reason stated |
| A blocked user searches for the blocker | No result, indistinguishable from "no such member" |
| Blocking someone mid-conversation | Their queued but unsent messages never arrive |
| Unblocking | The thread becomes writable again; nothing is retroactively delivered |
| One participant deletes their account | Thread persists, their messages unattributed, as everywhere else |
| A DM report is filed | Reaches platform moderators only; the other participant is not told |

**Out of scope.** Group DMs of three or more people (that is what a club, race, or Eboard is
for). DM requests or acceptance flows. Disappearing messages. Voice notes, unless and until
they exist in group chat first. Read receipts and typing indicators, exactly as in every other
scope.

**Open questions.** Should a club admin be able to disable DMs for their club entirely, for a
team of minors? Should blocking be reciprocal-visible, or silent to the blocked party as
specified above? Should there be a cap on how many new conversations one member can open per
day beyond ordinary rate limiting?
