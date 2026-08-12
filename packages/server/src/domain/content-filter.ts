/**
 * The content filter: what a member may not post, and what a human should look at.
 *
 * > **This exists to satisfy App Store guideline 1.2's first bullet** - *"a method for filtering
 * > objectionable material from being posted to the app"* - which is the one requirement of the
 * > four that had no implementation. Reporting, blocking, acting on a report and published
 * > contact information all shipped earlier.
 *
 * ### What it filters, and why that is narrower than "bad words"
 *
 * Apple defines objectionable in guideline 1.1.1, and the definition is specific:
 *
 * > *Defamatory, discriminatory, or mean-spirited content, including references or commentary
 * > about religion, race, sexual orientation, gender, national/ethnic origin, or other targeted
 * > groups, particularly if the app is likely to humiliate, intimidate, or harm a targeted
 * > individual or group.*
 *
 * **That is hate speech, not profanity.** Nothing in the guideline asks anybody to block
 * swearing, and a filter that did would fire constantly in a university club chat while catching
 * none of the harm this one exists to catch. So profanity is deliberately allowed, and this
 * module's lists contain no ordinary swearing at all. ADR-0026 records the decision and the
 * rejected alternative.
 *
 * ### Two tiers, because certainty differs
 *
 * | Verdict | What happens | For |
 * |---|---|---|
 * | `refuse` | The send is rejected. Nothing is stored | Terms no context in this product makes acceptable |
 * | `flag` | The message posts normally, and a report is filed automatically | Terms whose meaning depends on who said them to whom |
 * | `allow` | Nothing happens | Everything else, which is almost everything |
 *
 * The second tier is the important one, and it is why this is not a blunt instrument. `kys`
 * between two friends after a bad 5k is not the same message as `kys` to somebody being pushed
 * out of a group, and no list can tell them apart. A human can, so it goes to the queue that
 * already exists rather than being guessed at here.
 *
 * ### What it deliberately does NOT do
 *
 * **It is not a safety system.** A term list catches slurs. It does not catch bullying,
 * exclusion, grooming, coordinated harassment or a threat phrased politely, and every one of
 * those is a likelier harm in a real club than a slur is. Those are caught by reporting,
 * blocking and the moderation queue, and this module must never be cited as covering them.
 *
 * **`rape` is not in either list, on purpose.** It is ordinary sports-banter hyperbole ("that
 * hill raped me") often enough that flagging it would bury the queue in noise, and a queue
 * nobody can read is worse than no queue. A real threat reaches a moderator by being reported,
 * which is the path that works for every threat phrased in words no list holds.
 *
 * **It reads the body and nothing else.** Not names, not images, not documents. An image
 * classifier is a different feature with a different cost, and claiming this covers pictures
 * would be a lie in the one direction that matters.
 *
 * ### Matching
 *
 * Two passes, because a member who wants to evade a list will space out the letters, and a
 * member who does not should never be caught by accident.
 *
 * 1. **Word-position**, over normalized text. Diacritics stripped and common leetspeak folded
 *    back, then each term matched at word boundaries. This is the pass that does the work.
 * 2. **Collapsed**, over letters only, for the subset of terms in {@link OBFUSCATION_SAFE}.
 *    `n i g g e r` and `n.i.g.g.3.r` both collapse onto the same string. Repeated letters are
 *    deliberately not squeezed - see {@link collapseForMatching} for the country name that
 *    rules it out.
 *
 * > **The second pass is opt-in per term, and that is load-bearing rather than cautious.**
 * > Collapsing throws away the boundaries the first pass depends on, so a term that appears
 * > inside any innocent word starts matching it: `coon` inside `raccoon`, `jap` inside `japan`.
 * > Only terms that are substrings of no ordinary English word may be listed there, and
 * > `content-filter.test.ts` holds a corpus of innocent words that proves it rather than
 * > trusting the judgement.
 *
 * This is the same lesson as `resolveMentions` in `send-message.ts`, one module over: a bare
 * `includes` cannot tell a word from the inside of another word, and the fix is about
 * positions rather than about a cleverer list.
 */

/** What the filter decided about a message body. */
export type FilterVerdict =
  | { action: 'allow' }
  /** Refuse the send. `term` is for the server log, and is never returned to the client. */
  | { action: 'refuse'; term: string }
  /** Store it, then file an automatic report. `term` is for the log. */
  | { action: 'flag'; term: string };

/**
 * Terms that are refused outright.
 *
 * The curation rule, so this list can be extended without drifting into a swear filter:
 * **a term belongs here only if there is no message in a sports club chat that could
 * legitimately contain it.** If somebody could plausibly say it without targeting anybody,
 * it belongs in {@link FLAG_TERMS} instead, where a person decides.
 *
 * Plural forms are listed explicitly rather than matched with a suffix pattern, because a
 * pattern that appends optional letters is how a list starts matching words nobody put in it.
 */
export const REFUSE_TERMS: readonly string[] = [
  // Racial and ethnic
  'nigger',
  'niggers',
  'sandnigger',
  'sandniggers',
  'gook',
  'gooks',
  'spic',
  'spics',
  'wetback',
  'wetbacks',
  'beaner',
  'beaners',
  'porch monkey',
  'porch monkeys',
  // Religious and national origin
  'kike',
  'kikes',
  'raghead',
  'ragheads',
  'towelhead',
  'towelheads',
  'mudslime',
  'mudslimes',
  // Sexual orientation and gender identity
  'faggot',
  'faggots',
  'tranny',
  'trannies',
  'shemale',
  'shemales',
  // Sexual content involving minors. Refused rather than flagged because there is no version
  // of this that a moderator should be asked to weigh, and no context that makes it a joke.
  'child porn',
  'childporn',
  'jailbait',
  'loli',
  'lolicon',
];

/**
 * Terms that post normally and file a report.
 *
 * Everything here is genuinely ambiguous, and the ambiguity is the reason it is not in
 * {@link REFUSE_TERMS}:
 *
 * - **`nigga`** is used in-group constantly and refusing it would be this design's own
 *   false-positive failure, aimed at exactly the members it exists to protect.
 * - **`chink`** is a real English noun. "A chink in the armour" is not a slur, and a word
 *   boundary cannot tell the two apart.
 * - **`coon`, `dyke`, `spaz`** are each an ordinary word or a surname somewhere.
 * - **`retard`, `retarded`** are casual insults in college speech far more often than they are
 *   aimed at a disabled person. Common enough that refusing them would train members to work
 *   around the filter, which is worse than seeing them.
 * - **the `kys` family** is the one that matters most and is hardest to judge: it is hyperbole
 *   between friends and a genuine push toward self-harm, in identical words.
 */
export const FLAG_TERMS: readonly string[] = [
  'nigga',
  'niggas',
  'chink',
  'chinks',
  'coon',
  'coons',
  'fag',
  'fags',
  'dyke',
  'dykes',
  'retard',
  'retards',
  'retarded',
  'spastic',
  'spaz',
  'kys',
  'kill yourself',
  'kill urself',
  'kill your self',
  'killyourself',
  'hang yourself',
  'hang urself',
  'neck yourself',
];

/**
 * Terms safe to match after collapsing the text to letters only.
 *
 * **Two rules, and both are load-bearing.**
 *
 * 1. **Refuse-tier terms only.** The collapsed pass returns `refuse`, so listing a
 *    {@link FLAG_TERMS} entry here would silently promote it past the human judgement the flag
 *    tier exists to preserve. Asserted in the test file rather than left to review.
 * 2. **A term qualifies only if it is a substring of no ordinary English word *and* falls out
 *    of no ordinary pair of words.** Collapsing throws the boundaries away, so both matter, and
 *    the second is the one that is easy to miss.
 *
 * The exclusions are more instructive than the inclusions, so they are recorded:
 *
 * | Excluded | Because |
 * |---|---|
 * | `coon` | inside `raccoon` |
 * | `fag` | inside `fagot` |
 * | `spic` | inside `auspicious` |
 * | `loli` | `hello liam` collapses onto it |
 * | `shemale` | `is she male or female` collapses onto it |
 * | `kike` | `Nikki Kern` collapses onto it |
 * | `wetback` | `my wet back hurts` collapses onto it, which a running club will genuinely say |
 * | `beaner`, `chink` | short enough that a pair of words reaches them the same way |
 *
 * Every one of those is in the innocent-word corpus in `content-filter.test.ts`, which is what
 * proves the judgement rather than restating it.
 */
export const OBFUSCATION_SAFE: readonly string[] = [
  'nigger',
  'sandnigger',
  'faggot',
  'raghead',
  'towelhead',
  'mudslime',
  'childporn',
  'jailbait',
];

/**
 * Leetspeak and lookalike substitutions, folded before matching.
 *
 * Deliberately short. Every additional mapping widens what an innocent message can be read as,
 * and the collapsed pass is where evasion is actually caught - this only has to handle the
 * casual case of somebody typing a `3` for an `e`.
 */
const LEET_DIGITS: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
};

/**
 * Symbol-for-letter substitutions. **Collapsed pass only.**
 *
 * > **Folding these before a boundary match silently breaks the match.** `!` is punctuation far
 * > more often than it is a stand-in for `i`, so folding it turns `you faggot!` into
 * > `you faggoti`, and `\bfaggot\b` then fails against the clearest possible slur. `@` and `$`
 * > do the same at the end of a word.
 * >
 * > A digit cannot do this, because a digit is already a word character - which is why
 * > {@link LEET_DIGITS} is safe in both passes and this is not. The collapsed pass has thrown
 * > its boundaries away already, so it has none left to lose.
 */
const LEET_SYMBOLS: Readonly<Record<string, string>> = {
  '@': 'a',
  $: 's',
  '!': 'i',
};

/**
 * Lowercase, strip diacritics, fold digit leetspeak.
 *
 * **Word boundaries survive**, which is the whole contract of this function and the reason
 * {@link LEET_SYMBOLS} is not applied here.
 *
 * NFKD splits an accented character into its base plus a combining mark, and the mark is then
 * dropped - so `nïgger` normalizes onto the term rather than sliding past it.
 */
export function normalizeForMatching(body: string): string {
  return body
    .normalize('NFKD')
    // Combining marks, now detached from the letters they were attached to.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[0134578]/g, (char) => LEET_DIGITS[char] ?? char);
}

/**
 * Reduce to letters only. Spacing, punctuation and digits go; nothing else changes.
 *
 * > **It deliberately does NOT squeeze repeated letters, and the reason is worth keeping.**
 * > Catching `niiiigger` needs runs squeezed to a single letter in the text *and* in the term,
 * > because the term carries a doubled `g` of its own. Squeezing that hard collapses `Nigeria`
 * > and the country `Niger` onto the same string as the slur, which would refuse a member for
 * > naming where they are from. That failure is far worse than the evasion it prevents, so
 * > letter-repetition evasion is knowingly not covered here. The plain spelling is still caught
 * > by the word-position pass, and anything this misses is what reporting is for.
 */
export function collapseForMatching(body: string): string {
  return (
    normalizeForMatching(body)
      // Safe only here, where there are no boundaries left to move. See LEET_SYMBOLS.
      .replace(/[@$!]/g, (char) => LEET_SYMBOLS[char] ?? char)
      .replace(/[^a-z]/g, '')
  );
}

/** `\b` around an escaped term, with runs of whitespace allowed inside a phrase. */
function termPattern(term: string): string {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+');
  return `\\b${escaped}\\b`;
}

function buildMatcher(terms: readonly string[]): RegExp {
  return new RegExp(terms.map(termPattern).join('|'), 'i');
}

// Built once at module load. Matching is a regex test per message and touches nothing outside
// this process, which is what lets the filter sit in the send path at all - see the channel-log
// invariant that the sequence-allocating transaction performs no I/O.
const REFUSE_MATCHER = buildMatcher(REFUSE_TERMS);
const FLAG_MATCHER = buildMatcher(FLAG_TERMS);
const OBFUSCATION_COLLAPSED: readonly string[] = OBFUSCATION_SAFE.map((term) =>
  term.replace(/[^a-z]/g, ''),
);

/**
 * Classify a message body.
 *
 * Pure, synchronous, and total: every input produces a verdict and nothing here can throw, so a
 * send can never fail because the filter did. Null and empty bodies are allowed without being
 * examined - a photo with no caption has nothing to read.
 *
 * **Refuse wins over flag.** A body carrying both is the worse of the two, and the ordering is
 * explicit rather than incidental so a later edit cannot silently reverse it.
 */
export function classifyContent(body: string | null | undefined): FilterVerdict {
  if (body === null || body === undefined || body.length === 0) return { action: 'allow' };

  const normalized = normalizeForMatching(body);

  const refused = REFUSE_MATCHER.exec(normalized);
  if (refused) return { action: 'refuse', term: refused[0].trim() };

  // Only after the boundary pass has cleared it, because the collapsed form is the lossy one
  // and a term found there is the weaker evidence of the two.
  const collapsed = collapseForMatching(body);
  const evaded = OBFUSCATION_COLLAPSED.find((term) => collapsed.includes(term));
  if (evaded) return { action: 'refuse', term: evaded };

  const flagged = FLAG_MATCHER.exec(normalized);
  if (flagged) return { action: 'flag', term: flagged[0].trim() };

  return { action: 'allow' };
}
