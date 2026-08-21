import { describe, expect, it } from 'vitest';
import { createReadinessCheck } from './health.ts';
import type { Db } from './db/client.ts';
import type { Redis } from 'ioredis';

/**
 * Direct tests for the readiness module.
 *
 * The endpoint suites cover what a caller SEES - the status code and the body it must never leak.
 * This file covers what an OPERATOR sees, which is a different question with a different failure
 * mode: a probe can grade correctly and still report uselessly.
 */

const livePing = { ping: async () => 'PONG' } as unknown as Redis;
const liveExecute = { execute: async () => undefined } as unknown as Db;

type Line = { level: string; message: string; detail: Record<string, unknown> };

function collect(): { lines: Line[]; log: (l: 'info' | 'error', m: string, d: Record<string, unknown>) => void } {
  const lines: Line[] = [];
  return { lines, log: (level, message, detail) => lines.push({ level, message, detail }) };
}

describe('readiness reporting', () => {
  /**
   * **Drizzle wraps driver errors, so the reason is on `.cause` and never on the thrown object.**
   *
   * `AGENTS.md` failure mode 1 records this class already: a check that reads only the top level
   * silently matches nothing, and looks correct while doing it. Here it does not corrupt the
   * verdict - `grade()` never inspects the error's shape - but it empties the log line, and the
   * comment above that line promises "how long was it down" is a question the logs answer.
   *
   * `DrizzleQueryError`'s own message is always `Failed query: <sql>\nparams: <params>`, identical
   * whether the database refused the connection, rejected the password, or was missing a grant.
   * An operator tailing stdout during the outage this endpoint exists to detect would learn only
   * that a query failed, which they already knew.
   */
  it('logs the driver reason rather than the ORM wrapper around it', async () => {
    const wrapped = new Error('Failed query: select 1 from users limit 1\nparams: ');
    (wrapped as { cause?: unknown }).cause = new Error('connect ECONNREFUSED 10.0.0.1:5432');

    const { lines, log } = collect();
    const check = createReadinessCheck({
      db: { execute: async () => Promise.reject(wrapped) } as unknown as Db,
      redis: livePing,
      where: 'test.ready',
      log,
    });

    await check();

    const failure = lines.find((line) => line.level === 'error');
    expect(failure).toBeDefined();
    expect(String(failure?.detail['error'])).toContain('ECONNREFUSED');
  });

  /**
   * The other half of the same fix: walking the chain must not lose the ordinary case, where
   * nothing wrapped anything and the thrown error is already the useful one.
   */
  it('logs an unwrapped error message unchanged', async () => {
    const { lines, log } = collect();
    const check = createReadinessCheck({
      db: { execute: async () => Promise.reject(new Error('permission denied for table users')) } as unknown as Db,
      redis: livePing,
      where: 'test.ready',
      log,
    });

    await check();

    const failure = lines.find((line) => line.level === 'error');
    expect(String(failure?.detail['error'])).toContain('permission denied for table users');
  });

  /**
   * Redis is the degrade case, so its report is the only evidence it happened at all. A 200 that
   * says nothing anywhere is indistinguishable from a healthy instance.
   */
  it('reports a Redis failure loudly even though the verdict stays ready', async () => {
    const { lines, log } = collect();
    const check = createReadinessCheck({
      db: liveExecute,
      redis: { ping: async () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.2:6379')) } as unknown as Redis,
      where: 'test.ready',
      log,
    });

    const ready = await check();

    expect(ready).toBe(true);
    const failure = lines.find((line) => line.level === 'error');
    expect(failure?.detail['dependency']).toBe('redis');
    expect(failure?.detail['removedFromRotation']).toBe(false);
    expect(String(failure?.detail['error'])).toContain('ECONNREFUSED');
  });
});
