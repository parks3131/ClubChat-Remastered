/**
 * Tests for the content filter.
 *
 * **Both directions, and the second one is the point.** A filter that refuses everything passes
 * every test that only checks slurs are caught, so the corpus of innocent messages below carries
 * more weight here than the term lists do. Each entry in it is a real class of false positive:
 * the Scunthorpe family, a word that contains a slur, a pair of words that collapse onto one,
 * and ordinary swearing - which this product deliberately allows.
 *
 * The term lists are swept by iteration rather than by hand-picked examples, so a term added to
 * a list without a matching pattern cannot ship silently.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyContent,
  collapseForMatching,
  normalizeForMatching,
  FLAG_TERMS,
  OBFUSCATION_SAFE,
  REFUSE_TERMS,
} from './content-filter.ts';

describe('classifyContent', () => {
  describe('the lists do what they say', () => {
    it.each([...REFUSE_TERMS])('refuses %s', (term) => {
      expect(classifyContent(`what a ${term} thing to say`).action).toBe('refuse');
    });

    it.each([...FLAG_TERMS])('flags %s', (term) => {
      expect(classifyContent(`what a ${term} thing to say`).action).toBe('flag');
    });

    /**
     * The collapsed pass returns `refuse`, so a flag-tier term listed as obfuscation-safe would
     * be silently promoted past the human judgement the flag tier exists to preserve. Asserted
     * rather than left to review, because the two lists are far apart in the file.
     */
    it('lists only refuse-tier terms as obfuscation-safe', () => {
      const refusable = new Set(REFUSE_TERMS.map((term) => term.replace(/[^a-z]/g, '')));
      for (const term of OBFUSCATION_SAFE) {
        expect(refusable.has(term)).toBe(true);
      }
    });
  });

  describe('innocent messages are left alone', () => {
    /**
     * Every entry is a class of false positive rather than a random sentence.
     *
     * The pairs at the end are the ones that justify {@link OBFUSCATION_SAFE} being a subset:
     * each collapses onto a term that is deliberately NOT in it, and each would be refused if
     * the exclusions in that list were relaxed.
     */
    const INNOCENT = [
      // The Scunthorpe family: an innocent word containing a rude substring.
      'Scunthorpe',
      'we drove through Scunthorpe on the way',
      'assassin',
      'a classic negative split',
      'the analysis says we went out too fast',
      'shuttlecock',
      'Penistone Ferry Bridge',
      // An innocent word containing a listed term.
      'raccoon',
      'a raccoon got into the bins',
      'auspicious start to the season',
      'a fagot of kindling',
      'Lolita is on the reading list',
      'melancholic after that race',
      'Nigeria',
      'she is running for Niger this year',
      // Word pairs that collapse onto an excluded term.
      'hello Liam, good run today',
      'is she male or female in the results?',
      'my wet back hurts after that downpour',
      'Nikki Kern is joining us',
      // Ordinary club chat, including swearing, which is allowed on purpose. See ADR-0026.
      'great run today everyone',
      'that hill workout was fucking brutal',
      'shit, I forgot my spikes',
      'damn that was a hard 5k',
      'the 10k is at 8:30, meet at 7:45',
      '',
    ];

    it.each(INNOCENT)('allows %j', (body) => {
      expect(classifyContent(body).action).toBe('allow');
    });

    it('allows a null or absent body', () => {
      expect(classifyContent(null).action).toBe('allow');
      expect(classifyContent(undefined).action).toBe('allow');
    });

    /**
     * **The accepted cost of the flag tier, stated as a test.**
     *
     * `chink` is an ordinary English noun and a slur, and no boundary rule separates them - so
     * the idiom files a report that a moderator dismisses in one tap. That is the trade the two
     * tiers exist to make: the message still posts, nobody is refused mid-sentence, and the only
     * cost lands on somebody who signed up to look at a queue.
     *
     * Asserted so that "it flags the armour idiom" reads as a decision rather than as a bug
     * somebody later fixes by deleting the term.
     */
    it('flags rather than refuses an idiom that shares a word with a slur', () => {
      expect(classifyContent('a chink in the armour on the last hill').action).toBe('flag');
    });
  });

  describe('evasion', () => {
    it('catches letters spaced or punctuated apart', () => {
      expect(classifyContent('n i g g e r').action).toBe('refuse');
      expect(classifyContent('n.i.g.g.e.r').action).toBe('refuse');
      expect(classifyContent('f-a-g-g-o-t').action).toBe('refuse');
    });

    it('catches digit leetspeak at a word boundary', () => {
      expect(classifyContent('you n1gg3r').action).toBe('refuse');
      expect(classifyContent('f4gg0t').action).toBe('refuse');
    });

    it('catches symbol leetspeak through the collapsed pass', () => {
      expect(classifyContent('f@ggot').action).toBe('refuse');
    });

    it('catches diacritics', () => {
      expect(classifyContent('nïgger').action).toBe('refuse');
    });

    /**
     * The known hole, asserted so it is a decision rather than a surprise. Squeezing repeated
     * letters hard enough to catch this collapses `Nigeria` onto the slur - see
     * `collapseForMatching`, which explains why that trade was refused.
     */
    it('does NOT catch repeated-letter padding, knowingly', () => {
      expect(classifyContent('niiiigger').action).toBe('allow');
    });
  });

  describe('precedence and shape', () => {
    it('refuses when a body carries both a refuse and a flag term', () => {
      const verdict = classifyContent('you faggot retard');
      expect(verdict.action).toBe('refuse');
    });

    it('matches a slur followed by punctuation', () => {
      // The boundary pass must survive a trailing `!`, which an earlier version folded to `i`
      // and thereby broke.
      expect(classifyContent('you faggot!').action).toBe('refuse');
      expect(classifyContent('kill yourself!').action).toBe('flag');
    });

    it('matches a multi-word term across any run of whitespace', () => {
      expect(classifyContent('just kill  yourself').action).toBe('flag');
      expect(classifyContent('porch   monkey').action).toBe('refuse');
    });

    it('reports the term it matched, for the log', () => {
      const verdict = classifyContent('you faggot');
      expect(verdict.action).toBe('refuse');
      if (verdict.action === 'refuse') expect(verdict.term).toBe('faggot');
    });

    it('is case insensitive', () => {
      expect(classifyContent('YOU FAGGOT').action).toBe('refuse');
      expect(classifyContent('Retard').action).toBe('flag');
    });
  });

  describe('the normalizers', () => {
    it('folds case, diacritics and digits without moving boundaries', () => {
      expect(normalizeForMatching('Níce 5k')).toBe('nice sk');
      // Punctuation survives, which is what keeps `\b` meaningful.
      expect(normalizeForMatching('faggot!')).toBe('faggot!');
    });

    it('collapses to letters only', () => {
      expect(collapseForMatching('n i g.g-e_r')).toBe('nigger');
      expect(collapseForMatching('f@ggot')).toBe('faggot');
    });
  });
});
