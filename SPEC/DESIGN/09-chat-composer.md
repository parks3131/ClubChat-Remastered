# Surface: chat composer

## Purpose

The bar you write a message in, and everything that lives beside it.

Distinct from [Composer](06-composer.md), which is the *form* you fill in to make a poll or an
event. This is the one-line bar at the bottom of a conversation, and it is on screen more than any
other control in the product.

## Where it appears

The bottom of chat, in every scope. A conversation nobody may post in shows the same bar carrying
its reason instead of a field, because losing the ability to post should not also change what the
bottom of the screen is made of.

## Anatomy

| Part | What it is |
|---|---|
| `composerBar` | The blurred layer and its top hairline. |
| `composer` | The wash, and the row itself. |
| `attachButton` | The "+", which becomes a keyboard glyph. See [Attachment panel](08-attachment-panel.md). |
| `input` | The message field: a white pill. |
| `announceButton` | The admin's announcement toggle. Fills when armed. |
| `sendButton` | An accent disc, present only when there is something to send. Carries a check instead of an arrow while an edit is being saved. |
| `replyBar` | The line of context directly above the row, shared by the reply quote and the editing label. One bar, never two: what it says is what the send will do. |

## Rules that must survive

1. **A wash of the accent, not a panel colour.** The founder asked for WhatsApp's translucent bar
   in our own colour. A few percent of the accent over a blur, because this bar sits under every
   conversation all day: enough to tint the light through it, nowhere near enough to compete with
   a message bubble or with the send control in the same row.

2. **The tint is a layer between the blur and the row.** Not a background on the blurred view,
   which is invisible - the blur material draws over its own host's background. Not an
   absolutely-positioned overlay inside it either: on web, CSS paints positioned elements above
   static siblings, so it covers the message field, while on native it sits behind. A parent
   cannot have that argument with its children.

3. **The controls are glyphs, not chips.** They wore white discs with hairlines, which made three
   framed objects in a row that is mostly one field. The tap target keeps its size; only the paint
   is gone. The one exception is the armed announcement toggle, which fills, because an
   announcement sent by accident cannot be recalled.

4. **Send appears when there is something to send.** A permanent greyed-out SEND slab occupied the
   corner in the loudest colour in the palette for the entire time somebody was reading rather
   than writing. Nothing takes its place when it goes: the row simply gets shorter.

5. **The bar carries the home indicator's space.** Every other app's does, and ours ended right
   under the field with the indicator through it. It does not change when the keyboard does - see
   rule 7.

6. **The newest message clears the bar by more than the gutter.** Reported from the device as the
   bottom message "getting cut" against it. The list is inverted, so this is `paddingTop` on the
   content and it lands at the visual bottom.

7. **The bar's height never changes while the keyboard is moving.** The floor dropping to a
   hairline while the keyboard was up meant the bar resized in the middle of the keyboard's
   animation - one more thing moving in the frames where the conversation is already moving. The
   keyboard avoider's offset pays for the floor instead, so the field still lands exactly on the
   keyboard's top edge.

8. **The rise is animated and quicker than the keyboard; the fall is not animated at all.**
   Promoted to [Engineering pitfalls](../TECH/14-engineering-pitfalls.md) entry 23, because it
   binds anything that moves with the keyboard rather than this bar alone.

## States

| State | Treatment |
|---|---|
| Default | "+", field, announcement toggle where the viewer is an admin |
| Typing | The send disc appears |
| Uploading | The "+" becomes a spinner and is disabled, so a second tap cannot start a concurrent upload |
| Panel open | The "+" is a keyboard glyph; the floor hands its space to the panel |
| Announcement armed | The toggle fills, and the field's placeholder says "Announcement" |
| Replying | A quote of the answered message sits in the bar above, with its own cancel |
| Editing | "Editing message" sits in that same bar, with its own cancel, and the send disc becomes a check |
| Read-only | The whole row is replaced by the reason, which is stated rather than implied |

**Editing and replying are one slot, and cannot both be occupied.** The bar above the row says
what the send will do, so two of them stacked would be a composer answering one message while
rewriting another. The glyph on the disc is the only thing carrying "this replaces what you said
rather than adding to it" - an arrow there would be the composer's one lie, because send means a
new message everywhere else in the product.

## Obligations it creates elsewhere

| Obligation | Who owes it | Recorded in |
|---|---|---|
| Animate the keyboard's rise, never its fall | Anything that moves with the keyboard | [Engineering pitfalls](../TECH/14-engineering-pitfalls.md) 23 |
| The list must clear the bar without the bar knowing the list exists | The chat list's content padding | Rule 6 |
| A keyboard event must not re-render the chat screen | `KeyboardAvoider`, which holds that state itself | HISTORY 2026-08-14 |

## Accessibility

The send control is labelled for what it does rather than for its glyph, and it is absent rather
than disabled when there is nothing to send - a disabled control still announces itself. The
announcement toggle reports its selected state and says, in words, that it notifies everybody.

## Platform differences

| | Behaviour |
|---|---|
| iOS | As described. |
| Android | Unverified - no build exists. |
| Web | No software keyboard, so the bar simply sits at the bottom. The field is a `<textarea>`, whose default is two rows, so it is pinned to one. |

## Rejected alternatives

**A floating, inset bar**, like the tab bar. It would rhyme with the tab bar and cost the field
its full width, on the one control where width is the point.

**Keeping SEND visible and disabled.** Rejected with rule 4: it is a permanent advertisement for
an action that is unavailable.

**Tinting with a solid panel colour.** Simpler, and it makes the bottom of chat a slab under a
blurred header - the two ends of the same screen made of different materials.
