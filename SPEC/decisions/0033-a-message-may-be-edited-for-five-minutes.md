# 33. A message may be edited by its sender for five minutes

Date: 2026-08-14

## Status

Accepted. Reverses the "editing a sent message" entry in
[PRD/05](../PRD/05-chat.md)'s out-of-scope list, in the same way
[ADR-0009](0009-direct-messages-as-fourth-channel-scope.md) reversed the DM entry and the
2026-08-01 note separated quote replies from threads.

## Context

Chat has always let a member **delete** a message and never let them **correct** one, so the only
way to fix "see you at 6pm" was to delete it and say it again - which loses the reactions, breaks
every reply that quoted it, and puts two messages in the room where one was meant.

Editing was listed out of scope from the first draft of the chat spec, alongside threads and read
receipts. It sat in better company than it deserved. Threads are a second conversation the whole
product would have to bend around; read receipts are a feature with a privacy argument attached.
Editing a typo is neither. It is what every product ClubChat replaces already does, and the
founder asked for it directly on 2026-08-14.

Two things in the codebase pointed the other way and both turned out to be softer than they read:

- **`MessagePatch` said an update "must never be able to rewrite a message's body, sender or seq.
  Those are the log, and the log is append-only."** What append-only is protecting is the
  **ordering** - `seq` is the address every reply, quote and read cursor points at. Correcting
  text does not touch it. The line was never quite where the comment drew it either, since
  `deletedAt` has been allowed to blank a body since Phase 0.
- **The pin route's comment records v1's column-level authority trap**: a single row-level rule
  over the whole message let any member pin their own message and then retro-flip it into an
  announcement, notifying the entire club. That is an argument for editing being **its own command
  with its own predicate**, not an argument against editing.

The `rev` machinery built for tombstones already solves the hard half. A correction is a change to
a row **below** a client's local max, which is exactly the class of change
[the revision counter](../TECH/02-channel-log.md) exists to deliver to a device that was offline
when it happened.

## Decision

**The sender of a text message may replace its body for five minutes after sending it. Nobody
else ever may, and the message says that it was edited.**

Concretely:

1. **Sender only.** `canEditMessage` deliberately does **not** mirror `canDeleteMessage`, which
   grants the admin tier a second path. Deleting somebody's words is moderation and leaves a
   tombstone everyone can see; replacing them is forgery, and a club admin quietly rewriting a
   member's sentence is indistinguishable from that member having said it. An admin who objects
   to a message deletes it.
2. **Five minutes**, as one shared constant asked through one shared function, so the client's
   pencil and the server's refusal cannot drift. The server is the enforcement - a client clock
   is not an authority on a deadline.
3. **Plain text only.** Announcements are excluded because an announcement has already pushed to
   every phone in the space, so editing one leaves the lock screen and the conversation
   disagreeing with no way to reconcile them. Cards and system messages have no author to correct
   them. A tombstone has no body left.
4. **The message says so**, as an `edited_at` timestamp on the envelope and an "Edited" label on
   the bubble. Nothing changes silently.
5. **The previous text is not kept.** No revision table, no `previous_body`.
6. **Its own command over exactly one column.** `POST /channels/:id/messages/:seq/body`, with a
   strict body schema, joining `/pinned` and the `DELETE` rather than collapsing the three into a
   `PATCH`.
7. **The content filter runs again**, and a newly added `@mention` notifies - once, computed as a
   diff against who was already named.

## Consequences

| | |
|---|---|
| Positive | A typo is fixable without losing the message's reactions, its replies or its place. The correction reaches an offline device, because it rides the revision counter the tombstone already rides. The "Edited" label keeps the conversation honest. |
| Negative | A message can now differ from what somebody replied to or reacted to. Five minutes bounds it and the label discloses it, but it is a real cost and it is accepted rather than solved. A reader who saw the original and looks again has no way to see what changed. |
| Follow-up needed | None. A cached reply's quote box is restated by `restateQuotedMessage`, which the local store applies exactly where it already applies `strikeQuotedMessage`. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Keep an edit history, viewable from the bubble** | It turns a five-minute typo fix into a permanent record of what somebody meant to unsay, which is a worse deal for the member than not being able to edit at all. It is also a table, a read and a screen for a feature whose whole point is that the correction is minor. |
| **No "Edited" label** | A message could become something other than what was replied to or reacted to with nothing on screen admitting it. That is the dishonesty the tombstone exists to prevent, one step milder, and PRD/05's standing rule is that nothing is hidden without the row saying so. |
| **Let admins edit too, mirroring delete** | Forgery. See decision 1. The symmetry is superficially attractive and the two capabilities are not the same kind of thing. |
| **An unlimited window** | The cost in the Negative row grows without bound: a message somebody answered last week could be rewritten into something their answer no longer fits. A correction window and a rewrite privilege are different features, and only the first was asked for. |
| **Delete-and-resend under the hood** | Loses the reactions, breaks every quote of it, moves the message to the end of the conversation, and pushes everyone a second time. It is the workaround this replaces, automated. |
| **A `PATCH` over the message carrying `body`** | The exact shape of v1's column-level authority trap: a route whose payload could also carry `type` would let a member edit their own text into an announcement and notify the whole club. Three narrow commands cannot be got wrong by sending the wrong field. |
