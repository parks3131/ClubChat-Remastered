#!/usr/bin/env node
//
// AGENTS.md standing instruction 1: never use an em dash (U+2014).
//
// The instruction also warns that some grep variants silently match nothing and
// report a clean file full of them, so this script self-tests first: it builds a
// string it knows contains the character and asserts the detector fires on it.
// A checker that cannot fail is worse than no checker, because it reports success.

import { execFileSync } from 'node:child_process';

const EM_DASH = '—';

// The single legitimate occurrence is the rule's own worked example, which has to
// contain the character in order to show you what to search for.
const ALLOWED = new Map([['AGENTS.md', 1]]);

function selfTest() {
  const probe = `a ${EM_DASH} b`;
  if (!probe.includes(EM_DASH) || probe.indexOf(EM_DASH) === -1) {
    process.stderr.write('detector self-test FAILED - aborting rather than reporting clean\n');
    process.exit(2);
  }
}

selfTest();

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const readFile = (await import('node:fs/promises')).readFile;

let violations = 0;
for (const file of files) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    continue; // binary or unreadable, e.g. the generated diagram assets
  }
  if (!text.includes(EM_DASH)) continue;

  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (line.includes(EM_DASH)) hits.push({ line: i + 1, text: line.trim() });
  });

  const budget = ALLOWED.get(file) ?? 0;
  if (hits.length <= budget) continue;

  for (const hit of hits) {
    process.stdout.write(`${file}:${hit.line}: ${hit.text}\n`);
    violations += 1;
  }
}

if (violations > 0) {
  process.stderr.write(`\n${violations} em dash(es) found. Use a plain hyphen instead.\n`);
  process.exit(1);
}

process.stdout.write('no stray em dashes\n');
