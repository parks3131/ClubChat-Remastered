# Domain model

Conceptual entities and their relationships. No storage decisions implied.

```
User ──< ClubMembership >── Club
                             ├──< JoinRequest
                             ├──< CalendarEvent
                             ├──< RoutineWorkout
                             ├──< NewsPost ──< NewsPostReaction
                             ├──< Poll ──< PollOption ──< PollVote
                             ├──< Race
                             │     ├──< RaceMembership
                             │     ├──< RaceJoinRequest
                             │     ├──< RacePin (per user)
                             │     ├──< CarGroup ──< CarGroupMembership
                             │     └──  MeetInformation (5 fields on the race itself)
                             ├──  EboardChannel (exactly one)
                             │     ├──< EboardMembership
                             │     ├──< EboardJoinRequest
                             │     └──< Meeting
                             └──< Channel (chat)
                                   ├──< Message ──< Reaction / Mention / Report
                                   └──< ReadCursor (per user)
```

### The channel abstraction

**This is the single most important structural idea in the product.** There is **one** chat
channel concept with three scopes:

| Scope | Owned by | Who can read/post |
|---|---|---|
| Club main chat | A club | Every club member |
| Race chat | A race | Every race roster member |
| Eboard chat | An Eboard channel | Every Eboard member |
| **Direct message** | **A pair of users** | **Exactly those two, while they share a club** |

Everything that hangs off a channel - messages, reactions, mentions, reports, read cursors,
pins, announcements, highlights, galleries - works **identically in all three scopes with
zero duplication**. A feature added to club chat is added to all three, or it is a
parameter. Polls repeat the same trick: one poll concept with a club/race/Eboard scope.

**Rule:** adding a fourth scope must cost one membership predicate, one admin predicate, one
poll-access predicate, one branch per notification audience rule, and a set of thin screen
wrappers. Nothing shared should change. If a fourth scope would require forking chat, the
abstraction has been broken.

> **The rule was tested and held.** Direct messages became that fourth scope on 2026-07-28.
> Cost: one membership predicate (`isDmParticipant`), one admin predicate (constant-false, which
> removes announcements and polls for free), one nullable column, and thin screen wrappers.
> Sequencing, sync, cursors, unread counts, pins, reactions, gallery, media and push fan-out all
> carried over untouched. The one thing the rule did **not** anticipate is that a scope with no
> admins has nowhere to send a report - see [Direct messages](14-direct-messages.md).

### Entity notes

| Entity | Key facts |
|---|---|
| **User / profile** | Full name, avatar, bio, city, date of birth, school. Self-editable only. Created automatically on signup. |
| **Club** | Name, sport, description, avatar, join policy (`open` \| `request`), invite token. Exactly one Owner at all times. The token is **only ever surfaced as a share link** and is never displayed as something a person types. |
| **ClubMembership** | Role: `owner` \| `admin` \| `member`. Per club. **Exactly one owner per club, enforced at the data layer, not in the UI.** |
| **Channel** | Belongs to a club always; optionally scoped to a race or an Eboard channel. Exactly one main channel per club, one per race, one per Eboard. |
| **Message** | Type: `text` \| `photo` \| `document` \| `announcement` \| `system` \| `poll` \| `event` \| `meeting`. Carries body, media reference, pinned flag, soft-delete timestamp, optional document name/size, optional linked poll/event/meeting. |
| **Race** | Name, date (date only, no time), avatar, plus five Meet Information fields: description, location link, hotel link, photos link, results link. |
| **RaceMembership** | The **only** source of truth for race access. Club-admin status is not a substitute, ever. |
| **CarGroup** | Auto-numbered ("Group 1", "Group 2"), one optional Incharge who must be a current member of that group. A person is in at most one group per race. |
| **EboardChannel** | Exactly one per club, created automatically with the club. Name, description, avatar. |
| **Meeting** | Title, description, datetime, optional link. Creator-only edit/delete. |
| **Poll** | Question, 2-10 options, `allow_multiple`, `is_private`, optional `closes_at`. Scope: club, race, or Eboard. **Closed-ness is not stored** - it is "closed by its creator, or past its deadline", evaluated whenever the poll is read, so a passed deadline reads as closed everywhere without anyone having acted. |
| **CalendarEvent** | Type (`race` \| `practice` \| `team_bonding` \| `volunteer` \| `other`), title, start datetime, optional end, optional location, optional description. Club-scoped only. The `race` type is a **label only** and has no relationship to a real Race. |
| **RoutineWorkout** | Date (a real calendar date), activity type (10 values), title, optional description. Club-scoped only. |
| **NewsPost** | Body text and/or one photo (at least one required), author, timestamp, emoji reactions. |
| **Notification** | Recipient, actor, club, type (18 values), and the structured parameters its text and target are rendered from. The wording and the destination are produced when the row is read, not frozen into it when written. |

### Invariants that must hold in any architecture

1. **Exactly one Owner per club, always.** Enforced by the data layer. An ownerless club has
   no recovery path.
2. **Exactly one main channel per club, one per race, one per Eboard.** Any lookup for "the
   club's main channel" must exclude race- and Eboard-scoped channels. *(current-stack
   detail: forgetting this predicate caused "more than one row returned by a subquery"
   twice.)*
3. **Race membership is the sole source of truth for race access.** Substituting "is a club
   admin" has been wrong in five separate places.
4. **Eboard membership is always a subset of the club's admin tier.**
5. **A person is in at most one car group per race.**
6. **Poll vote counts are public; voter identity is gated.** Counts must be readable without
   exposing who voted, so a count cannot simply be derived from rows the viewer is forbidden
   to read.
7. **Message deletion is a soft delete with a tombstone**, never a removal.
8. **Notifications are written server-side only.** No client path may create one.
9. **Deleting a club, race, or Eboard cascades** to all its children, including chat history,
   rosters, polls, and notifications.
10. **Deleting an account anonymises, it does not remove content.** Messages stay in their
    conversations, unattributed, so history stays readable.
