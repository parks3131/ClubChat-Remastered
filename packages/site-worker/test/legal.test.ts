/**
 * `GET /privacy` and `GET /terms`.
 *
 * **Nothing here asserts a word of the policy**, on purpose. `docs/legal/privacy-policy.md` and
 * `docs/legal/terms-of-service.md` are the only copy of that text in the repo and they are written
 * and revised by whoever owns the words, not by this package. A test that pinned a sentence would
 * turn every edit of the policy into a red suite, which teaches people to edit the test.
 *
 * What is asserted is everything that is this package's job: the two routes exist, the content is
 * the bundled markdown rendered rather than markdown printed raw, the page title comes from the
 * document rather than from a constant here, the pages are reachable with the api down, and they
 * carry the same headers as everything else. The renderer itself is covered against fixtures in
 * `markdown.test.ts`.
 *
 * The text is bundled at BUILD time by the `Text` module rule in `wrangler.jsonc`, so a change to
 * either document is a redeploy of this Worker. That is the intended trade: what is served is
 * pinned to a commit and cannot drift from the repo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockApi, get, releaseApi } from './harness.ts';

beforeEach(blockApi);
afterEach(releaseApi);

const PAGES = [
  ['/privacy', 'privacy policy'],
  ['/terms', 'terms of service'],
] as const;

describe.each(PAGES)('%s', (path) => {
  it('is served as HTML with the api unreachable', async () => {
    const { response } = await get(path);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
  });

  it('renders the markdown rather than printing it', async () => {
    const { body } = await get(path);

    // A rendered document has a heading element. An unrendered one has a `#` at the start of a
    // line, which is what "we forgot to call the renderer" looks like and what this catches.
    expect(body).toMatch(/<h1>[^<]/);
    expect(body).not.toMatch(/<main class="page">\s*#/);
  });

  it('takes its title from the document rather than from a constant in the Worker', async () => {
    const { body } = await get(path);

    const title = /<title>([\s\S]*?)<\/title>/.exec(body)?.[1] ?? '';
    const heading = /<h1>([\s\S]*?)<\/h1>/.exec(body)?.[1] ?? '';
    expect(title.length).toBeGreaterThan(0);
    expect(title).toContain(heading);
  });

  it('carries no script and no inline style', async () => {
    const { body } = await get(path);

    expect(body).not.toContain('<script');
    expect(body).not.toContain('<style');
  });

  it('is cacheable, because the text changes on a deploy and not per request', async () => {
    const { response } = await get(path);

    expect(response.headers.get('cache-control')).toMatch(/max-age=\d+/);
  });

  it('links to the other legal page, so one is always reachable from the other', async () => {
    const { body } = await get(path);

    expect(body).toContain('href="/privacy"');
    expect(body).toContain('href="/terms"');
  });
});

describe('the two documents are actually different', () => {
  it('does not serve the same bytes at both paths', async () => {
    // A single import used for both routes typechecks, deploys, and serves the privacy policy as
    // the terms of service. Nothing else in this file would notice.
    const privacy = await get('/privacy');
    const terms = await get('/terms');

    expect(privacy.body).not.toBe(terms.body);
  });
});
