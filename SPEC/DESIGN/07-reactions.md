# Surface: reactions

## Purpose

The row of emoji pills under a message, and the sheet behind them that says who put each one there.

The pills answer "how did this land" at a glance. The sheet answers "who", which a count cannot -
and in a club where forty people share a chat, *which* Emma agreed is most of the information.

## Where it appears

Under every message and every card in chat, in all four scopes, **and under every news post**. The
sheet opens from the pills and nowhere else.

> **News used to be the exception and stopped being one on 2026-08-16.** It had a fixed row of six
> quick reactions, always drawn whether or not anybody had used them, with no picker and no sheet -
> justified as a different surface that happened to share the catalog. Shown the post mockup, the
> founder asked for chat's behaviour instead: *"you can reach and apply the same thing how the
> emoji and [long]press on any emoji we can select using the emoji category we created"*. So the
> pills, the `+` picker over the full catalog and the hold-to-see-who sheet are one surface across
> the product now, and `news_reactions.emoji` already keyed the same catalog table, so nothing in
> the data had to move.

## Anatomy

| Part | What it is |
|---|---|
| `pill` | One emoji with its count. Outlined in the accent when the viewer is in it. |
| `+N` chip | Stands for every pill past the fourth. |
| `sheet` | The panel: grabber, title with the total, filter chips, then the people. |
| `chip` | `All` plus one per emoji, each with its count. The shared `Tabs` chip variant. |
| `row` | One person: avatar, name, and the emoji they chose, at the end. |

## Rules that must survive

1. **A pill taps to act and holds to explain.** The tap joins or leaves that reaction; the hold
   opens the sheet. The same split the message bubble uses, so the gesture is learned once. The
   founder asked for this explicitly after a build where the tap opened the sheet: the one-tap
   "me too" on an existing pill is the common act, and burying it behind a hold to surface a rarer
   question is the wrong way round.

2. **The hold buzzes before the sheet is drawn.** A hold has no visual progress, so without the
   haptic "not held long enough" and "control is dead" are the same experience. See
   [Tab bar](01-tab-bar.md) for the same principle on a different gesture, and `longPressFeedback`
   for the one constant every hold in the product shares.

3. **The `+N` chip is a tap.** It has no reaction of its own to toggle, so the hold would be the
   only gesture on it - and a control whose only gesture differs from its neighbours' teaches the
   wrong lesson about its neighbours.

4. **The sheet's unit is a person, not an emoji.** One row each, with a face. It listed emoji with
   their reactors' names run together in a sentence until 2026-08-14, which answers "who" only by
   being read, and answers "which of the two Emmas" not at all. Somebody who used three emoji
   appears three times, because the row is the *reaction*, not the person.

5. **The chips filter; they never truncate.** The sheet opens on `All` and shows everybody, not
   only what the `+N` chip was hiding. Chips carry the pill row's order, which is
   `reactionSummary`'s order - one ordering rule for both, or they drift.

6. **The panel rises and the scrim fades.** Never both together: the dimming belongs to the whole
   screen and does not travel with the panel. Promoted to
   [Design system](../TECH/13-design-system.md) as an obligation on every bottom sheet, because it
   is a property of the platform's `Modal` rather than of this surface.

   **The emoji picker behind the strip's "+" broke this until 2026-08-14** - it still had
   `animationType="slide"` and a dark backdrop, so the shade slid with it, which is what the
   founder was pointing at when he asked for WhatsApp's behaviour. All three sheets now share one
   implementation (`useRisingSheet`), so this rule is enforced by construction rather than by
   whoever remembers to read it.

7. **Your own row says it is yours and removes on tap.** Which makes the sheet the one place a
   reaction can be taken back while looking at what you actually picked. Nobody else's row is
   pressable - a row that looks tappable and does nothing is worse than one that plainly does not.

8. **What is on the pills and what is in the sheet come from the same live set.** The envelope's,
   so a reaction landing over the socket appears in an open sheet and removing yours redraws it at
   once. Only the names and pictures are fetched. Chips and counts must never wait on a network
   read to be correct.

## States

| State | Treatment |
|---|---|
| Default | Pills under the message; no sheet |
| Pressed | Pill takes a press; the sheet's own rows only when the row is the viewer's |
| Loading | Chips and counts are already right; the people area holds a spinner until names arrive |
| Empty | No reactions renders no row at all. The last one being removed closes the sheet, since the pill that opened it is gone |
| Error | The names read failing leaves the chips and says so in the list area, rather than an empty sheet that reads as "nobody" |

## Obligations it creates elsewhere

| Obligation | Who owes it | Recorded in |
|---|---|---|
| A sheet's scrim fades in place while its panel travels | Every bottom sheet in the app | [Design system](../TECH/13-design-system.md), signature treatments |
| Reactors come back in a stable order, or rows shuffle between reads | The reaction read on the server | HISTORY 2026-08-14 |
| A message caps at twenty distinct emoji, so the chip strip is bounded | The reaction toggle | [Chat](../PRD/05-chat.md) rule R4 |

## Accessibility

A pill's label carries the emoji, its count, whether the viewer is in it, and that holding shows
who - the hold is otherwise undiscoverable to somebody who cannot see the sheet appear for other
people. A sheet row announces the person and the emoji; the viewer's own announces that it removes.
Chips are tabs and announce their count, which is the count the sighted reader gets from the
numeral beside the emoji.

## Platform differences

| | Behaviour |
|---|---|
| iOS | As described. |
| Android | Unverified - no build exists. |
| Web | Everything but the haptic, which has no Taptic Engine to reach. The hold still works, so the sheet is reachable. |

## Rejected alternatives

**Tapping a pill to open the sheet.** Built first, from a screenshot. It costs the one-tap join and
leaves the sheet as the only way back out of a reaction. See rule 1.

**Names on the envelope.** Would put a name under every emoji on every message in a page of
history, repeating one person once per reaction. The names are a separate read for exactly this
reason - see `readReactions`, and [ADR-0017](../decisions/0017-reactions-travel-on-the-message-envelope.md)
for why the reactions themselves are not.

**A row of faces instead of a list.** Compact, and it turns "who" into a guessing game for everyone
without a photo - which is most people, most of the time.
