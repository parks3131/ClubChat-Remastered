/**
 * The development dashboard: one page that shows what a tap actually does.
 *
 * Mounted on the API because that is the process a browser can already reach, and served
 * UNAUTHENTICATED because the point is to watch somebody else's session - a page that
 * required its own sign-in would show the dashboard's traffic rather than the app's.
 *
 * That is only defensible because it cannot exist outside development. `registerDevDashboard`
 * is called from one place, behind `devTraceEnabled()`, and refuses again here. Both checks
 * are kept: the caller's is what stops the routes being registered, and this one is what stops
 * a future caller from registering them by accident.
 *
 * Three routes:
 *
 *   GET /dev/trace           the page
 *   GET /dev/trace/stream    server-sent events, one per traced interaction
 *   GET /dev/trace/catalogue every REST route this server has, with the note the spec
 *                            writes about it
 *
 * The catalogue is the half that turns "click everything" into something with an end. The
 * server knows its own route table, so the page can show which routes have been exercised and
 * which have not, and a walk through the app becomes a checklist rather than a guess.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { createRecorder, type Recorder } from './recorder.ts';
import { devTraceEnabled, subscribeToTrace, type TraceEvent } from './trace.ts';

/** The repository root, from this file. Also how the spec is found below. */
const repoRoot = () => join(import.meta.dirname, '..', '..', '..', '..');

/**
 * Where the session recording goes, or `null` for none.
 *
 * On by default, because the case it exists for is a long walk through the app and remembering
 * to switch a recorder on before a session is the one moment nobody is thinking about it. Set
 * `DEV_TRACE_FILE=off` to run without one, or to any path to put it somewhere else.
 */
function recordingPath(): string | null {
  const configured = process.env['DEV_TRACE_FILE'];
  if (configured === 'off') return null;
  if (configured !== undefined && configured !== '') return configured;
  return join(repoRoot(), '.dev-trace', 'trace.jsonl');
}

/** One route, as Fastify registered it. */
export type RouteEntry = { method: string; url: string };

/**
 * Pull `path -> note` out of the REST block in the protocol spec.
 *
 * The spec is the closest thing this project has to per-route documentation, and it is
 * maintained because it is the contract rather than because somebody remembers to. Reading it
 * here means the dashboard explains a route in the project's own words instead of a second
 * description that would immediately start drifting from the first.
 *
 * Written to degrade rather than fail: a missing file, a renamed heading or a reformatted
 * table costs the notes and nothing else. The page is still useful with an empty map.
 */
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Read the method/path pairs out of one line of the spec's REST block.
 *
 * The block is written for a human, so one line routinely names several routes and the
 * shorthand varies. All four of these appear, and all four mean something different:
 *
 *   GET    /me                                   one route
 *   POST   /clubs · GET/PATCH/DELETE /clubs/:id  two paths, four routes
 *   GET    /dm/threads | /dm/candidates?q=       one method, two paths
 *   POST   /channels/:id/mute | DELETE           one path, two methods, the second trailing
 *
 * Hence a small state machine rather than a regex: a method token that follows a path starts
 * a NEW group rather than joining the previous one, and a trailing method with no path after
 * it belongs to the path before it.
 */
function parseRouteLine(left: string): { method: string; path: string }[] {
  // `GET/PATCH/DELETE` is a list, not a path. Flattened first so the tokenizer below cannot
  // read `/PATCH` as a route, which is the one ambiguity in the notation.
  const flattened = left.replace(/\b(?:GET|POST|PATCH|PUT|DELETE)(?:\/(?:GET|POST|PATCH|PUT|DELETE))+\b/g, (run) =>
    run.replace(/\//g, ' '),
  );

  // Path characters deliberately exclude `?`, `[` and `{`, which is what trims
  // `/media/:id[?variant=thumb]` and `/sync?channels[]=...` back to the route itself.
  const tokens = flattened.match(/\b(?:GET|POST|PATCH|PUT|DELETE)\b|\/[A-Za-z0-9:_\-*/]*/g) ?? [];

  const pairs: { method: string; path: string }[] = [];
  let methods: string[] = [];
  let sawPath = false;
  let lastPath: string | null = null;

  for (const token of tokens) {
    if (METHODS.has(token)) {
      if (sawPath) {
        methods = [];
        sawPath = false;
      }
      methods.push(token);
      continue;
    }

    const path = token.replace(/\/$/, '');
    if (path.length < 2) continue;
    sawPath = true;
    lastPath = path;
    for (const method of methods.length > 0 ? methods : ['GET']) pairs.push({ method, path });
  }

  // `POST /channels/:id/mute | DELETE`: the trailing method applies to the path before it.
  if (!sawPath && lastPath !== null) {
    for (const method of methods) pairs.push({ method, path: lastPath });
  } else if (!sawPath && methods.length > 0 && pairs.length > 0) {
    const previous = pairs[pairs.length - 1]!.path;
    for (const method of methods) pairs.push({ method, path: previous });
  }

  return pairs;
}

/**
 * Pull `route -> note` out of the REST block in the protocol spec.
 *
 * Keyed BOTH ways: `"DELETE /me"` and `"/me"`. The method-qualified key is what a lookup
 * should prefer, because the spec documents `GET /me` and `DELETE /me` as different things
 * and a path-only map silently keeps whichever it read last. The bare key is the fallback for
 * a route whose path the spec spells slightly differently, and it is first-wins for the same
 * reason.
 */
export function parseSpecNotes(markdown: string): Record<string, string> {
  const notes: Record<string, string> = {};

  // The REST section's fenced block, and only that one. The WebSocket tables above it are
  // pipe tables rather than a code fence, so they cannot be caught by accident.
  const restIndex = markdown.indexOf('### REST');
  if (restIndex === -1) return notes;
  const fenceStart = markdown.indexOf('```', restIndex);
  if (fenceStart === -1) return notes;
  const fenceEnd = markdown.indexOf('```', fenceStart + 3);
  if (fenceEnd === -1) return notes;

  const lines = markdown.slice(fenceStart + 3, fenceEnd).split('\n');

  // A note wraps onto following lines that carry no arrow of their own, so the parser holds
  // the keys the current note belongs to until a new arrow line replaces them.
  let current: string[] = [];

  for (const line of lines) {
    const arrow = line.indexOf('←');

    if (arrow === -1) {
      // A continuation only counts while a note is open AND the line is indented past the
      // arrow column, which is what distinguishes wrapped prose from the next route.
      if (current.length > 0 && /^\s{20,}\S/.test(line)) {
        const extra = line.trim();
        for (const key of current) notes[key] = `${notes[key]} ${extra}`.trim();
      } else if (line.trim() !== '') {
        current = [];
      }
      continue;
    }

    const note = line.slice(arrow + 1).trim();
    current = [];

    for (const { method, path } of parseRouteLine(line.slice(0, arrow))) {
      const key = `${method} ${path}`;
      notes[key] = note;
      current.push(key);
      if (notes[path] === undefined) {
        notes[path] = note;
        current.push(path);
      }
    }
  }

  return notes;
}

/** Load the spec once per request, so editing the spec updates the page on refresh. */
function loadSpecNotes(): Record<string, string> {
  try {
    return parseSpecNotes(readFileSync(join(repoRoot(), 'SPEC', 'TECH', '10-protocol.md'), 'utf8'));
  } catch {
    return {};
  }
}

export type DevDashboardOptions = {
  /** A connection of its own: ioredis subscriber mode is exclusive. */
  subscriber: Redis;
  /**
   * Every route the API registered, collected by an `onRoute` hook.
   *
   * Passed by reference and read at request time rather than copied, because route
   * registration inside `app.register` is deferred until `ready()` - this array is still
   * empty when the dashboard is mounted, and full by the time anybody asks for it.
   */
  routes: RouteEntry[];
  log?: (message: string) => void;
};

export function registerDevDashboard(app: FastifyInstance, opts: DevDashboardOptions): void {
  if (!devTraceEnabled()) return;

  /** Browsers currently watching. One Redis subscription feeds all of them. */
  const clients = new Set<import('node:http').ServerResponse>();

  /**
   * A short replay for a page that connects late.
   *
   * Without it, opening the dashboard shows an empty screen until the next click, which reads
   * as broken rather than as idle. 200 events is a few seconds of a busy sync and long enough
   * to see what the app did while it was starting up.
   */
  const recent: TraceEvent[] = [];
  const RECENT_LIMIT = 200;

  /*
   * The file recording, fed from the SAME subscription the browsers are.
   *
   * One Redis subscription rather than two: a second connection just to write a file would be a
   * second thing that can lag behind the first, and then the recording and the page would
   * disagree about what happened - which is the one property a recording exists to have.
   */
  const recorder: Recorder = createRecorder(recordingPath(), { log: (message) => opts.log?.(message) });
  const started = recorder.stats().path;
  if (started !== null) opts.log?.(`dev trace: recording to ${started}`);

  subscribeToTrace(opts.subscriber, (event) => {
    recorder.write(event);

    recent.push(event);
    if (recent.length > RECENT_LIMIT) recent.shift();

    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      // A browser that has gone away fails here rather than anywhere useful. Dropping it is
      // the whole of the cleanup, because the 'close' handler may not have fired yet.
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  });

  app.get('/dev/trace', (_request, reply) => {
    reply.hijack();
    let html: string;
    try {
      html = readFileSync(join(import.meta.dirname, 'dashboard.html'), 'utf8');
    } catch (error) {
      reply.raw.writeHead(500, { 'content-type': 'text/plain' });
      reply.raw.end(`dashboard.html could not be read: ${String(error)}`);
      return;
    }

    /*
     * Headers written raw, bypassing helmet.
     *
     * The API's global policy is `default-src 'none'` because this process serves JSON and one
     * redirect and never a document. That is right, and this is the one document. Rather than
     * loosen the global policy for the sake of a dev page, the page states its own: everything
     * it needs is inline and same-origin, and nothing may be loaded from anywhere else.
     */
    reply.raw.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      'x-frame-options': 'DENY',
    });
    reply.raw.end(html);
  });

  /*
   * What the recording has captured so far.
   *
   * Exists so the page can say it out loud. A recorder that silently stopped - the ceiling, a
   * full disk, a path that cannot be written - would otherwise be discovered at the end of a
   * long session, which is exactly when the session cannot be repeated.
   */
  app.get('/dev/trace/recording', async () => recorder.stats());

  app.get('/dev/trace/catalogue', async () => {
    const notes = loadSpecNotes();

    // `/dev/*` is the observer, not the observed. HEAD and OPTIONS are Fastify's own
    // additions rather than routes anybody clicks.
    const routes = opts.routes
      .filter((route) => !route.url.startsWith('/dev/'))
      .filter((route) => route.method !== 'HEAD' && route.method !== 'OPTIONS')
      .map((route) => ({
        ...route,
        // Method-qualified first: `GET /me` and `DELETE /me` are different routes and the
        // spec describes them differently.
        note: notes[`${route.method} ${route.url}`] ?? notes[route.url] ?? null,
      }));

    return { routes, specNotes: notes };
  });

  app.get('/dev/trace/stream', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Proxies that buffer turn a live stream into a batch delivered on close.
      'x-accel-buffering': 'no',
    });

    clients.add(reply.raw);
    opts.log?.(`dev trace: browser attached (${clients.size} watching)`);

    for (const event of recent) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

    // A comment frame, which EventSource ignores. It exists so an idle connection is not
    // reaped by whatever sits between the browser and the process.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    const close = () => {
      clearInterval(heartbeat);
      clients.delete(reply.raw);
    };
    request.raw.on('close', close);
    request.raw.on('error', close);
  });
}
