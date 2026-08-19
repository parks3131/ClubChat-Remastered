/**
 * How many database round trips one request actually costs.
 *
 * > **Everything the backend-cleaning mission found until now was about what the CLIENT asks
 * > for.** Nothing had ever looked at what the server does to answer one question - whether a
 * > single tidy request becomes twenty database round trips. `TECH/18` 3.5 called this the
 * > natural next tool, for a specific reason: the batch routes added in 2.7 and 2.14
 * > deliberately loop their single-item authorizer once per id, which is right for
 * > authorization and is exactly the shape that hides an N+1 one layer down.
 *
 * The trick is the same one the trace already plays, applied to the layer below. A counter is
 * put in async context when a request arrives, every query the pool runs adds to whichever
 * counter it finds there, and the number is read back out when the response goes.
 *
 * ## Why `AsyncLocalStorage` and not a field on the request
 *
 * A query is run by `domain/` code that has no idea a request exists, which is the whole point
 * of that boundary. Threading a counter through every read would mean changing every signature
 * in the codebase to measure something, and the measurement would then be one forgotten
 * parameter away from being quietly wrong. Async context is the one mechanism that follows a
 * call chain without appearing in it.
 *
 * ## The pooled CLIENT is wrapped, and `pool.query` deliberately is NOT
 *
 * A transaction does not go through `pool.query` at all - drizzle checks a client out with
 * `pool.connect()` and runs every statement on that - and there are 49 `db.transaction(...)`
 * sites, all of them write paths. So the client is the thing to wrap.
 *
 * > **Wrapping `pool.query` as well double-counted every ordinary read, and the first numbers
 * > this tool produced were twice the truth.** `Pool.prototype.query` is not a separate path: it
 * > acquires a client and runs `client.query` on it, so a wrapper on each counts one statement
 * > twice. Removing it then reported ZERO, which exposed the second half: `Pool.query` acquires
 * > through the **callback** form of `connect`, and the first version of this file passed that
 * > form straight through unwrapped. Both numbers were wrong, in opposite directions, and both
 * > were caught by the test beside this file within an hour.
 *
 * So every client is wrapped however it was acquired, and nothing else is. One statement is
 * counted once, on whichever path produced it. **That is the entire argument for testing a
 * measuring instrument**: a number wrong in the flattering direction closes an investigation,
 * and one wrong in the other direction starts a hunt for a defect that is not there.
 *
 * Clients are REUSED by the pool, so a `WeakSet` marks the ones already wrapped. Without it
 * every checkout adds another layer and a single query is counted as many times as that client
 * has ever been lent out.
 *
 * ## It is inert unless development switched it on
 *
 * `instrumentPool` is called from one place, behind `devTraceEnabled()`, exactly like the
 * tracer. Nothing in production and nothing in any test constructs it, so the pool a test or a
 * deploy uses is the unwrapped one.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';

/** What one request accumulated. Mutable on purpose: the pool wrapper adds to it in place. */
export type QueryCount = {
  /** Statements run, including every one inside a transaction and the BEGIN/COMMIT pair. */
  queries: number;
  /** Milliseconds spent waiting on them, summed. Overlaps if a request runs queries in parallel. */
  dbMs: number;
};

const storage = new AsyncLocalStorage<QueryCount>();

/**
 * Start counting for the current request, and keep counting through everything it awaits.
 *
 * `enterWith` rather than `run`, because Fastify hooks return before the handler runs - a `run`
 * callback would close its context at the end of the hook and count nothing. `enterWith` sets
 * the context for the remainder of this execution and everything asynchronous below it, which
 * is exactly a request.
 */
export function beginQueryCount(): QueryCount {
  const counter: QueryCount = { queries: 0, dbMs: 0 };
  storage.enterWith(counter);
  return counter;
}

/**
 * Count everything one callback does, in its own scope.
 *
 * `run` rather than `enterWith`, which makes this the safe form anywhere the work is bounded by
 * a function - the tests below, and anything measuring a job rather than a request. `enterWith`
 * is only needed where the scope OUTLIVES the call that opens it, which is exactly a Fastify
 * hook and exactly why `beginQueryCount` exists separately.
 */
export async function withQueryCount<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; counted: QueryCount }> {
  const counted: QueryCount = { queries: 0, dbMs: 0 };
  const result = await storage.run(counted, fn);
  return { result, counted };
}

/**
 * Count one query against whoever ISSUED it.
 *
 * > **The counter is captured when the query is sent, never when it comes back.** pg runs a
 * > query's completion callback in its own internal async context - a pooled client's, rooted
 * > wherever that connection was first established - so asking `getStore()` at completion
 * > attributes the query to whatever request happened to open that connection, or to nobody.
 * > It reported 0 for entire requests. Reading the store at CALL time is both correct and the
 * > obvious meaning: a query belongs to the code that asked for it.
 *
 * A query with no counter is normal rather than an error: the worker's drain loop and the
 * gateway's own reads are not requests, and neither is anything at boot.
 */
function record(counter: QueryCount | undefined, startedAt: number): void {
  if (counter === undefined) return;
  counter.queries += 1;
  counter.dbMs += Date.now() - startedAt;
}

/**
 * Wrap one `query` method so it reports itself, in every call shape pg accepts.
 *
 * > **Both shapes are load-bearing, and assuming only one cost a wrong number.** A transaction
 * > awaits the promise `client.query` returns. `pool.query` hands `client.query` a CALLBACK, and
 * > a callback call returns a `Query` object rather than a promise - so timing only the promise
 * > recorded every ordinary read as taking 0ms while still counting it. The count looked right
 * > and the duration was silently a lie.
 */
function timed<T extends (...args: never[]) => unknown>(original: T, self: unknown): T {
  return function (this: unknown, ...args: never[]) {
    // Captured HERE, in the caller's context. See `record`.
    const counter = storage.getStore();
    const startedAt = Date.now();
    const run = original as unknown as (...a: unknown[]) => unknown;

    // Callback form: the answer arrives there, so that is where the round trip ends.
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const callback = last as (...a: unknown[]) => unknown;
      const patched = [...(args as unknown[])];
      patched[patched.length - 1] = function (this: unknown, ...answer: unknown[]) {
        record(counter, startedAt);
        return callback.apply(this, answer);
      };
      return run.apply(self, patched);
    }

    const result = run.apply(self, args as unknown[]);
    if (result !== null && typeof result === 'object' && 'then' in result) {
      return (result as Promise<unknown>).then(
        (value) => {
          record(counter, startedAt);
          return value;
        },
        (error: unknown) => {
          // A failed query is still a round trip, and a request that fails slowly is exactly the
          // kind this tool exists to show.
          record(counter, startedAt);
          throw error;
        },
      );
    }

    // Neither shape: count it rather than lose it, and leave the value untouched.
    record(counter, startedAt);
    return result;
  } as unknown as T;
}

/**
 * Make a pool report every statement it runs, including the ones inside transactions.
 *
 * Mutates the pool rather than returning a proxy, because the pool is handed to `createDb`
 * before anything here can see it and drizzle keeps its own reference.
 */
export function instrumentPool(pool: pg.Pool): void {
  const wrappedClients = new WeakSet<object>();

  const wrapClient = (client: pg.PoolClient): pg.PoolClient => {
    // Already wrapped: this client has been lent out before. Wrapping again would count each of
    // its queries once per checkout it has ever had.
    if (wrappedClients.has(client)) return client;
    wrappedClients.add(client);
    client.query = timed(client.query.bind(client) as never, client) as typeof client.query;
    return client;
  };

  /*
   * `connect` and nothing else, in BOTH of its forms.
   *
   * Every statement reaches the database through a client, so this is the one chokepoint that
   * catches an ordinary read and a transaction alike without counting either twice. A
   * transaction takes the promise form; `pool.query` takes the callback form.
   */
  const connect = pool.connect.bind(pool);
  pool.connect = function (callback?: unknown) {
    if (typeof callback === 'function') {
      return (connect as (cb: unknown) => unknown)(
        (error: unknown, client: pg.PoolClient | undefined, done: unknown) => {
          if (client) wrapClient(client);
          (callback as (...a: unknown[]) => unknown)(error, client, done);
        },
      );
    }
    return (connect as () => Promise<pg.PoolClient>)().then(wrapClient);
  } as typeof pool.connect;
}
