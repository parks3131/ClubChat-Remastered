/**
 * The `@` mention rules, as pure functions.
 *
 * Kept out of the chat screen so they can be tested without a composer, a keyboard or a device.
 * Everything here is string handling; nothing touches React or the network.
 *
 * **Names contain spaces**, which is what makes this more than a regex. A member is `Sean O
 * Donnell`, not `sean`, so a mention is not a token the way it is in Slack or GitHub - it cannot
 * be found by splitting on whitespace, and the query the user is typing may itself span spaces.
 */

/** A person the composer can offer. */
export type Mentionable = { userId: string; name: string; image: string | null };

/** Somebody the composer has already inserted, remembered until the message is sent. */
export type MentionPick = { userId: string; name: string };

/**
 * How far back a partial name may reach.
 *
 * The query runs from the `@` to the caret and may contain spaces, so without a bound every
 * `@` ever typed would keep matching against the entire rest of the message. Long enough for
 * "Sean O Donnell", short enough that an `@` in prose stops offering a list after a few words.
 */
const MAX_QUERY_LENGTH = 32;

/**
 * The mention being typed at the caret, or null.
 *
 * Returns the `@` position and the text between it and the caret. The `@` only counts at the
 * **start of a word** - preceded by nothing or by whitespace - so an email address never opens
 * the list, which is the single most common false positive.
 *
 * A newline ends a query: a mention does not span lines.
 */
export function activeMentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const upToCaret = text.slice(0, caret);
  const at = upToCaret.lastIndexOf('@');
  if (at === -1) return null;

  const before = at === 0 ? '' : upToCaret[at - 1]!;
  if (before !== '' && !/\s/.test(before)) return null;

  const query = upToCaret.slice(at + 1);
  if (query.length > MAX_QUERY_LENGTH) return null;
  if (query.includes('\n')) return null;

  return { start: at, query };
}

/**
 * The people worth offering for a query, best first.
 *
 * An empty query offers everybody, which is what makes the list appear the instant `@` is typed.
 * A name matches if the query appears at the start of the whole name or of any of its parts, so
 * "don" finds "Sean O Donnell" by his surname without "don" also matching somebody with "don"
 * buried mid-word.
 */
export function matchMentionables(
  members: readonly Mentionable[],
  query: string,
): Mentionable[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...members];

  return members.filter((member) => {
    const name = member.name.toLowerCase();
    if (name.startsWith(needle)) return true;
    return name.split(/\s+/).some((part) => part.startsWith(needle));
  });
}

/**
 * Insert a chosen name, replacing the partial query.
 *
 * Returns the new text and where the caret should land - after the trailing space, so typing
 * simply continues. The trailing space also means the next character cannot accidentally extend
 * the name and stop it matching the body check on send.
 */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  member: Mentionable,
): { text: string; caret: number } {
  const inserted = `@${member.name} `;
  const next = text.slice(0, start) + inserted + text.slice(caret);
  return { text: next, caret: start + inserted.length };
}

/**
 * The user ids to claim as mentions for this body.
 *
 * > **Filtered against the final text, not against what was picked.** Somebody chooses a name
 * > from the list and then deletes it again before sending; claiming the mention anyway notifies
 * > a person about a message that does not contain their name, which no wording explains away.
 *
 * The server applies exactly this rule again on arrival and is the real enforcement - it has to
 * be, since a request can claim anything. Doing it here too means the common case never reaches
 * the server as a lie, and the two rules are written the same way on purpose.
 *
 * Deduplicated: naming somebody twice in one message is one mention and one notification.
 */
export function mentionIdsInBody(picks: readonly MentionPick[], body: string): string[] {
  const present = picks.filter((pick) => body.includes(`@${pick.name}`));
  return [...new Set(present.map((pick) => pick.userId))];
}

/**
 * Split a body into plain runs and mention runs, for rendering.
 *
 * Longest name first, so that when one name is a prefix of another - "Sean" and "Sean O Donnell"
 * both in the same club - the longer one wins the span rather than being cut short by the
 * shorter. Each match is then excluded from further scanning so a name inside an already-matched
 * mention cannot match again.
 *
 * Returns plain text unchanged when nothing is mentioned, which is the overwhelming majority of
 * messages and costs one early return.
 */
export function splitMentions(
  body: string,
  mentions: readonly MentionPick[],
): Array<{ text: string; userId: string | null }> {
  if (mentions.length === 0 || body.length === 0) return [{ text: body, userId: null }];

  const byLongest = [...mentions].sort((a, b) => b.name.length - a.name.length);
  // Which characters belong to which mention. Null means plain text.
  const owner: Array<string | null> = new Array(body.length).fill(null);

  for (const mention of byLongest) {
    const token = `@${mention.name}`;
    let from = 0;
    for (;;) {
      const found = body.indexOf(token, from);
      if (found === -1) break;
      // Skip a match overlapping one already claimed by a longer name.
      let free = true;
      for (let i = found; i < found + token.length; i += 1) {
        if (owner[i] !== null) {
          free = false;
          break;
        }
      }
      if (free) {
        for (let i = found; i < found + token.length; i += 1) owner[i] = mention.userId;
      }
      from = found + token.length;
    }
  }

  const runs: Array<{ text: string; userId: string | null }> = [];
  let index = 0;
  while (index < body.length) {
    const current = owner[index] ?? null;
    let end = index;
    while (end < body.length && (owner[end] ?? null) === current) end += 1;
    runs.push({ text: body.slice(index, end), userId: current });
    index = end;
  }
  return runs;
}
