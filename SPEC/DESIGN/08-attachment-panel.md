# Surface: attachment panel

## Purpose

Everything the composer's "+" can send or make, laid out where the keyboard was.

Typing and attaching are two things you do with the same strip of screen, so they take turns in it
rather than stacking. That is the whole design: the conversation gives up no room it was not
already giving up, and nothing above the composer moves when you switch.

## Where it appears

Chat, in every scope, for anybody who may post there. A read-only conversation has no composer and
therefore no panel.

## Anatomy

| Part | What it is |
|---|---|
| `attachButton` | The "+" in the composer, which becomes a keyboard glyph while the panel is open. |
| `attachPanel` | The panel itself, exactly the keyboard's height, sunken so it reads as keyboard-space. |
| `attachTile` | One circular icon with a label beneath. Four to a row. |

## Rules that must survive

1. **The panel stands in the keyboard's place, never above the composer.** It opened above it
   until 2026-08-14, which pushed the composer up the screen *and* left the keyboard below it, so
   the conversation lost two bands at once for one action.

2. **The composer does not move during the swap.** This is the test of the whole surface: the
   panel is the keyboard's own height, not a guessed one, so the two exchange places invisibly.

3. **One control, two modes.** The "+" becomes a keyboard glyph, because the way back to typing
   has to be where the way out of it was. A second control appearing beside it would say the panel
   is a menu; the glyph says it is a mode you can leave.

4. **The keyboard and the panel are alternatives, decided in one place.** Anything that raises the
   keyboard closes the panel - including tapping the message field, which knows nothing about the
   panel and does not need to.

5. **The swap happens inside the keyboard's own event, never before it.** Rule 4 is not enough on
   its own: a panel opened the moment "+" is pressed exists alongside a keyboard that has not begun
   to leave, and the composer briefly carries both heights. Promoted to
   [Design system](../TECH/13-design-system.md), because it binds anything that ever replaces the
   keyboard.

6. **Four tiles to a row, by proportion rather than a fixed width**, so the row divides evenly on
   any phone. The grid scrolls: a scope with polls, events and meetings has more tiles than a short
   keyboard has room for, and a tile nobody can reach is a feature nobody has.

7. **Icons carry the recognition.** Circular, tinted, labelled underneath - v1's grid, not a list
   of rows, which is what makes "+" read as things you can send rather than as settings.

## States

| State | Treatment |
|---|---|
| Default | Closed. The composer shows "+" |
| Open | Panel in the keyboard's place, glyph is a keyboard |
| Uploading | The control is a spinner and is disabled, so a second tap cannot start a concurrent upload |
| Empty | Not possible: Photos, Camera and Document are always there for anybody who can post |
| Loading | None of its own. What the scope offers is already known from the channel |
| Error | None of its own. A failed pick or upload is reported by the composer's notice |

## Obligations it creates elsewhere

| Obligation | Who owes it | Recorded in |
|---|---|---|
| Anything replacing the keyboard changes inside the keyboard's own event | Every such panel | [Design system](../TECH/13-design-system.md), signature treatments |
| The panel's height must track the real keyboard, per device and per keyboard | The chat screen's keyboard listeners | HISTORY 2026-08-14 |
| Which tiles exist is the scope's answer; who may use them is the server's | `createActions` and `canAnnounce`, kept separate | [Chat](../PRD/05-chat.md) rule 11 |

## Accessibility

The control announces its destination rather than its glyph - "Attach a photo or file" closed,
"Show the keyboard" open - and reports itself as expanded while the panel is up, so the mode is
audible without seeing the swap. Each tile is a button labelled with what it sends.

## Platform differences

| | Behaviour |
|---|---|
| iOS | As described. The keyboard reports its height, duration and curve before it moves, which is what the swap is built on. |
| Android | Unverified - no build exists. There is no "will" event, only "did", so the swap will be late rather than simultaneous. |
| Web | No software keyboard to trade with, so the panel simply opens and closes below the composer, at a default height. |

## Rejected alternatives

**A modal sheet over the conversation.** It is the platform's habit for this and it is wrong here:
a sheet dims the conversation to offer three tiles, and the thing being attached is *to* the
conversation you just hid.

**Keeping the keyboard up and putting the panel above it.** What shipped first. See rule 1.

**Guessing the keyboard's height with a constant.** Wrong on most devices, and wrong again on any
device with a third-party keyboard. A constant survives only as the first-run fallback, for the
one press that can happen before the keyboard has ever been seen.
