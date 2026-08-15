# 37. A meetup carries a name, and its map comes from a pasted link

Date: 2026-08-15

## Status

Accepted. Reverses the "no detail screen" consequence in
[ADR-0036](0036-a-meetup-is-a-calendar-kind.md), extends
[ADR-0029](0029-a-meetup-answers-where-when-and-what.md) rather than reopening it, and leaves the
RSVP non-goal in [PRD/00](../PRD/00-overview.md) standing.

## Context

Meetups reached the calendar the same morning, which made them findable and immediately showed
what they lack: tapping one arrives at a place and a time and nothing else. The founder designed
two screens and asked for them.

**Three of the four things he designed are built. One is not, and that is the decision worth
recording first.** His mockup carried "12 Attending" and an RSVP button. `PRD/00` lists *"RSVP or
attendance, anywhere"* as a deliberate non-goal, next to *"Completion tracking of any kind -
Weekly Meetups is a plan, not a checklist"*. Put to him directly, he chose to leave the non-goal
standing rather than reverse it from a mockup. It can still be reversed later, on use rather than
on a picture - which is how DMs were reversed, and the difference is evidence.

## Decision

### A meetup may have a name

Optional. Without one the location is the headline, exactly as it shipped, so nothing that exists
changes and nothing new is required.

**The reason is reach, not decoration.** In the founder's words: *"it can be morning book reading
or swim practice night"*. A meetup identified only by its place reads as a running club's fixture;
one with a name belongs to a chess club, a choir or a reading group. That is the same
generalisation `ADR-0029` reached when it deleted the per-club activity-type catalog - free text
rather than a taxonomy - arriving from the other side. `TODO.md` already flags "Races and Meets"
as the next name with the same problem.

It also gains **location notes**: how to find the club once you are there, which a pin cannot say.
"Meet at the wooden archway. Parking is tight, so carpool from the union."

**Not distance.** It was in the mockup's metadata strip and it is the one field that edges into
the training-detail territory `PRD/00` rules out in three separate rows.

### A meetup has a screen of its own

`ADR-0036`, written hours earlier, said it had none and was not getting one. That was correct
while a meetup was three facts a row could hold. A name, location notes and a map are not, and a
row that opened a screen showing the same one line would have been the thing 0036 was avoiding.
What changed is the content, not the reasoning.

One consequence worth naming: **a member can now open a meetup at all.** The week's rows were
pressable only for admins, because the only thing behind them was an admin menu.

### The map's point comes from a pasted link, and the server reads it

The admin pastes a Google or Apple Maps URL. The server takes the coordinate out of it.

**No geocoder, and that is the point.** A meetup's place is free text - "Bimini", "the wooden
archway entrance", "Nature Preserve Entrance" - and no geocoding service turns those into a
coordinate. A link does, because a human already found the spot on a map and the link is the
record of that. It also needs no API key and costs nothing.

Three things follow:

1. **The client sends a link and never a coordinate**, so a phone cannot put a pin somewhere the
   link does not go, and the answer is the same whichever client saved it.
2. **A link on a host that is not a map is dropped rather than stored.** Whatever is stored ends
   up behind a Directions button that opens it, which makes the stored URL a capability rather
   than a string. The host check happens BEFORE the coordinate is read, because
   `maps.google.com.evil.test/?q=1,1` parses perfectly well - a parser is not a gatekeeper. That
   ordering was wrong in the first draft and a test caught it.
3. **Short links are followed by the server, one hop at a time.** The Google Maps app shares
   `maps.app.goo.gl/XYZ`, which contains no coordinate at all, so this is the common case rather
   than an edge one. The allowlist is re-checked at **every** hop rather than only on the pasted
   URL, because a shortener's whole purpose is to point somewhere else - checking only the first
   URL checks the one hop that was never in doubt.

A link that resolves to nothing is not an error. It is stored, it still opens in Maps, and the
meetup simply has no picture.

### And a pin can be placed by hand, because one share never carries a point

**Found on the device within the hour, and it is the part of this decision that was wrong first.**
A Google **"share a place"** link carries no coordinates at all - not in the short link, not at any
hop of the redirect, and not in the page it lands on. It resolves to a place NAME and a feature id:

```
maps.google.com/maps?q=Appalachian+Dining+Hall+at+Mountainview,+Vestal,+NY+13850&ftid=0x89daef42...
```

Three kinds of link DO carry a point, and all three worked from the start: an Apple Maps share
(`?ll=`), a Google **dropped-pin** share (`?q=lat,lng`), and a desktop URL-bar link (`/@lat,lng`).
The short-link follow was built and tested against a stub redirecting to the third shape, which is
exactly the sort of thing a stub will agree with and a phone will not.

Geocoding the address Google hands back does not rescue it: OpenStreetMap finds the town and not
the dining hall, which would put the pin two kilometres away - a confidently wrong map, worse than
none. A Places API key would resolve it and costs money, which was ruled out.

**So the admin can place the pin by tapping the map**, on the composer, when the link cannot supply
one. Free, exact, works for a campus building no geocoder has heard of, and it needs nothing new -
the map module was already installed. The tap wins over the link when both exist: a link is a
guess about where somebody meant, and a tap is somebody saying it.

### And then the map came out, the same afternoon

**The founder's call, an hour later: *"I don't want the map feature for now. Just keep it. Instead
we can have the direction. If someone [pastes] the link, then direction will pop up."*** So the
picture is gone and the button is what ships:

- **A meetup with a pasted link shows a Directions button**, on its own screen, and it opens that
  link. Exact, for every place including the ones no geocoder can find.
- **A meetup with no link shows nothing.** Deliberately not a text search on the location: handing
  Maps "Bimini" sends somebody wherever it guesses that means, which is worse than no button.
- **Nobody places a pin.** The composer asks for a link and nothing else.

What this is really recording is that the map was never the feature. Getting a member to the place
was, and the link does that on its own - the picture was a nicety that turned out to cost either a
hand-placed pin or a paid key, for a place the button already opens.

**`react-native-maps` is left installed on purpose**, and the ADR is the place that says so, since
an unused native dependency is otherwise a future mystery. The pod and the rebuild are the
expensive half; keeping them means the map returns without another install on every device. The
server still reads a point out of a link that carries one, and `meetups` still holds the pair -
one nullable column pair to keep this reversible. Nothing draws it today.

### The map is a real map, and one file is allowed to import it

`react-native-maps`, which this Expo SDK bundles a version of, on Apple Maps - so no API key and
no raising the deployment target, which `expo-maps` would have needed.

**It is a native module, and this app has been taken down twice by exactly that.** So the import
is a `require` inside the component rather than at the top of a file, which is the pattern
`AGENTS.md` failure mode 8 already prescribes for a module that does not exist on every platform.
Here the platform that may not have it is **an older build of this same app**, which is the same
problem wearing different clothes. The screen renders without it: the place, the notes and a
Directions button, and no picture.

## Consequences

- One migration adds five nullable columns. Nothing becomes required, so every meetup that already
  exists stays valid and simply has no name and no map.
- `map_lat` / `map_lng` are `numeric`, not float, and are constrained in `constraint-proof.sql` to
  be **both or neither** and **on the earth**. Half a coordinate would centre a map on the wrong
  line, and `map-link.ts` refusing an out-of-range pair is the kind refusal rather than the only
  one.
- **Directions exists whether or not the map draws.** A map you cannot navigate from is a picture,
  and the point of the pin is to get somebody to the place.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| **A link-out only**, with no map in the app | Offered first, with the rebuild cost of the alternative stated plainly. The founder chose the real map - and then **chose this** a few hours later, once a Google place-share turned out to carry no point. It is what ships. |
| **A static map image** from Google or Mapbox | No native module, but it needs an API key shipped in the client and billed, and a real address to place the pin - so "Bimini" would still show nothing. The problem it does not solve is the one that matters. |
| **`expo-maps`** | The Expo-first option, and it requires iOS 17 while this build targets 16.4. A deployment-target bump to draw a map is a bigger decision than the map. |
| **Geocoding the typed location** | Put to the founder. It resolves a street address and fails on every place a club actually names. |
| **Dropping a pin on a map in the create form** | Offered and declined in favour of pasting, then **built anyway an hour later** - because a Google place-share turned out to carry no point, so pasting alone cannot always produce one. It complements the link rather than replacing it: the link still drives Directions. |
| **Geocoding the address Google resolves the link to** | Tested against the real case and rejected: OpenStreetMap finds "Vestal, NY 13850" and not "Appalachian Dining Hall", so the pin would land on the town centre two kilometres off. A wrong map that looks right is worse than no map. |
| **Decoding the `ftid` in Google's resolved URL** | Its first half is an S2 cell id and does encode a position. Rejected: it is an undocumented identifier, decoding it is Hilbert-curve arithmetic that puts a plausible-but-wrong pin on screen if it is even slightly off, and it could change without notice. Not something a member should rely on to find where their club meets. |
| **Building RSVP from the mockup** | Put to the founder and declined; see Context. |
