# 39. A post says where it happened with a name and a link, not a place search

Date: 2026-08-16

## Status

Accepted. Reaches the same answer as
[ADR-0037](0037-a-meetup-carries-a-name-and-a-pasted-map-link.md) from a different direction, and
leaves that decision untouched: meetups keep the flow they have, and nothing here is applied to
them.

## Context

The post mockup carries a location row: a pin glyph and *"Lincoln Memorial, Washington DC"*. Posts
have no location model at all, and meetups already have one worth copying.

Asked which shape to use, the founder asked for something neither option offered: *"can you add a
location searcher like how it is google maps or while posting at instagram, instead of just
pasting links"*. A place picker with autocomplete, which is what that surface feels like
everywhere else.

Put back to him with the constraint that actually decides it - **not coverage, but whether we are
allowed to keep the place on the post** - he chose to drop the searcher: *"for now lets keep
[it] like if they click the location they can see location name and location link where they can
fill its optional"*.

## Decision

### A post carries an optional name and an optional link, and nothing resolves them

Two nullable columns. The composer's **Location** control opens both fields; either, both, or
neither may be filled. The card draws the row only when there is a name, and the row opens the
link only when there is one.

**No provider, no key, no billing, no attribution, no outbound request.** The post stores exactly
what the author typed, forever, and depends on nobody to keep meaning it.

### Why the searcher did not survive contact with its own terms

The three candidate providers were put up with their storage rights stated, because that is the
question a club app has to answer and it is not the one a demo answers:

- **Google Places** has the coverage that makes the Instagram feel possible, and its terms allow
  caching `place_id` indefinitely while restricting the name and coordinates that go with it. A
  post is permanent. Storing the place on it therefore means storing an id and re-resolving the
  label on every read, which is a paid network round trip standing between a member and a feed
  that would otherwise be one query.
- **Mapbox** carries the same permanent-storage question with a smaller catalogue.
- **Self-hosted Photon or Nominatim** is free and stores permanently with attribution, and it is
  weakest on exactly the small local places a club actually names. It also means running a
  geocoder to serve a text field.

None of that is a cost argument, which `AGENTS.md` rules out anyway. It is that **a permanent
record should not hold a temporary licence to its own contents**. A post from 2026 whose location
reads correctly only while a billing account is current is a post that will one day be wrong.

**ADR-0037 reached this from the other end and its sentence still applies:** a club's place is
free text - *"Bimini"*, *"the wooden archway entrance"* - and no geocoder turns those into
anything. A human typing what they mean is not a downgrade from a search box; for most of what a
club posts it is the only thing that works.

### The link is stored as pasted, and it is not validated against a host allowlist

This is the one place this decision **differs** from ADR-0037, and the difference is deliberate.

A meetup's link sits behind a **Directions** button, which makes the stored URL a capability -
somebody tapping "Directions" has been told where it goes. So `maps.ts` fences it: an allowlist
re-checked at every redirect hop, before any coordinate is read.

A post's link sits behind the **location's own text**, which is a link that says what it is. It is
still opened, so it still gets the treatment every untrusted outbound link in the product gets,
and it does **not** get a maps-only allowlist: an author saying where a run happened may
reasonably link a race results page, a park's own site or a Strava route, and refusing those would
make the field narrower than the sentence above it.

> **What this does not do is resolve anything.** No hop is followed, no coordinate is parsed, no
> host is contacted. `maps.ts` is not called from this path at all, and the post has no `lat`/`lng`
> pair to fill.

## Consequences

- **Two nullable text columns.** Nothing becomes required and every existing post stays valid.
- **The pin glyph is decorative when there is no link**, which is honest: it marks the row as a
  place rather than promising a map.
- **A location cannot be searched.** Search covers the title and the tags, which is what was asked
  for; a place typed freehand by forty different people is not a facet, and pretending it is would
  produce four spellings of the same park.
- **The searcher is not closed off forever.** If it returns, it returns as a way to *fill these
  two fields* rather than as a new model, so nothing stored today has to change shape.
- **Meetups are untouched.** Asked whether the new control should replace the pasted link there,
  the founder said *"skip"*. Two ways of naming a place now exist in the product, which is
  recorded here as a known inconsistency rather than left to be discovered.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| **Google Places autocomplete** | The founder's first ask, and the best version of the feel he described. Its terms will not let a permanent post keep the place it names; see above. |
| **Mapbox Search Box** | Same storage question, smaller catalogue, and a second vendor for one text field. |
| **Self-hosted Photon or Nominatim** | Free and permanently storable, and it means operating a geocoder that is weakest on the local places clubs post about. |
| **Reusing the meetup's `maps.ts` resolution** | It exists and it works, and it answers a question this field is not asking. A post wants to say where it happened, not to route somebody there. |
| **A maps-only host allowlist on the link** | Correct for a Directions button and wrong here; it would refuse a results page or a route link, which are reasonable things to attach to a recap. |
| **Storing a coordinate pair for later** | Two columns nothing writes and nothing reads, kept in case a map arrives. ADR-0037 did exactly this for meetups with a reason - the map was built and then pulled - and there is no such history here. |
