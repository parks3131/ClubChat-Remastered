/**
 * The `@` rules, which are all edge case.
 *
 * Names contain spaces here - members are real people with real names, not usernames - so none of
 * the usual token-based shortcuts apply. These tests exist for the cases that are easy to get
 * wrong and invisible when they are: a name that is a prefix of another name, an email address,
 * a name typed and then deleted again.
 */

import { describe, expect, it } from 'vitest';
import {
  activeMentionQuery,
  applyMention,
  matchMentionables,
  mentionIdsInBody,
  splitMentions,
} from './mentions.ts';

const SEAN = { userId: 'u-sean', name: 'Sean O Donnell', image: null };
const SEANNA = { userId: 'u-seanna', name: 'Seanna Wright', image: null };
const MARC = { userId: 'u-marc', name: 'Marc Lucasey', image: null };
const MEMBERS = [SEAN, SEANNA, MARC];

describe('finding the mention being typed', () => {
  it('opens on a bare @, so the list appears immediately', () => {
    expect(activeMentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeMentionQuery('hey @', 5)).toEqual({ start: 4, query: '' });
  });

  it('keeps matching across a space, because names have spaces in them', () => {
    // The single reason this cannot be a word-token search.
    expect(activeMentionQuery('hey @Sean O', 11)).toEqual({ start: 4, query: 'Sean O' });
  });

  it('ignores an @ inside a word, so an email address does not open the list', () => {
    expect(activeMentionQuery('mail me at sean@club.com', 24)).toBeNull();
  });

  it('stops at a newline, since a mention does not span lines', () => {
    expect(activeMentionQuery('@Sean\nnext line', 15)).toBeNull();
  });

  it('gives up once the query is implausibly long', () => {
    // Otherwise one stray '@' keeps the list open over the whole rest of the message.
    const long = `@${'x'.repeat(40)}`;
    expect(activeMentionQuery(long, long.length)).toBeNull();
  });

  it('reads from the caret, not the end of the text', () => {
    const text = 'hey @Se and then more words';
    expect(activeMentionQuery(text, 7)).toEqual({ start: 4, query: 'Se' });
  });
});

describe('matching names', () => {
  it('offers everybody for an empty query', () => {
    expect(matchMentionables(MEMBERS, '')).toHaveLength(3);
  });

  it('matches on any part of the name, so a surname works', () => {
    expect(matchMentionables(MEMBERS, 'don').map((m) => m.userId)).toEqual(['u-sean']);
    expect(matchMentionables(MEMBERS, 'luc').map((m) => m.userId)).toEqual(['u-marc']);
  });

  it('does not match mid-word, which would make the list noise', () => {
    expect(matchMentionables(MEMBERS, 'onnell')).toHaveLength(0);
  });

  it('is case-insensitive while typing', () => {
    expect(matchMentionables(MEMBERS, 'SEAN').map((m) => m.userId)).toEqual([
      'u-sean',
      'u-seanna',
    ]);
  });
});

describe('inserting a name', () => {
  it('replaces the partial query and leaves the caret past a trailing space', () => {
    const result = applyMention('hey @Se', 4, 7, SEAN);
    expect(result.text).toBe('hey @Sean O Donnell ');
    expect(result.caret).toBe(result.text.length);
  });

  it('keeps whatever followed the caret', () => {
    const result = applyMention('hey @Se are you in?', 4, 7, SEAN);
    expect(result.text).toBe('hey @Sean O Donnell  are you in?');
  });
});

describe('deciding what to claim on send', () => {
  it('claims a name still present in the text', () => {
    expect(mentionIdsInBody([SEAN], '@Sean O Donnell are you in?')).toEqual(['u-sean']);
  });

  /** The realistic path: picked from the list, then edited out again before sending. */
  it('drops a name the sender deleted before sending', () => {
    expect(mentionIdsInBody([SEAN], 'are you in?')).toEqual([]);
  });

  it('drops a partially deleted name rather than claiming it', () => {
    expect(mentionIdsInBody([SEAN], '@Sean O are you in?')).toEqual([]);
  });

  it('claims one mention when a name is typed twice', () => {
    expect(mentionIdsInBody([SEAN, SEAN], '@Sean O Donnell and @Sean O Donnell')).toEqual([
      'u-sean',
    ]);
  });
});

describe('splitting a body for rendering', () => {
  it('returns the body untouched when nobody is mentioned', () => {
    expect(splitMentions('just a message', [])).toEqual([{ text: 'just a message', userId: null }]);
  });

  it('marks the mention and leaves the rest plain', () => {
    expect(splitMentions('hi @Marc Lucasey ok', [MARC])).toEqual([
      { text: 'hi ', userId: null },
      { text: '@Marc Lucasey', userId: 'u-marc' },
      { text: ' ok', userId: null },
    ]);
  });

  /**
   * > **The case that silently mangles a name.** "Sean O Donnell" starts with "Sean", so a
   * > shortest-first scan highlights only "@Sean" and leaves " O Donnell" as plain text hanging
   * > off the end of a link.
   */
  it('prefers the longer name when one is a prefix of the other', () => {
    const seanShort = { userId: 'u-short', name: 'Sean' };
    const runs = splitMentions('@Sean O Donnell here', [seanShort, SEAN]);
    expect(runs[0]).toEqual({ text: '@Sean O Donnell', userId: 'u-sean' });
  });

  it('marks two different people in one message', () => {
    const runs = splitMentions('@Marc Lucasey and @Seanna Wright', [MARC, SEANNA]);
    expect(runs.filter((r) => r.userId !== null).map((r) => r.userId)).toEqual([
      'u-marc',
      'u-seanna',
    ]);
  });

  it('leaves a name that is not in the mention list as plain text', () => {
    // Nobody can make arbitrary text highlight by typing an @ in front of it.
    expect(splitMentions('@Nobody At All', [MARC])).toEqual([
      { text: '@Nobody At All', userId: null },
    ]);
  });
});
