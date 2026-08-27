# The send scrolled before the message existed

**2026-08-27.** Reported from the founder's iPhone with two screen recordings, one of ClubChat and
one of GroupMe beside it. Reproduced on the iOS Simulator before the fix and re-run on it after.

## What was seen

Send a message in a club chat and nothing arrives on screen. The list jumps once, the pinned notice
strip disappears, and then it sits still. The message you just wrote is under the composer, out of
sight, with a floating **"1 new message"** pill over it announcing your own words back to you.
Nothing moves until you drag down to find it.

Measured off the founder's recording at 8 frames per second: composer clears at 0.13s, the list
jumps and the strip vanishes at 0.25s, and then nothing for **2.6 seconds** until his finger
appears. My first write-up said the app dragged itself down at the end of that; it did not. He
corrected it in one line - *"it doesnt move i draged down"* - and the corrected version is worse
and simpler: **the app never scrolls to your own message at all.**

## What it was

One line in `send()`, in the wrong place.

```
setDraft("");
scrollToNewest();               // <- here
...
await client.sendWithRetry(...) // <- the message is created in here
```

`scrollToNewest()` ran **before the row it wanted existed**. At that instant the newest message is
the one *before* yours, so the animated scroll went there. Then the optimistic row was inserted, and
`maintainVisibleContentPosition={{ minIndexForVisible: 0 }}` - whose entire job is to hold visible
content still while the list resizes - held the viewport exactly where it was. The new row landed
below the fold and stayed there.

**Nothing in the system was wrong except the order.** The intent was correct, documented, and
already in the spec: `PRD/05` rule 3 says *"the reader's own action always [moves them]: sending,
attaching, or creating a poll, event or meeting returns them to the newest message so they watch it
land."* The spec was right and the code could not do it.

The pinned strip vanishing was not a second bug. It hides on upward scroll (`onScroll` reads the
direction), so the stray scroll took it with it.

## The fix

The intent is **recorded at the send and spent when the row exists.** `followOwnSendRef` is armed by
each of the three send paths; an effect keyed on `rows` - the state the optimistic row lands in -
scrolls to the newest once it is really there. Bounded by `FOLLOW_ATTEMPTS`, because a sent message
settles in stages (pending bubble, then the acked row that replaces it, then any card or photo
beside it finishing its measurement) and each stage is a content change that leaves a single scroll
short. It gives way to a finger in `onScrollBeginDrag`, like every other placement on this screen.

The same session also changed where a chat opens, at the founder's request: **the newest message,
always**, rather than travelling up to the first unread one. The "Last read" rule is still drawn.
See `PRD/05` rule 3.

## What went wrong while fixing it

**I spent the first pass solving a different problem.** The two videos showed message bubbles that
are much taller than GroupMe's - own name and face over every message, the clock on its own line -
and I built a whole plan for grouping and density before he said *"all i want you to focus on is
after the message is sent it automatically dragged to the bottom."* Two of the four multiple-choice
questions I had drafted were about a surface he had not mentioned. **The videos were evidence about
one thing and I read them as evidence about everything in frame.**

**The diagnosis was right and my account of the ending was wrong**, in the direction that flatters
the app: I described the list settling to the bottom on its own after the acknowledgement. There was
no such settle. It was his finger, and the distinction is the whole severity of the bug.

**This could not be reproduced in a browser**, and knowing that in advance was luck rather than
judgement - it is written in `AGENTS.md` failure mode 28 and in a memory note, because
`maintainVisibleContentPosition` does not exist in react-native-web at all and is half the cause. A
web check would have shown a different bug and passed.

**Building the Simulator had to happen somewhere else.** `expo run:ios` runs `pod install`, which
rewrites a header inside `node_modules/react-native-maps` and moves the fingerprint
(`TECH/14` pitfall 42) - so doing it in the main tree would have made it unable to publish an
over-the-air update until a full reinstall, which cannot run while the founder's api is up under
`node --watch`. The work was done in a worktree of its own for that reason alone.

Two smaller ones. The seed script's first run failed on `deviceId` because the auth frame requires a
uuid and I passed `"seed-owner"`; the frame is rejected as `malformed`, which names the shape and
not the field. And my first swipe on the Simulator was slow enough to register as a long press and
opened the message menu instead of scrolling.

## What has no test

Nothing here is a pure function, and the mobile app has deliberately no component or hook harness
(`AGENTS.md`), so the reproduction on the Simulator **is** the red step - run before the fix, re-run
after it, with recordings of both. `buildChatRows` is the pure part of this screen and it was not
involved: it knows nothing about scrolling.
