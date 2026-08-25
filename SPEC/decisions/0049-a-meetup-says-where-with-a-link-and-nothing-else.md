# 49. A meetup says where with a link, and nothing else

Date: 2026-08-25

## Status

Accepted. Completes [ADR-0037](0037-a-meetup-carries-a-name-and-a-pasted-map-link.md), which
stopped collecting a place but kept the column, and reverses that ADR's decision to keep the
coordinate pair against a map returning.

## Context

A nudge went out to a real club on 2026-08-25 reading **"Parks RPK nudged: 18:00 at null"**.

The founder had filled in every field the form offers: a title, a date and time, a pasted Google
Maps link, location notes, and a description. Nothing was missing. The word came from a column the
form has not asked about since ADR-0037 ten days earlier.

**The chain, in order.** ADR-0037 replaced the meetup's required free-text place with a name, a
pasted map link and location notes. `meetups.location` stayed nullable and uncollected. `nudge`
shipped on 2026-08-14, one day earlier, reading `meetup.location` into its notification params.
The worker wraps every param in `String(...)`, and `String(null)` is the four-character text
`"null"` - a valid string, so the Zod schema that requires `location: z.string()` accepted it, the
row stored it, and `renderNotification` printed it.

**Three readers of the column survived ADR-0037; only one broke.** The detail screen passed it to
`DetailLine`, which omits an empty row, so the "Where" line simply vanished. `meetupHeadline` read
it behind `?.trim() ?? 'Meetup'`. The nudge had no guard at all, and is the only one of the three
that speaks to every member at once.

**The coordinate pair was empty for a different reason and a worse one.** `map_lat`/`map_lng` were
kept by ADR-0037 so the embedded map could return "without another rebuild-and-reinstall on every
device". They are null on every meetup any phone has ever created, because the Google Maps app's
share sheet emits `maps.app.goo.gl/...`, and that short link resolves - at every hop, with the
resolver working exactly as designed - to a place name and a feature id rather than to a point.
The pair could only ever be filled by a link copied from a desktop URL bar or by an Apple Maps
link. What was being kept reversible was a column pair that had never held anything.

**The tests did not catch it, and one of them nearly did.** `notifications.test.ts` asserts that no
rendered body contains the literal `"undefined"`. It passed throughout, because the fixture
supplied a place that production no longer had, and because the missing value arrived as the word
`"null"` rather than as an absent key.

## Decision

**A meetup answers "where" with a pasted map link, location notes, or not at all.**

Removed:

- `meetups.location`, and the `location` field from every input type, route schema, wire type and
  composer body that carried it.
- `meetups.map_lat` and `meetups.map_lng`, with the `meetup_point_is_whole` and
  `meetup_point_on_earth` constraints and their proofs.
- `packages/server/src/maps.ts` - the short-link follower - and the parsing half of
  `map-link.ts`: `parseMapLink`, `isShortMapLink`, `MapPoint`, `ALLOWED_MAP_HOSTS`.
- The coordinate fallback in `directionsUrl`, and the `carried` parameter of `toMeetupBody`, whose
  only reason to exist was carrying `location` through a whole-form save.

Kept:

- `map_url`, and `isMapLink` with its host allowlist. **This is a security control, not a
  leftover.** A stored link becomes a Directions button every member of the club taps, and the
  allowlist is what stops `maps.google.com.evil.test` from becoming that button.
- `react-native-maps` in the binary. Removing it needs a native build and a reinstall on every
  device, and it is the expensive half to restore. Left as it was, deliberately.

The nudge now reads `title`, which is `NOT NULL`, and says:

> Parks RPK nudged the club about Welcome Owen, today at 18:00

"today" is true when it is sent, which is where a nudge is read, and ages in the Notifications tab
afterwards. The relative timestamp beside every row carries the correction. Naming the date instead
is not available: `renderNotification` is pure and locale-free by design and the client is what
knows the reader's locale.

The stored `meetup_nudged` rows are deleted by the migration rather than backfilled. There is one
in production, it is the bug report, and it describes a day that has passed.

## Consequences

**A field the form does not collect is now a field the row does not have.** That is the general
rule this is an instance of. A column kept "in case" is a column every future reader has to decide
about, and one of them will decide wrong without anything failing.

**Old app binaries degrade rather than break.** A TestFlight build compiled before this reads
`meetup.location` and `mapPoint` off the response and gets `undefined`; `DetailLine` hides the row
and `meetupHeadline` falls back. No client needs rebuilding for this fix, which is why it ships on
the API alone.

**The "undefined" assertion in `notifications.test.ts` now also refuses "null".** That is the check
that would have caught this on 2026-08-14, and the reason it did not is recorded next to it.

**Reversing this is a migration, not a flag.** If an embedded map is ever wanted, the columns come
back and so does the parser. ADR-0037 tried to keep that cheap by leaving them in place; ten days
of an empty column producing a live bug is the cost of that convenience, and it was higher than the
migration would have been.
