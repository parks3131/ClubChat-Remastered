/**
 * Editing a message: the five-minute window, and what it deliberately cannot reach.
 *
 * `PRD/05` rule 9a and ADR-0033. The feature is one column and one command, so these tests are
 * shaped around the things that have an easy way to look correct while being wrong:
 *
 *  - **The window is enforced on the server**, not by the client hiding a pencil. A deadline that
 *    lives only in the UI is not a deadline, and it is the half a modified client skips first.
 *  - **An admin cannot edit somebody else's message.** This is the asymmetry against
 *    `canDeleteMessage`, which DOES grant the admin tier a second path. Deleting somebody's words
 *    is moderation; replacing them is forgery, so the two predicates part company here on purpose
 *    and the only way to prove it stayed parted is to attempt it.
 *  - **The command changes exactly one column.** `type`, `pinned` and `seq` are not in its `SET`,
 *    and the reason is the v1 defect the pin route's comment records: a member who could carry a
 *    second column along with their own edit could retro-flip their message into an announcement
 *    and notify the entire club.
 *  - **The content filter runs on the edit too.** Otherwise the window is a hole straight through
 *    it - post something harmless, then edit it into what the filter would have refused.
 *  - **`rev` advances**, which is what carries the correction to a device that was offline when it
 *    happened. Sync pulls on `rev`, so an edit that did not bump it would reach only the clients
 *    that were connected - the same hole the tombstone had, and asserted here through `syncSince`
 *    rather than by reading the column.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { MESSAGE_EDIT_WINDOW_MS } from '@clubchat/shared';
import { createClub } from '../domain/create-club.ts';
import { addMember, changeRole } from '../domain/membership.ts';
import { FLAG_TERMS, REFUSE_TERMS } from '../domain/content-filter.ts';
import { editMessage, sendMessage, softDeleteMessage } from '../domain/send-message.ts';
import { getChannelRef, readHistory, syncSince } from '../domain/reads.ts';
import { loadAccessContext } from '../policy/context.ts';
import { messageMentions, messageReports, messages, outbox, users } from '../db/schema.ts';
import { anyViewer, startTestDb, type TestDb } from './harness.ts';
import type { ChannelRef } from '../policy/predicates.ts';

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
}, 120_000);
afterAll(async () => {
  await h?.stop();
});

const ctxFor = (id: string) => loadAccessContext(h.db, id);

async function makeUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await h.db.insert(users).values({ id, name, email: `${name}-${id.slice(0, 8)}@t.invalid` });
  return id;
}

async function say(
  userId: string,
  channel: ChannelRef,
  body: string | null,
  extra: { type?: 'text' | 'announcement'; mentions?: string[] } = {},
) {
  const result = await sendMessage(h.db, await ctxFor(userId), channel, {
    channelId: channel.id,
    clientMsgId: crypto.randomUUID(),
    body,
    ...extra,
  });
  if (!result.ok) throw new Error(`send refused: ${result.code}`);
  return result.message;
}

type Fixture = {
  channel: ChannelRef;
  ownerId: string;
  memberId: string;
  adminId: string;
};

async function setup(): Promise<Fixture> {
  const ownerId = await makeUser('Owner');
  const memberId = await makeUser('Member');
  const adminId = await makeUser('Admin');
  const club = await createClub(h.db, { name: 'Hillside', sport: 'running', creatorId: ownerId });
  await addMember(h.db, await ctxFor(ownerId), club.clubId, memberId);
  await addMember(h.db, await ctxFor(ownerId), club.clubId, adminId);
  await changeRole(h.db, await ctxFor(ownerId), club.clubId, adminId, 'admin');
  const channel = await getChannelRef(h.db, club.mainChannelId);
  if (!channel) throw new Error('fixture channel missing');
  return { channel, ownerId, memberId, adminId };
}

/** The one message in a page, by seq. Reads go through the real query, never a hand-built row. */
async function reread(channel: ChannelRef, seq: number) {
  const page = await readHistory(h.db, anyViewer(), channel.id, {});
  const found = page.find((message) => message.seq === seq);
  if (!found) throw new Error(`seq ${seq} not in history`);
  return found;
}

/**
 * Age a message by rewriting its `created_at`.
 *
 * The alternative is passing a `now` far in the future, which would prove the arithmetic and not
 * the wiring - the route calls `editMessage` with no clock at all, so a test that only ever
 * supplies one would never exercise the default. This moves the message instead and lets the real
 * `new Date()` run, which is the path production takes.
 */
async function age(channel: ChannelRef, seq: number, ms: number): Promise<void> {
  await h.db.execute(sql`
    UPDATE messages
       SET created_at = created_at - ${`${ms} milliseconds`}::interval
     WHERE channel_id = ${channel.id}::uuid AND seq = ${seq}
  `);
}

describe('the edit window', () => {
  it('lets the sender correct their own text, and says so on the envelope', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'see you at 6pm');

    const result = await editMessage(
      h.db,
      await ctxFor(f.memberId),
      f.channel,
      sent.seq,
      'see you at 7pm',
    );

    expect(result.ok).toBe(true);
    const after = await reread(f.channel, sent.seq);
    expect(after.body).toBe('see you at 7pm');
    // The label's whole reason for existing. Text that changed with nothing saying so is the
    // dishonesty rule 9a exists to prevent.
    expect(after.editedAt).not.toBeNull();
  });

  it('refuses once the window has passed, on the server rather than in the UI', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'six pm');
    // One second past, so this asserts the deadline and not some larger interval either side.
    await age(f.channel, sent.seq, MESSAGE_EDIT_WINDOW_MS + 1000);

    const result = await editMessage(
      h.db,
      await ctxFor(f.memberId),
      f.channel,
      sent.seq,
      'seven pm',
    );

    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect((await reread(f.channel, sent.seq)).body).toBe('six pm');
  });

  it('still allows an edit just inside the window', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'six pm');
    await age(f.channel, sent.seq, MESSAGE_EDIT_WINDOW_MS - 5000);

    const result = await editMessage(
      h.db,
      await ctxFor(f.memberId),
      f.channel,
      sent.seq,
      'seven pm',
    );

    expect(result.ok).toBe(true);
  });
});

describe('who may edit, which is not who may delete', () => {
  it('refuses an admin editing somebody else\'s message', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'i will be late');

    const result = await editMessage(
      h.db,
      await ctxFor(f.adminId),
      f.channel,
      sent.seq,
      'i will be on time',
    );

    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect((await reread(f.channel, sent.seq)).body).toBe('i will be late');
  });

  it('lets that same admin DELETE it, which is the asymmetry', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'i will be late');

    // The point of asserting both in one file: these two predicates look like they should agree
    // and deliberately do not. A future refactor that unified them would pass every other test.
    const deleted = await softDeleteMessage(h.db, await ctxFor(f.adminId), f.channel, sent.seq);
    expect(deleted.ok).toBe(true);
  });

  it('refuses the owner editing somebody else\'s message too', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'i will be late');

    const result = await editMessage(
      h.db,
      await ctxFor(f.ownerId),
      f.channel,
      sent.seq,
      'i will be on time',
    );

    expect(result).toEqual({ ok: false, code: 'forbidden' });
  });

  it('refuses a non-member entirely', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'hello');
    const outsiderId = await makeUser('Outsider');

    const result = await editMessage(
      h.db,
      await ctxFor(outsiderId),
      f.channel,
      sent.seq,
      'goodbye',
    );

    expect(result).toEqual({ ok: false, code: 'forbidden' });
  });
});

describe('what an edit cannot reach', () => {
  it('refuses an announcement, which has already buzzed every phone in the space', async () => {
    const f = await setup();
    // The owner announces, so this is refused for being an announcement rather than for
    // belonging to somebody else - the sender is the caller.
    const sent = await say(f.ownerId, f.channel, 'practice is cancelled', {
      type: 'announcement',
    });

    const result = await editMessage(
      h.db,
      await ctxFor(f.ownerId),
      f.channel,
      sent.seq,
      'practice is on',
    );

    expect(result).toEqual({ ok: false, code: 'forbidden' });
  });

  it('refuses a tombstone, which has no body left to correct', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'oops');
    await softDeleteMessage(h.db, await ctxFor(f.memberId), f.channel, sent.seq);

    const result = await editMessage(
      h.db,
      await ctxFor(f.memberId),
      f.channel,
      sent.seq,
      'un-oops',
    );

    expect(result).toEqual({ ok: false, code: 'forbidden' });
  });

  it('refuses an empty body: deleting is how a message is taken back', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'something');

    const result = await editMessage(h.db, await ctxFor(f.memberId), f.channel, sent.seq, '   ');

    expect(result).toEqual({ ok: false, code: 'empty_body' });
    expect((await reread(f.channel, sent.seq)).body).toBe('something');
  });

  it('leaves type, pinned and seq untouched: the column-level authority trap', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'ordinary');

    await editMessage(h.db, await ctxFor(f.memberId), f.channel, sent.seq, 'still ordinary');

    /*
     * Read from the row rather than the envelope, because the envelope is derived and the
     * question here is what the UPDATE wrote. v1's defect was a member pinning their own message
     * and retro-flipping it into an announcement; the remaster's answer is that no command over a
     * message can carry a second column, and this is that claim asserted against the table.
     */
    const rows = await h.db
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, f.channel.id), eq(messages.seq, sent.seq)));
    expect(rows[0]?.type).toBe('text');
    expect(rows[0]?.pinned).toBe(false);
    expect(rows[0]?.seq).toBe(sent.seq);
    expect(rows[0]?.senderId).toBe(f.memberId);
  });
});

describe('the edit reaches everybody, including a device that was offline', () => {
  it('advances the channel revision, so sync carries the correction', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'six pm');

    // The state a caught-up client is in: it holds every message up to the head, and the
    // revision mark the server last reported. An edit mutates a row BELOW that seq, which is
    // exactly the change `seq > mine` could never see.
    const caughtUp = await syncSince(h.db, anyViewer(), f.channel.id, 0);

    await editMessage(h.db, await ctxFor(f.memberId), f.channel, sent.seq, 'seven pm');

    // Asking the way a reconnecting client asks: nothing new by seq, but something new by rev.
    const changed = await syncSince(
      h.db,
      anyViewer(),
      f.channel.id,
      sent.seq,
      500,
      caughtUp.maxRev,
    );
    const found = changed.messages.find((m) => m.seq === sent.seq);
    expect(found?.body).toBe('seven pm');
    expect(found?.editedAt).not.toBeNull();
  });

  it('writes a message.edited event for the worker to publish', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'six pm');

    await editMessage(h.db, await ctxFor(f.memberId), f.channel, sent.seq, 'seven pm');

    /*
     * Scoped to THIS channel, not just to the event type. Every test in this file shares one
     * database, so an unscoped count is a count of every edit the whole file has made - which
     * passes on its own and breaks the moment a test is added above it. The partition key is the
     * channel by construction, which is what makes this the right filter rather than a workaround.
     */
    const events = await h.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.eventType, 'message.edited'), eq(outbox.partitionKey, f.channel.id)));
    expect(events.length).toBe(1);
    expect(events[0]?.payload).toMatchObject({ channelId: f.channel.id, seq: sent.seq });
  });
});

describe('the content filter runs on an edit too', () => {
  /*
   * The terms come from the filter's own exported lists rather than being written out here.
   *
   * Two reasons, and both matter. It keeps the test honest about what it asserts - that the SAME
   * classifier runs on this path, not that one particular string is caught - so a list that grows
   * or shrinks does not silently stop testing anything. And it keeps slurs out of a source file
   * that has no other reason to contain them; `content-filter.ts` owns them, with the reasoning
   * for each tier beside them.
   */
  it('refuses text it would have refused at send time', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'a harmless message');

    const result = await editMessage(
      h.db,
      await ctxFor(f.memberId),
      f.channel,
      sent.seq,
      `hey ${REFUSE_TERMS[0]}`,
    );

    expect(result).toEqual({ ok: false, code: 'content_refused' });
    // Nothing was written: a refusal must not be a half-applied edit. Without this, the window is
    // a hole straight through the filter - post something harmless, then edit it into this.
    const after = await reread(f.channel, sent.seq);
    expect(after.body).toBe('a harmless message');
    expect(after.editedAt).toBeNull();
  });

  it('posts the flag tier and queues it for review, as the send path does', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, 'a harmless message');

    const result = await editMessage(
      h.db,
      await ctxFor(f.memberId),
      f.channel,
      sent.seq,
      `you ${FLAG_TERMS[0]}`,
    );

    // Flagged, not refused: the member sees nothing and the edit lands. A reviewer sees a report
    // filed by ClubChat rather than by a person.
    expect(result.ok).toBe(true);
    const reports = await h.db
      .select()
      .from(messageReports)
      .where(eq(messageReports.messageId, sent.id));
    expect(reports.length).toBe(1);
  });
});

describe('mentions follow the text', () => {
  it('notifies a name the edit added, and only that name', async () => {
    const f = await setup();
    const owner = f.ownerId;
    const sent = await say(f.memberId, f.channel, 'who is driving');

    const result = await editMessage(
      h.db,
      await ctxFor(f.memberId),
      f.channel,
      sent.seq,
      '@Owner who is driving',
      [owner],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.addedMentions).toEqual([owner]);

    const stored = await h.db
      .select({ userId: messageMentions.userId })
      .from(messageMentions)
      .where(eq(messageMentions.messageId, sent.id));
    expect(stored.map((r) => r.userId)).toEqual([owner]);
  });

  it('does not re-notify a name that was already there', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, '@Owner are you coming', {
      mentions: [f.ownerId],
    });

    // A typo fix elsewhere in the sentence, with no picks at all - the common case.
    const result = await editMessage(
      h.db,
      await ctxFor(f.memberId),
      f.channel,
      sent.seq,
      '@Owner are you coming tonight',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nothing added, so nobody is told again. A phone buzzing twice for one sentence is the
    // failure this diff exists to prevent.
    expect(result.addedMentions).toEqual([]);
    // And the existing mention survived an edit that never touched it.
    const stored = await h.db
      .select({ userId: messageMentions.userId })
      .from(messageMentions)
      .where(eq(messageMentions.messageId, sent.id));
    expect(stored.map((r) => r.userId)).toEqual([f.ownerId]);
  });

  it('drops a mention the edit removed from the text', async () => {
    const f = await setup();
    const sent = await say(f.memberId, f.channel, '@Owner are you coming', {
      mentions: [f.ownerId],
    });

    await editMessage(h.db, await ctxFor(f.memberId), f.channel, sent.seq, 'is anyone coming');

    /*
     * "Edit the name out and the mention goes with it" is a property of the system rather than of
     * the client remembering to send a shorter list - the caller here sends no picks at all, and
     * the row goes because the name is no longer in the body.
     */
    const stored = await h.db
      .select({ userId: messageMentions.userId })
      .from(messageMentions)
      .where(eq(messageMentions.messageId, sent.id));
    expect(stored).toEqual([]);
  });

  it('refuses to mention somebody who cannot reach the channel', async () => {
    const f = await setup();
    const outsiderId = await makeUser('Outsider');
    const sent = await say(f.memberId, f.channel, 'hello');

    const result = await editMessage(
      h.db,
      await ctxFor(f.memberId),
      f.channel,
      sent.seq,
      '@Outsider hello',
      [outsiderId],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The client can name anyone by editing the payload. A mention is a notification into a
    // conversation the named person may have no access to, so the server filters rather than
    // trusting the list - the same gate the send path applies.
    expect(result.addedMentions).toEqual([]);
  });
});
