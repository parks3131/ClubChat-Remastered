/**
 * The two monitoring drills, tested as code rather than trusted as procedure.
 *
 * > **The founder's complaint is that no production error has ever reached a human.** Everything
 * > between a `throw` and a phone buzzing - the error handler, the DSN, the network egress, the
 * > Sentry project's alert rule, the inbox rule that files it - has never been exercised end to
 * > end, and every piece of it looks fine from the inside. A drill is the only thing that answers
 * > it, and a drill nobody has run is a paragraph in a document.
 *
 * So the drills are code, and this is what proves the code does what its script claims:
 *
 *  1. **The forced 5xx really goes through the production error handler.** Not a `capture` call
 *     with a made-up `where`: the real `buildApp`, the real `setErrorHandler`, the real opaque
 *     `{ error: 'internal' }` response. The only thing the drill adds is a route registered on
 *     the built instance, which is exactly what `error-reporting.test.ts` already does and is why
 *     the production API needs no route that throws on purpose.
 *  2. **The parked-outbox drill parks its own event and NOTHING else.** This one writes to a
 *     database, so the property that matters is not that it works but that it cannot reach a real
 *     pending effect: a synthetic partition of its own, and a revert that deletes by that
 *     partition rather than by "parked".
 *  3. **Both scripts refuse to run when nobody named the target.** The whole hazard of an
 *     operational script is running it against the wrong thing, and the refusal is the feature.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DRILL_ROUTE, forceFiveHundred } from '../drills/forced-5xx.ts';
import {
  DRILL_EVENT_TYPE,
  DRILL_PARTITION_PREFIX,
  insertDrillEvent,
  readDrillEvent,
  removeDrillEvents,
} from '../drills/outbox-park.ts';
import type { Monitor } from '../monitoring.ts';
import { RecordingPushSender } from '../push/sender.ts';
import { drainOnce, MAX_ATTEMPTS } from '../worker/drain.ts';
import type { EffectDeps } from '../worker/effects.ts';
import { parkedEventCount } from '../worker/retention.ts';
import { startTestDb, type TestDb } from './harness.ts';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

type Captured = { where: string; context: Record<string, unknown> | undefined };

function spyMonitor(): { captured: Captured[]; monitor: Monitor } {
  const captured: Captured[] = [];
  return {
    captured,
    monitor: {
      capture(_error, where, context) {
        captured.push({ where, context });
      },
      async flush() {},
    },
  };
}

describe('the forced 5xx drill', () => {
  it('answers 500 through the real error handler and tells the caller nothing', async () => {
    const spy = spyMonitor();

    const result = await forceFiveHundred(spy.monitor);

    expect(result.status).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'internal' });
  });

  it('reports at api.request, with the route pattern, exactly as a real 500 does', async () => {
    // If the drill reported under a `where` of its own it would prove a path that does not exist:
    // the thing being drilled is the handler every real 5xx goes through.
    const spy = spyMonitor();

    await forceFiveHundred(spy.monitor);

    expect(spy.captured).toHaveLength(1);
    expect(spy.captured[0]?.where).toBe('api.request');
    expect(spy.captured[0]?.context).toMatchObject({ method: 'GET', route: DRILL_ROUTE });
  });

  it('needs no database, so it can be run from anywhere with only a DSN', async () => {
    // The drill builds the app with stub deps deliberately. Requiring the production DATABASE_URL
    // on a laptop to prove that Sentry alerts a human would be a worse trade than the stub.
    await expect(forceFiveHundred(spyMonitor().monitor)).resolves.toMatchObject({ status: 500 });
  });
});

describe('the parked-outbox drill', () => {
  let h: TestDb;

  beforeAll(async () => {
    h = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await h?.stop().catch(() => undefined);
  });

  beforeEach(async () => {
    await h.db.execute(sql`TRUNCATE outbox RESTART IDENTITY CASCADE`);
  });

  const deps = (monitor: Monitor): EffectDeps => ({
    db: h.db,
    redis: { publish: async () => 1 } as never,
    push: new RecordingPushSender(),
    monitor,
    log: () => undefined,
  });

  it('parks on the FIRST attempt, so the drill takes a tick rather than two hours', async () => {
    const spy = spyMonitor();
    const event = await insertDrillEvent(h.db);

    const result = await drainOnce(h.db, deps(spy.monitor));

    expect(result.parked).toBe(1);
    expect(await parkedEventCount(h.db)).toBe(1);

    const state = await readDrillEvent(h.db, event.id);
    expect(state?.attempts).toBe(MAX_ATTEMPTS);
    expect(state?.parked).toBe(true);
  });

  it('fires the worker.outbox.parked alarm, which is the thing being drilled', async () => {
    const spy = spyMonitor();
    const event = await insertDrillEvent(h.db);

    await drainOnce(h.db, deps(spy.monitor));

    expect(spy.captured.map((c) => c.where)).toContain('worker.outbox.parked');
    const alarm = spy.captured.find((c) => c.where === 'worker.outbox.parked');
    expect(alarm?.context).toMatchObject({
      eventId: Number(event.id),
      eventType: DRILL_EVENT_TYPE,
      partitionKey: event.partitionKey,
      permanent: true,
    });
  });

  it('parks in a partition of its own, so no real effect is ever held behind it', async () => {
    // A parked row does not block its partition (drain.ts), but a drill that borrowed a real
    // club's partition would still put a synthetic failure in that club's ordering history.
    const event = await insertDrillEvent(h.db);
    expect(event.partitionKey.startsWith(DRILL_PARTITION_PREFIX)).toBe(true);
    // Real partition keys are bare uuids - a club id, a channel id, a user id. Nothing that
    // reaches this table by any other path can carry this prefix.
    expect(event.partitionKey).not.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reverts by deleting its own rows, and leaves a REAL parked event alone', async () => {
    // The one thing this script must never do. `processed_at IS NULL AND attempts >= 8` is the
    // parked predicate, and deleting by it would destroy the durable evidence that a real effect
    // never ran - which `retention.ts` refuses to delete on a timer for exactly that reason.
    await h.db.execute(sql`
      INSERT INTO outbox (partition_key, event_type, payload, attempts, processed_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'unhandled.type', '{}'::jsonb, ${MAX_ATTEMPTS}, NULL)
    `);
    await insertDrillEvent(h.db);
    await drainOnce(h.db, deps(spyMonitor().monitor));
    expect(await parkedEventCount(h.db)).toBe(2);

    const removed = await removeDrillEvents(h.db);

    expect(removed).toBe(1);
    expect(await parkedEventCount(h.db)).toBe(1);
    const survivors = await h.db.execute<{ partition_key: string }>(
      sql`SELECT partition_key FROM outbox`,
    );
    expect(survivors.rows).toEqual([{ partition_key: '11111111-1111-4111-8111-111111111111' }]);
  });

  it('leaves a real PENDING event pending, because it never touches another partition', async () => {
    await h.db.execute(sql`
      INSERT INTO outbox (partition_key, event_type, payload)
      VALUES ('22222222-2222-4222-8222-222222222222', 'unhandled.type', '{}'::jsonb)
    `);
    await insertDrillEvent(h.db);

    await removeDrillEvents(h.db);

    const pending = await h.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM outbox WHERE processed_at IS NULL`,
    );
    expect(pending.rows[0]?.count).toBe('1');
  });
});

/**
 * The refusal, proved by running the scripts rather than by reading them.
 *
 * Both drills do something an operator would not want to do twice, in a place they might not have
 * meant: one posts a fake incident into whatever Sentry project the environment points at, the
 * other writes to whatever database `DATABASE_URL` names. Naming the target is the whole of the
 * protection, so the exit code with no arguments is a behaviour and not a convention.
 */
describe('both drill scripts', () => {
  const scripts = ['forced-5xx.mjs', 'outbox-park.mjs'] as const;

  for (const script of scripts) {
    it(`${script} refuses to run when nobody named the target`, async () => {
      const file = path.join(repoRoot, 'scripts/drills', script);

      const failure = await run('node', [file], { cwd: repoRoot }).catch((error: unknown) => error);

      const { code, stderr } = failure as { code: number; stderr: string };
      expect(code).toBe(2);
      expect(stderr).toMatch(/--target/);
    }, 30_000);

    it(`${script} refuses before it reads any credential from the environment`, async () => {
      // The order matters: a script that connected first and validated second would have already
      // reached production by the time it told you off.
      const file = path.join(repoRoot, 'scripts/drills', script);

      const failure = await run('node', [file], {
        cwd: repoRoot,
        env: { ...process.env, DATABASE_URL: 'postgres://unreachable.invalid/x', SENTRY_DSN: '' },
      }).catch((error: unknown) => error);

      const { code, stderr } = failure as { code: number; stderr: string };
      expect(code).toBe(2);
      expect(stderr).not.toMatch(/unreachable\.invalid/);
    }, 30_000);
  }
});
