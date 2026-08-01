# Protocol specification

### WebSocket

Envelope: `{ "t": <type>, "id": <correlation id>, "d": <payload> }`

**Client → server**

| Type | Payload | Notes |
|---|---|---|
| `auth` | `{ token, device_id, platform }` | First frame. Socket closed if absent within 5s. |
| `subscribe` | `{ channel_ids: [] }` | **Authorized here, once.** Rejected ids returned in the reply. |
| `unsubscribe` | `{ channel_ids: [] }` | |
| `msg.send` | `{ client_msg_id, channel_id, type, body?, media_id?, mentions?, reply_to_seq? }` | `reply_to_seq` is a seq, not an id, and the quote itself is never sent: the server joins it on read, so a sender cannot put words in somebody's mouth. See [Message flows](03-message-flows.md) 6.5. |
| `msg.read` | `{ channel_id, up_to_seq }` | Advances the read cursor. |
| `ping` | `{}` | Every 30s. |

**Server → client**

| Type | Payload | Notes |
|---|---|---|
| `auth.ok` | `{ session_id, server_time, channels: [{id, last_seq, last_read_seq}] }` | The client immediately knows every channel with a gap. |
| `auth.err` | `{ code }` | Socket closed. |
| `msg.ack` | `{ client_msg_id, message_id, seq, created_at }` | **Gap-checked exactly like `msg.new`** - a skipped `seq` here leaves a permanent hole. See [Client architecture](08-client-architecture.md). |
| `msg.err` | `{ client_msg_id, code }` | `rate_limited`, `forbidden`, `channel_gone`, `malformed`, `media_not_ready` |
| `msg.new` | full message envelope incl. `seq`, `reactions` and a resolved `reply_to` | Append if `seq == local_max + 1`, else sync. Reactions ride on the envelope so they survive offline with the message ([ADR-0017](../decisions/0017-reactions-travel-on-the-message-envelope.md)). `reply_to` is resolved here rather than left as a seq, for the same reason: the cache has to be able to draw the quote with no network. |
| `msg.update` | `{ channel_id, seq, pinned?, deleted_at?, reactions? }` | **Reactions are the FULL set, never a delta.** Only the fields that changed are present, and an absent field is distinct from an explicit `null`. Declared from Phase 0 and had no producer at all until reactions arrived in Phase 3.5 - pins and tombstones now travel on it too. Deliberately **not** gap-checked: an update names an existing `seq` rather than extending the log, so it can neither create nor reveal a hole. See [ADR-0017](../decisions/0017-reactions-travel-on-the-message-envelope.md). **An update missed while disconnected is missed permanently** - sync pulls strictly above the local max and never re-reads a cached row. Item 14 of [the roadmap](../PRD/17-roadmap-and-open-questions.md). |
| `notif.new` | `{ notification }` | Drives the badge live. |
| `pong` | `{}` | |

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
GET    /users/:id                            ← profile card; dob withheld from everyone but its owner
PATCH  /me/profile                           ← self only; there is deliberately no PATCH /users/:id
DELETE /me                                   ← anonymize + block future sign-in; 409 while they own a club

GET    /sync?channels[]={id}:{since_seq}     ← the reconnect / foreground path
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

GET    /dm/threads | /dm/candidates?q=       ← no global user search
POST   /dm/threads                           ← open or re-open; idempotent per pair
GET    /blocks | POST /blocks | DELETE /blocks/:uid

GET    /moderation/dm-reports                ← platform moderators only, metadata only
GET    /moderation/reports/:id/context       ← the narrow, audit-logged read
POST   /moderation/reports/:id/dismiss
GET    /moderation/reads                     ← a moderator's own audit trail

GET    /clubs/search?q=                      ← safe projection, non-members only, no paging
POST   /clubs · GET/PATCH/DELETE /clubs/:id  ← GET withholds the invite token from non-admins
GET    /clubs/:id/members                    ← roster; pendingRequests null for a non-admin
POST   /clubs/:id/members/seen               ← clears that club's join-request rows
POST   /clubs/:id/join | /join-requests/:id/approve | /deny
POST   /invites/:token/redeem                ← the only invite path; no typed-code entry
POST   /clubs/:id/invite-token/rotate        ← admin; invalidates every outstanding link
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
POST   /clubs/:id/workouts · DELETE /workouts/:id
GET    /clubs/:id/routines?monday=YYYY-MM-DD ← the Monday is required, never guessed
GET    /clubs/:id/news · POST /clubs/:id/news
GET    /news/:id · PATCH · DELETE            ← any club admin, not only the author
POST   /news/:id/reactions                   ← the same emoji set as chat, constrained in the column

GET    /calendar?club=:id&when=upcoming|past|all   ← merged feed; omit club for cross-club
GET    /calendar/markers?club=:id&year=&month=     ← the month grid; polls excluded

POST   /media/upload-intent · POST /media/:id/complete
GET    /media/:id[?variant=thumb|display]   ← authorized redirect, hour-aligned signature
GET    /channels/:id/gallery?before={seq}   ← paginated; inherits the chat's access rules
GET    /notifications?cursor=                · POST /notifications/read
POST   /devices                              ← register push token
```

> **`PATCH /races/:id` and `PATCH /races/:id/meet-information` obey opposite rules about an
> absent key, and that is why they are two routes rather than one.** Meet Information is a
> single form saved whole, so an omitted field means "this is now empty". A race's identity is
> three independent facts touched from two different controls - the pencil sends a name and a
> date, tapping the avatar sends nothing but a picture - so an omitted field means "not mine to
> touch". Merged, an avatar upload would be indistinguishable from a form that cleared the name.
> `PATCH /eboards/:id` and `PATCH /clubs/:id` follow the identity rule, not the form rule.

Every mutation returns the created/updated resource - legal and trivial now, and the direct
counter-example to [Engineering pitfalls](14-engineering-pitfalls.md) 1.
