# The tail pointed away from the face

**2026-08-27.** Reported from the founder's iPhone with a photograph of a club chat, then a second
photograph of the same screen with the bubble circled and two arrows drawn at it. Reproduced on the
iOS Simulator and re-checked there after the fix.

## What was seen

In a club chat, Sean's grey bubbles each have one small corner at the **top left**, directly under
the face hanging in the left gutter. It reads as a tail: the bubble points at the person who sent
it. The founder's own orange bubble had its small corner at the **bottom left**, pointing down and
away from his own face, which hangs in the *right* gutter above it.

> *"the pointer should point towards my profile. If you see the hit in shon, the pointed gray
> color points towards shon's profile. I want the same for my side."*

## What it was

Four lines in one style. `styles.received` put its small corner top left; `styles.sent` put its
small corner bottom left. They were not mirror images and had not been since the morning.

**The corner did not move. The face did.** v1 kept the avatar in a column to the LEFT of every
bubble on both sides, so no small corner on either side pointed at anything in particular and
bottom left on a sent bubble was as good as anywhere. Earlier the same day the author line moved
above the bubble and **mirrored** - a received message's face in the left gutter, your own in the
right - which is what turned that corner into a tail and gave it something to be wrong about. One
half of the change followed the face and the other half stayed where it was.

## The fix

`styles.sent` is now the mirror of `styles.received`: small corner top right, everything else large.
The rule is written beside both, because the two only make sense read together.

## What went wrong while fixing it

**The report was misread twice before it was read correctly, and both misreadings were confident.**
The first reading was that the pinned "Notice" strip should jump the conversation to the pinned
message - which is a real behaviour this app deliberately does not have ([PRD/05](../SPEC/PRD/05-chat.md)
rule 7, corrected away from exactly that on 2026-08-11), so acting on it would have reversed a
written decision to fix a defect that was somewhere else entirely. The second reading was that the
author line was sitting too close to the photo above it. Both came from trying to decode dictated
words - *"the pinted should point us in the hi"* - instead of asking what the drawing meant. The
drawn arrows genuinely were arrows, and "pointer" genuinely meant the tail.

**Two questions were spent on the wrong readings.** The founder answered the third one by describing
the thing in his own words in one sentence, which is what the first question should have asked for.

**`sim.sh tap` silently missed for one round.** Its coordinate mapping is derived from
`scratchpad/_probe.png`, which only exists once `sim.sh shot` has been run with no path argument.
Screenshotting straight to a named file left `_probe.png` absent, `sips` printed nothing, and the
empty width fell through bash arithmetic as zero rather than as an error - so the tap landed
somewhere off screen and looked exactly like a tap on a dead row. Run `sim.sh origin` first; it
takes the probe shot itself.

**A drag to scroll registered as a long press** and opened the message menu, which has **Delete** in
it, on the founder's data. The first attempt used 80ms waits between the move steps. `cliclick -w 12`
with more, smaller steps scrolls; the menu dismisses by tapping the backdrop well clear of the
sheet.
