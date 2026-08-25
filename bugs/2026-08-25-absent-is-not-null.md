# Opening a meetup crashed the app, because a dropped column removed a key rather than a value

**Found** 2026-08-25, reported from the phone within minutes of a deploy. Caused by that deploy.

## What broke

Migration 0041 dropped `meetups.location`. `readMeetup` then stopped returning the `location`
**key** at all. The build installed on the founder's phone reads it:

```tsx
<DetailLine label="Where" value={meetup.location} />
```

and `DetailLine` guards like this:

```ts
if ((value === null || value.trim().length === 0) && placeholder === undefined) return null;
```

`||` short-circuits. For `undefined` the first test is false, so it evaluates `value.trim()` and
throws. **The guard handles null and only null**, and an absent key is not null.

## The second one, which was latent

`directionsUrl` guards `if (point !== null) { ... point.lat ... }`, so an absent `mapPoint` throws
the same way - but only for a meetup with NO map link, because a link returns one line earlier. It
would have surfaced days later, on a different meetup, looking like a new bug.

## How it was found

Not by reading code. The api log settled it in one line: `GET /meetups/:id` answered **200 in
27ms**, and then the app stopped making requests entirely. A perfect server response followed by
silence puts the fault in the client, on a successful payload, which is what pointed at a missing
field rather than a failing query.

## The fix

`location: null` and `mapPoint: null` returned as always-null compatibility keys. The columns stay
dropped. The removal condition is written at the return site because it is a fact about which
builds are installed on phones, and nothing in this repo can query that.

## What went wrong while fixing it

**Both sessions had watched the wrong window.** The deploy plan carefully accounted for old server
code against a new schema, which lasts about sixty seconds. The window that mattered was an old
CLIENT against a new server, and it does not close on its own: a phone runs the build it has until
somebody installs a new one. That is `TECH/21` rule 5, one level above where either session looked.

**Two existing tests asserted the defect.** They read `not.toHaveProperty('location')` and
`not.toHaveProperty('mapPoint')` - correct about the schema, wrong about the installed base, and
they would have locked the crash in. Both were changed, each carrying its reasoning inline.

**The checklist written to prevent a repeat would only have caught half of it.** It asks whether a
shipped build reads the dropped column. `location` is the same word in both places, so that half is
caught. `map_lat` and `map_lng` become `mapPoint` via `toPoint()`, a name appearing nowhere in the
migration, so a grep returns a confident and useless answer. The checklist now asks what the column
FEEDS before asking what reads it.
