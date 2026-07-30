/**
 * The token module. One flat set of named exports, imported directly.
 *
 * **Never hardcode a colour, radius, spacing value or font size that a token covers.**
 * The module is a flat named export specifically so a dark variant can be swapped in
 * without touching a single call site - the app is light-mode only today, and that is
 * the seam that keeps it cheap to change.
 *
 * > **Values are the "Kinetic Performance System", taken verbatim from v1's
 * > `constants/theme.ts`** - which took them verbatim from the Stitch export's
 * > `kinetic_performance_system/DESIGN.md` frontmatter. **This is the palette that shipped and
 * > ran in production**, which is why it is the source rather than any later design iteration.
 *
 * > **A correction worth recording, 2026-07-30.** These values were briefly replaced with a warm
 * > peach ramp read live from the current Stitch project, on the assumption that the project was
 * > authoritative and `SPEC/TECH/13`'s table had drifted. It was the other way round: the table was
 * > transcribed from v1's shipped theme and was correct, and the Stitch project has moved on since.
 * > The lesson is the one the repo already holds about v1 - **it is ground truth for what the
 * > product looks like, because it is the thing that actually ran** - and a live design tool is a
 * > working document, not a record of what shipped.
 *
 * `accent` is `#ff4d00`, not DESIGN.md's `#aa3000`: an explicit founder preference, applied
 * app-wide. Every other token is untouched.
 */

/**
 * The loaded font families, by the name `expo-font` registers them under.
 *
 * Lives here rather than beside the loader because a family name IS a token - and because the
 * loader needs `color` for its spinner, so the other direction is a cycle. It was one, briefly:
 * `theme` importing `fonts` importing `theme` failed at runtime with "Cannot access 'color'
 * before initialization", which is the module graph saying the dependency points the wrong way.
 *
 * **The token module imports nothing.** Everything imports it.
 */
export const fontFamily = {
  display: 'Anton_400Regular',
  body: 'ArchivoNarrow_400Regular',
  bodyBold: 'ArchivoNarrow_700Bold',
  label: 'Inter_600SemiBold',
  labelRegular: 'Inter_400Regular',
} as const;

export const color = {
  /** One accent app-wide. No screen introduces its own. The founder's Energetic Orange. */
  accent: '#ff4d00',
  /** The accent's container, for a pressed or filled state. */
  accentPressed: '#d43f00',

  appBackground: '#f7f9fb',
  card: '#ffffff',
  /** Every header and the tab bar share this surface. */
  chrome: '#f2f4f6',
  /** A surface that sits above `card` without becoming chrome. */
  cardRaised: '#eceef0',
  divider: '#eceef0',
  /** A real border, as opposed to a hairline. */
  border: '#916f65',
  fallback: '#e0e3e5',

  textPrimary: '#191c1e',
  textSecondary: '#5c4037',

  secondary: '#565e74',
  secondaryContainer: '#dae2fd',
  tertiary: '#005daa',
  error: '#ba1a1a',
  errorContainer: '#ffdad6',

  onAccent: '#ffffff',
  /** For a surface that inverts, such as the full-screen photo viewer. */
  inverseSurface: '#2d3133',
  onInverseSurface: '#eff1f3',
} as const;

/** rem values from DESIGN.md converted to px at a 16px base. */
export const radius = {
  xs: 4,
  /** The default. */
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 9999,
} as const;

export const space = {
  /** Micro. */
  xs: 4,
  /** Tight stack. */
  sm: 8,
  /** The gutter, and screen padding. */
  md: 16,
  /** Section separation. */
  lg: 24,
  /** Empty-state top offset. */
  xl: 48,
} as const;

/**
 * Typography roles.
 *
 * Each role is a complete family/size/line-height triple, spread at the call site rather than
 * copied field by field - a partially-applied role is how a screen ends up with the right size and
 * the wrong line height, or the right size and the wrong face.
 *
 * **Sizes are DESIGN.md's own values**, not rescaled: `title` is already the design system's
 * mobile-scaled headline. The scale is deliberately bold - Anton at 28px for a screen title is the
 * look, and shrinking it to fit more on screen is how the design gets lost.
 *
 * `fontWeight` is absent from every Anton role. It ships in a single weight, and asking for a
 * heavier one makes some platforms synthesise a fake bold that looks nothing like the design.
 */
export const type = {
  /** The largest thing in the product. */
  displayXl: { fontFamily: fontFamily.display, fontSize: 48, lineHeight: 53, letterSpacing: 1 },
  display: { fontFamily: fontFamily.display, fontSize: 32, lineHeight: 38 },
  /** A screen title. The design system's own mobile-scaled headline. */
  title: { fontFamily: fontFamily.display, fontSize: 28, lineHeight: 34 },
  /** Every navigation header title: Anton, per the design system's own rule. */
  headerTitle: { fontFamily: fontFamily.display, fontSize: 20, lineHeight: 26 },
  /** Numeric emphasis. */
  numeric: { fontFamily: fontFamily.bodyBold, fontSize: 24, lineHeight: 24 },
  headline: { fontFamily: fontFamily.bodyBold, fontSize: 17, lineHeight: 24, fontWeight: '700' },
  body: { fontFamily: fontFamily.body, fontSize: 16, lineHeight: 26 },
  bodySmall: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 22 },
  /** Labels, badges and buttons: uppercase and letterspaced. */
  label: { fontFamily: fontFamily.label, fontSize: 12, lineHeight: 16, letterSpacing: 0.6 },
} as const;
