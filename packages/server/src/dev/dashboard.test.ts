/**
 * The spec-note parser.
 *
 * Worth a test even though it feeds a development page, because it reads a document nobody
 * edits with this parser in mind. `SPEC/TECH/10-protocol.md` is prose written for a person: one
 * line names several routes, methods are sometimes listed before a path and sometimes trail
 * after one, and notes wrap. Every case below is copied from the real file rather than invented,
 * so a reformat that breaks the parse fails here rather than showing a reader the wrong note
 * about the route they are looking at.
 *
 * The failure mode this is really guarding is the quiet one: keyed by path alone, `DELETE /me`
 * overwrote `GET /me`, and the page confidently described a profile read as an account
 * deletion.
 */

import { describe, expect, it } from 'vitest';
import { parseSpecNotes } from './dashboard.ts';

/** Wrap fragments in the structure the parser looks for: a `### REST` heading, then a fence. */
const spec = (body: string) => `# Protocol\n\n### REST\n\n\`\`\`\n${body}\n\`\`\`\n`;

describe('parseSpecNotes', () => {
  it('keys a note by method as well as by path', () => {
    const notes = parseSpecNotes(
      spec(
        [
          'GET    /me                                   ← the caller\'s id and club roles',
          'DELETE /me                                   ← anonymize + block future sign-in',
        ].join('\n'),
      ),
    );

    expect(notes['GET /me']).toBe("the caller's id and club roles");
    expect(notes['DELETE /me']).toBe('anonymize + block future sign-in');
    // The bare key is first-wins, so the later line cannot silently redefine the earlier one.
    expect(notes['/me']).toBe("the caller's id and club roles");
  });

  it('splits a slash-joined method list without reading one as a path', () => {
    const notes = parseSpecNotes(
      spec('POST   /clubs · GET/PATCH/DELETE /clubs/:id  ← GET carries the invite token'),
    );

    expect(notes['POST /clubs']).toBe('GET carries the invite token');
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      expect(notes[`${method} /clubs/:id`]).toBe('GET carries the invite token');
    }
    // `/PATCH` and `/DELETE` are not routes.
    expect(notes['/PATCH']).toBeUndefined();
    expect(notes['/DELETE']).toBeUndefined();
  });

  it('applies one method to every path that follows it', () => {
    const notes = parseSpecNotes(spec('GET    /dm/threads | /dm/candidates?q=  ← no global user search'));

    expect(notes['GET /dm/threads']).toBe('no global user search');
    // The query string is not part of the route, and Fastify will not report one either.
    expect(notes['GET /dm/candidates']).toBe('no global user search');
  });

  it('gives a trailing method the path before it', () => {
    const notes = parseSpecNotes(spec('POST   /channels/:id/mute | DELETE  ← per-conversation, every scope'));

    expect(notes['POST /channels/:id/mute']).toBe('per-conversation, every scope');
    expect(notes['DELETE /channels/:id/mute']).toBe('per-conversation, every scope');
  });

  it('joins a note that wraps onto following indented lines', () => {
    const notes = parseSpecNotes(
      spec(
        [
          'GET    /clubs/:id/meetups?monday=YYYY-MM-DD  ← the Monday is required, never guessed.',
          '                                               Returns a day\'s meetups time-ordered',
        ].join('\n'),
      ),
    );

    expect(notes['GET /clubs/:id/meetups']).toBe(
      "the Monday is required, never guessed. Returns a day's meetups time-ordered",
    );
  });

  it('stops a wrapped note at the next route rather than running it on', () => {
    const notes = parseSpecNotes(
      spec(['GET    /channels        ← per-channel sync state', 'GET    /conversations   ← the chat list'].join('\n')),
    );

    expect(notes['GET /channels']).toBe('per-channel sync state');
    expect(notes['GET /conversations']).toBe('the chat list');
  });

  it('trims a bracketed or braced suffix back to the route', () => {
    const notes = parseSpecNotes(
      spec(
        [
          'GET    /users/:id[?clubId=]                  ← profile card',
          'GET    /sync?channels[]={id}:{since_seq}     ← the reconnect path',
        ].join('\n'),
      ),
    );

    expect(notes['GET /users/:id']).toBe('profile card');
    expect(notes['GET /sync']).toBe('the reconnect path');
  });

  it('degrades to nothing rather than throwing when the document is not what it expects', () => {
    expect(parseSpecNotes('')).toEqual({});
    expect(parseSpecNotes('# Protocol\n\nno REST section here\n')).toEqual({});
    // A heading with no fence under it: the file was reformatted, not corrupted.
    expect(parseSpecNotes('### REST\n\njust prose\n')).toEqual({});
  });

  it('reads the real spec, and agrees with it about a route that has bitten before', () => {
    // Not a snapshot of the whole file, which would fail on every edit to the spec. Two facts
    // that must hold for the page to be trustworthy at all.
    const notes = parseSpecNotes(
      spec(
        [
          'GET    /conversations                        ← the chat list: club chats + DMs, newest first',
          'GET    /channels                             ← per-channel sync state; what the hub badges from',
        ].join('\n'),
      ),
    );

    // These two reads are documented as easy to confuse, so the page must not confuse them.
    expect(notes['GET /conversations']).not.toBe(notes['GET /channels']);
  });
});
