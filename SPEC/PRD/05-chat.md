# Chat

**The centre of gravity.** One chat implementation serves club, race, and Eboard scopes with
**total feature parity**; only the menus differ.

**In scope**

| Capability | Notes |
|---|---|
| Text messages | With @mention tagging and autocomplete |
| Photo attachments | Library or camera |
| Document attachments | Any file type, shown with filename and size |
| Emoji reactions | Fixed set: 👍 ❤️ 😂 🔥 🎉 😮 |
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

**Out of scope:** threaded/quote replies, editing a sent message, typing indicators, read
receipts, presence, voice notes, video calls, DMs, message search, and paging *newer* beyond
a jump window (chat only pages upward from the live tail).

**Behaviour rules**

1. **One chat implementation serves all three scopes.** Feature parity is total.
2. **Chat loads the most recent ~40 messages** and pages further backward as the user scrolls
   up.
3. **Chat opens positioned on the first unread message, with no visible scroll motion.** If
   fully caught up, it opens at the bottom.
4. **Opening a chat marks it read**, which clears its unread count everywhere. Nothing else
   clears it.
5. **Only an admin of that space can post an announcement or pin a message.** In race chat
   that means a club admin who is **also on the roster**; in Eboard chat every member
   qualifies.
6. **A pin is separate from an announcement.** Pinning an ordinary message notifies nobody;
   posting an announcement notifies everyone in that space.
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
    or dismiss the report.
11. **The composer's "+" opens an attach menu** with Photos, Camera, and Document always
    available, plus admin-gated create actions for whatever the scope supports (club: Poll,
    Event; race: Poll; Eboard: Poll, Meeting).
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
    club chat, roster members in race chat, Eboard members in Eboard chat.

**Highlights**

A view of chat, not a feed of its own. Tabs: **Pinned**, **Announcements**, and (admins only)
**Reports**. The list is view-only; jumping to a message in context is the pinned strip's
job in chat.

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

**Acceptance criteria**

- [ ] A message sent on one device appears on another in realtime without a refresh.
- [ ] Photos and documents round-trip: upload, appear, and open when tapped.
- [ ] A document bubble shows its filename and size.
- [ ] Reactions toggle on and off and are visible to everyone.
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
- [ ] Reporting surfaces the message in the admin Reports tab; a second report by the same person changes nothing.
- [ ] Creating a poll from "+" posts a votable card, and voting on the card matches the full poll screen.
- [ ] Race and Eboard chat behave identically to club chat for everything above.

**Rejected alternatives.** Reusing pinning to mean "important" (the club already faked
announcements by pinning; making them distinct is the whole point). Notifying on every pin
(pins are reference, not interruption). Hard delete (a message vanishing mid-conversation
makes the replies unreadable). Auto-hiding reported messages (abusable by a single reporter
in a small trusted group). Always opening at the bottom (explicit founder request: landing at
the bottom means hunting upward for what you missed). A full emoji picker (fast tap targets
beat completeness). Link-only poll cards (voting should be one tap from the conversation).
