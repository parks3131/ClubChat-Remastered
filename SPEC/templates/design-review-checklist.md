# Design review checklist

Run through this before calling any visual change done. **Every item here shipped as a defect at
least once**, in this project, on this stack - the same claim
[the authorization checklist](authorization-checklist.md) makes, and for the same reason.

> `AGENTS.md` standing instruction 5: **be picky about the UI. Pixel perfection is the standard.**
> Anything that looks off is a defect worth fixing, including things unrelated to the current task.

## Before drawing anything

- [ ] Which surface spec in [`SPEC/DESIGN/`](../DESIGN/) covers this? If none does and the surface
      is reusable, write one - the template is [here](design-spec-template.md).
- [ ] Does a component for this already exist? [Design system](../TECH/13-design-system.md) rule 5
      requires **one** implementation shared across club, race, Eboard and DM, not a copy per
      scope. A fix has to land everywhere at once.
- [ ] Is the design being read as a specification of **appearance** rather than of **scope**? A
      mockup showing data the product does not hold is a domain expansion, not a re-skin. Record
      the gap and raise it; never invent the data in a component.

## Tokens and type

- [ ] No hardcoded colour, radius, spacing or font size that a token covers. Tokens only.
- [ ] One accent, app-wide. No screen introduces its own.
- [ ] Typography roles spread whole, never copied field by field - a half-applied role is how a
      screen gets the right size with the wrong line height.
- [ ] A new token is named for **what it is**, not for the one place it is used.

## Layout, insets and the floating bar

- [ ] **Is the safe-area inset counted exactly once?** Counting it twice put 34pt of dead band
      inside the tab bar and pushed every icon into its top half - and it survived the bar being
      made both taller and shorter, because the height was never what was wrong.
- [ ] **Can every scrolling screen bring its last row clear of the tab bar?** The bar floats over
      the scene, so a screen that does not reserve the shared clearance token has a final row that
      is visible and unreachable, which is worse than one that is absent.
- [ ] Does anything translucent actually have content behind it? A translucent surface over a
      scene that ends beneath it is an opaque surface with extra steps.
- [ ] Does a press highlight run to the row's full width? A highlight inset by the gutter leaves an
      untinted stripe down each edge and reads as a rendering fault rather than a press.

## States

- [ ] Loading, loaded and a **retryable** error on everything that reads. No screen may fail to a
      blank page.
- [ ] A designed empty state that **tells the truth** - "nothing matches this search" and "nothing
      here yet" are different sentences, and using one for the other is a lie.
- [ ] Pressed and disabled both drawn. A control that answers a tap only by the next screen
      arriving reads as dead on a slow open.
- [ ] A disabled input **says why it is disabled**.

## Motion

- [ ] Going deeper slides right to left, coming back slides left to right. Declared rather than
      inherited, or it is wrong on Android.
- [ ] Siblings do not slide. A motion that means both "you went in" and "you moved across" means
      neither.
- [ ] Does the animation have something continuous to move? Four things cross-fading cannot slide,
      however they are tuned - that is a jump with a duration on it.
- [ ] Is it fast enough to read as motion rather than as lag behind a screen that already changed?

## Interaction

- [ ] Every long press fires the one shared haptic, on press registration rather than on menu
      appearance. A long press shows no progress, so without it the only signal that it worked is
      the menu, and the only signal that you have not held long enough is nothing at all.
- [ ] **No nested pressable.** Invalid HTML on web and it swallows the outer gesture on native.
      Only the outermost element in a row owns the gesture.
- [ ] Is a destructive item last, red, and confirmation-gated - with the confirmation **naming the
      thing** and stating what is lost?

## Navigation chrome

- [ ] Back control present on every screen below a destination, as permanent furniture rather than
      conditional on history existing. This is the most repeated bug in the project.
- [ ] Tried history first, then fell back to an explicitly declared parent.
- [ ] A guarded screen renders a placeholder in its denied branch, never a flash of the protected
      content before the redirect lands.

## Accessibility

- [ ] **Colour is never the only channel** for a state. Accent against grey alone fails the
      contrast bar and is invisible to a red-green colourblind reader.
- [ ] Every icon-only control carries a label. If text was removed from a control, the name it lost
      moved to an accessibility label rather than being deleted.
- [ ] Text that must not wrap fits by **style** rather than by an iOS-only prop, or it truncates on
      web instead.
- [ ] Touch targets are as large as they look.

## Per platform

- [ ] Verified on iOS **hardware**, not only the simulator.
- [ ] Verified on web, in a browser, with the console open.
- [ ] Android: stated honestly. It has never been run in this project, so "should work" is the one
      claim that may not be made.
- [ ] No platform-only native module imported at module scope. It has no web build, so evaluating
      it takes the **entire bundle** down - a blank screen on every route, not one broken control.

## Proof

- [ ] Looked at it on a device, at the real size, rather than reasoning about the diff.
- [ ] Reproduced the original complaint first, and confirmed the fix against that same
      reproduction.
- [ ] If a value was tuned, the surface spec records the **relationship** that had to hold, not the
      number that satisfied it today.
