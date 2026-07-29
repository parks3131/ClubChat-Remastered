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

### Current tokens (for reference)

| Category | Values |
|---|---|
| Accent | `#ff4d00` "Energetic Orange" - every accent: header titles, FABs, active tab, links, back arrows, pins, primary buttons |
| Surfaces | App background `#f7f9fb`; cards `#ffffff`; **every header and the tab bar** `#f2f4f6`; dividers/fallbacks in the `#ecee…`-`#e0e3…` ramp |
| Text | Primary `#191c1e`; secondary/muted `#5c4037` |
| Semantic | Secondary/poll badges `#565e74` family; practice/tertiary `#005daa` family; error and the notification badge `#ba1a1a` family |
| Radii | 4 / 8 (default) / 12 / 16 / 24 / pill. Avatars use an explicit half-width radius |
| Spacing | 4 micro / 16 gutter and screen padding / 8 tight stack / 24 section / 48 empty-state top |
| Type | Anton for display and **every header title**; Archivo Narrow for body and numeric emphasis; Inter SemiBold, uppercase, letterspaced, for labels/badges/buttons |

### Signature treatments

- **Glass-blur headers** on chat and Highlights (they opt out of the native header and render
  their own), plus the floating pinned strip. Consequence: the list needs manual top padding
  computed from header height + safe-area inset + pinned-strip height, and the back control is
  reimplemented inline - which is exactly why every such component takes an explicit
  back-fallback.
- **Gradient fill on sent message bubbles**, isolated in a container component so the list's
  row renderer never switches element types between sent and received.
- **Chat hides the bottom tab bar** while open.

**Light mode only** today; there is no dark palette. The token module is a flat named export
specifically so a dark variant can be swapped in without touching call sites.
