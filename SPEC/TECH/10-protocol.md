# Protocol specification

### WebSocket

Envelope: `{ "t": <type>, "id": <correlation id>, "d": <payload> }`

**Client → server**

| Type | Payload | Notes |
|---|---|---|
| `auth` | `{ token, device_id, platform }` | First frame. Socket closed if absent within 5s. |
| `subscribe` | `{ channel_ids: [] }` | **Authorized here, once.** Rejected ids returned in the reply. |
| `unsubscribe` | `{ channel_ids: [] }` | |
| `msg.send` | `{ client_msg_id, channel_id, type, body?, media_id?, mentions? }` | |
| `msg.read` | `{ channel_id, up_to_seq }` | Advances the read cursor. |
| `ping` | `{}` | Every 30s. |

**Server → client**

| Type | Payload | Notes |
|---|---|---|
| `auth.ok` | `{ session_id, server_time, channels: [{id, last_seq, last_read_seq}] }` | The client immediately knows every channel with a gap. |
| `auth.err` | `{ code }` | Socket closed. |
| `msg.ack` | `{ client_msg_id, message_id, seq, created_at }` | **Gap-checked exactly like `msg.new`** - a skipped `seq` here leaves a permanent hole. See [Client architecture](08-client-architecture.md). |
| `msg.err` | `{ client_msg_id, code }` | `rate_limited`, `forbidden`, `channel_gone`, `malformed`, `media_not_ready` |
| `msg.new` | full message envelope incl. `seq` and `reactions` | Append if `seq == local_max + 1`, else sync. Reactions ride on the envelope so they survive offline with the message ([ADR-0017](../decisions/0017-reactions-travel-on-the-message-envelope.md)). |
| `msg.update` | `{ channel_id, seq, pinned?, deleted_at?, reactions? }` | **Reactions are the FULL set, never a delta.** Only the fields that changed are present, and an absent field is distinct from an explicit `null`. Declared from Phase 0 and had no producer at all until reactions arrived in Phase 3.5 - pins and tombstones now travel on it too. Deliberately **not** gap-checked: an update names an existing `seq` rather than extending the log, so it can neither create nor reveal a hole. See [ADR-0017](../decisions/0017-reactions-travel-on-the-message-envelope.md). |
| `notif.new` | `{ notification }` | Drives the badge live. |
| `pong` | `{}` | |

### REST (sketch)

```
POST   /auth/register | /auth/login | /auth/refresh | /auth/logout
DELETE /me                                   ← anonymize + block future sign-in

GET    /sync?channels[]={id}:{since_seq}     ← the reconnect / foreground path
GET    /channels/:id/messages?before={seq}&limit=40
GET    /channels/:id/messages?around={seq}   ← jump-to-message window
GET    /channels/:id/pinned | /announcements | /reports | /gallery
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

GET    /clubs/search?q=                      ← safe projection, non-members only
POST   /clubs · GET/PATCH/DELETE /clubs/:id
POST   /clubs/:id/join | /join-requests/:id/approve | /deny
POST   /invites/:token/redeem                ← the only invite path; no typed-code entry
POST   /clubs/:id/invite-token/rotate        ← admin; invalidates every outstanding link
POST   /clubs/:id/members · PATCH /members/:uid/role · DELETE /members/:uid
POST   /clubs/:id/transfer-ownership

POST   /clubs/:id/races · GET/PATCH/DELETE /races/:id
POST   /races/:id/join-requests · /members · /pin
POST   /races/:id/car-groups · /car-groups/:id/members · PATCH /incharge

GET    /clubs/:id/eboard · POST /eboard/:id/members · /meetings

POST   /polls · POST /polls/:id/votes · POST /polls/:id/close | /reopen
POST   /clubs/:id/events | /routines | /news
GET    /calendar?club=:id                    ← merged feed; omit club for cross-club

POST   /media/upload-intent · POST /media/:id/complete
GET    /media/:id[?variant=thumb|display]   ← authorized redirect, hour-aligned signature
GET    /channels/:id/gallery?before={seq}   ← paginated; inherits the chat's access rules
GET    /notifications?cursor=                · POST /notifications/read
POST   /devices                              ← register push token
```

Every mutation returns the created/updated resource - legal and trivial now, and the direct
counter-example to [Engineering pitfalls](14-engineering-pitfalls.md) 1.
