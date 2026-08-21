/**
 * Is this process fit to be sent traffic?
 *
 * > **Neither role could answer that.** The API's check was
 * > `app.get('/health', async () => ({ ok: true }))` - a fact about the event loop, true of a
 * > process whose database credentials had been rotated out from under it - and the gateway had
 * > no HTTP surface at all. Fly gates BOTH traffic routing and deploy success on a check like
 * > this, so a deploy against an unreachable Postgres would go green and immediately take live
 * > traffic, and every request it took would 500.
 *
 * Two questions, deliberately separated, because the platform does two different things with the
 * answers:
 *
 *  - **Liveness** (`/health`) is "is this process running". It touches nothing. Fly RESTARTS a
 *    machine that fails it, so a liveness check that consulted the database would restart every
 *    machine at once during a database blip - the outage amplifier this module exists to avoid,
 *    aimed at the one check that can kill the process.
 *  - **Readiness** (`/ready`) is "should this process be routed to". Fly takes the instance out of
 *    rotation and fails the deploy. That is the one that is allowed to ask a dependency.
 *
 * This module is the readiness half, and it is HTTP-free on purpose: the api and the gateway share
 * it, and the grading rule below must be defined exactly once. AGENTS.md section 4 - "the same
 * predicate restated in many places will eventually be restated wrongly".
 */

import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Db } from './db/client.ts';
import type { Monitor } from './monitoring.ts';

/**
 * How long ONE probe may take before it is called a failure.
 *
 * Required rather than decorative, and both dependencies are why. The pool's
 * `connectionTimeoutMillis` is 10 seconds, and ioredis runs `maxRetriesPerRequest: 3` with
 * `enableOfflineQueue: true` - so a dependency that is hanging rather than refusing will hold this
 * handler far past any sane check interval. Fly would read that as a failure anyway, after its own
 * timeout, having held a prober the whole time; and the handler would still be running when the
 * next poll arrived. Answering "no" quickly is strictly better than answering "no" slowly.
 *
 * Two seconds is generous against the real numbers: the probe query is an index-free single-row
 * touch and `PING` is a round trip. Anything above this is a dependency in trouble, whatever it
 * eventually says.
 */
export const READINESS_TIMEOUT_MS = 2_000;

export type Dependency = 'postgres' | 'redis';

/**
 * `down` and `timeout` are graded identically and reported separately, because they are different
 * incidents: `down` is a refused connection or a rejected query, and `timeout` is a dependency
 * that accepted the work and never came back. The second is the one that needs a human.
 */
export type DependencyState = 'ok' | 'down' | 'timeout';

export type ReadinessReport = {
  postgres: DependencyState;
  redis: DependencyState;
  /**
   * What a failing probe threw, for the monitor. Empty when everything answered.
   *
   * Kept beside the states rather than folded into them so the states stay the plain, assertable
   * vocabulary the grading is written in, while the report an operator reads still carries the
   * driver's own words.
   */
  errors: Partial<Record<Dependency, unknown>>;
};

/** The whole of what the probes need, so a test can supply a stub that hangs or throws. */
export type ReadinessDb = Pick<Db, 'execute'>;
export type ReadinessRedis = Pick<Redis, 'ping'>;

/** Distinguishable from anything a driver throws, which is what makes `timeout` a real state. */
export class ReadinessTimeoutError extends Error {
  constructor(dependency: Dependency, timeoutMs: number) {
    super(`${dependency} did not answer within ${timeoutMs}ms`);
    this.name = 'ReadinessTimeoutError';
  }
}

/**
 * Run one probe, or give up on it.
 *
 * `clearTimeout` is in a `finally` and that is not tidiness: this runs every few seconds forever,
 * so a timer left armed on the happy path is a leak that grows for the life of the process.
 *
 * A dependency that answers AFTER the race has been lost is handled and discarded - `Promise.race`
 * attaches its own handler to every entry, so a late rejection cannot become an unhandled one and
 * take the process down. That is the whole reason this is a race rather than an `AbortSignal`
 * neither driver would honour anyway.
 */
async function withTimeout<T>(
  dependency: Dependency,
  run: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReadinessTimeoutError(dependency, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function grade(settled: PromiseSettledResult<unknown>): {
  state: DependencyState;
  error: unknown;
} {
  if (settled.status === 'fulfilled') return { state: 'ok', error: undefined };
  return {
    state: settled.reason instanceof ReadinessTimeoutError ? 'timeout' : 'down',
    error: settled.reason,
  };
}

/**
 * Ask both dependencies, at once, and answer within the timeout whatever they do.
 *
 * **Through the application's OWN pool and client, never a connection of this module's making.**
 * A side connection would report "Postgres is up" while the app's own twenty connections are
 * exhausted, or while its role lacks the grants its queries need - which is the same class of lie
 * as `() => ({ ok: true })`, told more convincingly.
 *
 * `select 1 from users limit 1` rather than a bare `select 1` for the same reason: the bare form
 * proves a socket and a parser, and this form additionally proves the right database, a usable
 * `search_path`, and a `SELECT` grant on a real table. It reads at most one row and touches no
 * index, so it is cheap enough to run every few seconds forever.
 */
export async function probeDependencies(opts: {
  db: ReadinessDb;
  redis: ReadinessRedis;
  timeoutMs?: number | undefined;
}): Promise<ReadinessReport> {
  const timeoutMs = opts.timeoutMs ?? READINESS_TIMEOUT_MS;

  const [postgres, redis] = await Promise.allSettled([
    withTimeout('postgres', () => opts.db.execute(sql`select 1 from users limit 1`), timeoutMs),
    withTimeout('redis', () => opts.redis.ping(), timeoutMs),
  ]);

  const graded = { postgres: grade(postgres), redis: grade(redis) };
  const errors: Partial<Record<Dependency, unknown>> = {};
  for (const dependency of ['postgres', 'redis'] as const) {
    if (graded[dependency].state !== 'ok') errors[dependency] = graded[dependency].error;
  }

  return { postgres: graded.postgres.state, redis: graded.redis.state, errors };
}

export type ReadinessLog = (
  level: 'info' | 'error',
  message: string,
  detail: Record<string, unknown>,
) => void;

/**
 * The readiness verdict for one process, with its reporting attached.
 *
 * **The grading is asymmetric, and that asymmetry is the point of the whole module.**
 *
 *  - **Postgres unreachable is a 503.** With Postgres down every route 500s anyway, so taking this
 *    instance out of rotation costs nothing and stops a deploy from going green against a database
 *    that is not there.
 *  - **Redis unreachable is still a 200**, logged and captured. `SPEC/TECH/11-failure-modes.md`
 *    records Redis being wiped or unavailable as a DEGRADE - realtime stops, clients keep working
 *    over REST and recover via sync on reconnect, the limiter fails open, and nothing is lost
 *    because Redis holds no source of truth - and calls that property non-negotiable. Every
 *    instance shares one Redis, so failing readiness on it would remove every instance at once and
 *    convert that documented degrade into a total outage. Do not "fix" this.
 *
 * Returned as a closure rather than a function because it remembers one thing: which dependencies
 * were failing last time.
 */
export function createReadinessCheck(opts: {
  db: ReadinessDb;
  redis: ReadinessRedis;
  /** Absent is supported: the gateway's own tests construct deps without one. */
  monitor?: Monitor | undefined;
  /** The stable `where` this process reports under - `api.ready` or `gateway.ready`. */
  where: string;
  log: ReadinessLog;
  timeoutMs?: number | undefined;
}): () => Promise<boolean> {
  /**
   * Assumed healthy at boot, so the first failure IS a transition and is reported.
   *
   * A process that starts unable to reach anything is the case this must not miss.
   */
  const previous: Record<Dependency, DependencyState> = { postgres: 'ok', redis: 'ok' };

  return async function checkReadiness(): Promise<boolean> {
    const report = await probeDependencies({
      db: opts.db,
      redis: opts.redis,
      timeoutMs: opts.timeoutMs,
    });

    for (const dependency of ['postgres', 'redis'] as const) {
      const state = report[dependency];
      const was = previous[dependency];
      previous[dependency] = state;

      if (state === 'ok') {
        if (was !== 'ok') opts.log('info', 'a readiness probe recovered', { dependency });
        continue;
      }

      const error = report.errors[dependency];
      /*
       * Logged EVERY time, so "how long was it down" is a question the logs answer.
       */
      opts.log('error', 'a readiness probe failed', {
        dependency,
        state,
        // Whether this instance is now out of rotation, which is the operational difference
        // between the two dependencies and the first thing anybody reading this wants.
        removedFromRotation: dependency === 'postgres',
        error: error instanceof Error ? error.message : String(error),
      });

      /*
       * Captured on the TRANSITION only.
       *
       * A check polled every few seconds that reported to Sentry on each poll would burn the
       * quota during exactly the outage the quota exists for, and the second report says nothing
       * the first did not. The log line above is the per-poll record.
       */
      if (was === 'ok') opts.monitor?.capture(error, opts.where, { dependency });
    }

    return report.postgres === 'ok';
  };
}
