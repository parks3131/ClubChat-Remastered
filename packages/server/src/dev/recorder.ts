/**
 * Write the development trace to a file, so a session outlives the page watching it.
 *
 * ## Why the dashboard alone is not enough
 *
 * The page keeps a 200-event replay buffer, which is the right size for "I clicked something,
 * what happened" and the wrong size for anything longer. Walking the whole route surface is
 * thousands of events over the better part of an hour, and by the end the beginning is gone -
 * so the only part anybody could analyse would be the tail, which is the part they were already
 * watching. A file has no such window.
 *
 * It also survives what a browser tab does not: an API restart under `node --watch`, a laptop
 * lid, a tab closed by accident, and the several minutes somebody spends making a cup of tea
 * halfway through. Recording is a property of the server rather than of anyone being present.
 *
 * ## Shape
 *
 * JSON Lines, one event per line, appended. Chosen because it is the format that survives being
 * interrupted: a truncated file is every complete line up to the cut, and a reader can start
 * anywhere. A single JSON array would be unreadable unless the process closed it properly, which
 * is precisely what a crash does not do.
 *
 * ## The two guards
 *
 * **Writes are serialized.** Appends are chained onto one promise rather than fired
 * concurrently. An `O_APPEND` write is only atomic up to a size the kernel decides, and a trace
 * event carries message bodies - so two large events written at once could interleave into a
 * line that parses as neither.
 *
 * **There is a ceiling.** A file nobody is watching can fill a disk. At the limit it stops,
 * says so once, and leaves what it has rather than truncating or rotating: a partial recording
 * of the beginning is useful, and a rotation would silently discard the part somebody was
 * looking for.
 */

import { statSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TraceEvent } from './trace.ts';

/** How much is already there, or zero if there is nothing (or nothing readable). */
function existingSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Enough for a very long walk through the app; small enough to never be a disk problem. */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export type RecorderStats = {
  path: string | null;
  events: number;
  bytes: number;
  /** True once the ceiling was hit. Recording has stopped; the file is intact. */
  stopped: boolean;
};

export type Recorder = {
  write: (event: TraceEvent) => void;
  stats: () => RecorderStats;
};

/**
 * A recorder writing to `path`, or one that does nothing.
 *
 * `null` is an accepted argument rather than an error, so a caller can write
 * `createRecorder(enabled ? path : null)` without branching around the wiring - the same shape
 * `createTracer` uses.
 */
export function createRecorder(
  path: string | null,
  opts: { maxBytes?: number; log?: (message: string) => void } = {},
): Recorder {
  if (path === null) {
    return { write: () => undefined, stats: () => ({ path: null, events: 0, bytes: 0, stopped: false }) };
  }

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let events = 0;

  /*
   * Seeded from what is already on disk, because the file outlives the process.
   *
   * The API runs under `node --watch` in development, so a session spans several restarts - and
   * a ceiling counted from zero each time is not a ceiling at all, it is a ceiling per restart.
   * Recording APPENDS across restarts on purpose (that is most of why a file beats a browser
   * tab), so the limit has to be measured the same way.
   *
   * `events` deliberately is NOT seeded: counting lines means reading the whole file at boot,
   * and it is a progress figure for the page rather than a number anything depends on.
   */
  let bytes = existingSize(path);
  let stopped = false;
  let ensured = false;

  // The write queue. Every append is chained onto the previous one, so lines cannot interleave
  // and the file is always a sequence of whole events.
  let queue: Promise<void> = Promise.resolve();

  return {
    write(event: TraceEvent) {
      if (stopped) return;

      let line: string;
      try {
        line = `${JSON.stringify(event)}\n`;
      } catch {
        // A payload that will not serialize costs one line. The tracer already redacts and caps,
        // so this is close to unreachable, and it must never take the recording down.
        return;
      }

      if (bytes + line.length > maxBytes) {
        stopped = true;
        opts.log?.(`dev trace: recording stopped at ${maxBytes} bytes, kept ${events} events in ${path}`);
        return;
      }

      events += 1;
      bytes += line.length;

      queue = queue
        .then(async () => {
          // Created on the first write rather than at construction, so a disabled or unused
          // recorder never leaves an empty directory behind.
          if (!ensured) {
            await mkdir(dirname(path), { recursive: true });
            ensured = true;
          }
          await appendFile(path, line, 'utf8');
        })
        .catch((error: unknown) => {
          // A failed write must not poison the chain, or every later append rejects too. Report
          // once and carry on: a recording with a hole in it is worth more than none.
          if (!stopped) {
            stopped = true;
            opts.log?.(`dev trace: recording stopped, ${String(error)}`);
          }
        });
    },

    /*
     * What is actually on disk, and a reconciliation.
     *
     * > **Deleting the file to start a fresh session must not leave the ceiling full.** The byte
     * > count is seeded from the file at boot so the limit survives a restart, which means after
     * > a manual `rm` the counter believes in bytes that are no longer there - and if the old
     * > file was near the limit, the new recording would stop on its first event. That is a
     * > trap set precisely for the workflow this exists to support.
     *
     * So the truth on disk wins whenever it is SMALLER. Growing is never adopted from here,
     * because another writer appending to the same path is not a thing to accommodate silently.
     * The page polls this every few seconds, so it heals within one tick.
     */
    stats: () => {
      const onDisk = existingSize(path);
      if (onDisk < bytes) {
        // A file that SHRANK was replaced, which in practice means somebody deleted it to start
        // a fresh session. The event count is about the current recording, so it starts again
        // too - otherwise the page reports a total for a file that no longer contains them.
        bytes = onDisk;
        events = 0;
      }
      return { path, events, bytes, stopped };
    },
  };
}
