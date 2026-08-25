/**
 * Turning strings into HTML, and the one function that stops a club name becoming a script tag.
 *
 * This Worker renders exactly one piece of genuinely untrusted input: the club name on the join
 * page, which came from `GET /invites/:token/preview` on the api, which read it out of a row a
 * member typed. It reaches four separate places in one document - the `<title>`, an `<h1>`, and the
 * `content` attribute of two `<meta>` tags - and every one of them is a different escaping context
 * in the general case.
 *
 * **There is one escape function, not two, and that is the decision.** `escapeHtml` escapes the
 * full set `& < > " '`, which is simultaneously correct for element text and for a
 * double-quoted OR single-quoted attribute value. A pair of functions - `escapeText` and
 * `escapeAttribute` - would be more precise and would let a call site pick the wrong one, which is
 * the actual failure mode: nobody writes `escapeAttribute` and then omits it, they write
 * `escapeText` into an attribute and it looks fine until the first club called `Runner's " Club`.
 * One function costs four extra characters in a `<h1>` and cannot be picked wrongly.
 *
 * **What it is NOT sufficient for: a URL.** Escaping `javascript:alert(1)` produces
 * `javascript:alert(1)`, which is an unchanged working XSS payload the moment it lands in an
 * `href`. Every URL in this package goes through `safeHref` as well, and the two are used
 * together rather than one instead of the other.
 */

/**
 * The five characters, escaped so the result is safe as element text and as an attribute value.
 *
 * `&` first, and it has to be: escaping it after `<` would turn the `&` of `&lt;` into `&amp;lt;`
 * and print the literal text `&lt;` on the page. A single pass over a character class avoids the
 * ordering question entirely, which is why it is written as one regex rather than five `replace`
 * calls chained together.
 *
 * `'` is escaped as `&#39;` rather than `&apos;` because `&apos;` is an XHTML entity that older
 * HTML parsers do not know, and this file's whole job is to be boring.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * A URL that is safe to put in an `href`, or null.
 *
 * An allowlist rather than a denylist, because a denylist for this has to enumerate `javascript:`,
 * `data:`, `vbscript:`, and every spelling of each with embedded whitespace, control characters or
 * HTML entities. The allowlist is four cases and covers everything this site links to.
 *
 * **It is applied to the ESCAPED string on purpose**, and that ordering does real work. Escaping
 * first turns a source `&#106;avascript:` into `&amp;#106;avascript:`, which no browser decodes
 * back into a scheme, so an entity-encoded payload fails the prefix test rather than sneaking past
 * it. The four allowed prefixes contain no character that escaping changes, so testing them
 * against the escaped string is exact.
 *
 * **`//evil.example.com` is refused, and the second test is the whole reason this is two
 * expressions rather than one.** A leading `/` is meant to allow a same-site path, and a
 * protocol-relative URL starts with one too - it is a link to another host that inherits the
 * page's scheme. It was allowed by the first version of this function, and the test that caught it
 * is in `markdown.test.ts` under "emits no href at all".
 */
export function safeHref(escapedUrl: string): string | null {
  const absolute = /^(?:https?:\/\/|mailto:|#)/i.test(escapedUrl);
  const sameSite = escapedUrl.startsWith('/') && !escapedUrl.startsWith('//');
  return absolute || sameSite ? escapedUrl : null;
}

/** One `<meta name=... content=...>`, with the content escaped. */
function metaName(name: string, content: string): string {
  return `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`;
}

/** One `<meta property=... content=...>`, for the OpenGraph tags. */
function metaProperty(property: string, content: string): string {
  return `<meta property="${escapeHtml(property)}" content="${escapeHtml(content)}">`;
}

export type PageOptions = {
  /**
   * The `<title>`, and the OpenGraph title. RAW: this function escapes it.
   *
   * Passed unescaped deliberately. Every caller would otherwise have to remember to escape, and
   * the one that forgot would be indistinguishable from the ones that did not until a club with a
   * quote in its name signed up. Handing raw strings to one escaping boundary is the shape that
   * cannot be got wrong; handing pre-escaped strings is the shape that double-escapes half the
   * time and not at all the other half.
   */
  readonly title: string;
  /** The meta description and the OpenGraph description. RAW: this function escapes it. */
  readonly description: string;
  /** The body of `<main>`. ALREADY HTML: built by the page modules out of escaped pieces. */
  readonly main: string;
  /** `true` on a page that must never be indexed, which is every page carrying an invite token. */
  readonly noindex?: boolean;
};

/**
 * The whole document, and the only place `<html>` is written in this package.
 *
 * **No inline `<style>` and no `<script>` anywhere.** The stylesheet is a separate route so the
 * Content-Security-Policy can be `default-src 'none'; style-src 'self'` with no hash, no nonce and
 * no `unsafe-inline`. That is a stronger policy than an inline style block can have without
 * per-response hashing, and it costs one cacheable request.
 *
 * The consequence worth stating: **there is no JavaScript, so the page cannot try to open the app
 * for you.** Landing on `/join/:token` in a browser shows a button you tap. That is the honest
 * behaviour anyway - a script that redirects to `clubchat://` produces an OS error dialog for
 * every visitor who does not have the app, which is precisely the visitor this page exists for -
 * and when the app IS installed, iOS and Android open it from the universal link before this page
 * is ever fetched.
 */
export function page(options: PageOptions): string {
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(options.title)}</title>`,
    metaName('description', options.description),
    ...(options.noindex === true ? [metaName('robots', 'noindex, nofollow')] : []),
    metaProperty('og:type', 'website'),
    metaProperty('og:site_name', 'ClubChat'),
    metaProperty('og:title', options.title),
    metaProperty('og:description', options.description),
    '<link rel="stylesheet" href="/styles.css">',
  ].join('');

  return [
    '<!doctype html>',
    '<html lang="en">',
    `<head>${head}</head>`,
    '<body>',
    '<header class="masthead"><a class="wordmark" href="/">ClubChat</a></header>',
    `<main class="page">${options.main}</main>`,
    '<footer class="footer">',
    '<a href="/privacy">Privacy</a><a href="/terms">Terms</a>',
    '</footer>',
    '</body>',
    '</html>',
  ].join('');
}
