# Surface: tab bar

## Purpose

The four top-level destinations, offered where somebody is **choosing where to go** rather than
doing something. It is the product's only lateral navigation, so it is what keeps a member from
unwinding a stack to get anywhere.

## Where it appears

**Five screens**, and nowhere else:

| Level | Screens |
|---|---|
| The four destinations | Chats, Calendar, Notifications, Profile |
| A club's front door | The club hub |

> **It used to be "every signed-in screen except chat", and that was the wrong rule.** Everything
> below a destination lives inside the Chats tab's stack, so the bar followed a member all the way
> down - over the roster, over car groups, over Meet Information, over every create form. Two costs,
> and the second is the one that made it a defect rather than a preference. A floating bar over a
> form is chrome in the thumb's way on a screen somebody is filling in. And because it floats over
> the scene rather than sitting in flow, **every screen underneath it owes clearance** (rule 6), a
> debt twenty screens never paid - so each had a last row that was visible and unreachable.
>
> Changed 2026-08-12, at the founder's request. Shrinking the set discharged the clearance debt
> for twenty screens at once, which padding each of them by hand would not have done for the
> twenty-first.

**A race and the Eboard space do not keep it**, though [Overview](../PRD/00-overview.md) principle 1
makes them the same shape as a club. They are reached from inside a club, so they sit below the
front door and follow the general rule.

**Chat is unchanged and is still a stronger case.** It lives outside the tab group entirely rather
than merely not being painted over, because it owns both edges of the screen. Signed-out screens
have none at all. See [Screen map](../PRD/15-screen-map.md).

Which screen is which is one pure function over the pathname, `showsTabBar`, with its own tests.
**Unknown routes get no bar**, so a screen added later inherits no clearance obligation by
accident - the opposite default ships a sliced row and fails nothing.

## Anatomy

| Part | What it is |
|---|---|
| Bar | A floating, fully rounded, translucent surface, inset from both edges and lifted off the bottom |
| Item | One destination. An icon, and nothing else drawn |
| Pill | **One** `accentSoft` stadium that slides between items to mark the active one |
| Badge | The unread count, on the Notifications icon only |

## Rules that must survive

1. **There is exactly one pill, and it moves.** Four per-item backgrounds can only fade one out and
   the next in, which is a jump with a duration on it rather than motion. Nothing to travel means
   nothing can look like travelling.
2. **The pill is drawn by the app, not by the navigator's active background.** That prop paints a
   box of the navigator's own choosing, which turned out to be the icon's, and no style prop can
   move it.
3. **The pill runs on the native driver**, so it keeps moving while JS mounts the screen being
   navigated to - which is exactly when a tab indicator is asked to move.
4. **The pill is the only second channel for the selected state.** With the labels gone, removing
   it would leave accent-versus-grey alone, which fails [Cross-cutting UX](../PRD/16-cross-cutting-ux.md)
   outright. It is not decoration and it is not removable.
5. **The bar floats over the scene, and content passes behind and around it.** This is what fills
   the strips either side and the band above the home indicator. **It is also what makes the
   translucency mean anything**: in normal flow the scene ends at the bar's top edge, so there is
   nothing behind the glass and a translucent bar is indistinguishable from an opaque one.
6. **Therefore every scrolling screen reserves clearance**, from the same shared token the bar's
   own height comes from. See Obligations.
7. **The side inset is deliberately larger than the content gutter.** At the gutter the bar's ends
   align with the text above it and it still reads as flush; breaking that alignment is what makes
   it read as a separate object resting on the page rather than as another block of it.
8. **The height carries the presence the labels used to.** It is taller now than it ever was with
   text in it, and that is the point rather than an accident.
9. **The safe-area inset is counted exactly once.** The bar clears the home indicator on its own
   margin, so the navigator's bottom padding must be zeroed or the inset lands twice.
10. **Destinations are icons alone**, from 2026-08-09, at the founder's request. The name each one
    lost moved to an accessibility label rather than being deleted.
11. **No motion between destinations.** They are siblings, not depth, and sliding between them
    would say something untrue about where you are.

## States

| State | Treatment |
|---|---|
| Active item | Icon in accent, with the pill behind it |
| Inactive item | Icon in secondary text colour, no pill |
| Badge present | Count on the Notifications icon, capped at 99+ |
| Badge absent | Nothing drawn at zero, never a "0" |
| Hidden | On every screen but the five above, and while the session is unresolved - so the shell cannot flash chrome over the sign-in redirect |

The badge counts **things, not messages**: a chat with 48 unread adds one. A badge of 200 because
somebody sent 200 messages is noise.

## Obligations it creates elsewhere

| Obligation | Who owes it | Recorded in |
|---|---|---|
| Reserve bottom clearance from the shared tab-bar token, or keep a last row that is visible and unreachable | **The five screens the bar is drawn on** | [Design system](../TECH/13-design-system.md), [Screen map](../PRD/15-screen-map.md) |
| Live outside the tab group | Chat, in all four scopes | [Screen map](../PRD/15-screen-map.md) |

**The first one is now paid in full, and it was paid by shrinking the set rather than by extending
it.** It was previously owed by every scrolling screen in the product and honoured by six, so every
roster, poll, race and news list had a final row nobody could reach - the debt was recorded here
and went unnoticed for a month because a sliced row still looks like a row. The five screens that
keep the bar reserve the clearance; nothing else owes anything.

The club hub was the last one outstanding, and it was the worst of them: **Add Group is its final
row**, so the bar sat across the button the screen exists for. It survived because a tall button
with its bottom third covered still looks pressable.

## Accessibility

The pill is the second channel required by [Cross-cutting UX](../PRD/16-cross-cutting-ux.md); accent
against grey is not sufficient on its own. Each destination announces its name through an
accessibility label, because a tab containing no text gives a screen reader nothing to read. The
badge announces its count rather than being a bare shape.

## Platform differences

| | Behaviour |
|---|---|
| iOS | Home-indicator inset lifts the bar; the band it leaves is a strip content is visible in |
| Android | **Never run.** No claim is made |
| Web | No inset, so a plain margin substitutes; the bar is otherwise identical |

## Rejected alternatives

| Alternative | What actually happened |
|---|---|
| The navigator's active-background prop | Painted a full-height rectangle edge to edge, then a box that excluded the label. Not movable by any style |
| A pill per item | Can only cross-fade. This is the "click and jump" the sliding pill exists to remove |
| Insetting the pill with margins | The navigator decided there was no room and **dropped all four labels**, which is the icon-only bar the accessibility rule forbids - arrived at deliberately later, but not like that |
| Nudging the pill with `marginTop` | **Clipped the top off every icon** on a real phone. Moving content inside a box that is too small is not a fix; sizing the box is |
| Keeping the bar in normal flow | The comment defending this was right about the cost and wrong about the look: it is not "the same look", it is the look with the effect missing, and that is only discoverable by asking for the effect and not getting it |
| A blur rather than a flat tint | Separates layers better and is a second treatment to maintain. The bar sits over ordinary lists rather than over photography, so a tint is enough |
| Tuning the slide slower to read as motion | Over-corrected to about 400ms. Past a point a slow trip stops reading as motion and starts reading as lag behind a screen that has already changed |

## Verified on

| Platform | When | By what |
|---|---|---|
| iOS, physical iPhone 15 Pro | 2026-08-09 | Every change watched as it landed. Two of the four pill failures were visible **only** on the device, and the clipped icons arrived as a screenshot from the founder's phone with a simulator a foot away |
| Web | 2026-08-09 | Renders; no console errors |
| Android | **never** | No build has ever been run in this project |
