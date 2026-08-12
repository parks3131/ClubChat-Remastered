# Design system

The current visual language is a Material-3-shaped token set called the "Kinetic Performance
System". The remaster may restyle, but these structural rules should survive.

### Structural rules

1. **One flat token module** - colours, radii, spacing, typography - imported directly.
   **Never hardcode a colour, radius, or font size a token covers.**
2. **One accent colour app-wide.** No screen introduces its own.
3. **Typography roles are spread, not copied** - each role is a complete family/size/
   line-height triple.
4. **The whole app is gated on fonts being loaded**, so no screen ever flashes system fonts.
5. **Shared screens, not forked copies.** Chat, Highlights, Polls, Calendar, Events, Members,
   and Gallery are each **one** implementation reused by club, race, and Eboard, so a fix
   lands everywhere at once.
6. **Consistent headers** across every club-scoped screen, including a working back control
   on screens reached by deep link.

### Current tokens

The **"Kinetic Performance System"**, extracted verbatim from the Stitch export's
`kinetic_performance_system/DESIGN.md` frontmatter and shipped in v1 as `constants/theme.ts`.
**This is the palette that ran in production**, which is why it is the source of truth here.

| Category | Values |
|---|---|
| Accent | `#ff4d00` "Energetic Orange" - every accent: header titles, FABs, active tab, links, back arrows, pins, primary buttons. Container `#d43f00` |
| Surfaces | App background `#f7f9fb`; cards `#ffffff`; **every header and the tab bar** `#f2f4f6`; raised `#eceef0`; fallback `#e0e3e5` |
| Text | Primary `#191c1e`; secondary/muted `#5c4037` |
| Semantic | Secondary/poll badges `#565e74` family; practice/tertiary `#005daa` family; error and the notification badge `#ba1a1a` family; outline `#916f65`, hairline `#e6beb2` |
| Radii | 4 / 8 (default) / 12 / 16 / 24 / pill. Avatars use an explicit half-width radius |
| Spacing | 4 micro / 16 gutter and screen padding / 8 tight stack / 24 section / 48 empty-state top |
| Type | Anton for display and **every header title** (48 / 32 / 28 / 20); Archivo Narrow for body (16/26) and numeric emphasis (24 bold); Inter SemiBold 12, letterspaced 0.6, for labels/badges/buttons |
| Icons | MaterialIcons from `@expo/vector-icons`. The four destinations are `forum`, `calendar-month`, `notifications`, `person` - the first was v1's `groups` until that destination stopped being a roster of clubs and became the conversation list |
| Avatar identity | Five placeholder colours for a **group** avatar with no photo, picked by hashing its channel id so a club keeps one forever. Not a second accent: they stand in for a photograph and are never interactive, a state, or a surface |

> **`primary` is `#ff4d00`, not DESIGN.md's `#aa3000`** - an explicit founder preference applied
> app-wide. Every other token is untouched. Worth knowing before somebody "fixes" it back.

> **A correction, 2026-07-30.** This table was briefly rewritten to a **warm peach** ramp read live
> from the current Stitch project, on the assumption that the live project was authoritative and
> this table had drifted from it. It was the other way round: the table came from v1's shipped
> theme, and **the Stitch project has moved on since v1 shipped**. The values above were restored
> from `constants/theme.ts` in the v1 repository.
>
> The general rule, since more designs will arrive: **v1 is ground truth for what the product looks
> like, because it is the thing that actually ran.** A live design tool is a working document. Read
> it for screens the product does not have yet, not to settle what the shipped ones look like.

### Signature treatments

- **Glass-blur headers** on chat and Highlights (they opt out of the native header and render
  their own), plus the floating pinned strip. Consequence: the list needs manual top padding
  computed from header height + safe-area inset + pinned-strip height, and the back control is
  reimplemented inline - which is exactly why every such component takes an explicit
  back-fallback.
- **Gradient fill on sent message bubbles**, isolated in a container component so the list's
  row renderer never switches element types between sent and received.
- **Chat hides the bottom tab bar** while open.
- **A floating tab bar**, inset from the edges, fully rounded, translucent, and lifted off the
  bottom, with the active destination carrying an `accentSoft` pill that **slides** between
  destinations rather than fading in place - one pill that moves, since four separate backgrounds
  can only cross-fade and that is what read as a jump. It is drawn by the app rather than by
  `tabBarActiveBackgroundColor`, which paints a box of the navigator's own choosing.

  **The destinations are icons alone since 2026-08-09**, at the founder's request. Two consequences
  follow and neither is optional. The pill is now the *only* second channel for the selected state,
  so removing it would leave accent-versus-grey by itself and fail `PRD/16` outright. And each
  destination's name moved to an accessibility label, because a tab containing no text gives a
  screen reader nothing to announce.

  **The bar is positioned absolutely, and that is load-bearing twice.** It is what puts content
  behind the glass: in normal flow the scene ends at the bar's top edge, so the strips either side
  of an inset bar hold nothing and a translucent bar is indistinguishable from an opaque one. It is
  also what obliges **every scrolling screen** to reserve `tabBarSpace()` from the same token the
  bar is built from - a screen that does not has a last row that can never be scrolled clear.
- **The Chats list is flat**, not carded: rows sit directly on the app background, and unread is an
  accent timestamp plus an accent count badge rather than a tinted row. **The notification inbox
  went flat on 2026-08-12**, and did it as a `flat` parameter on the shared `Row` rather than as a
  second row implementation - so the follow-up below is now half done and has somewhere to land.

  The inbox is the case that shows why flat is not only a finish. Its unread rows are *tinted*, and
  a card insets its tint, so consecutive unread rows read as separate blocks with gaps between
  them; full-bleed rows meet, and a run of them becomes one band. That is a property of the
  variant rather than of the caller, which is why it belongs in the component.

  Every remaining list still uses cards; unifying them is a deliberate follow-up rather than an
  oversight. **Whatever goes flat next owes a pressed wash**: flat removes the card edge and the
  chevron, so without one a tap is acknowledged only by the next screen arriving, and on a slow
  open the row reads as dead. `Row` now carries that with the variant.

**Light mode only** today; there is no dark palette. The token module is a flat named export
specifically so a dark variant can be swapped in without touching call sites.

### Where the Stitch designs go further than the product, and what was decided

The Stitch project carries 67 screens, several of which show things the product does not have. All
four were settled on 2026-07-30, and all four the same way: **take the visual language, not the
implied features.**

| The design shows | Decision |
|---|---|
| Stat tiles - "MILES LOGGED 42.1K / Goal: 50K", "MEMBERS 1,248 / +12% this month" | **Dropped.** Member count is real; per-member mileage, season goals and growth-over-time exist nowhere in the schema or the PRD. Building them is a domain expansion, not a re-skin |
| A **Message Search** screen | **Stays deferred.** [Roadmap](../PRD/17-roadmap-and-open-questions.md) lists message search under "deliberately deferred (do not fix)", and a design being ahead of the spec does not un-defer it |
| An **Appearance & Dark Mode** screen | **Light only for now.** The flat token module is already the seam, so adding dark later is a token change plus a preference rather than a re-verification of every screen in two modes |
| A **hero cover image** per club | **Skipped.** Clubs carry no media at all today; adding one is a schema change, an upload surface, and a default for every existing club |

The rule these share is worth stating on its own, because more designs will arrive: **a design is a
specification of appearance, not of scope.** Where one implies data the product does not hold, the
gap gets recorded here and raised, never quietly invented in a component.
