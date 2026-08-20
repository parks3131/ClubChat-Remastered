/**
 * The database client.
 *
 * The API connects as a single application role. Every other role - including any
 * future service, analytics job, or leaked credential - is denied by default at the
 * grant level. There are deliberately NO per-row policies: enforcement lives in one
 * layer, in one place, fully tested. Mirroring the policy module as RLS "for defence
 * in depth" means two definitions of every rule that must be kept in sync, and drift
 * between two definitions of isClubAdmin is literally how the v1 bugs happened.
 * See ADR-0002.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof createDb>;
export type Schema = typeof schema;

/**
 * The ceiling on one SQL statement.
 *
 * Thirty seconds is enormous for anything this application asks. The slowest reads are the sync
 * and batch queries, which are indexed and measured in milliseconds, and the slowest writes are
 * the retention sweeps. A statement still running after half a minute is a plan that went wrong
 * or a lock nobody is going to release, and the honest answer is to abandon it rather than to
 * hold a pool connection until the process restarts.
 *
 * Deliberately NOT tighter. `worker/drain.ts` legitimately does slow work, and a value chosen
 * against the fast case would break it on a busy tick - so the number is picked to catch a
 * runaway, not to police latency.
 */
export const STATEMENT_TIMEOUT_MS = 30_000;

/**
 * The ceiling on a transaction that is open and doing nothing.
 *
 * **This is the one that matters, and `connectionTimeoutMillis` is not a substitute for it.**
 * That bounds acquiring a connection from the pool; it says nothing about a client that already
 * holds one and is sitting inside a transaction. `worker/drain.ts` claims up to fifty outbox rows
 * with `FOR UPDATE SKIP LOCKED` and then awaits each effect handler INSIDE that transaction -
 * push over HTTP, object storage over HTTP - so every one of those awaits is a session idle in
 * transaction, holding row locks, with no statement running for a statement timeout to catch.
 *
 * Two minutes rather than a round ten seconds, because the number has to clear the slowest
 * legitimate single dispatch or it breaks the drain rather than protecting it. The worst of those
 * is `media.uploaded`: a `store.get` of up to 25 MB, a decode, two resizes and two `store.put`s,
 * each storage call now bounded by `media/store.ts` at roughly forty seconds across its three
 * attempts. Two minutes is comfortably above that and immeasurably below forever, which is what
 * it was.
 *
 * When it fires, Postgres terminates the backend. `pg` surfaces that on the transaction's next
 * statement, the drain's `db.transaction` rolls back, the claimed rows are released, and the next
 * tick re-claims them under the outbox's own retry schedule. A loud, self-healing failure is the
 * entire point: today the same fault is a silent freeze of every partition's effects.
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 120_000;

/**
 * Both ceilings, overridable per pool.
 *
 * On the pool rather than per session, which is the choice worth stating. Postgres accepts both
 * as startup parameters, so `pg` sends them once when a connection is established and every
 * session on it inherits them - no `SET` on a checkout path that could be forgotten, and no way
 * for a code path to opt out by not knowing it should opt in. A default that has to be applied is
 * not a default.
 *
 * The one caller that legitimately opts out is `db/migrate.ts`. Zero disables a ceiling, matching
 * Postgres's own meaning for these settings.
 */
export type PoolTimeouts = {
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  /**
   * Where a connection-level fault is written.
   *
   * Injected only so a test can assert one happened. Every entrypoint takes the default, which
   * writes to stderr - the same stream pino writes to, so nothing is lost by not having a logger
   * threaded down here.
   */
  onConnectionError?: (error: Error) => void;
};

export function createPool(connectionString: string, timeouts: PoolTimeouts = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    // The sequence-allocating transaction holds a row lock until commit, so a
    // starved pool shows up as send latency on one channel. Keep headroom.
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: timeouts.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout:
      timeouts.idleInTransactionTimeoutMs ?? IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });

  const report =
    timeouts.onConnectionError ??
    ((error: Error) => console.error('[db] connection-level fault', error.message));

  /*
   * **A connection that dies while nobody is querying it crashes the process, and adding the
   * ceiling above is what makes that routine rather than rare.**
   *
   * Found by running the timeout, not by reading `pg`. When
   * `idle_in_transaction_session_timeout` fires, Postgres terminates the backend and sends
   * `FATAL 25P03` while no statement is in flight - and `pg`'s `_handleErrorMessage` routes an
   * error with no active query to `client.emit('error')`. `pg-pool` attaches its own listener to
   * an IDLE client and removes it again on checkout, so a client held open inside a transaction
   * has none: an `EventEmitter` emitting `error` unheard throws, and the API has no
   * `uncaughtException` handler to catch it. The socket close that follows arrives the same way,
   * as a second `Connection terminated unexpectedly`. Both showed up in `pool-timeouts.test.ts`
   * as uncaught exceptions beside four passing assertions, which is precisely the shape of a fix
   * that looks finished.
   *
   * These two listeners are not a swallow. The authoritative report of this fault reaches the
   * caller anyway - the drain's next statement rejects, `db.transaction` rolls back, and the row
   * is retried and eventually captured at the park. What is recorded here is the duplicate
   * notification that would otherwise take the process down with it, and it is written rather
   * than discarded so that "the database dropped our connection" is never invisible.
   */
  pool.on('connect', (client) => {
    client.on('error', (error: Error) => report(error));
  });
  // The same fault on a client that was idle when it died. `pg-pool` removes the client from the
  // pool and re-emits here, and an unheard `error` on the pool throws exactly as it does on a
  // client.
  pool.on('error', (error: Error) => report(error));

  return pool;
}

export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}

export { schema };
