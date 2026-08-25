/**
 * Markdown to HTML, for the two legal documents and nothing else.
 *
 * ## Why this is hand-written rather than a dependency
 *
 * The repo has no markdown renderer, no HTML templating engine and no `escapeHtml` anywhere - the
 * one `.html` file in the tree is the dev dashboard, read off disk and written to the socket
 * unrendered. So this is genuinely new, and the choice was between pulling in `marked` or
 * `markdown-it` and writing the subset.
 *
 * The subset won, on the criteria AGENTS.md 0.3 sets rather than on effort. A general renderer is
 * built to accept arbitrary internet markdown, which means it accepts raw HTML by default and its
 * safety then rests on a sanitiser being configured correctly and staying configured through
 * upgrades. This renderer's input is two files in this repo, written by us, changing perhaps twice
 * a year, and it runs on a hostname that serves the two app-association files. **It escapes first
 * and interprets a fixed grammar second, so there is no configuration that turns HTML back on and
 * no upgrade that can change that.**
 *
 * ## The supported grammar, in full
 *
 * Anything not on this list renders as the literal text it is. That is a deliberate failure mode -
 * visibly wrong on the page rather than silently dropped - and it is why the list is written down
 * here and repeated in `README.md` for whoever writes the legal text.
 *
 *  - `#` through `######` headings
 *  - paragraphs, separated by a blank line
 *  - `-`, `*` or `+` bullet lists, and `1.` or `1)` numbered lists
 *  - `>` blockquotes, which may contain any of the above
 *  - `---`, `***` or `___` horizontal rules
 *  - fenced code blocks with three or more backticks or tildes
 *  - GFM pipe tables, with the header row, the delimiter row, and any number of body rows
 *  - inline: `` `code` ``, `**bold**`, `*italic*`, `_italic_`, `[text](url)`
 *
 * NOT supported, and each renders as its literal characters: raw HTML, reference-style links,
 * images, footnotes, task lists, nested lists, setext headings, autolinks, HTML entities.
 * **Write plain characters rather than entities** - `&` rather than `&amp;` - because this renderer
 * treats the source as text and would print `&amp;` on the page.
 *
 * ## The ordering that makes it safe
 *
 * Every line is HTML-escaped BEFORE any pattern is matched against it, and every tag this file
 * emits is a literal in this file. There is therefore no path by which a character in the source
 * becomes part of a tag. The one place source text reaches an attribute is a link's `href`, and
 * that goes through `safeHref` on top of the escaping - see the note there on why escaping first
 * defeats an entity-encoded `javascript:`.
 */

import { escapeHtml, safeHref } from './html.ts';

/**
 * The placeholder that protects a code span from the inline passes that follow it.
 *
 * NUL, because the source is stripped of it first, so a placeholder can never collide with real
 * text. A visible sentinel such as `@@CODE0@@` can appear in a document that talks about
 * sentinels, and a legal document about data handling is exactly the kind of document that might.
 */
const CODE_PLACEHOLDER = '\u0000';

const HEADING = /^(#{1,6})\s+(.*)$/;
const HORIZONTAL_RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET_ITEM = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED_ITEM = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const BLOCKQUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*\S*\s*$/;
/** The `| --- | --- |` row. It is what distinguishes a table from a paragraph containing pipes. */
const TABLE_DELIMITER = /^\s{0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** Every construct that ends a paragraph by starting something else. */
function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    HORIZONTAL_RULE.test(line) ||
    BULLET_ITEM.test(line) ||
    NUMBERED_ITEM.test(line) ||
    BLOCKQUOTE.test(line) ||
    FENCE.test(line)
  );
}

/**
 * Inline formatting, applied to text that is ALREADY HTML-escaped.
 *
 * Code spans are lifted out first and replaced by a placeholder, so that `` `**not bold**` ``
 * renders as the literal asterisks a reader of a legal document would expect from backticks.
 * Everything else runs on the remaining text and is then reunited with the code spans.
 */
function inline(escaped: string): string {
  const codeSpans: string[] = [];
  const withPlaceholders = escaped.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return CODE_PLACEHOLDER;
  });

  const formatted = withPlaceholders
    // Links before emphasis, so `[**text**](url)` puts the emphasis inside the anchor rather than
    // leaving a stray `<strong>` wrapped around half of it.
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (match, text: string, url: string) => {
      const href = safeHref(url);
      // A link this renderer will not vouch for keeps its text and loses its destination. Dropping
      // the whole thing would silently remove a sentence from a legal document; keeping the href
      // would be the vulnerability. Showing the words without the link is the honest third option.
      return href === null ? text : `<a href="${href}">${text}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '<em>$1</em>')
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '<em>$1</em>');

  let index = 0;
  return formatted.replace(/\u0000/g, () => codeSpans[index++] ?? '');
}

/** One table row's cells, from `| a | b |` or from `a | b`. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * The block parser.
 *
 * Recursive on one construct only, the blockquote, because a blockquote is the one block whose
 * contents are themselves blocks. Lists are deliberately flat: a nested list renders as its
 * literal `- ` text, which is the documented gap rather than a silent mis-render.
 */
function renderBlocks(lines: readonly string[]): string {
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(marker)) {
        body.push(escapeHtml(lines[index] ?? ''));
        index += 1;
      }
      // An unterminated fence consumes the rest of the document rather than throwing. The document
      // is in this repo, so a missing closing fence is a visible block of monospace on the page and
      // an obvious thing to fix, where a thrown error would be a 500 on the privacy policy.
      index += 1;
      out.push(`<pre><code>${body.join('\n')}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '#').length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2] ?? ''))}</h${level}>`);
      index += 1;
      continue;
    }

    if (HORIZONTAL_RULE.test(line)) {
      out.push('<hr>');
      index += 1;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = BLOCKQUOTE.exec(lines[index] ?? '');
        if (match === null) break;
        quoted.push(match[1] ?? '');
        index += 1;
      }
      out.push(`<blockquote>${renderBlocks(quoted)}</blockquote>`);
      continue;
    }

    // A table is a line with a pipe in it whose NEXT line is a delimiter row. Testing the next line
    // is what keeps an ordinary sentence containing a pipe from becoming a one-cell table.
    const next = lines[index + 1];
    if (line.includes('|') && next !== undefined && TABLE_DELIMITER.test(next)) {
      const headers = tableCells(line)
        .map((cell) => `<th>${inline(escapeHtml(cell))}</th>`)
        .join('');
      index += 2;
      const rows: string[] = [];
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        const cells = tableCells(lines[index] ?? '')
          .map((cell) => `<td>${inline(escapeHtml(cell))}</td>`)
          .join('');
        rows.push(`<tr>${cells}</tr>`);
        index += 1;
      }
      out.push(
        `<table><thead><tr>${headers}</tr></thead><tbody>${rows.join('')}</tbody></table>`,
      );
      continue;
    }

    const bullet = BULLET_ITEM.exec(line);
    const numbered = NUMBERED_ITEM.exec(line);
    if (bullet !== null || numbered !== null) {
      const ordered = bullet === null;
      const pattern = ordered ? NUMBERED_ITEM : BULLET_ITEM;
      const items: string[] = [];
      while (index < lines.length) {
        const match = pattern.exec(lines[index] ?? '');
        if (match === null) break;
        // A continuation line is any non-blank line that does not itself start a block. It is
        // joined with a space, which is what a markdown reader expects from a wrapped bullet.
        const parts = [match[1] ?? ''];
        index += 1;
        while (index < lines.length) {
          const continuation = lines[index] ?? '';
          if (continuation.trim() === '' || startsBlock(continuation)) break;
          parts.push(continuation.trim());
          index += 1;
        }
        items.push(`<li>${inline(escapeHtml(parts.join(' ')))}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '') break;
      if (paragraph.length > 0 && startsBlock(current)) break;
      paragraph.push(current.trim());
      index += 1;
    }
    out.push(`<p>${inline(escapeHtml(paragraph.join(' ')))}</p>`);
  }

  return out.join('');
}

/** Line endings normalised, and NUL removed so the code-span placeholder cannot be forged. */
function normalise(source: string): string[] {
  return source.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n');
}

/** The document, as HTML. */
export function renderMarkdown(source: string): string {
  return renderBlocks(normalise(source));
}

/**
 * The document's first `#` heading, for the `<title>` and the OpenGraph title.
 *
 * Returned RAW rather than escaped, because `page()` in `html.ts` escapes everything it is handed
 * and a pre-escaped title would come out double-escaped. Null when the document has no `#`
 * heading, which the caller answers with a fallback rather than an empty `<title>`.
 */
export function markdownTitle(source: string): string | null {
  for (const line of normalise(source)) {
    const heading = HEADING.exec(line);
    if (heading !== null && (heading[1] ?? '').length === 1) {
      const text = (heading[2] ?? '').trim();
      if (text.length > 0) return text;
    }
  }
  return null;
}
