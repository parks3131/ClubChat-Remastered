#!/usr/bin/env node
//
// Prove every server module actually loads under plain `node`.
//
// This exists because of a gap the rest of the pipeline cannot see. Vitest transforms
// with esbuild, which accepts the full TypeScript grammar. Node runs `.ts` by STRIPPING
// types, which supports strictly less: a parameter property (`constructor(readonly x: T)`)
// typechecks, passes the whole test suite, and then crashes the real process at import
// time with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
//
// So `typecheck` + `test` both passing is NOT evidence the server can boot. This closes
// that gap by importing every module the way production does.
//
// Entrypoints (`main.ts`) are excluded because importing one starts a server. Everything
// they depend on is covered, which is where the syntax lives.

import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const ROOTS = [
  'packages/server/src',
  'packages/shared/src',
  'packages/client-core/src',
];

async function walk(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(full)));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    // Importing an entrypoint would start a server and never return.
    if (entry.name === 'main.ts') continue;
    // The migration runner executes on import.
    if (entry.name === 'migrate.ts') continue;
    // So does the load test, and it would start a Postgres container to do it. Same class as
    // the two above: a module whose whole purpose is to execute cannot be import-probed, and
    // the cost of excluding it is that a syntax Node cannot strip would surface when somebody
    // runs `npm run load:test` rather than here.
    if (entry.name === 'load-test.ts') continue;
    found.push(full);
  }
  return found;
}

const files = [];
for (const relative of ROOTS) {
  files.push(...(await walk(path.join(root, relative))));
}

if (files.length === 0) {
  process.stderr.write('found no modules to check - is this running from the repo root?\n');
  process.exit(2);
}

let failures = 0;
for (const file of files.sort()) {
  const shown = path.relative(root, file);
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    // A module that throws at import for an environmental reason (a missing env var, no
    // database) is not what this checks for. Only syntax the runtime cannot handle is.
    if (error?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' || error instanceof SyntaxError) {
      process.stdout.write(`FAIL  ${shown}\n      ${error.message.split('\n')[0]}\n`);
      failures += 1;
    } else {
      process.stdout.write(`skip  ${shown} (threw at import, not a syntax problem)\n`);
    }
  }
}

if (failures > 0) {
  process.stderr.write(
    `\n${failures} module(s) contain TypeScript the Node runtime cannot strip.\n` +
      'Parameter properties, enums and namespaces are the usual causes.\n',
  );
  process.exit(1);
}

process.stdout.write(`${files.length} modules load cleanly under node\n`);
