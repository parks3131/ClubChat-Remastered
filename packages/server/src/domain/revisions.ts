/**
 * The per-channel revision counter: "what has changed", as an integer.
 *
 * > **A client that was offline when a message was deleted kept showing it, with its text,
 * > indefinitely.** Sync asked for `seq > <the client's local max>`, so a row the client already
 * > held was never fetched again - and a pin, a soft delete and a reaction all mutate rows BELOW
 * > that mark. `PRD/17` item 14, and it is a moderation hole rather than a staleness annoyance:
 * > the whole point of a delete is that it reaches everybody.
 *
 * Every message carries the channel revision at which it last changed, and every mutation
 * allocates the next one. Sync then asks a single question - `rev > mine` - which covers a new
 * message and a changed message alike, because an append allocates a revision too.
 *
 * ---
 *
 * **Why an integer and not a timestamp.** `TECH/00` chose a monotonic per-channel ordinal for
 * ordering precisely so "have I seen everything up to N" is an integer comparison with no clock
 * in it. The same argument applies to "what have I not seen change": two transactions committing
 * out of order around a wall-clock watermark can both fall on the wrong side of it, and the row
 * that slips past is missed permanently rather than late.
 *
 * **Why a second counter and not `seq`.** Bumping a message's `seq` when somebody pinned it would
 * move that message to the end of the conversation and leave a hole where it had been - the
 * phantom gap the gapless design exists to make unrepresentable. `seq` says where a message sits;
 * `rev` says when it last changed. They answer different questions and must not share a number.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';

/** A transaction handle, or the pool. Every caller here is already inside a transaction. */
type Executor = Pick<Db, 'execute'>;

/**
 * Take the next revision for a channel.
 *
 * > **Call this INSIDE the transaction that performs the mutation, never beside it.** The
 * > `UPDATE ... RETURNING` takes a row lock held until commit, which is what serialises
 * > concurrent mutations of the same channel and what makes the revision usable as a watermark:
 * > if the mutation rolls back, its revision rolls back with it and no client is ever told to
 * > skip past a change that did not happen.
 *
 * Deliberately the same shape as the `last_seq` bump in `append-message.ts`, and deliberately not
 * a Postgres SEQUENCE - a sequence is non-transactional and leaks numbers on rollback. A leaked
 * revision is less catastrophic than a leaked `seq` (it advertises a change nobody made rather
 * than a hole in history) but it would still hand clients a mark they can never reach.
 *
 * Returns `null` when the channel no longer exists, which the caller decides what to do about:
 * for a mutation whose row is being deleted anyway this is not an error.
 */
export async function nextRevision(tx: Executor, channelId: string): Promise<number | null> {
  const bumped = await tx.execute<{ last_rev: number }>(sql`
    UPDATE channels
       SET last_rev = last_rev + 1
     WHERE id = ${channelId}
    RETURNING last_rev
  `);
  return bumped.rows[0]?.last_rev ?? null;
}

/**
 * Stamp a message with the next revision, in one statement.
 *
 * For the mutation sites that change a row through something other than the message table itself
 * - a reaction lives in `message_reactions`, and its arrival changes what the message's envelope
 * says without touching the message. **Those are exactly the changes that were being lost**, so
 * the row has to be touched even though none of its own columns changed.
 */
export async function touchMessage(
  tx: Executor,
  channelId: string,
  seq: number,
): Promise<number | null> {
  const rev = await nextRevision(tx, channelId);
  if (rev === null) return null;

  await tx.execute(sql`
    UPDATE messages SET rev = ${rev} WHERE channel_id = ${channelId} AND seq = ${seq}
  `);
  return rev;
}
