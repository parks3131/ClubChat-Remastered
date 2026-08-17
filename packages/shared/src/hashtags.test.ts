/**
 * Pulling the tags out of a post's body.
 *
 * These matter because a tag is a search key rather than decoration: getting one wrong does not
 * look broken, it just quietly files a post where nobody will look for it. The cases below are
 * the ones the database constraint also has an opinion about, so a disagreement between this
 * function and `news_post_tags_normalised` is a 500 rather than a bad search result.
 */

import { describe, expect, it } from 'vitest';
import { extractHashtags, MAX_TAG_LENGTH } from './hashtags.ts';

describe('what counts as a tag', () => {
  it('takes the tags out of a sentence, in the order they were written', () => {
    expect(extractHashtags('Six miles along the reflecting pool. #longrun #bingRC')).toEqual([
      'longrun',
      'bingrc',
    ]);
  });

  it('lowercases, so a club does not end up with two spellings of one tag', () => {
    expect(extractHashtags('#LongRun')).toEqual(['longrun']);
    // The pair that would otherwise be two tags and one constraint violation.
    expect(extractHashtags('#Run and #run')).toEqual(['run']);
  });

  it('takes a tag at the very start of the body', () => {
    expect(extractHashtags('#raceday was brutal')).toEqual(['raceday']);
  });

  it('stops at punctuation rather than swallowing it', () => {
    expect(extractHashtags('Great work, #bingRC! Next up: #5k.')).toEqual(['bingrc', '5k']);
  });

  it('allows digits and underscores', () => {
    expect(extractHashtags('#5k #half_marathon #2026')).toEqual(['5k', 'half_marathon', '2026']);
  });

  it('reads tags that are not written in English', () => {
    // A rule that worked only for ASCII would be a rule about English, not about tags.
    expect(extractHashtags('#carrera #Δρόμος')).toEqual(['carrera', 'δρόμος']);
  });

  it('deduplicates, because a repeated tag is emphasis rather than a second tag', () => {
    expect(extractHashtags('#longrun again and again #longrun')).toEqual(['longrun']);
  });

  it('keeps first-written order when it deduplicates', () => {
    expect(extractHashtags('#b #a #b')).toEqual(['b', 'a']);
  });
});

describe('what does not count', () => {
  it('ignores a URL fragment', () => {
    // The case that would otherwise tag every post carrying a link to a page anchor.
    expect(extractHashtags('Results here https://example.test/race#results')).toEqual([]);
  });

  it('ignores a hash in the middle of a word', () => {
    expect(extractHashtags('written in C#')).toEqual([]);
  });

  it('ignores a bare hash with nothing after it', () => {
    expect(extractHashtags('# ## #')).toEqual([]);
  });

  it('returns nothing for an empty or absent body', () => {
    expect(extractHashtags('')).toEqual([]);
    expect(extractHashtags(null)).toEqual([]);
    expect(extractHashtags(undefined)).toEqual([]);
  });

  it('drops an over-long tag rather than truncating it into one nobody typed', () => {
    const tooLong = 'a'.repeat(MAX_TAG_LENGTH + 1);
    expect(extractHashtags(`#${tooLong} #short`)).toEqual(['short']);
  });

  it('keeps a tag of exactly the maximum length, which the constraint also allows', () => {
    const exact = 'a'.repeat(MAX_TAG_LENGTH);
    expect(extractHashtags(`#${exact}`)).toEqual([exact]);
  });
});
