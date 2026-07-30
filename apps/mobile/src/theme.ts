/**
 * The token module. One flat set of named exports, imported directly.
 *
 * **Never hardcode a colour, radius, spacing value or font size that a token covers.**
 * The module is a flat named export specifically so a dark variant can be swapped in
 * without touching a single call site - the app is light-mode only today, and that is
 * the seam that keeps it cheap to change.
 *
 * Values are the "Kinetic Performance System" set from SPEC/TECH/13-design-system.md.
 */

export const color = {
  /** One accent app-wide. No screen introduces its own. */
  accent: '#ff4d00',

  appBackground: '#f7f9fb',
  card: '#ffffff',
  /** Every header and the tab bar share this surface. */
  chrome: '#f2f4f6',
  divider: '#eceef0',
  fallback: '#e0e3e6',

  textPrimary: '#191c1e',
  textSecondary: '#5c4037',

  secondary: '#565e74',
  tertiary: '#005daa',
  error: '#ba1a1a',

  onAccent: '#ffffff',
} as const;

export const radius = {
  xs: 4,
  /** The default. */
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
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
 * Each role is a complete size/line-height/weight triple, spread at the call site
 * rather than copied field by field - a partially-applied role is how a screen ends up
 * with the right size and the wrong line height.
 */
export const type = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: '800' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  headline: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  bodySmall: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  /** Labels, badges and buttons: uppercase and letterspaced. */
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0.8 },
} as const;
