# The connection layer

### WebSockets - confirmed

The transcript's reasoning holds unchanged for ClubChat. Polling wastes bandwidth and adds
latency; long polling burns a handshake per message. We need server-initiated push (a message
from another member arrives with no client action), so a persistent bidirectional socket is
correct.

**Consequence: L4 load balancing for the gateway.** L7 balancers that terminate HTTP break the
upgrade or add proxy hops. The REST API keeps an ordinary L7 balancer.

### Connection registry

Redis, exactly as the transcript describes, with one simplification.

```
key:   conn:{user_id}
type:  hash of session_id → { gateway_id, device_id, platform, connected_at }
TTL:   90s, refreshed on every heartbeat (client pings every 30s)
```

**The registry has exactly one job: routing a publish to the gateways that hold sockets.** It is
never consulted to decide whether someone needs a push notification - see [Message flows](03-message-flows.md) for why that
would be a correctness bug rather than an optimization.

**The TTL must never exceed the reaper window** (both are 90s). An entry that outlives the socket
it describes causes a publish to a gateway that no longer holds the connection, which is a
harmless no-op. An entry that outlived the socket while *also* gating push delivery would cause
silent missed notifications, which is why that coupling does not exist.

> **The registry write is best effort, and failing it does not fail the handshake.** It is a
> Redis write on `maxRetriesPerRequest: 3`, so a Redis restart makes it reject in a second or
> two - and it used to be awaited on the handshake path, where a rejection took the whole
> connection down without answering the client. Refusing a socket because Redis blinked is the
> wrong trade twice over: [Failure modes](11-failure-modes.md) requires a wiped Redis to
> *degrade* the system rather than break it, and per-channel fan-out means nothing reads this
> hash at all today - the gateway subscribes to `chan:{id}` and fans out in process, so routing
> never consults it. A socket that works is worth more than a routing hint that is accurate. The
> failure is logged and reported, because an empty registry has no other symptom.

**Simplification vs. WhatsApp:** the transcript's presence service exists largely to power
*user-visible* online/offline and "last seen". [Chat](../PRD/05-chat.md) puts presence, typing indicators
and read receipts explicitly **out of scope**. So:

> **Decision.** There is no presence *service* and no presence *feature*. The connection
> registry exists solely for message routing and to decide whether a member needs a push
> notification. No online/offline state is ever rendered in the UI.

This removes an entire subsystem, its fan-out, and its subscription bookkeeping. If presence is
ever wanted as a product feature, it is added on top of the registry that already exists.

### Heartbeats and the reaper

Client → server `ping` every 30s; server closes a socket silent for 90s. A gateway that dies
without closing sockets leaves stale Redis entries which expire by TTL. A publish to a stale
entry is a no-op - and it does not matter, because the message is already durable in the
channel log and the client will sync on reconnect.

> **Both halves of that sentence were unimplemented until 2026-08-19, and the reaper was
> therefore a machine for disconnecting live members.** No client ever sent a `ping` - the
> gateway handled the frame and nothing produced it - and `lastSeenAt` advanced only on an
> inbound application frame. So a member reading the clubs tab for ninety seconds without typing
> had their socket terminated underneath them. Nothing reconnected it either: the client's
> `onclose` nulled the socket and returned, and the only two callers of `reconnect()` were a
> send retry and the app-foreground listener, neither of which fires for somebody already
> looking at the app. They received no live message until they sent one or opened a chat, and
> nothing anywhere reported it: history still loaded over REST, their own sends still acked, and
> the failure looked exactly like a quiet afternoon.

**Three mechanisms, and each covers what the others cannot.**

1. **The client pings every 30s** (`packages/client-core/src/chat-client.ts`), which is what
   keeps a quiet socket unreaped and what refreshes the registry TTL. Three chances inside a 90s
   window, so one dropped frame is survivable. It runs only while the socket is authenticated,
   because the gateway closes a socket that speaks before `auth`.
2. **The server pings every 30s too**, on the reaper's own tick, and counts the protocol-level
   `pong` as liveness exactly like an inbound frame. This exists for the failure the client's
   ping cannot see: a **half-open** socket, where the peer is gone but no FIN ever arrived. A
   client in that state believes it is connected, sends its pings into a dead pipe, and
   reconnects nothing - and from the gateway it is indistinguishable from a quiet member until a
   ping goes unanswered. WebSocket peers answer a ping at the protocol level with no application
   involvement, so this needs nothing of the client and works for app builds already on phones.

   Note what it changes about the word *silent*: it now means "did not answer a ping in 90s"
   rather than "sent nothing in 90s", which is the property actually worth measuring.
3. **The client reconnects itself**, with exponential backoff from 500ms to a 30s ceiling, plus
   jitter - because the event that produces a great many reconnects at once is a gateway
   restarting, and every client returning in the same millisecond is how a restart becomes an
   outage. The reconnect re-authenticates, resubscribes every channel and runs `/sync`, which is
   what the channel log exists to make correct. A refusal the server states - `invalid_token` or
   `signin_blocked` - ends the loop rather than retrying it; every other failure is a moment
   rather than a verdict.

### The handshake, and the frames that arrive during it

A socket sends `auth` first and is closed if it has not within 5s. `auth` is answered after two
database round trips - resolving the session, then loading the access context - which is a real
window, and it is the window a cold open occupies: a chat screen mounting from a deep link, a
notification tap or a page refresh asks to subscribe and to advance a read cursor from its mount
effect, while the handshake is still in flight.

**Both ends are responsible for that window, for different reasons.**

- **The gateway handles one socket's frames at a time, in arrival order.** Otherwise a `subscribe`
  sent after `auth` is evaluated before `auth` has been applied, and refused. See
  [Protocol](10-protocol.md).
- **The client sends nothing until `auth.ok`,** holding subscriptions and read cursors the way it
  already holds queued sends. A socket that exists is not a socket that may be used.

> **Why both, when either would do.** A client already installed on somebody's phone cannot be
> fixed retroactively, so the server must not refuse correctly-ordered frames. And a server that
> discards a frame from an unauthenticated socket *and closes the connection* means an early frame
> does not merely fail, it takes the conversation down - so the client must not send one. Each end
> is the other's blast radius.

**Every terminating path of the handshake produces exactly one `auth.ok` or `auth.err`, and the
socket is closed on the second.** Not "usually", and not "unless something throws": the client
awaits that reply and its only other rejector is the socket closing, so a path that returns
without answering leaves the app on its loading spinner permanently - the outcome
[Accounts and profile](../PRD/03-accounts-and-profile.md) rules out absolutely.

Two rules keep it true, and both were missing until 2026-08-19:

- **The auth timer outlives the handler rather than being cleared on entry to it.** It is armed
  at 5s for the `auth` frame to arrive, and re-armed at 10s for the handshake to be answered.
  Clearing it on entry meant that from the moment the frame arrived, nothing was watching -
  and the generic per-frame catch deliberately keeps the socket open and says nothing, which is
  right for one bad `msg.send` and fatal here. A throw inside the handler therefore sent no
  reply, no refusal and no close. The likeliest thrower was the registry write above: Redis
  restarts for thirty seconds and every phone that cold-opens in that window hangs.
- **The client bounds its own wait** at 12s, deliberately longer than the server's 10s window so
  that a server which is *alive* always answers first and the client acts on a reason rather
  than on a silence. The client's timer is the backstop for a server that is not there at all.

> **A handshake that fails for a server-side reason answers `auth.err {"code":"timeout"}`, and
> that is a compromise rather than a description.** The code set in [Protocol](10-protocol.md) is
> closed, and of the six, `timeout` is the only one that says "this handshake did not complete"
> without blaming the credential. The two that describe the token - `invalid_token` and
> `signin_blocked` - are the ones a client acts on by **signing the member out**, so reaching for
> either would turn a Redis blip into a mass sign-out. A distinct `server_error` code is a
> protocol change and belongs with that document and the schemas in `packages/shared`.

Until 2026-08-09 neither held, and the pair cost a member their session: the refusal was reported
as `invalid_token`, which the client reads as proof the session is dead. See
[Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) and the 2026-08-09 entry in
[`HISTORY.md`](../../HISTORY.md).

### Fan-out topology - a deliberate improvement on the transcript

The transcript publishes to **per-user** Redis channels: for a 50-person group, up to 50
publishes and 50 subscriber authorizations per message. [Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md) debt 2 records exactly
this cost in the old build ("with 200 concurrent users, one message insert costs ~200
authorizations, ~200 billed messages, and ~200 full refetches").

We publish to **per-channel** topics instead:

```
publish  →  chan:{channel_id}   payload: { channel_id, seq, kind }
subscribe←  every gateway holding ≥1 socket subscribed to that channel
```

- Authorization happens **once, at subscribe time**, not once per message per recipient.
- One publish per message regardless of channel size.
- Fan-out is to *gateways* (a handful), which then fan out in-process to sockets (cheap).
- A gateway holding no member of that channel receives nothing.

This is strictly better than the reference design for a group-only product, and it is the direct
fix for the unfiltered-subscription debt recorded in
[Roadmap and open questions](../PRD/17-roadmap-and-open-questions.md).

> **The cost of authorizing once: revocation must be pushed, not waited for.**
>
> Because access is checked at subscribe time and *not* rechecked per message, a live
> subscription outlives the membership that justified it. Removing someone from a club, a race
> roster, or the Eboard - or blocking them in a DM - drops the database row, and their socket
> would happily keep receiving messages until they next reconnect.
>
> **Every membership-revoking effect must therefore force-unsubscribe that user's sockets from
> the affected channels**, not merely delete the row. The cascade in
> [Server event catalogue](12-server-event-catalogue.md) is where this belongs, since it already
> enumerates exactly which memberships a removal touches.
>
> This is the one thing per-channel fan-out costs that per-user fan-out does not, and it is
> worth stating loudly because the failure is silent: a removed member keeps reading a channel
> they no longer belong to, and nothing in the system reports it. See
> [ADR-0007](../decisions/0007-per-channel-fanout-topics.md).
