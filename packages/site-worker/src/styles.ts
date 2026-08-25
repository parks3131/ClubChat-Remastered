/**
 * The whole stylesheet, served at `GET /styles.css`.
 *
 * ## Why it is a route rather than an inline `<style>`
 *
 * So that the Content-Security-Policy on every page can be `default-src 'none'; style-src 'self'`
 * with no `unsafe-inline`, no per-response hash and no nonce. An inline style block needs one of
 * those three, and the first is a blanket permission, the second breaks the moment a byte of CSS
 * changes without the hash being recomputed, and the third means every response is uncacheable.
 * A separate file needs none of them and is cached once per visitor.
 *
 * ## Why the values are transcribed rather than imported
 *
 * `apps/mobile/src/theme.ts` is the token module and says at the top: never hardcode a colour,
 * radius, spacing value or font size that a token covers. It cannot be imported here - it is a
 * React Native module in a different workspace, bundled for a different runtime - so the tokens are
 * transcribed into CSS custom properties ONCE, in `:root` below, and every rule after that reads
 * `var(--...)`. The rule the app's file states is therefore preserved in the shape that matters:
 * **no rule below contains a literal colour, radius or font size.** A palette change is an edit to
 * one block.
 *
 * The transcription is the accepted cost, and it is one-directional: if `theme.ts` moves, this
 * block is stale until somebody moves it too. That is written down here rather than hidden, and it
 * is why the block names each token by the app's own name for it.
 *
 * ## Light only
 *
 * The app is light-mode only, deliberately (`theme.ts`: "the app is light-mode only today, and
 * that is the seam that keeps it cheap to change"). The web surface follows it rather than
 * inventing a dark palette the app does not have, and `color-scheme: light` tells the browser so
 * that its own scrollbars and controls do not arrive dark against it.
 *
 * ## The typeface
 *
 * System stack, not the app's Anton / Archivo Narrow / Inter. Loading those means a `font-src` to
 * a font CDN in the CSP and a third-party request on the apex, which is a real dependency to take
 * on for a page whose entire job is to be reachable when other things are not. Named here as a
 * decision rather than left as an omission.
 */
export const STYLESHEET = `:root {
  /* Transcribed from apps/mobile/src/theme.ts. Nothing below this block names a literal value. */
  --accent: #ff4d00;
  --accent-pressed: #d43f00;
  --accent-soft: #ffdbd0;
  --accent-soft-border: #ffb59e;
  --on-accent-soft: #852400;
  --on-accent: #ffffff;
  --app-background: #f7f9fb;
  --card: #ffffff;
  --card-sunken: #e6e8ea;
  --divider: #eceef0;
  --hairline: #e6beb2;
  --text-primary: #191c1e;
  --text-secondary: #5c4037;
  --error: #ba1a1a;

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-pill: 9999px;

  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 48px;

  --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --size-display: 32px;
  --size-title: 28px;
  --size-heading: 20px;
  --size-body: 16px;
  --size-small: 14px;
  --size-label: 12px;

  --measure: 42rem;

  color-scheme: light;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--app-background);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: var(--size-body);
  line-height: 1.6;
  -webkit-text-size-adjust: 100%;
}

a { color: var(--accent); }
a:hover { color: var(--accent-pressed); }

.masthead {
  padding: var(--space-md) var(--space-md);
  border-bottom: 1px solid var(--divider);
  background: var(--card);
}

.wordmark {
  font-size: var(--size-heading);
  font-weight: 700;
  letter-spacing: 0.02em;
  text-decoration: none;
  color: var(--text-primary);
}

.page {
  max-width: var(--measure);
  margin: 0 auto;
  padding: var(--space-xl) var(--space-md);
}

h1 { font-size: var(--size-display); line-height: 1.2; margin: 0 0 var(--space-md); }
h2 { font-size: var(--size-title); line-height: 1.25; margin: var(--space-lg) 0 var(--space-sm); }
h3 { font-size: var(--size-heading); line-height: 1.3; margin: var(--space-lg) 0 var(--space-sm); }
h4, h5, h6 { font-size: var(--size-body); margin: var(--space-md) 0 var(--space-xs); }

p { margin: 0 0 var(--space-md); }
ul, ol { margin: 0 0 var(--space-md); padding-left: var(--space-lg); }
li { margin-bottom: var(--space-xs); }
hr { border: 0; border-top: 1px solid var(--divider); margin: var(--space-lg) 0; }

blockquote {
  margin: 0 0 var(--space-md);
  padding: var(--space-sm) var(--space-md);
  border-left: var(--space-xs) solid var(--accent-soft-border);
  background: var(--card);
  color: var(--text-secondary);
}

code {
  font-family: var(--font-mono);
  font-size: var(--size-small);
  background: var(--card-sunken);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-xs);
}

pre {
  overflow-x: auto;
  background: var(--card-sunken);
  border-radius: var(--radius-md);
  padding: var(--space-md);
}
pre code { background: none; padding: 0; }

table {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 var(--space-md);
  font-size: var(--size-small);
}
th, td {
  text-align: left;
  padding: var(--space-sm);
  border-bottom: 1px solid var(--divider);
  vertical-align: top;
}

.lede { font-size: var(--size-heading); line-height: 1.5; color: var(--text-secondary); }

.club-name { overflow-wrap: anywhere; }

.meta {
  font-size: var(--size-small);
  color: var(--text-secondary);
  margin: 0 0 var(--space-lg);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  margin: var(--space-lg) 0;
}

.button {
  display: inline-block;
  padding: var(--space-sm) var(--space-lg);
  border-radius: var(--radius-pill);
  text-decoration: none;
  font-weight: 600;
  background: var(--accent);
  color: var(--on-accent);
}
.button:hover { background: var(--accent-pressed); color: var(--on-accent); }

.button-secondary {
  background: var(--accent-soft);
  color: var(--on-accent-soft);
  border: 1px solid var(--accent-soft-border);
}
.button-secondary:hover { background: var(--accent-soft-border); color: var(--on-accent-soft); }

.notice {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background: var(--card);
  padding: var(--space-md);
  margin: 0 0 var(--space-lg);
}
.notice-error { color: var(--error); }

.footer {
  max-width: var(--measure);
  margin: 0 auto;
  padding: var(--space-lg) var(--space-md) var(--space-xl);
  border-top: 1px solid var(--divider);
  font-size: var(--size-label);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.footer a { margin-right: var(--space-md); }
`;
