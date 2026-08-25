/**
 * The club name is a string a member typed, and this Worker prints it into five places.
 *
 * `GET /invites/:token/preview` returns `club.name` straight out of a row. Nothing between that row
 * and this page sanitises it - it must not, because a club really can be called `Ben & Jerry's` and
 * the page has to say so. So the whole defence is escaping at the boundary, in every context the
 * name reaches, and this file is the proof rather than the claim.
 *
 * ## Five contexts, enumerated rather than sampled
 *
 * The name goes into the `<title>` element, an `<h1>` element, and the `content` attribute of three
 * `<meta>` tags: `description`, `og:title` and `og:description`. Each is asserted separately. A
 * single "the page contains no `<script>`" assertion would pass a page that escaped four of the
 * five and left the fifth open, which is exactly how this class of defect ships.
 *
 * ## The payload
 *
 * One string carrying every character that matters in any of those contexts: a tag, a double quote
 * that would close an attribute, a single quote that would close a differently-spelled one, and an
 * ampersand that has to survive being escaped without being double-escaped into visible mojibake.
 *
 * ## Proving the test can fail
 *
 * These assertions were watched failing before `escapeHtml` existed, and then again with the `&`
 * case removed from it, because a test for an escaping property that has never been red is a test
 * that may only be asserting that the string is present somewhere. See AGENTS.md 0.11.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { armApi, blockApi, get, previewBody, releaseApi, TOKEN } from './harness.ts';

beforeEach(blockApi);
afterEach(releaseApi);

const HOSTILE = `Evil" onmouseover="alert(1)" <script>alert('xss')</script> & Ben's`;

/** Everything between the tags, raw, so the assertion sees the bytes the browser will parse. */
function element(body: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(body);
  if (match === null) throw new Error(`no <${tag}> in the page`);
  return match[1] ?? '';
}

/**
 * The raw text between the quotes of one meta tag's `content` attribute.
 *
 * **The `">` at the end of the pattern is load-bearing and was added after a mutation run.** The
 * first version stopped at `content="([^"]*)"`, which silently captured a TRUNCATED value when the
 * escaping was broken: with `"` left unescaped, `content="Evil" onmouseover="alert(1)" ...` matched
 * and handed back `Evil`, which contains none of the characters the assertions look for. Three of
 * the five context tests passed against a page carrying a live event handler.
 *
 * Requiring the attribute to run to the end of the tag removes that. A leaked quote now means no
 * match at all, and this throws instead of returning a plausible-looking prefix.
 */
function metaContent(body: string, selector: string): string {
  const match = new RegExp(`<meta ${selector}[^>]*content="([^"]*)">`).exec(body);
  if (match === null) throw new Error(`no well-formed <meta ${selector}> with a content attribute`);
  return match[1] ?? '';
}

async function hostilePage(): Promise<string> {
  armApi(() => Response.json(previewBody({ name: HOSTILE, memberCount: 3 })));
  const { body } = await get(`/join/${TOKEN}`);
  return body;
}

/** Every context the name reaches, by the name of the context and how to pull it back out. */
const CONTEXTS: ReadonlyArray<readonly [string, (body: string) => string]> = [
  ['the <title> element', (body) => element(body, 'title')],
  ['the <h1> element', (body) => element(body, 'h1')],
  ['the meta description', (body) => metaContent(body, 'name="description"')],
  ['the og:title', (body) => metaContent(body, 'property="og:title"')],
  ['the og:description', (body) => metaContent(body, 'property="og:description"')],
];

describe('a club name containing HTML and quote characters', () => {
  it.each(CONTEXTS)('is escaped in %s', async (_name, extract) => {
    const body = await hostilePage();

    const context = extract(body);

    // The name really is there, so this is not passing because the page dropped it.
    expect(context).toContain('Evil');
    // And none of the four characters that would end the context survives raw.
    expect(context).not.toContain('<');
    expect(context).not.toContain('>');
    expect(context).not.toContain('"');
    expect(context).not.toContain("'");
  });

  it.each(CONTEXTS)('escapes rather than strips, in %s', async (_name, extract) => {
    const body = await hostilePage();

    const context = extract(body);

    // A page that deleted the characters would pass the test above. The name has to arrive intact
    // in its escaped spelling, so that a club genuinely called `Ben's` reads correctly.
    expect(context).toContain('&lt;script&gt;');
    expect(context).toContain('&quot;');
    expect(context).toContain('&#39;');
    expect(context).toContain('&amp;');
  });

  it('never puts an executable script tag or a real attribute in the document', async () => {
    const body = await hostilePage();

    expect(body).not.toContain('<script');
    // `onmouseover=` on its own DOES appear, as inert text inside an escaped name, and asserting
    // its absence was this test's own first failure. What must not appear is the handler followed
    // by a quote the browser would read as opening an attribute value, which is what escaping the
    // quote prevents. Asserting the harmless substring instead would have been a test that only
    // passes for names nobody would write.
    expect(body).not.toContain('onmouseover="');
    expect(body).not.toContain("onmouseover='");
  });

  it('does not double-escape an ampersand into visible mojibake', async () => {
    armApi(() => Response.json(previewBody({ name: 'Ben & Jerry', memberCount: 1 })));

    const { body } = await get(`/join/${TOKEN}`);

    expect(element(body, 'h1')).toContain('Ben &amp; Jerry');
    expect(body).not.toContain('&amp;amp;');
  });

  it('caps a name longer than the api itself accepts', async () => {
    // `packages/server/src/api/routes/clubs.ts` is `z.string().min(1).max(120)`. A longer one is
    // either drift or an attempt to make the page enormous; both are answered by truncating.
    armApi(() => Response.json(previewBody({ name: 'x'.repeat(5_000), memberCount: 1 })));

    const { body } = await get(`/join/${TOKEN}`);

    expect(element(body, 'h1')).not.toContain('x'.repeat(121));
    expect(element(body, 'h1')).toContain('x'.repeat(120));
  });
});
