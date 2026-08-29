# Surface: pinned strip

## Purpose

The floating row of notices above a conversation, carrying the most recent pins so a member can
see what the space wants them to see without leaving the chat.

Without it a pin is only findable by opening Highlights, which nobody does unprompted - the pin
would be a filing decision rather than a notice.

## Where it appears

Chat, in every scope: club, race, Eboard and DM. Nowhere else. Highlights lists the same pins as
an ordinary scrolling list and deliberately has no strip of its own - a floating notice above a
screen that is *entirely* notices would be describing itself.

## Anatomy

| Part | What it is |
|---|---|
| `clip` | The outer box. Owns the height and hides what leaves it. |
| `slider` | The inner box. Translates upward so the strip travels rather than squashes. |
| `card` | One notice: pin glyph, label, one-line preview, dismiss control. |
| `rail` | The horizontal scroller holding the cards. |

## Rules that must survive

1. **The strip answers "which way is this person going", not "where are they".** Any movement away
   from the conversation hides it; any movement back brings it. From anywhere in the log.

   **This shipped wrong.** It first keyed on distance from the newest message: visible within a
   fixed distance of the tail, hidden beyond it. That reads as broken rather than as strict,
   because a member deep in history who nudges toward the newest message sees nothing happen -
   they must travel the entire remaining distance before the strip will consider returning. **No
   value of that threshold is correct**, which is the tell that the quantity was wrong rather than
   its size. Measured after the change: a 7-point nudge returns the strip from 3,900 points deep.

2. **A movement too small to be a decision changes nothing.** Below a deadzone the strip holds
   whatever it is doing, so a finger wobble or the rubber-band bounce at the end of the list
   cannot flip it.

3. **Arriving at the newest message always shows it**, whichever way the last few points of travel
   went. Otherwise easing into the tail leaves a member at the conversation with the notice hidden,
   which is the one place it is unambiguously wanted.

4. **The conversation takes the space back.** The strip collapses rather than turning invisible in
   place. An earlier version set opacity to zero and left the box in the layout, so a permanent
   empty band sat under the header - the strip was gone and its absence was still occupying room.

5. **It travels under the header rather than being wiped away.** Collapsing the height alone
   erases it from the bottom edge upward, which reads as a squash. The content slides by the same
   distance the box loses, so the two must change together - alter one and the other follows, or
   the strip drifts against its own clip.

6. **Fast enough to read as an answer to the finger.** Slow enough and it becomes an animation
   being played at somebody; instant and it is a jump. The tab bar learned the same lesson from
   the opposite side - see [Tab bar](01-tab-bar.md) and HISTORY 2026-08-09.

7. **The strip is a recency window, never the pin list.** It carries the most recent few. Falling
   off the end **never unpins anything** - the pin stays, stays in Highlights, and stays findable.
   An app that quietly undid an admin's decision to reclaim a few points of height would be
   destroying a decision to save space.

8. **Dismissing is "I have read this", not "unpin this".** It is local, affects nobody else, and
   does not survive leaving the screen. Unpinning is a separate authorized act.

9. **Ordered by when it was PINNED, not by when it was sent.** Re-pinning something old makes it
   the most recent notice. See [Chat](../PRD/05-chat.md) rule 7.

## States

| State | Treatment |
|---|---|
| Default | Visible, at the live tail |
| Hidden | Collapsed to nothing, having slid under the header. Untappable throughout the transition, not merely at the end of it |
| Pressed | The card takes a press; where it goes depends on what is pinned (`PRD/05` rule 7) |
| Disabled | Not a state |
| Empty | Nothing pinned renders no strip at all, not an empty one |
| Loading | None of its own; it draws from messages already loaded |
| Error | None of its own |

## Obligations it creates elsewhere

| Obligation | Who owes it | Recorded in |
|---|---|---|
| A pinned card whose object is deleted must leave the strip, on **every** device including one that was offline when it happened - which requires the removal to advance the channel revision | The card-removal cascade in the worker | [Chat](../PRD/05-chat.md) rule 7; HISTORY 2026-08-11 |
| The strip and the Highlights list must send a pin to the same destination | Both surfaces, from one decision function over the message - which is where the route table is consulted for a card, so the pin and a notification about the same object still cannot disagree | [Chat](../PRD/05-chat.md) rule 7 |

## Accessibility

Each card is a button whose label **names its actual destination**, which differs by what is
pinned - a card announcing "in Highlights" when it opens a poll describes the old behaviour to the
one person who cannot see where they landed. A photograph and a document are the third and fourth
cases and each needs its own: both open where you already are rather than going anywhere, so a
label naming a destination would be wrong about them too, and a document's says the **filename**,
which is the thing somebody is looking for when several are pinned. The dismiss control is a
separate button and says so.

Hidden, the strip must not intercept touches meant for the conversation behind it. The guard sits
on the clip rather than the scroller, so a half-collapsed strip is untappable for the whole
transition - otherwise there is a window in which an invisible strip eats a tap.

## Platform differences

| | Behaviour |
|---|---|
| iOS | As described. |
| Android | Unverified - no build exists. |
| Web | The animation runs; the scroll physics differ, so the deadzone is tuned for a finger rather than a wheel. |

## Rejected alternatives

**Tuning the distance threshold.** Tried first, and the reason it failed is the useful part: the
threshold was not too large, it was measuring the wrong quantity. Position cannot express intent,
and no amount of adjustment turns it into direction. Recorded because the instinct on seeing a
sluggish threshold is always to change the number.

**Fading in place.** Cheap and it was what shipped. It leaves the box in the layout, so the space
never returns and the header keeps a permanent gap beneath it whether or not anything is showing.

**Animating height alone, with no slide.** Wipes the strip away from its bottom edge. Reads as the
strip being eaten rather than leaving.

## The trap this surface exists to warn about

> **Do not measure a node from inside the box whose size you are animating.**

The strip has to know its own height to collapse from it, so the height is measured on layout. The
measured node was inside the clip whose height animates, so as the clip travelled from full height
to nothing, the child was squeezed, reported its squashed height, and the strip adopted **that** as
its full size. It settled at **8 points**.

Everything else was correct throughout. The strip went on showing and hiding on exactly the right
gestures, at a height nobody could see - which from the outside is indistinguishable from the
feature never having been built, and was reported as "no change at all".

Two lessons, both cheap only in hindsight:

- **A guard that rejects zero is not a guard.** `measured > 0` excludes the one wrong value that
  was thought of and accepts every other one. The real rule is narrower: **the only trustworthy
  measurement is the one taken before anything constrains it** - the first pass, while no height
  has yet been applied. Every later pass can only report the clip.
- **It was found by instrumenting, not by reading.** The code was read three times and judged
  correct, and it *was* correct. One log line carrying the measured height alongside the gesture
  ended it immediately. See AGENTS.md standing instruction 4.
