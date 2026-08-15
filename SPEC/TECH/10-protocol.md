# Protocol specification

### WebSocket

Envelope: `{ "t": <type>, "id": <correlation id>, "d": <payload> }`

> **Payload fields are camelCase, and this table said snake_case until 2026-08-02.** The frames
> are parsed against the Zod schemas in `packages/shared`, so a field spelled the way this
> document used to spell it is not merely untidy - it is rejected, and the socket answers
> `auth.err {"code":"malformed"}` before anything else happens. Found by writing a client from
> this table and watching it fail to connect. The schemas are the contract; this table describes
> them.

**Client → server**

| Type | Payload | Notes |
|---|---|---|
| `auth` | `{ token, deviceId, platform }` | First frame. Socket closed if absent within 5s. |
| `subscribe` | `{ channelIds: [] }` | **Authorized here, once.** Rejected ids returned in the reply. |
| `unsubscribe` | `{ channelIds: [] }` | |
| `msg.send` | `{ clientMsgId, channelId, type, body?, mediaId?, mentions?, replyToSeq? }` | `replyToSeq` is a seq, not an id, and the quote itself is never sent: the server joins it on read, so a sender cannot put words in somebody's mouth. See [Message flows](03-message-flows.md) 6.5. |
| `msg.read` | `{ channelId, upToSeq }` | Advances the read cursor. |
| `ping` | `{}` | Every 30s. |

**Server → client**

| Type | Payload | Notes |
|---|---|---|
| `auth.ok` | `{ sessionId, userId, displayName, displayImage, serverTime, channels: [{id, scope, scopeId, clubId, lastSeq, lastReadSeq}] }` | The client immediately knows every channel with a gap. `displayName` and `displayImage` ride here rather than on every ack, because neither can change for the life of the connection and the client needs both to draw its own optimistic bubble. |
| `auth.err` | `{ code }` | Socket closed. `invalid_token`, `expired_token`, `signin_blocked`, `not_authenticated`, `timeout`, `malformed`. **`not_authenticated` means the frame was early, not that the credential is bad** - see below. |
| `msg.ack` | `{ clientMsgId, messageId, channelId, seq, createdAt }` | **Gap-checked exactly like `msg.new`** - a skipped `seq` here leaves a permanent hole. See [Client architecture](08-client-architecture.md). |
| `msg.err` | `{ clientMsgId, code }` | `rate_limited`, `forbidden`, `channel_gone`, `malformed`, `media_not_ready` |
| `msg.new` | full message envelope incl. `seq`, `reactions` and a resolved `reply_to` | Append if `seq == local_max + 1`, else sync. Reactions ride on the envelope so they survive offline with the message ([ADR-0017](../decisions/0017-reactions-travel-on-the-message-envelope.md)). `reply_to` is resolved here rather than left as a seq, for the same reason: the cache has to be able to draw the quote with no network. |
| `msg.update` | `{ channelId, seq, pinned?, pinnedAt?, deletedAt?, reactions?, body?, editedAt? }` | **Reactions are the FULL set, never a delta.** Only the fields that changed are present, and an absent field is distinct from an explicit `null`. Declared from Phase 0 and had no producer at all until reactions arrived in Phase 3.5 - pins, tombstones and **edits** now travel on it too. `body`/`editedAt` are the one pair that rewrites what a message SAYS, added 2026-08-14; `seq` and `senderId` remain unreachable from this frame, which is what append-only was actually protecting - see [ADR-0033](../decisions/0033-a-message-may-be-edited-for-five-minutes.md). Each pair travels together for the same reason `pinned`/`pinnedAt` does: a store that took one without the other holds half a change, which looks current and is wrong. Deliberately **not** gap-checked: an update names an existing `seq` rather than extending the log, so it can neither create nor reveal a hole. See [ADR-0017](../decisions/0017-reactions-travel-on-the-message-envelope.md). **An update missed while disconnected is missed permanently over the socket** - but every producer of this frame also bumps the channel `rev`, so a reconnecting client's sync carries the change. Item 14 of [the roadmap](../PRD/17-roadmap-and-open-questions.md). |
| `notif.new` | `{ notification }` | Drives the badge live. |
| `pong` | `{}` | |

### One socket's frames are handled one at a time, in arrival order

The gateway queues each socket's frames behind the previous one. Different sockets still proceed
in parallel; a single socket's do not.

> **The guarantee is load-bearing, and it was missing until 2026-08-09.** `auth` is answered after
> two database round trips, and the handler used to start the next frame immediately rather than
> behind it - so a client that correctly sent `auth` and then `subscribe` had its `subscribe`
> evaluated while the socket was still unauthenticated, refused, and the connection closed. Any
> check that reads state an earlier frame writes is meaningless without this.

Two consequences worth stating, because they are what a client may rely on:

1. **A frame sent after `auth` is evaluated after `auth` has been applied.** A client does not have
   to wait for `auth.ok` to avoid being refused - though `@clubchat/client-core` waits anyway, so
   that a server without this guarantee cannot take the conversation down.
2. **`not_authenticated` is not `invalid_token`.** The first says the frame was early; the second
   says the credential is no good. Only the second is grounds for a client to end the session, and
   conflating them signed members out whose token the API was answering `200` for. See
   [Authorization](05-authorization.md) and the 2026-08-09 entry in [`HISTORY.md`](../../HISTORY.md).

The rejected alternative is handling frames concurrently for throughput, which is what it did.
There is nothing to win: a socket's frames are already ordered by the client that sent them, sends
serialize on the channel's `last_seq` row lock regardless, and liveness is recorded on arrival
rather than on handling, so a queued frame never reads as a silent socket.

### Frames are parsed at both ends, never cast

Every frame crossing this socket is validated against the schemas above - `ClientFrame` on the
way in, `ServerFrame` on the way back - and neither side reads a field it has not parsed.

> **This was the single largest source of drift in the codebase.** The gateway declared its send
> handler's payload by hand rather than importing `MsgSendFrame`; the client read every field as
> `frame.d['x'] as T`; and the gateway relayed whatever `JSON.parse` returned from Redis under a
> `ServerFrame` annotation nothing checked. All three typechecked perfectly and all three were
> assertions about a payload rather than knowledge of one. On 2026-08-01 one of them cost a bug:
> a worker older than the `mentions` field published an envelope without it, and every client's
> cache bound SQL NULL into a NOT NULL column and lost the message.

Three properties follow, and each is load-bearing:

1. **Defaults are applied, so an older producer is repaired rather than rejected.** A field added
   to the envelope after a running process started is filled in by the schema, at the gateway,
   before fan-out. This is what makes a rolling restart safe, and it is why the gateway parses
   even though the client does too - an app build already on somebody's phone cannot be fixed
   retroactively, but the server in front of it can.
2. **A frame the client cannot read is dropped and paid for with one sync**, rather than guessed
   at. `syncAll` pulls every channel above its local max, so a lost `msg.new` costs a round trip;
   `msg.update` and `msg.ack` are idempotent or repeated. **The exception is the handshake**: an
   unreadable `auth.ok` or `auth.err` fails the connection instead, because nothing further will
   arrive to prompt a retry and a dropped one leaves the app on a spinner forever - the outcome
   [Accounts and profile](../PRD/03-accounts-and-profile.md) rules out absolutely.
3. **The client's frame switch is exhaustive by construction.** `ServerFrame` is a discriminated
   union, so a new frame type added to the protocol and not handled is a type error in
   `chat-client.ts` rather than a log line nobody reads.

### REST

> **Built, not sketched, as of Phase 3.75a.** Every line below exists and is exercised by a
> route-level test. Where the shape differs from the original sketch the reason is stated inline;
> the two systematic ones are worth reading first:
>
> 1. **No route accepts a `clubId` alongside a scope id.** The owning club is resolved
>    server-side, because a two-part authorization check cannot tell whether its two arguments
>    describe the same thing. See [Authorization](05-authorization.md).
> 2. **Every `:id` and `:uid` is a UUID, enforced by one hook** rather than per route. A
>    malformed id is a 404, not a 500.

```
POST   /api/auth/*                           ← better-auth handles sign-up/in/out
GET    /me                                   ← the caller's id and club roles
GET    /users/:id[?clubId=]                  ← profile card; dob withheld from everyone but its owner.
                                               Carries canReport, and a `dm` block ONLY when the pair
                                               already has a thread - the card must never open one to
                                               find out (DESIGN/10 rule 5a)
PATCH  /me/profile                           ← self only; there is deliberately no PATCH /users/:id
DELETE /me                                   ← anonymize + block future sign-in; 409 while they own a club

GET    /conversations                        ← the chat list: club chats + DMs, newest first
                                               a club row's unread covers EVERY channel of that
                                               club the caller can reach, not the main chat alone
GET    /channels                             ← per-channel sync state; what the hub badges from
GET    /sync?channels[]={id}:{since_seq}     ← the reconnect / foreground path. The entry is
                                               NEVER percent-encoded by the client, and an entry
                                               that does not parse is a 400 - see below
GET    /channels/:id/messages?before={seq}&limit=40
GET    /channels/:id/messages/around?around={seq}&radius=20   ← jump-to-message window
GET    /channels/:id/pinned | /announcements ← Highlights; whole channel, never a loaded window
GET    /channels/:id/reports | /gallery
POST   /channels/:id/messages/:seq/pinned    ← admin of the space; NEVER carries a type change
DELETE /channels/:id/messages/:seq           ← soft delete: sender or space admin
GET    /channels/:id                         ← title, canPost + why not, muted, peer
GET    /media/:id                            ← 302 to the signed URL, for an <img src>
GET    /media/:id/url                        ← the same hop as JSON, for a header-bearing client
POST   /channels/:id/messages/:seq/reactions ← toggle; returns the FULL resulting set
GET    /channels/:id/messages/:seq/reactions ← who reacted
POST   /channels/:id/messages/:seq/report
POST   /channels/:id/mute | DELETE           ← per-conversation, every scope
POST   /channels/:id/pin  | DELETE           ← personal; sorts it to the top of YOUR list
POST   /channels/:id/clear                   ← "Delete chat": hides it for the caller only, dm only

GET    /dm/threads | /dm/candidates?q=       ← no global user search
GET    /dm/shared-clubs/:uid                 ← the clubs you both belong to, for the DM profile
POST   /dm/threads                           ← open or re-open; idempotent per pair
GET    /blocks | POST /blocks | DELETE /blocks/:uid

POST   /users/:uid/report                    ← report a PERSON; every refusal is 404 (ADR-0035)

GET    /moderation/dm-reports                ← platform moderators only, metadata only
GET    /moderation/user-reports              ← the person queue; never a club admin, ever
POST   /moderation/user-reports/:uid/dismiss ← by SUBJECT, closing every open report about them
GET    /moderation/reports/:id/context       ← the narrow, audit-logged read
POST   /moderation/reports/:id/dismiss
POST   /moderation/reports/:id/remove        ← soft-delete the reported message; dm scope only
POST   /moderation/users/:uid/suspended      ← body { suspended, messageId? }; reversible ejection
GET    /moderation/reads                     ← a moderator's own audit trail

GET    /clubs/search?q=                      ← safe projection, non-members only, no paging
POST   /clubs · GET/PATCH/DELETE /clubs/:id  ← GET carries the invite token for any MEMBER
                                               (ADR-0024); a non-member is refused the club
GET    /clubs/:id/members                    ← roster; pendingRequests null for a non-admin
POST   /clubs/:id/members/seen               ← clears that club's join-request rows
POST   /clubs/:id/join | /join-requests/:id/approve | /deny
POST   /invites/:token/redeem                ← the only invite path; no typed-code entry. WHICH
                                               of the club's two links decides join vs request
                                               (ADR-0025). A ban answers 403, everything else 404
POST   /clubs/:id/invite-token/rotate        ← admin; invalidates BOTH links at once
POST   /clubs/:id/members · PATCH /members/:uid/role · DELETE /members/:uid
POST   /clubs/:id/transfer-ownership

GET    /clubs/:id/races?q=                   ← every race in the club; viewer state per row
POST   /clubs/:id/races                      ← admin; name and date only
GET    /races/:id                            ← preview, manager hub and member race, one read
DELETE /races/:id
PATCH  /races/:id                            ← name, date, picture; absent KEEPS
PATCH  /races/:id/meet-information            ← all five fields, one form; absent clears
POST   /races/:id/pin                        ← personal; body { pinned }
GET    /races/:id/members                    ← roster; pendingRequests null for a non-manager
POST   /races/:id/members · DELETE /races/:id/members/:uid
POST   /races/:id/members/seen               ← clears that race's join-request rows
POST   /races/:id/join-requests
POST   /race-join-requests/:id/approve | /deny
GET    /races/:id/car-groups                 ← groups, Incharge tags, and who is unassigned
POST   /races/:id/car-groups                 ← auto-numbered; no name in the request
POST   /car-groups/:id/members · PATCH /car-groups/:id/incharge
DELETE /races/:id/car-group-members/:uid     ← keyed by race: one group per person per race

GET    /eboards/:id                          ← the landing state and the space, one read
PATCH  /eboards/:id                          ← name, description, picture; MEMBERS only
GET    /eboards/:id/members                  ← members only; a club admin outside gets nothing
POST   /eboards/:id/members/seen
POST   /eboards/:id/join-requests             ← the rejoin path for an admin who left
POST   /eboard-join-requests/:id/approve | /deny   ← existing members ONLY, never any club admin
POST   /eboards/:id/members                  ← existing members; target must be admin-tier
DELETE /eboards/:id/members/:uid             ← leaving is free; removing is Owner-only

GET    /eboards/:id/meetings?when=upcoming|past
POST   /eboards/:id/meetings                 ← any member of the space
GET    /meetings/:id · PATCH                 ← PATCH is the creator only
DELETE /meetings/:id                         ← ANY member of the space; posts "X cancelled Y"

POST   /clubs/:id/polls · /races/:id/polls · /eboards/:id/polls
GET    /clubs/:id/polls · /races/:id/polls · /eboards/:id/polls
GET    /polls/:id                            ← counts public, voters gated, own vote always shown
POST   /poll-options/:id/vote                ← cast, move or withdraw; addressed by OPTION
POST   /polls/:id/closed                     ← body { closed }; the creator only, in every scope
DELETE /polls/:id

POST   /clubs/:id/events · DELETE /events/:id
GET    /events/:id                           ← any club member; `canManage` says who may delete
POST   /clubs/:id/meetups · PATCH · DELETE /meetups/:id
GET    /clubs/:id/meetups?monday=YYYY-MM-DD  ← the Monday is required, never guessed.
                                               Returns a day's meetups time-ordered;
                                               a day may hold several. Carries
                                               nudgeBlockedUntil for the bell
POST   /meetups/:id/nudge                    ← admin; 202. Pushes the meetup to the club.
                                               409 { error, availableAt } while cooling
                                               down - the refusal names a TIME, because
                                               a bare no gets tapped again (ADR-0030)
GET    /meetups/:id                          ← one meetup, for its own screen. Club membership
                                               reads it; a club you are not in answers 404 and
                                               not 403, so an id cannot be probed. Carries the
                                               name, the notes, the pasted map link and the
                                               point read out of it (ADR-0037)
GET    /clubs/:id/news · POST /clubs/:id/news
GET    /news/:id · PATCH · DELETE            ← any club admin, not only the author
POST   /news/:id/reactions                   ← the same emoji set as chat, constrained in the column

GET    /calendar?club=:id&when=upcoming|past|all   ← merged feed; omit club for cross-club
                                                     events, races, meetings and meetups. No
                                                     polls, and every row carries a date
                                                     (PRD/07 rule 2). A row is a day plus
                                                     allDay, and a meetup adds timeOfDay - the
                                                     club's wall clock, never folded into the
                                                     date (ADR-0036)
GET    /calendar/markers?club=:id&year=&month=     ← the month grid; days inside the month only.
                                                     Derived from the feed, so it can never
                                                     disagree with it about what is on a day

POST   /media/upload-intent · POST /media/:id/complete
GET    /media/:id[?variant=thumb|display]   ← authorized redirect, hour-aligned signature
GET    /channels/:id/gallery?before={seq}   ← paginated; inherits the chat's access rules
GET    /notifications?cursor=                · POST /notifications/read
POST   /devices                              ← register push token
DELETE /devices                              ← forget it on sign-out; scoped to the caller
```

> **`PATCH /races/:id` and `PATCH /races/:id/meet-information` obey opposite rules about an
> absent key, and that is why they are two routes rather than one.** Meet Information is a
> single form saved whole, so an omitted field means "this is now empty". A race's identity is
> three independent facts touched from two different controls - the pencil sends a name and a
> date, tapping the avatar sends nothing but a picture - so an omitted field means "not mine to
> touch". Merged, an avatar upload would be indistinguishable from a form that cleared the name.
> `PATCH /eboards/:id` and `PATCH /clubs/:id` follow the identity rule, not the form rule.

> **A `channels[]` entry is written raw, and an entry that does not parse is refused.** Two rules
> from one defect, found 2026-08-12. The client must never percent-encode the entry: React Native's
> `fetch` re-encodes the URL it is given, so a `%3A` written by the client left the phone as
> `%253A` and the server - which decodes exactly once - saw no colon at all. A uuid and an integer
> need no escaping, and whatever the platform escapes on its own the server decodes back. The
> server then made it invisible by **skipping** what it could not parse, which is the same answer
> as omitting a channel the caller may not read: every iOS sync returned `200` with an empty list
> and reconciled nothing for months. A malformed entry is now `400 bad_channel_entry`; an
> unauthorized one is still omitted, because a client holding a stale channel list must be able to
> sync the rest. See `AGENTS.md` failure mode 24.

> **`/conversations` and `/channels` are not the same read, and the names are close enough to
> matter.** `/channels` is sync state - ids, scopes and sequence numbers for the client's gap
> arithmetic, carrying nothing a person reads. `/conversations` is the chat list: names,
> pictures, unread counts and the last thing said in each, for club and DM scopes only
> ([Screen map](../PRD/15-screen-map.md)). Both scope themselves with the same access predicate,
> so neither can drift from the other about who may see what.

Every mutation returns the created/updated resource - legal and trivial now, and the direct
counter-example to [Engineering pitfalls](14-engineering-pitfalls.md) 1.
