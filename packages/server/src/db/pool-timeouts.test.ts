/**
 * The two ceilings a pooled connection carries, and the one it never had.
 *
 * > **`connectionTimeoutMillis` is not a substitute for either of these and reads as though it
 * > is.** It bounds ACQUIRING a connection. It says nothing about a client that already holds one
 * > and is sitting inside a transaction - which is exactly what `worker/drain.ts` does: claim up
 * > to fifty outbox rows with `FOR UPDATE SKIP LOCKED`, then await each effect handler inside that
 * > transaction while it talks to Expo and to object storage over HTTP. Every one of those awaits
 * > is a session idle in transaction holding row locks, with no statement running for a statement
 * > timeout to notice.
 *
 * Asserted behaviourally rather than by reading the pool's options back, because the failure this
 * is guarding against is the setting not reaching the session at all. `pg` sends both as startup
 * parameters, and a key it did not recognise would be dropped in silence.
 */

import { afterEach, describe, expect, inject, it } from 'vitest';
import type pg from 'pg';
import { sql } from 'drizzle-orm';
import {
  createDb,
  createPool,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  type PoolTimeouts,
} from './client.ts';

const pools: pg.Pool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end().catch(() => undefined)));
});

function poolFor(timeouts?: PoolTimeouts): pg.Pool {
  const pool = createPool(inject('pgAdminUri'), timeouts);
  pools.push(pool);
  return pool;
}

/** What the backend itself says it is running with, which is the only answer that counts. */
async function setting(pool: pg.Pool, name: string): Promise<string> {
  const result = await pool.query<Record<string, string>>(`SHOW ${name}`);
  return String(result.rows[0]?.[name]);
}

describe('what a pooled connection is configured with', () => {
  it('carries both ceilings into the session, not just into the pool options', async () => {
    const pool = poolFor();

    // Postgres normalises the value, so these are the defaults above expressed its way.
    expect(STATEMENT_TIMEOUT_MS).toBe(30_000);
    expect(IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(120_000);
    expect(await setting(pool, 'statement_timeout')).toBe('30s');
    expect(await setting(pool, 'idle_in_transaction_session_timeout')).toBe('2min');
  });

  it('lets a caller opt out, which is what migrations do', async () => {
    // Building an index over a table with real rows in it is a single statement that is SUPPOSED
    // to run for minutes. `db/migrate.ts` is the only caller that passes zeroes, and this is the
    // assertion that the escape hatch actually disables them rather than clamping to a minimum.
    const pool = poolFor({ statementTimeoutMs: 0, idleInTransactionTimeoutMs: 0 });

    expect(await setting(pool, 'statement_timeout')).toBe('0');
    expect(await setting(pool, 'idle_in_transaction_session_timeout')).toBe('0');
  });

  /*
   * **The two assertions above pass against this container whether or not the pool sends
   * anything at all**, which is why these three exist underneath them.
   *
   * Postgres defaults `statement_timeout` and `idle_in_transaction_session_timeout` to `0`, so an
   * opt-out test that asks for zero and reads zero cannot distinguish "we disabled it" from "we
   * sent nothing and inherited the default". It had never been seen to fail. Neon is where that
   * stopped being academic: measured on 2026-08-21 against the real project, `pg`'s individual
   * `statement_timeout` startup parameter is **silently discarded** - not rejected, discarded -
   * and the session came back `0 / 5min`, which is Postgres's default and Neon's compute-level
   * default respectively. The same code against this container returns `30s / 2min`.
   *
   * So the ceilings are asserted at the wire level too: what the pool will actually send.
   */
  it('sends the ceilings as `-c` options rather than as individual startup parameters', () => {
    const pool = poolFor();

    expect(pool.options.options).toContain(`statement_timeout=${STATEMENT_TIMEOUT_MS}`);
    expect(pool.options.options).toContain(
      `idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
    );
  });

  it('sends an explicit zero for the opt-out instead of omitting the parameter', () => {
    /*
     * `pg` writes the individual parameters into the startup packet behind
     * `if (params.statement_timeout)`, and `0` is falsy, so the escape hatch that
     * `db/migrate.ts` depends on used to send nothing whatsoever. It only ever appeared to work
     * because Postgres's own default is also `0`. On any server with a non-zero default - Neon
     * ships `idle_in_transaction_session_timeout` at five minutes - migrations silently inherited
     * a ceiling instead of disabling one.
     */
    const pool = poolFor({ statementTimeoutMs: 0, idleInTransactionTimeoutMs: 0 });

    expect(pool.options.options).toContain('statement_timeout=0');
    expect(pool.options.options).toContain('idle_in_transaction_session_timeout=0');
  });
});

describe('a transaction that stalls on something outside the database', () => {
  it('is terminated rather than holding its row locks forever', async () => {
    /*
     * The sleep stands in for the await that caused this: `store.get` against storage that
     * accepted the connection and never answered. Nothing throws there, so the SDK's retry never
     * engages and the drain's transaction simply never reaches its next statement - which means
     * the `FOR UPDATE` claims on up to fifty outbox rows are never released and every partition's
     * effects stop, silently, until somebody restarts the worker.
     */
    const reported: string[] = [];
    const db = createDb(
      poolFor({
        idleInTransactionTimeoutMs: 300,
        onConnectionError: (error) => reported.push(error.message),
      }),
    );

    const stalled = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await tx.execute(sql`SELECT 1`);
    });

    // Loud and self-healing is the whole point: the drain's tick fails, the claims roll back, and
    // the next tick re-claims the rows under the outbox's own retry schedule.
    await expect(stalled).rejects.toThrow();

    /*
     * And the process is still standing, which the assertion above says nothing about.
     *
     * The termination arrives while no statement is in flight, so `pg` routes it to
     * `client.emit('error')` - on a client `pg-pool` is not listening to, because it listens only
     * to idle ones. Unheard, that is an uncaught exception, and the API has no
     * `uncaughtException` handler: a fix that stopped at the line above would have traded a
     * silent freeze for a crash loop. This ran exactly that way before `createPool` attached its
     * own listeners - four green assertions and two exceptions escaping the file.
     */
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reported.length).toBeGreaterThan(0);
  });
});

describe('a statement that runs away', () => {
  it('is abandoned instead of pinning a pool connection until the process restarts', async () => {
    const pool = poolFor({ statementTimeoutMs: 200 });

    await expect(pool.query('SELECT pg_sleep(5)')).rejects.toThrow(/statement timeout/i);
  });
});
