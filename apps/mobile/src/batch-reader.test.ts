/**
 * The batch reader.
 *
 * The tests that matter here are the ones about what it must NOT do. Coalescing reads is easy;
 * coalescing them without showing somebody the tally from before their own vote, without
 * swallowing a failure and without leaving a caller waiting forever is the part worth pinning
 * down. The first test is that vote, and it is the reason `invalidate` exists.
 */

import { describe, expect, it } from 'vitest';
import { createBatchReader } from './batch-reader.ts';

type Row = { id: string; value: number };

/** A reader over a mutable table, so a test can change the answer between reads. */
function harness(table: Map<string, number>, opts: { idleWindowMs?: number; busyWindowMs?: number } = {}) {
  const calls: string[][] = [];
  const read = createBatchReader<Row>({
    fetchMany: async (ids) => {
      calls.push([...ids]);
      return ids.filter((id) => table.has(id)).map((id) => ({ id, value: table.get(id)! }));
    },
    keyOf: (row) => row.id,
    missing: () => new Error('not_found'),
    maxPerRequest: 100,
    idleWindowMs: opts.idleWindowMs ?? 5,
    busyWindowMs: opts.busyWindowMs ?? 30,
  });
  return { read, calls };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createBatchReader', () => {
  it('answers a vote-then-reread from the server, because the write cleared its memory', async () => {
    const table = new Map([['p1', 1]]);
    const { read, calls } = harness(table);

    expect((await read('p1')).value).toBe(1);

    // Casting a vote: `api.ts` calls `invalidate()` BEFORE the write, then the card reloads.
    table.set('p1', 2);
    read.invalidate();

    // This is the case a plain time-based cache would get wrong, silently, by showing the tally
    // from before the vote that was just cast. It is the reason `invalidate` exists at all.
    expect((await read('p1')).value).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('reuses a recent answer, which is what stops scrolling re-reading every card', async () => {
    const table = new Map([['p1', 1]]);
    const { read, calls } = harness(table);

    expect((await read('p1')).value).toBe(1);

    // A row scrolled off screen and back is a fresh mount asking the same question. Without this
    // the same twelve event cards were read six times each over one conversation.
    expect((await read('p1')).value).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('reads again once the answer is no longer fresh', async () => {
    const table = new Map([['p1', 1]]);
    const calls: string[][] = [];
    const read = createBatchReader<Row>({
      fetchMany: async (ids) => {
        calls.push([...ids]);
        return ids.map((id) => ({ id, value: table.get(id)! }));
      },
      keyOf: (row) => row.id,
      missing: () => new Error('not_found'),
      maxPerRequest: 100,
      idleWindowMs: 5,
      freshForMs: 20,
    });

    expect((await read('p1')).value).toBe(1);
    table.set('p1', 2);
    await tick(40);
    expect((await read('p1')).value).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('gathers ids asked for together into one request', async () => {
    const table = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const { read, calls } = harness(table);

    const results = await Promise.all([read('a'), read('b'), read('c')]);
    expect(results.map((r) => r.value)).toEqual([1, 2, 3]);
    expect(calls).toEqual([['a', 'b', 'c']]);
  });

  it('waits longer for ids that arrive in later passes, which is how a long list mounts', async () => {
    const table = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const { read, calls } = harness(table, { idleWindowMs: 5, busyWindowMs: 60 });
    // Each id is asked for exactly once below, so nothing here can be answered from memory.

    // The first card asks and is answered quickly, so a screen opening is not held up.
    await read('a');
    expect(calls).toHaveLength(1);

    // Two more mount a moment later, in separate passes, the way a list commits rows. They
    // belong to the same arrival and must not cost a request each.
    const later = Promise.all([read('b'), tick(20).then(() => read('c'))]);
    await later;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['b', 'c']);
  });

  it('joins a request already on the wire rather than sending it again', async () => {
    const calls: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const read = createBatchReader<Row>({
      fetchMany: async (ids) => {
        calls.push([...ids]);
        await gate;
        return ids.map((id) => ({ id, value: 1 }));
      },
      keyOf: (row) => row.id,
      missing: () => new Error('not_found'),
      maxPerRequest: 100,
      idleWindowMs: 5,
    });

    const first = read('x');
    await tick(20); // the request is now out and unanswered
    const second = read('x');

    release();
    expect((await first).value).toBe(1);
    expect((await second).value).toBe(1);
    expect(calls).toEqual([['x']]); // asked once, not twice
  });

  it('rejects an id the answer does not contain, without touching the others', async () => {
    const table = new Map([['here', 1]]);
    const { read } = harness(table);

    const [ok, gone] = await Promise.allSettled([read('here'), read('gone')]);
    expect(ok.status).toBe('fulfilled');
    expect(gone.status).toBe('rejected');
  });

  it('gives a failed request to every id in it, and lets the next ask retry', async () => {
    let attempt = 0;
    const read = createBatchReader<Row>({
      fetchMany: async (ids) => {
        attempt += 1;
        if (attempt === 1) throw new Error('offline');
        return ids.map((id) => ({ id, value: 9 }));
      },
      keyOf: (row) => row.id,
      missing: () => new Error('not_found'),
      maxPerRequest: 100,
      idleWindowMs: 5,
    });

    const failed = await Promise.allSettled([read('a'), read('b')]);
    expect(failed.map((r) => r.status)).toEqual(['rejected', 'rejected']);

    // A failure must not leave the id stuck in a map, or the retry would wait on the rejected
    // promise forever - which is the failure mode that looks like a screen hanging.
    expect((await read('a')).value).toBe(9);
  });

  it('splits a batch larger than the route allows', async () => {
    const calls: string[][] = [];
    const read = createBatchReader<Row>({
      fetchMany: async (ids) => {
        calls.push([...ids]);
        return ids.map((id) => ({ id, value: 1 }));
      },
      keyOf: (row) => row.id,
      missing: () => new Error('not_found'),
      maxPerRequest: 2,
      idleWindowMs: 5,
    });

    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(read));
    expect(calls).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('asks once for an id several callers want at the same moment', async () => {
    const table = new Map([['same', 7]]);
    const { read, calls } = harness(table);

    const all = await Promise.all([read('same'), read('same'), read('same')]);
    expect(all.map((r) => r.value)).toEqual([7, 7, 7]);
    expect(calls).toEqual([['same']]);
  });
});
