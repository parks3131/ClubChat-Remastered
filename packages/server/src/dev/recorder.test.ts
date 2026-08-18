/**
 * The session recorder.
 *
 * Worth testing for one reason above the others: the thing it exists to produce is only read
 * AFTER the session it recorded, so a defect here is discovered at the exact moment the session
 * cannot be repeated. The ordering and the ceiling are both about that - a file with interleaved
 * lines and a file that silently stopped are the two ways to lose an hour of somebody's clicking.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecorder } from './recorder.ts';
import type { HttpTrace, TraceEvent } from './trace.ts';

const dirs: string[] = [];

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clubchat-recorder-'));
  dirs.push(dir);
  // Deliberately a path one level DEEPER than the directory that exists, so every test also
  // covers the recorder creating its own directory - which is how it behaves in the repo.
  return join(dir, 'nested', 'trace.jsonl');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const event = (n: number): TraceEvent => ({
  kind: 'http',
  id: `req-${n}`,
  method: 'GET',
  url: `/thing/${n}`,
  route: '/thing/:id',
  status: 200,
  ms: n,
  startedAt: 1_000 + n,
  userId: null,
  reqBody: null,
  resBody: null,
  at: 1_000 + n,
  source: 'api',
});

/** Let the recorder's write queue drain. It is deliberately fire-and-forget from the caller. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('createRecorder', () => {
  it('writes one whole event per line, in the order they arrived', async () => {
    const path = await tempPath();
    const recorder = createRecorder(path);

    for (let n = 0; n < 25; n++) recorder.write(event(n));
    await settle();

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(25);

    // Every line parses on its own, which is the property JSON Lines is chosen for and the one
    // that concurrent appends would break.
    // Read back as the HTTP shape these events are, since `TraceEvent` is a union and the
    // assertion below is about a field only one member carries.
    const parsed = lines.map((line) => JSON.parse(line) as HttpTrace);
    expect(parsed.map((e) => e.ms)).toEqual([...Array(25).keys()]);
  });

  it('keeps what it has when it reaches the ceiling, rather than truncating or rotating', async () => {
    const path = await tempPath();
    const log: string[] = [];
    // Room for a couple of events and no more.
    const recorder = createRecorder(path, { maxBytes: 700, log: (message) => log.push(message) });

    for (let n = 0; n < 50; n++) recorder.write(event(n));
    await settle();

    const stats = recorder.stats();
    expect(stats.stopped).toBe(true);
    expect(stats.bytes).toBeLessThanOrEqual(700);

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(stats.events);
    // The BEGINNING is what survives. A rotation would have discarded exactly this.
    expect((JSON.parse(lines[0]!) as HttpTrace).ms).toBe(0);

    // Said once, not once per dropped event.
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('stopped');
  });

  it('does nothing, and reports nothing, without a path', async () => {
    const recorder = createRecorder(null);
    recorder.write(event(1));
    await settle();

    expect(recorder.stats()).toEqual({ path: null, events: 0, bytes: 0, stopped: false });
  });

  it('counts what it accepted, so the page can say whether a session was captured', async () => {
    const path = await tempPath();
    const recorder = createRecorder(path);

    recorder.write(event(1));
    recorder.write(event(2));
    await settle();

    const stats = recorder.stats();
    expect(stats.events).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.stopped).toBe(false);
    expect(stats.path).toBe(path);
  });
});
