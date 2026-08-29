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
| Photo attachments | Library or camera, through a preview that offers a crop and a caption |
| Document attachments | Any file type, shown with filename and size |
| Emoji reactions | Any emoji in the catalog, from a quick row of six plus a searchable picker. At most four pills show under a message, most-reacted first, with a `+N` chip for the rest. See the reaction rules below |
| Announcements | Admin-only, visually distinct |
| Pinning | Admin-only, with a floating dismissible pinned strip |
| Highlights | Pinned / Announcements / Reports tabs over the same conversation |
| Jump-to-message | Tapping a reply's quote, or arriving from a mention notification, lands on that exact message, highlighted |
| Entry | Chat opens at the newest message, always |
| Jump-to-latest | A floating "N new messages" control once messages arrive while the reader is back in history. Tapping lands on the FIRST of them, to read forward |
| System messages | Joins, leaves, adds, removes, promotions, demotions |
| Auto-posted cards | A created poll, event, or meeting posts itself into the relevant chat |
| Inline poll voting | A poll card in chat is fully votable without opening the poll screen |
| Moderation | Soft delete with a tombstone; report a message |
| Gallery | Every photo ever posted in that chat, as a grid |
| Quick-nav | A header menu into that space's other features |

| Editing | A sender may correct their own text message for five minutes, and the bubble says it was edited |

**Out of scope:** **threads**, typing indicators, read
receipts, presence, voice notes, video calls, message search, and paging *newer* beyond
a jump window (chat only pages upward from the live tail).

*(DMs were listed here as out of scope until 2026-07-28, when that position was reversed. See
[ADR-0009](../decisions/0009-direct-messages-as-fourth-channel-scope.md).)*

*(Editing was listed here as out of scope until 2026-08-14, when that position was reversed. It
sat in better company than it deserved: a thread is a second conversation the product would have
to bend around and a read receipt is a privacy question, while correcting a typo is neither. See
rule 9a and [ADR-0033](../decisions/0033-a-message-may-be-edited-for-five-minutes.md).)*

*(Quote replies were out of scope alongside threads until 2026-08-01, when the two were
separated. A quote is a **flat** reference to one earlier message and stays in the main
conversation; a thread is a second conversation hanging off a message, with its own unread
state, its own notification rules and its own place to hide. The first is a reading aid, the
second is a feature the whole product would have to bend around. Threads remain out.)*

**Behaviour rules**

1. **One chat implementation serves all four scopes.** Feature parity is total.
2. **Chat loads the most recent ~40 messages** and pages further backward as the user scrolls
   up.
3. **Chat opens at the newest message, with no visible scroll motion.** Always, whether or not
   anything was unread.

   *(Until 2026-08-27 it opened on the first unread message instead, travelling up to it. Changed
   at the founder's request after watching the app beside GroupMe: opening a club and being at the
   bottom is what every chat he uses does, and it is what he expects. The "Last read" rule below
   still marks where reading stopped - see 3c - because marking the place and being moved to it
   are different favours.)*

   **Who caused the movement decides whether there is any.** Somebody else's message never moves
   the reader - it is announced by the control in rule 3b instead. The reader's own action always
   does: sending, attaching, or creating a poll, event or meeting returns them to the newest
   message so they watch it land. Being taken somewhere you did not ask to go is the failure;
   watching your own thing arrive is the point.

3a. **The list is inverted**, which is what makes "no visible scroll motion" true rather than
   aspirational. Chat used to render oldest-first and chase the bottom, so opening a channel
   scrolled visibly and - measured on 2026-08-01 - frequently stopped partway up the history
   because the content was still growing when it decided it had arrived.

3b. **Messages arriving while the reader is back in history do not move them.** A floating
   control appears saying how many arrived; tapping it lands on the FIRST of them, so they read
   forward through what they missed rather than arriving after it. The count covers arrivals
   since they last saw the newest message, not since they opened the app.
3c. **A "Last read" rule marks where reading stopped**, drawn above the first message that was
   unread **when the screen opened**. It appears only when something actually was unread, and it
   is a marker rather than a destination: scrolling up finds it, and the control in 3b is what
   offers the trip. *(It was the arrival's landing target until 2026-08-27; see rule 3.)*

   **Unread is a fact about the moment of arrival, not a property a message keeps.** The rule is
   decided once, on entry, and nothing that arrives afterwards can create one or move one - not
   the reader's own message, not anybody else's. Shipped the other way on 2026-08-01 and reported
   from a phone the same evening: typing into a chat you were caught up on drew the rule above
   your own message, announcing that you had not read the thing you had just written.

3d. **A date heading opens each day**, above that day's first message: "Today", "Yesterday", or
   the date, with the year only when it is not this one. Quieter than the rule above, and the
   contrast is deliberate - a date says where you are, the rule says where to start reading.

3e. **A spell of messages from one person is introduced once, and the time is part of the
   introduction.** The face, the name and the clock sit over the first of them; the rest are
   bubbles under it, carrying no time of their own. A run ends when somebody else speaks, when the
   run has been going five minutes, or when anything full width sits between two messages - a date
   heading, the "Last read" rule, a system line, a tombstone, an announcement, or a poll, event or
   meeting card. A card always heads a run of its own: it carries a whole object rather than a turn
   in somebody's talking.

   **Five minutes, measured from the run's first message rather than from the last one.** The
   header's clock speaks for every bubble under it, so a run may only last as long as that one
   claim can stay true - and measuring from the last message would let a chain of four-minute
   messages run for an hour under a header still showing the hour's first minute. Every bubble is
   within five minutes of the time above it, and that is the guarantee the number exists to keep.

   **The clock is a clock, never "just now".** A relative label goes stale sitting on screen unless
   something re-renders every row on a timer, and it means nothing at all when the reader scrolls
   back through last month. A corrected message still says "Edited" in its own bubble (rule 9a);
   that is a fact about the words rather than about when they were sent.

   **One rule, with no branch on who is reading.** The same in a direct message as in a club chat,
   and the same for your own messages as for anybody else's. All three of those were offered as
   separate treatments on 2026-08-27 and all three were declined, which is worth recording because
   each of them is a plausible-looking special case somebody will propose again.

   **The gap between two bubbles says whether the same person is still talking.** Inside a run it
   is the list's own row gap and nothing more; a run is separated from what precedes it by that
   gap again, plus the face and the name. The relationship is the rule - a run must read as one
   person speaking rather than as a column of separate remarks - and the measurements belong to
   `theme.ts`.

   *(Before this, every message carried the face, the name and a clock line of its own, and every
   pair of bubbles sat the same distance apart whoever sent them - so a three-word message was two
   lines tall. Reported from a photograph of a DM: a conversation with two people in it, naming
   both of them on every line, with a repeated name circled. The pair under that circle were
   nineteen minutes apart and DO now get two headers, which is a decision rather than a
   regression: the founder moved the clock into the header hours later, was told in as many words
   that five minutes puts a header back exactly where he had circled one, and chose it. A header
   that repeats is a smaller price than a header whose time is not true.)*

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
   does not unpin for anyone.

   **Tapping a pinned notice opens what the pin is about, and that is not always the message.**
   A poll, event or meeting card opens that poll, event or meeting; anything else opens
   Highlights. It never jumps back into the conversation. **The same rule governs a row in
   Highlights**, which is the other surface that lists pins - see the Highlights section.

   *Corrected 2026-08-11, in two steps.* This rule used to say a tap jumps the conversation to
   that message and briefly highlights it. It stopped describing the app some time before that
   and nobody noticed: jumping dropped the reader into the middle of history with no clear way
   back, and whether it worked depended on how far back the message was, so the app had settled
   on Highlights. **The rule is the thing that changed here, not the behaviour** - per the
   standing rule that the implementation is the fact and the spec was the bug.

   The card half is a real behaviour change and the reason worth keeping: a poll is pinned
   *because somebody should vote in it*, so sending them to a record of the card leaves them to
   go and find the poll themselves. A pin that is about an object should reach the object.

   Two consequences that are not optional:

   - A pinned card whose object is deleted must leave the strip. The deletion cascade
     soft-deletes the card and clears its pin in the same statement, and the strip drops
     tombstones and unpinned rows - so this holds by construction rather than by a check.
   - The destination must be the same one a **notification** about that object would reach, and
     it is: both are derived from one route table, so they cannot disagree.
8. **@mentioning a member notifies them individually**, and the mention renders highlighted.
   A mention only notifies someone who can actually access that chat.
9. **A message can be deleted by its sender or by an admin of that space.** Deletion leaves a
   "This message was deleted" tombstone rather than removing it from history. Reactions and
   pin state are cleared with it.

   **The tombstone still says whose message it was.** It keeps the sender's face and name and
   stays on their side of the conversation, exactly as the message did - only the words go. A
   tombstone that says nothing about its author tells the room that something was removed and
   not who removed it, which leaves a mystery where the hole already is, and the reply above it
   still names the person being answered. Highlights had drawn a deleted message this way since
   it was written; the conversation was the surface that disagreed.

   **The attribution follows the same once-per-spell rule as any other message** (rule 3e). Six
   messages inside five minutes carry one face, and deleting the third of them does not add a
   second one in the middle of the spell or break the four below it. So a face appears on a
   tombstone only where it would have appeared on the message it replaces.

   **What is deliberately not said: who did the deleting.** A sender taking their own message
   back and an admin removing it are the same tombstone, because nothing records the difference -
   see the note in [`PRD/17`](17-roadmap-and-open-questions.md). Naming the remover is a
   different feature with a different cost, not an omission from this one.
9a. **A sender may correct their own text message for five minutes, and only their own.** Long
    press, then the pencil. The words return to the composer with a bar above it saying so, and
    the send control becomes a check.

    **An admin may not**, in any scope, and that is the deliberate half. Rule 9 gives an admin a
    second path into deleting anybody's message, because removing words somebody objects to is
    moderation and it leaves a tombstone the whole room can see. Putting *different* words in
    somebody's mouth is forgery, and it would be indistinguishable from them having said it. An
    admin who objects to a message deletes it.

    **The bubble says "Edited".** Nothing changes silently: a message that could become something
    other than what was replied to or reacted to, with nothing on screen admitting it, is the same
    dishonesty the tombstone exists to prevent one step milder. **The previous text is not kept**
    anywhere - a five-minute typo fix should not become a permanent record of what somebody meant
    to unsay.

    Only plain text. **An announcement cannot be edited**, because it has already buzzed every
    phone in the space, so a correction would leave the lock screen and the conversation
    disagreeing with nothing able to reconcile them. Neither can a card, a system message or a
    tombstone. An edit to nothing at all is refused rather than treated as a delete - deleting is
    how a message is taken back, and it says so.

    Reactions and pin state **survive** an edit, unlike a delete. Five minutes is short enough
    that what was reacted to is very close to what remains, and clearing the pills would punish
    the reactors for the sender's typo. A quote of an edited message shows the corrected text,
    everywhere at once, exactly as a quote of a deleted one shows the tombstone.

    **The refusal is the server's.** The pencil is hidden after five minutes as a courtesy, not as
    the rule - a deadline that lives only in the interface is not a deadline.

    **A name the edit adds is notified, once.** Adding an `@mention` by editing must reach that
    person or the mention is broken; a name that was already there is not told again, because a
    phone buzzing twice for one sentence is what the diff exists to prevent. Removing a name from
    the text removes its mention, which is rule 8 applied unchanged. The language filter in rule
    10a runs on the edit too - otherwise the window is a hole straight through it.
10. **Anyone can report a message they did not send, except in Eboard chat.** Reporting twice is
    a no-op, and the second one notifies nobody either.

    **Eboard has no reporting at all** - not a hidden button, not an empty tab. Every member of
    that space is already admin-tier, so a report would be raised by the same people who would
    review it; they delete the message directly, which is where reporting would have led anyway.

    **Filing a report notifies whoever reviews it**, because a work queue nobody is told about is
    a work queue nobody opens. Who that is depends on the scope, and the differences are
    deliberate:

    | Scope | Notified |
    |---|---|
    | club | the admin tier: Owner and admins |
    | race | admins **who are on that race's roster**. A club Owner not in the race hears nothing |
    | eboard | nobody - see above |
    | dm | platform moderators, never a club admin |

    Every admin is told, **including one whose own message was reported**: the alternative leaves
    a space with a single admin having nobody notified at all.

    The notification names the reporter and the channel and nothing else - not the reported
    member, not the text - because it can land on a lock screen before anybody has looked at it. Reports
    surface only to admins, in a Reports tab in Highlights, where they can delete the message
    or dismiss the report. **In a DM there is no such admin**, so a DM report routes to a
    platform moderation queue instead and no club admin ever sees it - see
    [Direct messages](14-direct-messages.md) rule 7. Reporting is gated on being able to *read*
    the conversation rather than on being able to post in it, so a member who has just blocked
    somebody can still report what was said to them.
10b. **A member can also report a *person* rather than a message, and that report goes to
    ClubChat's own moderators every time.** Offered where somebody's card can be opened, which
    today is the club roster.

    **Who may file one is exactly who may see the card**, and that is deliberately not restated as
    its own rule: sharing a club with them, or holding a conversation with them, which is the
    second case [Direct messages](14-direct-messages.md) rule 3 keeps alive after a last shared
    club goes. Anything narrower would put a Report control on a surface where it sometimes
    refuses, which teaches people the button is broken rather than that they are ineligible.

    **It never reaches a club's admins**, even the admins of the club the card was opened from,
    and even though those same admins can Remove and Ban from the same card. A person report has no
    message behind it, so the routing above has nothing to route on and a club officer would be
    weighing an accusation about their own member with no evidence attached. See
    [ADR-0035](../decisions/0035-a-person-is-reported-to-platform-moderators.md), which records
    what that costs.

    Everything rule 10 says still holds: reporting twice is a no-op, reporting yourself is refused,
    a block in either direction does not close the path, and **the reported member is never told**.
    The notification names the reporter and nothing else, for the same lock-screen reason.

    What a moderator sees is the account, and **how many people have reported it**. There is
    nothing to read, because there is nothing attached - which is why the count is the report.
10a. **A small set of language is refused when the member presses send, and a second set posts
    and is queued for review.** Both sets target hate speech and explicit self-harm direction, in
    the sense App Review guideline 1.1.1 defines: content aimed at somebody for their religion,
    race, sexual orientation, gender or national origin. **Ordinary profanity is deliberately
    allowed** - see [ADR-0026](../decisions/0026-filter-hate-speech-not-profanity.md) for why a
    swear filter is the wrong target and what it would cost a university club.

    | Verdict | What the member sees | What a reviewer sees |
    |---|---|---|
    | refused | The message is not sent. The composer keeps their text and a line explains why | nothing - it was never stored |
    | queued | Nothing. The message posts normally | a report in the same queue rule 10 fills, filed by ClubChat rather than by a person |
    | allowed | Nothing | nothing |

    **A refusal never names the word that caused it.** Naming it turns the filter into a puzzle
    with the answer printed on it. The refusal is also the one send failure that must not be
    retried, so the client hands the text back to be edited rather than offering a retry that
    cannot succeed.

    **This is not a safety feature and must not be described as one.** A term list catches slurs.
    Bullying, exclusion, grooming and a threat phrased politely all pass it, and each is a
    likelier harm in a real club. Those are what rules 10 and blocking exist for.
11. **The composer's "+" opens an attach menu** with Photos, Camera, and Document always
    available, plus admin-gated create actions for whatever the scope supports (club: Poll,
    Event; race: Poll; Eboard: Poll, Meeting).

    **Send appears when there is something to send**, and is absent rather than disabled the rest
    of the time.

    **It opens in the keyboard's place, and the "+" becomes a keyboard while it is there.**
    Sending something and typing something are two modes of the same strip of screen, so opening
    one closes the other and the way back is the control you came through. Nothing above the
    composer moves, and the conversation loses no more room than the keyboard was already
    taking - see [`DESIGN/08`](../DESIGN/08-attachment-panel.md).

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

11c. **A photo is previewed before it is sent, and the preview is where a crop and a caption
    happen.** Choosing from the library or taking one with the camera both land on a full-screen
    look at the picture, with a close, a **Crop**, a caption field and send.

    **Nothing leaves the phone until send is pressed.** Picking used to upload and post in one
    breath, so backing out cost a round trip and left an object behind with no message pointing at
    it. Cancelling now costs nothing and posts nothing.

    **The camera comes through the same preview**, and it is the path that needs it most: a shot
    you cannot re-check before it posts is worse than a library pick you can.

    **The crop is free-form and keeps the picture's own proportions.** A chat photo is shown at
    whatever shape it is, so cropping it to a square would throw away most of what somebody chose
    to send. The frame opens on the whole picture, because a frame that starts smaller has already
    cropped it.

    **A caption is a message body and behaves like one**: it @mentions from the same list the
    composer offers, it is filtered by rule 10a like any other text, and it renders under the
    photo as the message's text - because that is what it is.

    **A document has no preview.** There is nothing to look at and nothing to crop, so the step
    would only ever be dismissed.

11a. **The header's grid menu is quick-nav and is NOT role-gated.** Every member of the scope
    sees the same entries - club: Members, Poll, Meetups, Events; race: Members, Meet
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
    a document, otherwise the text - and tapping it jumps to the original and highlights it.
    A quote of a reply shows that reply's own words, never a chain.

    This is the jump-to-message window, which a mention notification also uses. **It is no longer
    what a pinned notice does** - see rule 7 - so this is now its own behaviour rather than a
    reference to that one.

    **A reply notifies nobody on its own.** Replying is a reading aid, not a summons: if you
    want the person to know, you @mention them, and that rule already exists. Adding a second
    silent way to generate a notification would make "why did my phone buzz" unanswerable.

    **A deleted original keeps its quote and says "This message was deleted."** The quote does
    not vanish - a reply answering nothing is exactly the unreadability the tombstone exists to
    prevent (rule 9), one level up - and it does not keep showing the deleted words either.
    Cards are replyable like anything else.

**Highlights**

A view of chat, not a feed of its own. Tabs: **Pinned**, **Announcements**, and (admins only)
**Reports**.

**A row for a poll, event or meeting card opens that object; every other row is view-only**, and
the avatar opens the sender. This is rule 7's destination rule applied to the second surface that
shows pins, and it has to be, for a reason stronger than consistency: **the strip shows only the
four most recent pins and this list shows all of them**, so a fifth pinned poll is reachable here
and nowhere else. A row that displayed it without opening it would be the one surface that could
show somebody a poll while giving them no way to reach it.

An ordinary pinned message still goes nowhere from here, and that is not an omission - Highlights
is where rule 7 sends it, so this screen is its destination rather than a waypoint. Nothing jumps
back into the conversation from this list.

In a DM the Reports tab does not appear at all: there is no admin of the conversation to read
it, and the reports it would contain belong to the platform moderation queue.

**Edge cases**

| State | Behaviour |
|---|---|
| Empty conversation | Empty state, composer available |
| Loading | Spinner; the composer is not shown until the channel resolves |
| Offline / send failure | The send fails **visibly** rather than silently dropping the message |
| Photo or document upload fails | The message is not posted and the failure is surfaced |
| Photo preview cancelled | Nothing is uploaded and nothing is posted |
| Crop rectangle does not fit the picture | Refused rather than trimmed, so no region nobody chose is ever sent |
| Deleted message | Tombstone; reactions and pin state cleared |
| Edited message | Corrected text with an "Edited" label; reactions and pin state kept |
| Edit window expired while typing | The save is refused and says the message can no longer be edited, offering to send a new one |
| Message deleted by an admin mid-edit | The editing bar disappears; the composer reverts to writing a new message |
| Deleted poll/event/meeting | Its chat card disappears |
| Jump target far back in history | A window of history around that message is loaded; scroll-up paging continues from there |
| Realtime message arrives while reading old history | It merges in, but the view is **not** yanked to the bottom |
| No back history (deep link, refresh) | The back control falls back to that space's parent, **never** to a screen that would bounce back into chat |
| Non-member opens a race/Eboard chat URL directly | Redirected out |
| A participant opens a DM they can no longer write to | History readable, composer disabled with a reason that does not say which cause |
| Non-participant opens a DM URL directly | Nothing back, including no confirmation that the conversation exists |

**Acceptance criteria**

- [ ] A message sent on one device appears on another in realtime without a refresh.
- [ ] Photos and documents round-trip: upload and appear, and both open full screen from the
      bubble - see [Media and galleries](13-media-and-galleries.md).
- [ ] A document bubble shows its filename, its type and its size.
- [ ] Tapping a document opens it in the platform's own viewer; holding it still opens the
      message menu.
- [ ] Choosing a photo opens a preview; cancelling it posts nothing and uploads nothing.
- [ ] A photo sent with a caption shows that caption under it, and an @mention in the caption
      notifies that person.
- [ ] Cropping a photo sends the cropped picture, at its own proportions rather than a square.
- [ ] A crop survives the keyboard opening and the Done tap, rather than reverting to the whole picture.
- [ ] A photo taken with the camera reaches the same preview as one chosen from the library.
- [ ] Reactions toggle on and off and are visible to everyone.
- [ ] Holding a pill lists everyone who reacted, by name and picture, filterable to one emoji.
- [ ] A reaction added on one device appears on another in realtime, without a refresh.
- [ ] Deleting a message clears its reactions for everyone.
- [ ] An @mention notifies the mentioned member and renders highlighted.
- [ ] The mention autocomplete lists only people who can access that chat.
- [ ] Every photo posted appears in that chat's Gallery and opens full screen from it.
- [ ] A member cannot post an announcement or pin; an admin can do both.
- [ ] The pinned strip appears when a message is pinned and can be dismissed without unpinning.
- [ ] Tapping a pinned ordinary message opens Highlights; tapping a pinned poll, event or meeting
      card opens that poll, event or meeting.
- [ ] The same card row in **Highlights** opens the same object, including a pin old enough to
      have fallen out of the four-item strip.
- [ ] Deleting a poll removes its pinned notice, **including on a device that was offline when it
      was deleted** - the case that only appears after a reconnect.
- [ ] Highlights lists pinned and announcement messages.
- [ ] Reopening a chat with unread messages lands on the first unread one with no visible scrolling.
- [ ] Opening a chat with unread messages lands on the first one, with nothing seen to scroll.
- [ ] A message arriving while the reader is back in history does not move them, and is announced
      by a control naming how many arrived.
- [ ] Sending, attaching, or creating a poll/event/meeting returns the reader to the newest message.
- [ ] Scrolling to the top loads older messages without losing scroll position, and **does not fire spuriously on open**.
- [ ] Deleting a message leaves a tombstone for every other member.
- [ ] A sender can correct their own text message within five minutes, and the bubble then says "Edited".
- [ ] The correction appears on another device in realtime, **and on one that was offline when it happened**.
- [ ] The pencil is absent after five minutes, and the save is refused by the server even if it is attempted anyway.
- [ ] An admin has no pencil on somebody else's message, and is refused if the request is made directly.
- [ ] An announcement, a card and a tombstone offer no pencil.
- [ ] An edited message keeps its reactions and its pin.
- [ ] A quote of an edited message shows the corrected text, including on a client that already had the reply on screen.
- [ ] Adding an @mention by editing notifies that person; fixing a typo in a message that already mentioned them does not notify them again.
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

**Reaction rules.**

Settled 2026-08-13, resolving the open question recorded on 2026-07-30. It was never a
re-litigation of the rejected alternative above: that one was a full picker *replacing* the quick
row, and the objection - fast tap targets beat completeness - still stands. This is both, as
WhatsApp does it. The quick row is unaffected.

R1. **Any emoji in the catalog may be used**, from a quick row of six plus a `+` that opens a
    searchable picker. The catalog is a table, which is what makes the set closeable, validation a
    lookup and normalisation a non-issue - see
    [ADR-0028](../decisions/0028-reactions-come-from-a-catalog-table.md).

R2. **At most four pills show under a message**, ordered most-reacted first, followed by a `+N`
    chip when there are more. Nothing is ever hidden without the row saying so.

R2a. **A pill taps to join or leave that reaction, and holds to ask who made it.** The hold buzzes
    before the list appears, like every other hold in the product. The `+N` chip has no reaction of
    its own, so a tap on it goes straight to the list.

R2b. **The list is one row per person**, with their picture, their name and the emoji they chose,
    behind chips that filter it to a single emoji. It shows everybody, not only the reactions the
    `+N` chip was hiding. Your own row says so and removes that reaction when tapped - the same
    toggle the pill performs, offered where you are already looking at what you picked.

R3. **Ties hold their position.** Equal counts are broken by the catalog's own order, so a pill
    only ever moves when a count actually changes. Ordering by count means the row can reshuffle -
    that is accepted deliberately, and this is the smallest version of the cost.

R4. **A message carries at most twenty distinct emoji.** The twenty-first is refused rather than
    silently dropped. Every update carries the full reaction set
    ([ADR-0017](../decisions/0017-reactions-travel-on-the-message-envelope.md)), so an unbounded
    set of distinct emoji is an unbounded frame.

R5. **Skin tone variants are not offered yet**, so a reaction is the default-tone emoji. The
    catalog can gain them later without a contract change.

R6. **News reactions use the same catalog as chat**, which keeps
    [News and Highlights](06-news-and-highlights.md) rule 4 true rather than making it an
    exception to explain.

Two of the five recorded costs remain real and are answered above rather than elsewhere: the pill
row stops being bounded, which R2 and R4 bound, and the picker is a substantial component. The
other three were dissolved by the catalog rather than managed.
