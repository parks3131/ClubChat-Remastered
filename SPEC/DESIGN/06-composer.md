# Surface: composer

## Purpose

The form you fill in to make a thing: a poll, an event, a race, a meeting. One arrangement for all
of them, so that learning to create one teaches you how to create the rest.

## Where it appears

Every create flow. **Built for the poll composer on 2026-08-13 and adopted there first.**
**Weekly Meetups followed on 2026-08-14** and cost no new parts, which is the claim below being
tested rather than asserted: it needed the header action, a filled field, one setting row and the
wheel, all of them already here. The event, race and meeting composers still wear the older
cards-and-labels arrangement and are meant to follow. The kit exists so that following is
composition rather than a second rewrite.

> **The week itself took rule 1 too.** Its seven days were bordered cards and read as seven
> unrelated panels rather than as one week - the same failure the poll composer's four groups had,
> on a screen that is not a composer at all. The rule is about forms because that is where it was
> found, not because that is where it stops.

## Anatomy

| Part | What it is |
|---|---|
| `ComposerHeader` | The way out, the title, and optionally the primary action. |
| `HeaderAction` | The primary action as a pill, sitting in the header. |
| `SectionLabel` | A quiet uppercase heading with air above it. No rule, no card. |
| `ComposerField` | A text field. Filled for the one field the form is about, outlined for the rest. |
| `AddRow` | A full-width filled row that adds another of something. |
| `SettingRow` | Label on the left, its state on the right. |
| `SettingValue` | The right-hand value of a row that opens something. Accent when set. |
| `SettingNote` | The one explanatory paragraph a section is allowed. |
| `Wheel` | Columns of values under a single highlight band. |

## Rules that must survive

1. **Space separates sections, not cards.** A section is a label with air above it. The composer
   this replaced put every group in a bordered card, which at four groups reads as four unrelated
   panels rather than as one form.

2. **Small type, generous padding.** The form is calm because the type is quiet and the fields are
   roomy, not because things are big. Tightening field padding is the first change that makes it
   feel cramped again, and it will be tempting because it fits more on screen.

3. **Only actionable surfaces are filled.** The question field, the add row and the primary action
   are filled. Everything else is an outline or nothing at all. A filled box is a promise that
   something happens there.

4. **A field is labelled by its placeholder, or by a section, never by both.** "Question" written
   above a box reading "What's your question?" says it twice.

5. **One note per section, at its end.** Not a description line under every row. Three
   explanations stacked in a settings list are three things nobody reads.

6. **A primary action in the header means no trailing button, and vice versa.** Both is two
   primary actions. The header is the right place whenever the form can grow while being filled
   in - an expanding picker will push a trailing button off screen exactly as somebody finishes.

7. **The way out matches where the action is.** A header carrying the primary action gets a close
   control, because the form is a thing you are inside and are dismissing. A form whose action is
   at its foot gets a back arrow, because you are stepping back through it.

### The wheel

8. **Every wheel item is also a button.** Snapping is scroll behaviour, and scroll behaviour is
   the part of this that differs most between iOS, Android and a browser. Selection must not
   depend on it. Tapping selects on every platform; snapping is what makes it feel like a wheel.

9. **One band across all the columns, and it takes no touches.** Drawn once for the whole wheel so
   the middle row reads as a single selected line rather than as three selections that happen to
   align. It must be `pointerEvents="none"` or it swallows every tap aimed at the row beneath it.

10. **A column is padded by half the wheel at each end.** That is what lets the first and last
    items reach the middle band. Without it neither end of a column can be scrolled to, and the
    bug presents as "it will not go to today".

11. **Opening a picker commits the value it is showing.** A row reading "No deadline" above a
    wheel highlighting tomorrow at ten is the control contradicting its own value, and it gets
    reported as "it will not save the time". The way back out is a clear control, not a state
    where nothing is chosen and something looks chosen.

12. **A picker needs a visible way to close, even when there is nothing to confirm.** Rule 11
    means the value is already committed, so the control is only a dismissal - but a wheel with
    no way out reads as unfinished, and tapping the row again to collapse it is not something
    anybody discovers. A poll's way out is its **No deadline** clear; where the value is required
    and there is nothing to clear, it is a plain **Done**. *(Reported from the device on
    2026-08-14 as not being able to set the time at all.)*

13. **Dismiss the keyboard before opening a picker.** They both want the bottom of the screen,
    and the keys win: they cover the wheel and whatever field follows it, so the day column
    cannot be reached and the last field cannot be typed into. **And the form must sit inside
    `KeyboardAvoider`** - a composer whose last field is below the fold is a field that can be
    focused and not seen. Both were reported together from the device on 2026-08-14.

## Obligations this creates elsewhere

- **`ComposerHeader`'s `action` and `dismiss` are optional and default to the old behaviour**, so
  the three composers that have not adopted this are untouched. Whoever adopts them next changes
  those composers deliberately rather than discovering they moved.

## Rejected alternatives

- **Keeping each group in a card.** See rule 1.
- **A description under every setting row.** See rule 5.
- **Leaving selection to snapping alone.** See rule 8. It is the arrangement that looks correct in
  a simulator and fails on one real platform.
