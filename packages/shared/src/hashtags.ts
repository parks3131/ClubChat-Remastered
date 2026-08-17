/**
 * The hashtags in a post's body, which are the only thing the news feed's search box reads
 * besides the title.
 *
 * **Pure, and in `shared` rather than on the server, for one reason: the composer has to draw
 * the same tags the server will store.** Somebody typing `#longRun` sees a `#longrun` chip
 * before they post, because the alternative is a composer that shows one thing and a card that
 * shows another, and the author never learns which of the two is real.
 *
 * ### What counts as a tag
 *
 * A `#` that begins a word, followed by letters, digits or underscores. Unicode letters count -
 * a club posting in Spanish tags `#carrera` and one posting in Greek tags in Greek, and a rule
 * that quietly worked only for ASCII would be a rule about English rather than about tags.
 *
 * **The `#` must begin a word**, which is what keeps `https://example.test/page#section` and
 * `C#` out of a club's tag vocabulary. A URL fragment is not a subject and neither is the tail
 * of a word somebody happened to write.
 */

/**
 * Longest tag we will store, matching the `news_post_tags_normalised` constraint.
 *
 * A tag longer than this is **dropped rather than truncated**. Truncating invents a tag nobody
 * typed and then indexes it, which is worse than ignoring a run of 200 characters that was
 * never going to be a search term.
 */
export const MAX_TAG_LENGTH = 64;

/**
 * The `(?<=...)` is why the `#` has to start a word: it must sit at the beginning of the string
 * or follow something that is not part of a word. Lookbehind rather than a captured prefix, so
 * two tags separated by a single space both match - a consuming prefix would eat the separator
 * that the second one needs.
 */
const TAG_PATTERN = /(?<![\p{L}\p{N}_/])#([\p{L}\p{N}_]+)/gu;

/**
 * Every distinct tag in `body`, lowercased, in the order they were first written.
 *
 * Order matters because it is the order the chips are drawn in, and "the order you wrote them"
 * is the only one that needs no explaining. Deduplicated, since a tag repeated in a sentence is
 * emphasis rather than a second tag.
 */
export function extractHashtags(body: string | null | undefined): string[] {
  if (!body) return [];

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const match of body.matchAll(TAG_PATTERN)) {
    const raw = match[1];
    if (raw === undefined) continue;

    // Lowercased BEFORE the length check and before dedupe, or `#Run` and `#run` would count as
    // two tags right up until the database refused the second one.
    const tag = raw.toLowerCase();
    if (tag.length > MAX_TAG_LENGTH) continue;
    if (seen.has(tag)) continue;

    seen.add(tag);
    tags.push(tag);
  }

  return tags;
}
