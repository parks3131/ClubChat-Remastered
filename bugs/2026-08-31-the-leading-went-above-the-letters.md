# The message field's placeholder hung below the centre of its own pill

**2026-08-31.** Reported from the iPhone with a close-up photograph of the composer and one
sentence: *"So I feel like the message is not hanging on the center. Can you make it hanging on the
center of the search bar, please?"*

## What was seen

The word "Message" sitting low in the white pill at the bottom of a conversation. The photograph is
a 3x screenshot of the composer alone: the "+", the pill, and the announcement megaphone.

Measured off that photograph before anything was opened, and then reproduced and measured on the
iOS Simulator: **16.0pt of air above the "M" against 11.0pt below the baseline**, in a pill 38.0pt
tall. The letters were **2.5pt below the pill's own centre**. Typed text sits exactly where the
placeholder does, so both were wrong together.

The same defect, from the same cause, was then found on `SearchField` - the search box on the Chats
screen, every club hub, the members list and the profile - at **2.2pt low in a 52pt field**. He had
called the pill "the search bar", which turned out to be the more useful reading than the literal
one.

## What it was

`type.body` is `16/26`: 16pt Archivo Narrow with **26pt of leading**, a number chosen for reading a
wall of message text. Both the composer's `input` and `searchInput` spread it whole.

On iOS, `RCTTextAttributes.mm` turns a `lineHeight` into `NSParagraphStyle.minimumLineHeight` and
`maximumLineHeight`, and TextKit reaches that number by **growing the line's ascent**. The surplus
over the font's own line box therefore lands entirely *above* the glyphs and is never split around
them. Symmetric padding cannot rescue that: the line box is centred and the letters are not.

Archivo Narrow at 16pt lays out a 21.7pt line of its own accord. Forcing 26 put 4.3pt of air above
the letters and none below.

## What fixed it

Both fields take the family and the size from `type.body` and let the font's own ascent and descent
centre the line, which they do to within a third of a point. The padding takes over whatever height
the line box has stopped contributing, so neither control changes size:

| | Before | After |
|---|---|---|
| Composer placeholder | +2.50pt low, pill 38.00pt | **+0.33pt**, pill 37.67pt |
| Composer, typed text | +2.50pt low | **+0.33pt** |
| Search field | +2.17pt low, field 52.00pt | **0.00pt**, field 51.67pt |

Promoted to [`TECH/14`](../SPEC/TECH/14-engineering-pitfalls.md) entry 46, because every one-line
control in the product has this shape, and recorded as rule 10 of
[`DESIGN/09`](../SPEC/DESIGN/09-chat-composer.md).

## What went wrong while fixing it

**Three of my four measurements were of a bundle that had never loaded, and they agreed with each
other.** After the first style edit the Simulator stopped applying Fast Refresh, silently. I
changed the padding from 5 to 2 and measured: identical numbers. That read as a real finding - "the
platform is centring it, the padding is not load-bearing" - and I went as far as opening
`RCTUITextView.mm` to explain a behaviour that was not happening. What caught it was raising the
padding to 14, a value that could not possibly render the same, and getting byte-identical output a
third time. Every measurement after that was a cold relaunch. This is failure mode 15 wearing
different clothes: *before believing a live-test result, confirm the process you are talking to is
the one you just started.*

**The first fix looked right and was wrong in the other direction.** Dropping the line height alone
left the box shorter than the `minHeight` already on it, and a box taller than its own text is slack
that iOS fills from the top. The letters went from 2.5pt low to **0.83pt high** - a threefold
improvement, entirely shippable, and still not centred. It only surfaced because the gauge was
printing numbers rather than because anything looked different.

**I measured the wrong thing twice before that.** The first pill detector found the near-white chat
background instead of the pill and reported a 94pt pill. The first attempt at typed text measured
the placeholder with a caret next to it, because the Simulator was not forwarding hardware
keystrokes and my typing had gone nowhere - the screenshot showed a focused, empty field and the
numbers looked plausible. `Connect Hardware Keyboard` had to be switched on before a single
character reached the app.

**A second, worse defect turned up beside it.** With two lines of text the
composer does not grow: the first line is clipped by the top of the pill. It is **not** caused by
this change - the identical clipping was reproduced on the unmodified code - and the cause is
`numberOfLines={1}`, which the code's own comment describes as "Android-only on native". That
stopped being true: React Native 0.86's `TextInput.js` forwards `numberOfLines` to the iOS native
component, so it now clamps the field to one line's height. Proved by removing the prop and
watching the pill grow to two full lines. Left in place for one exchange because it was not what was
asked for, then fixed in the same change once it was: see
[its own write-up](2026-08-31-the-field-stopped-growing.md).

**An Apple system alert sat over the app mid-session** and dimmed every pixel, which broke one
measurement outright. Same trap as
[2026-08-29](2026-08-29-a-sheet-came-to-rest-inside-the-page.md), where it was invisible to
`simctl io screenshot`; here it photographed fine and simply changed every colour under it.
