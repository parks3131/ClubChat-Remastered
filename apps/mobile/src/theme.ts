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

  /**
   * The accent at container weight, for a surface that is tinted rather than filled.
   *
   * v1's `primaryFixed`. It carries three jobs that all mean "this one is singled out": an
   * unread notification row, a poll option you voted for, and the create-a-poll prompt. A
   * screen wanting to highlight something reaches for this rather than for `accent` at an
   * opacity, which is how two screens end up with two different highlights.
   */
  accentSoft: '#ffdbd0',
  /** The border that goes with `accentSoft`. v1's `primaryFixedDim`. */
  accentSoftBorder: '#ffb59e',
  /** Text and icons on `accentSoft`. v1's `onPrimaryFixedVariant`. */
  onAccentSoft: '#852400',

  appBackground: '#f7f9fb',
  card: '#ffffff',
  /** Every header and the tab bar share this surface. */
  chrome: '#f2f4f6',
  /** A surface that sits above `card` without becoming chrome. */
  cardRaised: '#eceef0',
  /**
   * A surface that sits BELOW `card`: an inactive pill, an icon well, an avatar placeholder.
   *
   * v1's `surfaceContainerHigh`. Distinct from `cardRaised` by one step, and the distinction
   * matters where the two sit side by side - an inactive tab against the card behind it.
   */
  cardSunken: '#e6e8ea',
  divider: '#eceef0',
  /** A real border, as opposed to a hairline. */
  border: '#916f65',
  /**
   * The hairline that outlines a card.
   *
   * v1's `outlineVariant`, and the single most-used token in its whole interface: every card,
   * row, search field and list item carries `1px` of it. Its absence is why the remaster's
   * cards read as flat blocks of white against a near-white background.
   */
  hairline: '#e6beb2',
  fallback: '#e0e3e5',

  textPrimary: '#191c1e',
  textSecondary: '#5c4037',

  secondary: '#565e74',
  secondaryContainer: '#dae2fd',
  /** Text on `secondaryContainer`, and the colour v1 gives a location line. */
  onSecondaryContainer: '#5c647a',
  /** Text on `secondaryContainer` used as a badge. v1's `onSecondaryFixedVariant`. */
  onSecondarySoft: '#3f465c',
  tertiary: '#005daa',
  /** The tertiary at container weight, for a calendar badge. v1's `tertiaryFixed`. */
  tertiarySoft: '#d4e3ff',
  /** Text on `tertiarySoft`. v1's `onTertiaryFixedVariant`. */
  onTertiarySoft: '#004785',
  error: '#ba1a1a',
  errorContainer: '#ffdad6',
  /** Text on `errorContainer`. A destructive label that is readable rather than shouted. */
  onErrorContainer: '#93000a',

  /**
   * The ring around an avatar that has no photo.
   *
   * A hairline rather than a fill, so a letter or a glyph reads as sitting in a circle rather
   * than on a grey disc. `cardSunken` remains the fill behind a photo while it loads.
   */
  avatarRing: '#e6e8ea',

  onAccent: '#ffffff',
  /** Text on `accentPressed`. Not quite `onAccent`, and v1 ships both. */
  onAccentPressed: '#fffbff',
  /** For a surface that inverts, such as the full-screen photo viewer. */
  inverseSurface: '#2d3133',
  onInverseSurface: '#eff1f3',
} as const;

/**
 * Identity colours for a group avatar with no photo.
 *
 * > **This is not a second accent, and the distinction is what keeps "one accent app-wide" true.**
 * > Every one of these is a *placeholder for a photograph* - the colour a club would not have if
 * > it had uploaded an image. None of them is ever an interactive colour, a state, or a surface:
 * > nothing is tappable because it is amber, and nothing means anything because it is blue. They
 * > are doing the job the photo does, which is to make one row distinguishable from the next at a
 * > glance down a list.
 *
 * Sampled from the founder's mockup on 2026-08-09, which shipped as HTML without its stylesheet -
 * so these are read from the rendered design rather than from its CSS, and are worth replacing
 * with the exact values if that file turns up.
 *
 * Chosen by `avatarTint`, which hashes the club's id: a club keeps the same colour forever, on
 * every device and every reinstall, because the id never changes. Picking by list position would
 * make a club change colour whenever somebody else sent a message.
 */
export const avatarPalette = ['#f5a623', '#2f6fed', '#e0175b', '#12a594', '#8b5cf6'] as const;

/**
 * A stable colour for a group avatar, from the id that never changes.
 *
 * A sum of char codes rather than anything cryptographic: the requirement is determinism and an
 * even-ish spread over five buckets, not resistance to anybody. A uuid's own hex digits give both.
 */
export function avatarTint(id: string): string {
  let total = 0;
  for (let index = 0; index < id.length; index += 1) total += id.charCodeAt(index);
  return avatarPalette[total % avatarPalette.length]!;
}

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
 * The floating tab bar's footprint.
 *
 * > **A shared token because two files have to agree about it and cannot see each other.** The bar
 * > floats, inset and rounded, which means it is drawn OVER the screen behind it - so any list that
 * > scrolls to its own end needs to stop above the bar rather than under it. The tab layout owns
 * > the bar; the screens own their lists; and when only one of them knew this number, the last row
 * > of the chat list was sliced in half by the bar's top edge.
 *
 * `@react-navigation/bottom-tabs` normally answers this with `useBottomTabBarHeight`, which this
 * project's expo-router build does not re-export. Hence a token rather than a hook.
 */
export const tabBar = {
  /** The bar itself, excluding anything below it. */
  height: 60,
  /** Between the bar and the content above it. */
  gap: 8,
} as const;

/**
 * How much room a scrolling screen must leave at its bottom for the floating bar.
 *
 * Takes the safe-area inset rather than assuming one: the bar sits on `insets.bottom` where there
 * is a home indicator and on a plain margin where there is not.
 */
export function tabBarSpace(bottomInset: number): number {
  return tabBar.height + tabBar.gap + (bottomInset > 0 ? bottomInset : space.md);
}

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
