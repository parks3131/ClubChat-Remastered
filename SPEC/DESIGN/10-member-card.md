# Surface: member card

## Purpose

Answer "who is this?" without leaving the list that asked the question. A roster is a list somebody
works down - checking a name, then carrying on - and sending them to a screen and back makes that
two navigations per person. The card rises over the list, which stays dimmed behind it and is one
tap from being back.

## Where it appears

The club roster, on a row tap. Deliberately **not** yet on the race or Eboard rosters, which have
no club authority to offer and would show the plain screen's content in a panel for no gain; and
deliberately **not** yet in a direct message, where the card would want conversation actions
(mute, clear) that this pass does not carry.

`/users/:id` is not replaced. It stays the addressable, complete record - what a notification, a
pasted link and the card's own **View full profile** all open - and it is what a banned row would
have opened if a banned row opened anything.

## Anatomy

| Part | What it is |
|---|---|
| Panel | The rounded card that travels up from the bottom edge, hugging its content |
| Scrim | The dimming over the list behind, which fades **in place** and never travels |
| Grabber | The short bar at the panel's top, saying where this came from |
| Identity | Avatar, name, and the standing this person holds in the club it was opened from |
| Actions | Round, icon-only. Message today; the row is built to take more |
| Menu button | The "..." in the panel's own top corner, which opens the context menu |
| Details | Description, City, School - each absent when unset, never "Not set" |
| Shared clubs | What the two of you have in common, as a sentence and a stack of faces |
| Full-profile link | The way to everything the card does not carry |

## Rules that must survive

1. **The panel travels and the scrim does not.** They animate on separate values. A `Modal`'s own
   slide moves the whole thing including the dimming, which arrives as a shaded band sweeping up
   the screen with a hard edge across the middle of the list. Reported from the device as "the
   shade going up and down"; see [Reactions](07-reactions.md), which learned it first.
2. **The distance is measured, not assumed.** The panel hugs its content, so a card with a bio and
   one without start from different places. It stays invisible until measured rather than showing
   at its resting place for the frame before the animation knows how far to travel.
3. **The motion has one definition.** Both this and the reactions sheet take it from the same hook.
   Two panels rising at different speeds is the drift nobody files a bug about and everybody feels.
4. **Every action offered is the server's answer.** Remove and Ban come from `canRemove` / `canBan`
   on the profile read, never from a role this surface inspected. The two ladders are deliberately
   asymmetric ([ADR-0021](../decisions/0021-club-bans-are-harder-to-impose-than-to-lift.md)) and a
   client re-deriving either is a second definition of a rule that has exactly one.
5. **An empty menu means no menu button.** A "..." that opens onto nothing reads as broken; an
   absent one reads as "you may not do anything here".
6. **Everything raised from the card belongs to the card's own modal, never to a new one.** The
   menu, the ban confirmation and the shared-clubs list are `hosted` inside `RisingSheet`'s
   `overlay`. **iOS presents one modal per view controller and silently refuses the second**, so
   the obvious shape - a modal beside a modal - ships as controls that do nothing at all, which
   is exactly what reached the founder's phone on 2026-08-14. A browser stacks them happily and
   will tell you it works. See `AGENTS.md` failure mode 29.
7. **One overlay at a time above the card.** The menu closes itself before the confirmation
   opens, so the two never fight over the same space.
8. **On the way out, the shade is the last thing to leave.** The panel gets the gentler curve and
   the shorter duration; the dimming gets the steeper and the longer one. Reversed, the shade
   lifts while the panel is still halfway up an ordinary-looking list, which reads as a frozen
   screen rather than an animation - reported as "it just stucks in between". The entrance is
   deliberately the opposite: shade first, then the panel arrives into an already-dimmed screen.
9. **"You're both in" is a statement about two people**, so it is absent on your own card. The
   shared-clubs read intersects your clubs with the target's; asked about yourself it answers all
   of them, and the card said "You're both in ... and these other clubs" about you and you.
10. **A row that opens nothing says so.** The banned row has no reachable profile - a banned
    person shares no club with the viewer any more - so it opens neither card nor screen, and its
    label no longer offers to.

## States

| State | Treatment |
|---|---|
| Default | Panel at rest, scrim at full dim, list visible behind it |
| Entering | Scrim fades in place; panel travels from below its own bottom edge |
| Leaving | The same, reversed, and the panel is unmounted only once it has finished |
| Pressed | Inherited from the shared controls; nothing surface-specific |
| Disabled | Every control while a write is in flight, so a second tap cannot double-post |
| Empty | Details absent rather than "Not set"; shared clubs absent rather than a count of zero |
| Loading | Spinner inside the panel, which is already at rest - the card never waits off screen |
| Error | The read's message with a retry inside the panel; a write's refusal above the actions |

## Obligations it creates elsewhere

| Obligation | Who owes it | Recorded in |
|---|---|---|
| A panel rising over a list must animate scrim and panel separately | Any future bottom panel | [Reactions](07-reactions.md) rule on the same subject, and the shared hook's own doc comment |
| A roster that opens a card must still answer "does this row open at all" | Every roster caller | This file, rule 8, and the roster's `profileHref` contract |
| Anything the card may do must be answered by the server per row | Every scope that grows a card | [Authorization](../TECH/05-authorization.md) |

## Accessibility

The scrim is a real button labelled as the way out, so the card is dismissible without hitting a
target inside it. The menu button and the round message control are icon-only and both carry the
person's name in their label, since "Options" alone is meaningless read out of a list of people.
The role tag under the name is colour-distinguished but never colour-only: it says the word.

## Platform differences

| | Behaviour |
|---|---|
| iOS | **One modal at a time.** Everything above the card is hosted inside the card's modal rather than presented as a new one - see rule 6, which is a platform rule and not a preference. Verified on the Simulator 2026-08-14: menu, ban confirmation and shared-clubs list all appear, and the ban wrote through |
| Android | Never checked |
| Web | Verified. It stacks modals happily, which is why it could not see the iOS defect - a control that opened here opened nothing there. The native driver is unavailable, so the animation runs on the JS thread; that warning is pre-existing and prints for every animated surface |

## Rejected alternatives

| Alternative | What actually happened |
|---|---|
| Push `/users/:id` from the roster, as before | It is a navigation each way for a question answered in two seconds, and it loses the list's scroll position |
| Give the card its own menu component | A second popover treatment in one product. It uses the same context menu the roster's long press already opens, now with a `hosted` mode so the markup stays one copy |
| Leave the shared-clubs block flat, with no list behind it | Shipped that way and reported dead from the device within the hour. The block has looked pressable everywhere else in the product since it existed; consistency beat the "no panel inside a panel" argument |
| Raise the menu and the confirmation as their own modals | The obvious shape, and it works on web. On iOS neither ever appeared - see rule 6 |
| Put Remove and Ban on the card as red buttons | The founder's call: both belong in the "..." rather than on the face of a card people open casually |

## Verified on

| Platform | When | By what |
|---|---|---|
| iOS, Simulator | 2026-08-14 | Open, dismiss, the "..." menu, the shared-clubs list, the ban confirmation and the ban itself - proved against the database - plus the exit recorded and read frame by frame |
| iOS, physical device | 2026-08-14, **the broken build only** | The founder's report is what found failure modes 29 and 30. The repaired build has not been back on the phone |
| Android | **never** | - |
| Web | 2026-08-14 | Open, dismiss, role tag, own-card, banned row, and both writes proved against the database. It could not see either native defect |
