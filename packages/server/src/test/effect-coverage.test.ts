/**
 * Every event a producer writes has a consumer that claims it.
 *
 * > **This exists because three did not, for the entire life of the Eboard space.** The domain
 * > wrote `eboard.join_requested`, `eboard.membership_decided` and `eboard.member_departed` into
 * > the outbox; nothing handled them. `dispatch` throws on an unknown type, which routes the
 * > event through the retry path and parks it after five attempts - the right behaviour for a
 * > producer deployed ahead of its consumer, and completely silent when the consumer is never
 * > written at all. No notification ever arrived from that space and no test noticed, because
 * > `drainOnce` absorbs a handler failure into the `attempts` column rather than rethrowing.
 *
 * So this reads the source rather than the behaviour. A runtime test can only catch an event
 * type some test happens to trigger; the gap was in the three flows no test triggered. Scanning
 * for the literals catches the next one the moment it is written, which is the only point in
 * time where the fix is cheap.
 *
 * It is deliberately a string scan and not a type-level check. `eventType` is a plain column and
 * the outbox is untyped by design - it is a durable log that outlives the code that wrote to it -
 * so there is no union for a compiler to check the table against.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handlers } from '../worker/effects.ts';

/** Where events are written from. The worker itself never emits. */
const PRODUCER_DIRS = ['domain', 'media', 'push'];

function sourceFiles(dir: string): string[] {
  const root = fileURLToPath(new URL(`../${dir}`, import.meta.url));
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(root, name));
}

/** `eventType: 'club.role_changed'` -> `club.role_changed`, with the file it came from. */
function emittedEventTypes(): Array<{ type: string; file: string }> {
  const found: Array<{ type: string; file: string }> = [];
  for (const dir of PRODUCER_DIRS) {
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/eventType:\s*'([a-z_]+\.[a-z_]+)'/g)) {
        found.push({ type: match[1]!, file: file.slice(file.lastIndexOf('/') + 1) });
      }
    }
  }
  return found;
}

describe('the outbox has no orphaned producers', () => {
  it('finds the event types at all, so the scan cannot pass by matching nothing', () => {
    const emitted = emittedEventTypes();
    // A regex that silently stops matching would turn this whole file green while proving
    // nothing, which is the exact failure mode it was written to catch elsewhere.
    expect(emitted.length).toBeGreaterThan(20);
    expect(emitted.map((e) => e.type)).toContain('club.role_changed');
  });

  it('has a handler for every event type a producer writes', () => {
    const orphans = emittedEventTypes()
      .filter((emitted) => handlers[emitted.type] === undefined)
      // Reported with their file, because "no handler for X" is only half the address.
      .map((emitted) => `${emitted.type} (emitted by ${emitted.file})`);

    expect(
      [...new Set(orphans)],
      'these events are written to the outbox and nothing consumes them, so they will park',
    ).toEqual([]);
  });
});
