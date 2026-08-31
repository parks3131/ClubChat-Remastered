# A two-line message had its first line cut off by the top of the composer

**2026-08-31.** Not reported. Found on the Simulator while fixing
[the placeholder sitting below the centre of the same field](2026-08-31-the-leading-went-above-the-letters.md),
by typing a long enough message to make it wrap, which the centring work had no need to do.

## What was seen

Type past the width of the message field. The field **does not grow**. The text scrolls inside a
one-line pill, so the first line is cut in half by the pill's top edge and the second sits where
the only line used to be. You cannot read what you typed a second ago.

It was on the phone. Any message longer than about forty characters hits it.

## What it was

`numberOfLines={1}`, with this comment above it:

> One row until there is more than one row of text.
>
> This is a `<textarea>` on web, whose default is **two** rows - so the empty field came up a whole
> line taller than the field it is a copy of on the device, and the bar with it. It is Android-only
> on native, which is to say a no-op on the platform this is drawn for, and the fix for the one
> where it is visible.

Every sentence of that was true when it was written. React Native 0.86 changed the last one.
`Libraries/Components/TextInput/TextInput.js` builds the **iOS** element with
`numberOfLines={props.rows ?? props.numberOfLines}`, so the prop reaches the native component - and
there it is not a starting size, it is a **ceiling**. The field was being told it may never exceed
one line, by code written on the understanding that iOS would throw the instruction away.

Nothing in this repository changed. An upgrade started honouring something the code had always
been saying.

## What fixed it

The value goes to the platform that needs it and nowhere else:

```
const COMPOSER_ROWS = Platform.OS === 'web' ? 1 : undefined;
```

**Web is unchanged by construction**, which is worth stating because it is why this needed no web
verification: on web the prop still receives the literal `1` it received before. Only iOS and
Android stop receiving a ceiling.

Verified on the Simulator with the shipping code rather than with the probe that found it, since
removing a prop and passing it as `undefined` are not the same edit:

| Typed | Before | After |
|---|---|---|
| One line | Fits | Fits, and now centred (see the sibling bug) |
| Two lines | First line clipped by the pill's top edge | Both lines fully visible, the pill grew |
| Three lines | First two clipped | All three visible |
| Past the 120pt ceiling | n/a | Stops growing and scrolls, keeping the caret's line in view |

Promoted to [`TECH/14`](../SPEC/TECH/14-engineering-pitfalls.md) entry 47.

## What went wrong while fixing it

**The first probe proved nothing and looked like it had.** I removed the prop, ran the wrap test,
and got a field holding "GE one two three" on one line - the typing had been truncated because the
app was still settling when the keystrokes went in, so the message never wrapped and the probe was
inconclusive while producing a perfectly ordinary screenshot. It had to be typed again.

**I nearly attributed it to my own change.** The clipping was first seen immediately after the
centring fix, on a bar I had just edited, which is the strongest possible prior. The only reason it
was not written up as a regression is that the original code was put back and the identical
clipping reproduced on it. That step took two minutes and would have been very easy to skip.

**It was left unfixed for one exchange on purpose.** It is a different fault from the one that was
reported, and unrequested fixes have cost this project before
([2026-08-29](2026-08-29-a-sheet-came-to-rest-inside-the-page.md): "Only do what I ask to do"). It
was put to the founder as a choice with the diagnosis already proved, and he asked for it.
