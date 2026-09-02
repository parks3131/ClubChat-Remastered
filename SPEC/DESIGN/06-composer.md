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

   1a. **Fields that belong together share ONE border, and that is not a reversal of the rule
   above.** *(Added 2026-09-02.)* Air separates the sections; inside a section, several fields are
   one bordered object with a hairline between them rather than several outlined boxes stacked.

   The distinction is what each rule is protecting. Rule 1 is about **sections**, and the failure
   it names is four panels that look unrelated. This is about **fields**, and the failure is the
   opposite one: two outlined boxes with a small gap read as a single control with a line through
   it, and with no gap they touch outright. Reported off the phone against the meetup composer's
   map link and location notes, which shared an edge.

   **Air cannot fix that class, which is why this is structural.** A gap can be tuned until it
   looks right on one screen and be wrong on the next, and nothing stops a later change closing
   it again. Inside a group there is only ever one border, so two fields cannot collide however
   the spacing moves. `FieldGroup` in the composer kit is the implementation, and a group of one
   is legitimate: it keeps a lone field on the same rail as the grouped ones above it.

   1b. **The bright line is the group's edge. The line between two rows is the quiet one.**
   `hairline` outlines the group; `divider` separates its rows, and the two are deliberately
   different weights. The outside says where the object ends and the inside says where one row
   becomes the next, which is a smaller claim and should look like one.

   > **Got this wrong for one build, and the way it failed is worth keeping.** A grouped field had
   > its background and its radius cleared but not its `borderWidth`, so every row still drew the
   > border it would have drawn standing alone. What looked like a divider was really two adjacent
   > field borders in the bright colour, the real divider underneath was never visible, and the
   > group read as bright lines throughout rather than as a bright edge around quiet rows.
   > Reported off the phone in one sentence: the segmenting line is as bright as the border.

   1c. **Rows of one group are the same height unless one asks to be taller.** A multiline field
   is floored at a height that makes it look like it takes more than a line, which is right when
   it stands alone and wrong beside a single-line row sharing its border - the step is about
   eighteen points and it makes the group the uneven thing it was introduced to fix. Inside a
   group that floor is lifted; a field that genuinely wants the height asks for it explicitly.

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

7. **The way out matches what the form IS, not only where its action sits.** A form presented over
   the screen it came from is a thing you are inside and are dismissing, so it gets a close
   control. A form that takes the WHOLE screen was navigated to, so it gets a back arrow - even
   when it carries its own primary action in the header.

   > **Reversed 2026-09-02, at the founder's request, and the earlier wording is worth keeping
   > because it was right about the case it had seen.** It read: *a header carrying the primary
   > action gets a close control, because the form is a thing you are inside and are dismissing.*
   > That held while every such form sat under its space's own header - the meetup composer drew
   > the club's avatar and name above its own title and Create, two headers stacked.
   >
   > The meetup composer now hides that header and takes the full screen, which changes what the
   > control means rather than merely how it looks: a cross on a full screen says "abandon this",
   > and the arrow says "go back", which is what it does. The action's position was never the real
   > test; it was a proxy for whether the form was a layer or a screen.

   The poll, event, race and meeting composers still sit under their space's header, so they keep
   the close control and nothing about them changes.

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
