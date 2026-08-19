/**
 * The per-request query counter.
 *
 * Worth testing for one reason above the others: **a measuring tool that under-reports is worse
 * than no tool**, because a low number reads as good news and closes an investigation. The two
 * cases below are the two ways this one could have under-reported, and one of them did on the
 * first attempt.
 *
 *  - **Transactions.** Drizzle does not run a transaction through `pool.query` at all; it checks
 *    a client out with `pool.connect()`. There are 49 `db.transaction(...)` sites in this
 *    codebase, and they are the WRITE paths - the ones most likely to be doing too much. Wrapping
 *    only the pool reported `1` for every one of them.
 *  - **Client reuse.** A pool lends the same client out repeatedly, so wrapping on each checkout
 *    stacks the wrapper and a single query is counted once per checkout that client has ever had.
 *    That over-reports, which is the less dangerous direction and still makes the number a lie.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestDb, type TestDb } from '../test/harness.ts';
import { beginQueryCount, instrumentPool, withQueryCount } from './queries.ts';

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
  instrumentPool(h.pool);
}, 120_000);

afterAll(async () => {
  await h?.stop().catch(() => undefined);
});

describe('the per-request query counter', () => {
  it('counts the statements one request runs, through the hook form a request uses', async () => {
    // `beginQueryCount` is the `enterWith` form, which is what a Fastify `onRequest` hook needs:
    // the scope has to outlive the hook that opens it. Proved here once; the rest of this file
    // uses the scoped form, because `enterWith` does not reliably re-enter across test bodies.
    const counter = beginQueryCount();
    await h.db.execute(sql`SELECT 1`);
    await h.db.execute(sql`SELECT 2`);
    expect(counter.queries).toBe(2);
  });

  it('counts statements INSIDE a transaction, which take a different path to the database', async () => {
    const { counted: counter } = await withQueryCount(async () => {
      await h.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await tx.execute(sql`SELECT 2`);
        await tx.execute(sql`SELECT 3`);
      });
    });

    // The three above plus the BEGIN and COMMIT the driver issues around them. The exact total
    // matters less than the floor: anything at or below 1 means the checked-out client escaped.
    expect(counter.queries).toBeGreaterThanOrEqual(4);
  });

  it('does not count a query twice when the pool lends the same client out again', async () => {
    // Force a checkout and release, so the next transaction is handed a client already wrapped.
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
    });

    const one = await withQueryCount(async () => {
      await h.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
      });
    });
    const two = await withQueryCount(async () => {
      await h.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
      });
    });

    // Identical work must cost an identical count. A stacking wrapper grows it every round.
    expect(two.counted.queries).toBe(one.counted.queries);
  });

  it('records how long a statement actually took, not zero', async () => {
    // `pool.query` reaches the client through a CALLBACK, so a version of this that only timed
    // the promise form counted the query and reported 0ms for it - right count, invented time.
    const { counted } = await withQueryCount(async () => {
      await h.db.execute(sql`SELECT pg_sleep(0.05)`);
    });
    expect(counted.queries).toBe(1);
    expect(counted.dbMs).toBeGreaterThanOrEqual(40);
  });

  it('attributes nothing when nobody is counting', async () => {
    // The worker's drain, the gateway's reads and anything at boot run outside a request. They
    // must not raise, and must not land on the last request's total.
    const { counted } = await withQueryCount(async () => {
      await h.db.execute(sql`SELECT 1`);
    });
    // Asserted before the interesting half, so this test cannot pass by counting nothing at all.
    expect(counted.queries).toBe(1);

    await h.db.execute(sql`SELECT 1`);
    expect(counted.queries).toBe(1);
  });
});
