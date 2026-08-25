# Client architecture

Keep Expo + Expo Router. The screen map, navigation rules and design system in [Screen map](../PRD/15-screen-map.md) and
[Design system](13-design-system.md) are all still correct and represent real shipped work - the remaster is a backend and
data-flow change, not a UI rewrite.

What is new here, numbered so it can be cited:

### 1. Local persistence

SQLite (`expo-sqlite`, with OPFS on web) storing `messages` keyed by `(channel_id, seq)`, plus
channel metadata and cursors. This is what makes [Cross-cutting UX](../PRD/16-cross-cutting-ux.md)'s offline gap addressable: chat
becomes readable offline instead of a spinner.

### 2. Send outbox

```
enqueue(client_msg_id, channel_id, body, media_id?)
  → render optimistically as "pending"
  → attempt send over WS; on ack, replace with the server row at its seq
  → on failure: retry with backoff while the app is alive; surface "failed" with a retry
    affordance after N attempts
```

`client_msg_id` is generated **once**, at enqueue, so retries are free of double-post risk
([Channel log](02-channel-log.md), idempotency). This closes [Cross-cutting UX](../PRD/16-cross-cutting-ux.md)'s "no queued sends, no optimistic send" gap and
keeps its rule that a failed send fails *visibly*.

### 3. Sync engine - the fix for silent message loss

[Engineering pitfalls](14-engineering-pitfalls.md) 25 is the most dangerous open bug in the old build: *"A phone that backgrounds and
resumes can permanently miss messages with no error and no indication."*

```
on( socket connect | app foreground | network regained ):
    for each channel with local state:
        GET /sync?channels[]={id}:{local_max_seq}
        apply returned messages + updated cursors

on( msg.new with seq ) OR ( msg.ack with seq ):        ← both, identically
    if seq == local_max + 1  → append
    if seq >  local_max + 1  → append, then run sync for that channel
    if seq <= local_max      → duplicate, ignore
```

> **The gap rule applies to the client's own `msg.ack`, not only to `msg.new`.**
>
> Consider: A's `local_max` is 3. It missed seq 4 from another member while the socket was
> flapping. A sends, and receives `msg.ack {seq: 5}`. If the ack path skips the gap check, A
> appends its own message at 5, sets `local_max = 5`, and now holds a **permanent** hole at 4 -
> permanent because every future `msg.new` at 6 satisfies `local_max + 1` and never triggers
> a sync. The client believes it is caught up and is not, which is the exact state this
> section exists to make impossible.
>
> Note the asymmetry with `msg.new`: on a gap the client still **appends** its own message
> (the send succeeded and must not disappear from the UI) and syncs to backfill the hole
> behind it.

Gapless sequence numbers make gap detection *exact*, not heuristic. There is no state in which
the client silently believes it is caught up when it is not.

> **The `channels[]` entry is written raw, and this is load-bearing rather than a formatting
> preference.** React Native's `fetch` re-encodes the URL it is handed, so a `%3A` written by this
> client left the phone as `%253A`; the server decodes exactly once, found no colon, and dropped
> the entry. **Every `/sync` from iOS answered `200` with an empty list, for months** - the socket
> kept the phone current, so the only casualty was precisely what this section exists to prevent.
> A uuid and an integer need no escaping, and whatever the platform escapes on its own the server
> decodes back. See [Protocol](10-protocol.md) and `AGENTS.md` failure mode 24.
>
> The half that made it survivable is the server's, and it is fixed there: an entry that does not
> parse is now a `400` rather than being skipped. **A repair that achieves nothing must not report
> success** - `repairGaps` compares the hole before and after writing its page and says so when
> nothing changed, which is the signal that finally surfaced this.

### 4. Realtime remains an enhancement

[Cross-cutting UX](../PRD/16-cross-cutting-ux.md) rule 4 stands: every screen also loads its data over REST, so a dropped socket
degrades to stale-until-refresh rather than broken. The socket is an accelerator, never a
dependency.

### 5. A message row has three shapes, and two of them are not bubbles

The chat row branches before it builds a bubble, and each branch owns **everything** a message
needs rather than inheriting it:

| Shape | What it is |
|---|---|
| Bubble | Ordinary messages, photos, documents. Sided, avatared, timestamped. |
| Announcement | Full width, addressed to the room. No avatar, no side. |
| Card | Full width, a poll / event / meeting. No avatar, no side, no timestamp. |

**The obligation, promoted here from [`DESIGN/05`](../DESIGN/05-content-card.md) rule 4 because
this is where somebody adding a per-message feature will look:** anything hung on the bubble has
to be hung on the other two branches as well, or it silently stops existing for a third of the
conversation. Today that list is the long press that opens the react-and-report sheet, the visible
dots that stand in for that gesture on web, the pin marker, the jump-target highlight, and the
reaction row.

**Attribution is one component across the branches that have it**, `AuthorLine`: the avatar and
the name together above the content, hanging in the gutter on the sender's own side with the box
beneath inset to line up with the name. Bubbles mirror it for your own messages; a card never
does, being full width and unsided. Written twice for a few hours and the two copies had already
disagreed about the name's colour, which is the whole argument for it being one.

**A card's outer wrapper declares `accessibilityRole="none"`, and that is load-bearing.**
react-native-web renders a `Pressable` as a real `<button>` only when its role says so, and the
event and meeting cards are buttons themselves. `disabled` is not the alternative - it was tried,
and it disables descendants, so every option inside a poll card went dead.

### 6. The JavaScript can be replaced without a store release

`expo-updates`, publishing through EAS Update. Two properties are structural and neither should be
softened without reading [ADR-0048](../decisions/0048-updates-are-keyed-to-a-fingerprint.md).

**Compatibility is decided by a fingerprint, never by a version number.** `runtimeVersion` is
`{ "policy": "fingerprint" }`: a hash of everything affecting the native runtime - the dependency
tree, the `plugins` array, `app.json`, any local native module. An update can therefore only be
offered to a binary built from the same tree. This is what makes [Deployment](21-deployment.md)
rule 3 - *"a native build ships before the JavaScript that imports it, never after"* - a property of
the system rather than a rule somebody has to remember. The alternative policies key it to a version
string, which here is owned by EAS and auto-incremented, so it moves when nothing native has changed
and stays still when something has.

**An update is never on the launch path.** `checkAutomatically: "ON_LOAD"` with
`fallbackToCacheTimeout: 0`: checked at launch, downloaded in the background, applied at the
**next** launch. The app already holds its first frame on the font gate ([Design
system](13-design-system.md) rule 4), and a second gate in front of that one, on a request that can
time out, is a cold start indistinguishable from a hang. There is deliberately no update UI and no
`reloadAsync` call anywhere in the app.

`eas.json` gives `preview` and `production` a channel each, named for the profile. `development`
has none: it builds a dev client, which loads its JavaScript from Metro.

**Nothing in `app/` or `src/` imports `expo-updates`, and that is the finished state rather than
an omission.** The whole of the behaviour is native, configured through `app.json`; the only
JavaScript API it offers is for the update UI this deliberately does not have. The dependency
therefore looks unused to anything that counts imports, and removing it would leave an `updates`
block that reads as configured while no code implements it - which is why `src/app-config.test.ts`
asserts the dependency is present as well as asserting the configuration.

### 7. An invite link is one https URL, and the app has no link handler

The link a club hands out is `https://clubchatapp.com/join/<token>`, built by `inviteLink` in
`src/invite-link.ts` and used by the share sheet, the copy control and the QR code alike. It
replaced `clubchat://join/<token>`, which was nothing at all to a phone without the app installed.
The app claims that path - `ios.associatedDomains`, plus one auto-verifying Android intent filter
scoped to `/join/` - and `packages/site-worker` serves the two association files that make the
claim true. [ADR-0045](../decisions/0045-the-apex-is-a-standalone-worker.md) has the whole shape.

**There is no deep link handler in this app, and adding one would be a defect.** Expo Router takes
the URL the OS delivers, strips the origin off an `https://` one and the scheme off a custom one,
and navigates to what is left, so `https://clubchatapp.com/join/x` and `clubchat://join/x` both
reduce to `join/x` and land on the same screen with no code involved. Claiming the path was the
whole of the client work. A hand-written listener would be a second handler racing the first.

**The custom scheme keeps working, permanently.** Links already sent sit in conversations and codes
already printed are taped to walls; neither can be recalled.

`tokenFromScan` matches on the **path** and never on the scheme, because the scanner reads a string
rather than asking the OS to open it, and that string has four spellings across platforms and build
types. Anchoring on the scheme works on the founder's phone and fails in development.

Both halves of the link claim fail **silently** when they disagree: a path the app does not claim
opens a web page instead, and an Android package that does not match the published `assetlinks.json`
fails verification with nothing logged anywhere. `src/app-config.test.ts` therefore reads `app.json`
and `eas.json` as data and pins the values the app, the Worker and EAS all have to agree on.
