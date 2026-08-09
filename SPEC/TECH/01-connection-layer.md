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

**Simplification vs. WhatsApp:** the transcript's presence service exists largely to power
*user-visible* online/offline and "last seen". [Chat](../PRD/05-chat.md) puts presence, typing indicators
and read receipts explicitly **out of scope**. So:

> **Decision.** There is no presence *service* and no presence *feature*. The connection
> registry exists solely for message routing and to decide whether a member needs a push
> notification. No online/offline state is ever rendered in the UI.

This removes an entire subsystem, its fan-out, and its subscription bookkeeping. If presence is
ever wanted as a product feature, it is added on top of the registry that already exists.

### Heartbeats and the reaper

Client → server ping every 30s; server closes a socket silent for 90s. A gateway that dies
without closing sockets leaves stale Redis entries which expire by TTL. A publish to a stale
entry is a no-op - and it does not matter, because the message is already durable in the
channel log and the client will sync on reconnect.

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
