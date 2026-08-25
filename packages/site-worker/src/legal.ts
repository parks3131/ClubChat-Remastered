/**
 * The two legal documents, bundled at build time.
 *
 * `docs/legal/privacy-policy.md` and `docs/legal/terms-of-service.md` are the ONLY copy of that
 * text in the repo. Nothing duplicates them: not this package, not the mobile app, which links out
 * to `https://clubchatapp.com/privacy` and `https://clubchatapp.com/terms` rather than embedding
 * anything. Two copies of a legal document is one copy plus a liability.
 *
 * ## Bundled, not fetched
 *
 * The imports below are turned into strings by the `Text` module rule in `wrangler.jsonc`. Three
 * consequences, all intended:
 *
 *  - **What is served is pinned to a commit.** There is no store, no cache and no fetch that could
 *    hand back a version nobody can point at in git.
 *  - **A change to the text is a redeploy of this Worker.** That is the cost, and it is the right
 *    one for a document whose whole value is that it says what it said.
 *  - **A missing file is a build failure, not a runtime 500.** `wrangler deploy` and `vitest run`
 *    both fail to bundle rather than shipping a Worker that serves an empty privacy policy.
 *
 * ## Rendered per request rather than at module load
 *
 * `renderMarkdown` runs inside the handler. It could run once at module scope and be cached for the
 * life of the isolate, and it is not, because the documents are around twenty kilobytes and the
 * parse is linear: the saving is invisible and the cost is a module-level side effect that runs
 * during isolate startup, where a throw is a Worker that fails to boot rather than one route that
 * fails. If this ever shows up in a profile, the fix is a lazy cache, not a top-level constant.
 */

import privacyMarkdown from '../../../docs/legal/privacy-policy.md';
import termsMarkdown from '../../../docs/legal/terms-of-service.md';

export type LegalDocument = {
  /** The path it is served at. */
  readonly path: '/privacy' | '/terms';
  /** The title used if the document has no `#` heading of its own. */
  readonly fallbackTitle: string;
  /** The raw markdown, as bundled. */
  readonly markdown: string;
};

/**
 * The two documents, keyed by the path they are served at.
 *
 * Written as a record rather than as two exported constants so the router cannot serve one at the
 * other's path. `legal.test.ts` asserts that `/privacy` and `/terms` do not return identical bytes,
 * which is the one thing a single mistyped import would produce and nothing else would notice.
 */
export const LEGAL_DOCUMENTS = {
  '/privacy': {
    path: '/privacy',
    fallbackTitle: 'Privacy Policy',
    markdown: privacyMarkdown,
  },
  '/terms': {
    path: '/terms',
    fallbackTitle: 'Terms of Service',
    markdown: termsMarkdown,
  },
} as const satisfies Record<string, LegalDocument>;

export type LegalPath = keyof typeof LEGAL_DOCUMENTS;

/** Whether a path is one of the two legal documents, narrowing it for the caller. */
export function isLegalPath(pathname: string): pathname is LegalPath {
  return pathname === '/privacy' || pathname === '/terms';
}
