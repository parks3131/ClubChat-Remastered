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
| `msg.err` | `{ client_msg_id, code }` | `rate_limited`, `forbidden`, `channel_gone` |
| `msg.new` | full message envelope incl. `seq` | Append if `seq == local_max + 1`, else sync. |
| `msg.update` | `{ channel_id, seq, pinned?, deleted_at?, reactions? }` | |
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

POST   /media/upload-intent · POST /media/:id/complete · GET /media/:id
GET    /notifications?cursor=                · POST /notifications/read
POST   /devices                              ← register push token
```

Every mutation returns the created/updated resource - legal and trivial now, and the direct
counter-example to [Engineering pitfalls](14-engineering-pitfalls.md) 1.
