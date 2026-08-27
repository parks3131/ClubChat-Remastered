# A photo waited in a square hole, and was five times bigger than the hole

**2026-08-27.** Reported from the founder's iPhone with a screen recording: *"we are using CDN,
right? It should be faster. And why the images whenever I come back and get in, it's, like, taking
a while to load. I mean, we have SQLite for cache."*

## What was seen

Re-enter a chat containing a photo and the picture is absent for a moment, then appears, and the
conversation moves. Every time, on a fast connection, on a CDN that is doing its job.

## What it was

Three things, and none of them the CDN.

**1. The load is 0.4 seconds.** Measured off the recording at ten frames a second: the chat draws,
and four tenths of a second later the picture is there. What feels slow is not the wait.

**2. The hole is the wrong shape.** `PhotoBubble` drew its loading and failed states at a hardcoded
`240x240` square while the photo itself is drawn at `photoSize(ratio)`. A 1200x1900 portrait renders
240x320, so it grew its own hole by eighty points on arrival and shoved everything below it down.
That is what is actually being watched: a wrongly shaped grey box, and then the conversation moving.

**The shape was already known before any byte arrived**, which is the part worth keeping.
`rememberedRatio` survives mounts and is keyed by media id rather than by the URL that rotates
hourly, precisely so a photo seen once opens at its final size; and the server sends `width` and
`height` beside the URL for one it has never drawn. Both sat there unused by the one branch that
needed them most.

**3. The bubble was sent the full-screen photo.** Chat asked for the `display` variant, derived at
1600px wide, to fill a 240pt slot. On a 3x screen that is about five times the pixels it can show,
and roughly 13MB of memory once decoded against 3.4MB at 800 - which is why iOS evicted it between
visits and fetched it again.

**And SQLite never held any of it.** The local database has two tables, `messages` and `sync_state`.
It caches the conversation so chat opens offline. There have never been image bytes in it, which is
the gap between what was expected and what is there.

## The fix

`photoSize` owns the box for all three states, and `photoPlaceholder` carries no width or height of
its own - a second opinion in the style is what let the two disagree. A third derived size,
`bubble` at 800px, with `VARIANT_FALLBACKS` so a photo uploaded before it existed degrades to
`display` rather than breaking, plus `scripts/backfill-media-variants.mjs` for the ones already
stored. And `expo-image`, which keeps its own memory and disk cache, so a photo seen once is read
off the device rather than off the network.

Delivered in that order deliberately, because the middle one has a hazard: production had to learn
the name `bubble` BEFORE any phone asked for it, or the route's validator would have answered 400
and every chat photo would have read "Photo unavailable". [`TECH/21`](../SPEC/TECH/21-deployment.md)
rule 1. Server deployed, 19 production photos backfilled, then the client published.

## What went wrong while fixing it

**`expo-image` crashed the app in `dyld` before a line of JavaScript ran.**

```
Symbol not found: _$s15ExpoModulesCore10BaseModuleC11willDestroyyyFTj
  Referenced from: ExpoImage.framework
  Expected in:     ExpoModulesCore.framework
```

`expo-image@57.0.3` is compiled against a newer `expo-modules-core` than the project carried
(57.0.8). Asking `expo install --check` why turned up **sixteen packages behind SDK 57**, including
`react-native` and `expo-updates` itself. The founder chose to align all of them rather than force
one package out of step with fourteen others built against the old core - which is the same class of
mismatch, only quieter, because it would crash later instead of at launch. `pod install` then
refused across a version move that size and the generated `ios/` had to be deleted and regenerated,
which is free in a CNG project and would be alarming in one where that directory is source.

**I measured the wrong thing first.** The opening theory was that the signed URL rotates, so the
cache key changes and nothing can ever hit. It is wrong: the URL is hour-aligned and byte-identical
between visits, which is written in `api.ts` and is the property that makes the memo safe. Reading
that before proposing anything is the only reason it did not become the fix.

**Localhost was too fast to photograph the defect.** The placeholder could not be caught on the
Simulator at all until a temporary `setTimeout` was put in front of `setUri` to hold it on screen,
photographed, and removed. Worth remembering as a technique: an instrumented delay is how you see a
state that only exists on a slow network.

**A fourth near-miss, found by the agent on the server half.** `deriveVariants` skipped any row
where `thumb` and `display` were both present, naming them literally. Adding a third size without
fixing that would have made the backfill select every row, hand each to `deriveVariants`, get
"skipped" back, and report success having written nothing.

## How each half was proved

The fallback was tested against a row carrying `thumb` and `display` and no `bubble`, which is the
state every photo in the database was in. The backfill was run against production: 19 derived, 0
failed, 0 remaining. Production was proved to know the name by `fly ssh` into the running machine
rather than by inference, because auth runs before validation and a 401 cannot tell you.

The disk cache was proved by taking the network away: the app was killed to clear every in-memory
cache, MinIO - the only source of the bytes - was stopped, the app was cold-launched, and the photo
still rendered. `Library/Caches/com.hackemist.SDImageCache/default` holds it, a directory that did
not exist before.
