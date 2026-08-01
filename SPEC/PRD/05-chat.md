# Chat

**The centre of gravity.** One chat implementation serves club, race, Eboard **and direct-message**
scopes with **total feature parity**; only the menus differ. Everything below applies to all four
unless it names an exception, and the exceptions a DM carries are listed in
[Direct messages](14-direct-messages.md) rather than duplicated here.

**In scope**

| Capability | Notes |
|---|---|
| Text messages | With @mention tagging and autocomplete |
| Quote replies | A flat quote of one earlier message, tappable to jump to it. **Not threads** - see the out-of-scope note |
| Photo attachments | Library or camera |
| Document attachments | Any file type, shown with filename and size |
| Emoji reactions | Fixed set: 👍 ❤️ 😂 🔥 🎉 😮. **A full picker is requested and not built - see the open question below.** |
| Announcements | Admin-only, visually distinct |
| Pinning | Admin-only, with a floating dismissible pinned strip |
| Highlights | Pinned / Announcements / Reports tabs over the same conversation |
| Jump-to-message | Tapping a pinned notice lands on that exact message, highlighted |
| Unread-aware entry | Chat opens on the first unread message |
| Jump-to-latest | A floating control once scrolled away from the live tail |
| System messages | Joins, leaves, adds, removes, promotions, demotions |
| Auto-posted cards | A created poll, event, or meeting posts itself into the relevant chat |
| Inline poll voting | A poll card in chat is fully votable without opening the poll screen |
| Moderation | Soft delete with a tombstone; report a message |
| Gallery | Every photo ever posted in that chat, as a grid |
| Quick-nav | A header menu into that space's other features |

**Out of scope:** **threads**, editing a sent message, typing indicators, read
receipts, presence, voice notes, video calls, message search, and paging *newer* beyond
a jump window (chat only pages upward from the live tail).

*(DMs were listed here as out of scope until 2026-07-28, when that position was reversed. See
[ADR-0009](../decisions/0009-direct-messages-as-fourth-channel-scope.md).)*

*(Quote replies were out of scope alongside threads until 2026-08-01, when the two were
separated. A quote is a **flat** reference to one earlier message and stays in the main
conversation; a thread is a second conversation hanging off a message, with its own unread
state, its own notification rules and its own place to hide. The first is a reading aid, the
second is a feature the whole product would have to bend around. Threads remain out.)*

**Behaviour rules**

1. **One chat implementation serves all four scopes.** Feature parity is total.
2. **Chat loads the most recent ~40 messages** and pages further backward as the user scrolls
   up.
3. **Chat opens positioned on the first unread message, with no visible scroll motion.** If
   fully caught up, it opens at the bottom.
4. **Opening a chat marks it read**, which clears its unread count everywhere. Nothing else
   clears it.
5. **Only an admin of that space can post an announcement or pin a message.** In race chat
   that means a club admin who is **also on the roster**; in Eboard chat every member
   qualifies. **In a DM there are no admins, so announcements do not exist there - but pinning
   does, for either participant.** See rule 6 for why those come apart.
6. **A pin is separate from an announcement.** Pinning an ordinary message notifies nobody;
   posting an announcement notifies everyone in that space. That separation is what lets a DM
   keep pinning while losing announcements: "no admins" removes pinning-as-*authority*, and a
   pin is reference.
7. **The pinned strip floats over the conversation and can be dismissed locally.** Dismissing
   does not unpin for anyone. Tapping a pinned notice jumps the conversation to that message
   and briefly highlights it.
8. **@mentioning a member notifies them individually**, and the mention renders highlighted.
   A mention only notifies someone who can actually access that chat.
9. **A message can be deleted by its sender or by an admin of that space.** Deletion leaves a
   "This message was deleted" tombstone rather than removing it from history. Reactions and
   pin state are cleared with it.
10. **Anyone can report a message they did not send.** Reporting twice is a no-op. Reports
    surface only to admins, in a Reports tab in Highlights, where they can delete the message
    or dismiss the report. **In a DM there is no such admin**, so a DM report routes to a
    platform moderation queue instead and no club admin ever sees it - see
    [Direct messages](14-direct-messages.md) rule 7. Reporting is gated on being able to *read*
    the conversation rather than on being able to post in it, so a member who has just blocked
    somebody can still report what was said to them.
11. **The composer's "+" opens an attach menu** with Photos, Camera, and Document always
    available, plus admin-gated create actions for whatever the scope supports (club: Poll,
    Event; race: Poll; Eboard: Poll, Meeting).

    **The two axes are independent, and conflating them is the mistake to avoid.** *Which*
    actions the scope has is a fact about the scope; *whether this person gets them* is a fact
    about their authority in it. Read off v1 on 2026-07-30:

    | | Photos · Camera · Document | Poll | Event | Meeting |
    |---|---|---|---|---|
    | **Club chat** | anyone who can post | admin | admin | - |
    | **Race chat** | anyone who can post | manager | - | - |
    | **Eboard chat** | anyone who can post | member | - | member |

    Event exists only in the club scope (an event belongs to a club and there is no race or
    Eboard calendar), and Meeting only in the Eboard scope. Neither absence is a permission.

    > **"Admin" resolves to a different predicate in each scope.** In club chat it is club
    > admin-or-owner. In race chat it is a roster member who is *also* a club admin - so a
    > roster member without club standing does not get these, and a club admin without a roster
    > row never reaches race chat to begin with, because reading it requires the roster row.
    > In Eboard chat it is **every member of the space**, because membership there is admin-tier
    > by construction, so there is no second tier to gate against. Substituting one of these for
    > another is the class of bug that shipped in five places in v1.
    >
    > One predicate already answers all three: **the channel-admin question, asked of the
    > channel**. The screen asks that once and never re-derives it per scope, which is what stops
    > the three from drifting apart.

11a. **The header's grid menu is quick-nav and is NOT role-gated.** Every member of the scope
    sees the same entries - club: Members, Poll, Routines, Events; race: Members, Meet
    Information, Polls, Car Assignments and Groups; Eboard: Members, Meetings, Polls. Being
    able to *reach* a screen is not being able to *act* on it, and each destination applies its
    own rules on arrival. Hiding a destination a member may read would be a worse lie than
    showing one whose controls are absent.

11b. **The other admin-gated controls in chat**, in every scope, resolved by that scope's own
    predicate as above: the announcement toggle beside the composer, and Pin / Unpin. **Delete
    is the one that is not purely role-based** - a member may delete their own message, and an
    admin may delete anyone's. Report is available to everyone who can read the conversation.
12. **Creating a poll, event, or meeting posts a card into the corresponding chat**,
    regardless of whether it was created from chat or from its own screen.
13. **Deleting the underlying poll, event, or meeting removes its chat card**, rather than
    leaving a dead link.
14. **Chat is full-screen** - the bottom tab bar is hidden while in a conversation.
15. **The chat header carries the space's name and avatar, tappable to that space's
    profile**, plus Highlights and a quick-nav menu.
16. **Every chat has a Gallery**: every photo ever posted in that conversation, as a grid,
    tap-to-view full screen. Read-only; photos enter it only by being posted in chat.
17. **@mention autocomplete offers only people who can access that chat** - club members in
    club chat, roster members in race chat, Eboard members in Eboard chat, and the one other
    participant in a DM.
18. **A composer that is disabled says why.** A DM can become read-only without being deleted,
    and an input that silently rejects reads as a broken app. The stated reason never
    identifies whether a block or a lost shared club caused it - see
    [Direct messages](14-direct-messages.md).
19. **A reply quotes exactly one earlier message, in the same conversation, and stays flat.**
    The quote shows who said it and a short preview - a thumbnail for a photo, the filename for
    a document, otherwise the text - and tapping it jumps to the original and highlights it,
    the same jump a pinned notice uses. A quote of a reply shows that reply's own words, never
    a chain.

    **A reply notifies nobody on its own.** Replying is a reading aid, not a summons: if you
    want the person to know, you @mention them, and that rule already exists. Adding a second
    silent way to generate a notification would make "why did my phone buzz" unanswerable.

    **A deleted original keeps its quote and says "This message was deleted."** The quote does
    not vanish - a reply answering nothing is exactly the unreadability the tombstone exists to
    prevent (rule 9), one level up - and it does not keep showing the deleted words either.
    Cards are replyable like anything else.

**Highlights**

A view of chat, not a feed of its own. Tabs: **Pinned**, **Announcements**, and (admins only)
**Reports**. The list is view-only; jumping to a message in context is the pinned strip's
job in chat.

In a DM the Reports tab does not appear at all: there is no admin of the conversation to read
it, and the reports it would contain belong to the platform moderation queue.

**Edge cases**

| State | Behaviour |
|---|---|
| Empty conversation | Empty state, composer available |
| Loading | Spinner; the composer is not shown until the channel resolves |
| Offline / send failure | The send fails **visibly** rather than silently dropping the message |
| Photo or document upload fails | The message is not posted and the failure is surfaced |
| Deleted message | Tombstone; reactions and pin state cleared |
| Deleted poll/event/meeting | Its chat card disappears |
| Jump target far back in history | A window of history around that message is loaded; scroll-up paging continues from there |
| Realtime message arrives while reading old history | It merges in, but the view is **not** yanked to the bottom |
| No back history (deep link, refresh) | The back control falls back to that space's parent, **never** to a screen that would bounce back into chat |
| Non-member opens a race/Eboard chat URL directly | Redirected out |
| A participant opens a DM they can no longer write to | History readable, composer disabled with a reason that does not say which cause |
| Non-participant opens a DM URL directly | Nothing back, including no confirmation that the conversation exists |

**Acceptance criteria**

- [ ] A message sent on one device appears on another in realtime without a refresh.
- [ ] Photos and documents round-trip: upload and appear. *(Opening full screen waits on the
      viewer - see [Media and galleries](13-media-and-galleries.md).)*
- [ ] A document bubble shows its filename and size.
- [ ] Reactions toggle on and off and are visible to everyone.
- [ ] A reaction added on one device appears on another in realtime, without a refresh.
- [ ] Deleting a message clears its reactions for everyone.
- [ ] An @mention notifies the mentioned member and renders highlighted.
- [ ] The mention autocomplete lists only people who can access that chat.
- [ ] Every photo posted appears in that chat's Gallery and opens full screen from it.
- [ ] A member cannot post an announcement or pin; an admin can do both.
- [ ] The pinned strip appears when a message is pinned and can be dismissed without unpinning.
- [ ] Highlights lists pinned and announcement messages.
- [ ] Reopening a chat with unread messages lands on the first unread one with no visible scrolling.
- [ ] The jump-to-latest control appears after scrolling up and disappears at the bottom.
- [ ] Scrolling to the top loads older messages without losing scroll position, and **does not fire spuriously on open**.
- [ ] Deleting a message leaves a tombstone for every other member.
- [ ] A reply shows a quote of the message it answers, and tapping the quote jumps to it.
- [ ] Deleting a quoted message turns every quote of it into "This message was deleted",
      including on a client that already had the reply on screen.
- [ ] A reply notifies nobody unless it also @mentions them.
- [ ] Reporting surfaces the message in the admin Reports tab; a second report by the same person changes nothing.
- [ ] Reporting in a DM surfaces it to platform moderators and to no club admin.
- [ ] Creating a poll from "+" posts a votable card, and voting on the card matches the full poll screen.
- [ ] Race, Eboard and direct-message chat behave identically to club chat for everything above, except the DM exceptions named in [Direct messages](14-direct-messages.md).

**Rejected alternatives.** Reusing pinning to mean "important" (the club already faked
announcements by pinning; making them distinct is the whole point). Notifying on every pin
(pins are reference, not interruption). Hard delete (a message vanishing mid-conversation
makes the replies unreadable). Auto-hiding reported messages (abusable by a single reporter
in a small trusted group). Always opening at the bottom (explicit founder request: landing at
the bottom means hunting upward for what you missed). A full emoji picker **instead of** fast
tap targets (see the open question - the ask is now for one *in addition to* them, which is a
different proposal). Link-only poll cards (voting should be one tap from the conversation).

**Open question: the full emoji picker.**

Requested explicitly on 2026-07-30: reactions should offer the whole emoji list from a popup,
"like WhatsApp". Recorded here rather than half-built, and the fixed set shipped meanwhile.

Note first that this is **not** a re-litigation of the rejected alternative above. That one was
a full picker *replacing* the quick row, and the objection - fast tap targets beat completeness -
still stands. WhatsApp does both: six quick taps, plus a "+" that opens the full grid. The ask is
for the second thing, and the first is unaffected.

What it costs, so the decision is made with the bill in hand:

| | |
|---|---|
| **The set stops being closeable** | The emoji column carries a check constraint listing the six. Widening means dropping it, and that constraint is currently the only thing stopping arbitrary text reaching a column that renders directly into every client. Its replacement has to be real validation, not nothing. |
| **Validating "is this an emoji" is genuinely hard** | Not a character class. Grapheme clusters, zero-width joiner sequences, skin-tone and gender modifiers, regional indicator pairs, variation selectors. Length in code points is not a bound, and a naive check either rejects legitimate emoji or admits arbitrary text with one emoji in front of it. |
| **Normalisation becomes a correctness issue** | Two byte-different encodings of the same emoji must be one reaction, or the same emoji appears twice in a row with a count of one each. The primary key compares bytes. |
| **The pill row stops being bounded** | Six emoji means at most six pills. Arbitrary emoji means a message can carry dozens, and the row needs collapsing, an overflow affordance, and a decision about which win the visible slots. |
| **The picker itself is a real component** | Categories, search, recents, skin-tone selection, and a keyboard on a phone. It is the largest single piece of UI in the product so far. |

None of that is an argument against it. It is an argument for it being its own change with its own
tests, rather than a widened constant. The current shape is deliberately friendly to it: the emoji
travels as a string end to end, one reaction per emoji per member per message needs no revisiting,
and `reactionSummary` already renders an arbitrary set in a fixed order - so the fixed order is
the only thing that has to become a different rule.
