# Surface: meetup detail

## Purpose

One meetup, on its own screen: what it is called, where, when, what the club will be doing, how to
find them once there, and a way to get there. Built 2026-08-15 from a design the founder made in
Stitch.

Until that afternoon a meetup had no screen at all, and
[ADR-0036](../decisions/0036-a-meetup-is-a-calendar-kind.md) said it was not getting one - the
week's row held everything a meetup was. What changed is what a meetup *holds*: a name, location
notes and directions do not fit a row. See
[ADR-0037](../decisions/0037-a-meetup-carries-a-name-and-a-pasted-map-link.md).

## Where it appears

Reached from three places, all of which already know the day: the calendar's day popup, the club's
Upcoming/Past list, and the week. **The back control goes to the Calendar**, like an event and a
poll, because the club is only known once the read lands and the control has to exist before that.

## Anatomy

| Part | What it is |
|---|---|
| Eyebrow | "MEETUP", in the small uppercase label type every detail screen uses |
| Title | The name, or the place when there is no name. The screen's largest text |
| When | One accent line directly under the title: "TODAY @ 6:00 PM", or the weekday |
| Card | Where, Description, Who, Location notes - each omitted when empty, never shown blank. **"Description" rather than "What"**: the composer asks "What are we doing?" because a form reads as a question, and the record answering it does not |
| Directions | A full-width accent button, present only when a map link was pasted |

## Rules that must survive

1. **The clock is the club's own characters and is never converted.** A meetup stores a date and a
   time rather than an instant, precisely so a Tuesday evening does not become Monday for somebody
   reading from another country. Nothing on this screen may parse the two into one value.

2. **"TODAY" replaces the weekday when it is today**, and that is the only place this screen states
   the date at all. Every route in reaches it from a surface that already showed the day.

3. **Directions is the whole of the map, and it opens the pasted link.** That link is the exact
   spot a human chose on a map, including the ones no geocoder can resolve. A real embedded map was
   built on 2026-08-15 and removed the same afternoon; `ADR-0037` records why, and
   `react-native-maps` is still installed so it can return without another device rebuild.

4. **No link means no button.** Deliberately not a text search on the location: handing Maps
   "Bimini" or "the wooden archway entrance" sends somebody wherever it guesses that means, which
   is worse than the control not being there.

5. **There is no RSVP and no attendance count**, though the design that produced this screen had
   both. [`PRD/00`](../PRD/00-overview.md) rules them out beside "Weekly Meetups is a plan, not a
   checklist", and the founder left that standing on 2026-08-15 rather than reversing it from a
   mockup. If it is ever reversed it should be on use, not on a picture.

6. **Read-only, for everybody.** Editing, removing and nudging live on the week
   ([`PRD/08`](../PRD/08-weekly-meetups.md) rule 9), and putting a second copy here is how the two
   drift. This screen is the one place a plain member can see a meetup in full, which they could
   not before it existed.

## Obligations it creates elsewhere

- **Nothing imports a native map today**, and if one returns it goes back into `src/meetup-map.tsx`
  behind a guarded `require` - never a top-level import, which is the launch-time crash
  [`AGENTS.md`](../../AGENTS.md) failure modes 8 and 32 record.
- The week's rows became pressable for members to reach this, which is a behaviour change on that
  surface rather than on this one.

## Accessibility

Directions is labelled with the place rather than with itself - "Directions to Appalachian Dining
Hall" - because a button reading only "Directions" tells a screen reader nothing about which of the
day's meetups it belongs to.

## Rejected alternatives

**A static map image**, and **a live embedded one**. The second was built and removed the same day;
both need a point, and the share people actually use does not carry one. See `ADR-0037`.

**Putting Edit and Remove here too**, so the screen is self-sufficient. It would be a second copy
of the week's menu, and the two would drift. See rule 6.
