# Closing a photograph left the Gallery with no way out

**2026-08-29, about an hour after the swipe feature shipped over the air.** Reported from the
iPhone with a ten second screen recording: "if you're clicking a picture and click the back button
and the page look like this, I don't see the top bars."

## What was seen

Club profile, Gallery, tap a photograph, swipe to the next one, close it. The grid comes back with
**no navigation bar at all** - no title, no back arrow - the tiles starting directly under the
status bar. Nothing on the screen leads anywhere. The only ways out are the iOS back swipe and the
tab bar.

The recording shows it in four frames and needed no reproduction of its own to be believed. It was
reproduced anyway, on the Simulator, before the fix and after it.

## What it was

Mine, from an hour earlier, and it is the second half of a fix rather than an unrelated fault.

The viewer had been made to hide the navigator's header, so a photograph sits under the status bar
the way the reference the founder sent does. That was done with `<Stack.Screen options={{
headerShown: false }} />` rendered inside the branch that draws the viewer, and the assumption was
that unmounting the element would put the header back.

**It does not.** Screen options reach the navigator through `setOptions`, which **merges into**
what is already there and persists. There is no "unset": the element going away is not an
instruction, so `headerShown: false` simply stayed. The grid rendered underneath a header that had
been told to be gone and never told otherwise.

## What fixed it

The grid branch now states the header it wants rather than relying on the absence of an
instruction:

```
<Stack.Screen options={{ headerShown: true }} />
```

Both branches say what the header should be. Neither depends on the other having unmounted.

## What went wrong while fixing

**The bug was created by a fix and shipped inside it.** The header change was verified by opening a
photograph and looking at it, which is exactly the half that worked. Closing it again was never
tried, because closing was not what had been reported and not what had changed - so a control flow
with two directions was checked in one of them. The founder's own test was the return journey, and
it took him one try.

**The verification pass afterwards was thorough about the wrong thing.** Swipe direction, the
header following the sender, Report appearing and disappearing per photograph, the full suite - all
of it real, none of it touching the close path. Breadth on the feature is not coverage of the
screen it was added to.

**Nothing in the suite could have caught it**, and that is worth stating rather than filed as an
excuse: the mobile app is tested as pure functions only and nothing in it renders a navigator. The
check that would have caught this is the one that did - a person closing the screen - which is why
`AGENTS.md` 2.3.3 exists and why 2.3.4 says to test navigation by leaving as well as arriving.

**A cheaper lesson available before the fix, and not taken.** Chat and Highlights draw the viewer as
an absolutely positioned sibling over a screen that has no header in the first place. The gallery
returns the viewer *instead of* the grid, which is the difference that made a navigator option
necessary at all. The note written at the time even said so. Making the gallery match the other two
- render the viewer over the grid rather than in place of it - would have needed no option, and
therefore had no option to leave behind. That is a real simplification and it is deliberately not
being made in the same change as the fix for the screen it would rewrite.
