#!/usr/bin/env node
//
// The database restore drill: prove a Neon backup can be turned back into a working database.
//
//   NEON_PROJECT_ID=... node scripts/drills/restore-drill.mjs --target restore-drill-2026-08-25
//   NEON_PROJECT_ID=... NEON_API_KEY=... node scripts/drills/restore-drill.mjs \
//       --target restore-drill-2026-08-25 --at 2026-08-25T09:00:00Z --execute
//
// **A backup nobody has restored is a hope.** Neon's history window is continuous and its
// restores are a branch away, which makes it very easy to never test one: the dashboard says the
// history is there, and it is, right up until the evening somebody needs it and discovers that
// the schema, the roles or the retention window are not what they assumed.
//
// ## The three safety properties, and how each is enforced
//
// **1. It restores onto a NEW branch and never onto production.** This script issues exactly two
// mutating calls: `POST /branches` to create one, and `DELETE /branches/{id}` on the branch it
// just created. It never calls `POST /branches/{id}/restore`, which is the endpoint that rewrites
// an EXISTING branch in place, and which is what "restore the database" means to most people.
// That endpoint does not appear in this file. Nothing here can overwrite production, because
// nothing here has a code path that writes to a branch it did not create.
//
// **2. The target has to be named, and a production name is refused.** No default target, so
// there is nothing to run by accident. The name is checked against production identifiers FIRST
// (`main`, `prod`, `production`, anything containing `prod`, and the project's actual default
// branch), then against a required `restore-drill-` prefix, then for the charset Neon accepts.
// Ordering the production check first is deliberate: `--target main` must be refused for the
// reason that matters, not for a prefix.
//
// **3. It never reads DATABASE_URL.** The only connection string it can ever use is the one the
// Neon API hands back for the branch this run created, and even that is checked against the
// production endpoint hosts before a client is opened. A drill that connected to whatever was in
// the environment would be one stale `.env` away from running DDL on production.
//
// ## What it proves
//
// The API answering `201 Created` proves a branch exists. `restore-proof.mjs` holds what
// "restored" actually means, and it is queries against the restored database: the schema is
// there, the migration ledger matches this repo exactly, the core tables hold real rows, nothing
// is newer than the restore point, no row points at a parent that is missing, and a transaction
// commits. See that file, and `restore-proof.selftest.mjs`, which drives those checks through an
// empty, a migrated and a seeded database on a laptop so they have been watched failing.
//
// ## Why this one is Node and the other two are bash
//
// `scripts/` holds both (`surface-gate.sh` beside `check-emdash.mjs`), and the rule this repo
// follows is that a script reaches for Node when it needs something the shell would have to
// shell out for. This one has to connect to Postgres and run queries, and there is no `psql` on
// the machine this was written on - `packages/server` already depends on `pg`, which resolves
// from the repo root. The rollback and DMARC drills drive `fly` and `dig`, which are commands,
// so they are bash.
//
// ## Defaults
//
// Dry run. `--execute` is the only thing that makes it act, and without a `NEON_API_KEY` it will
// not even do that. In dry run WITH a key it still performs the read-only reconnaissance - the
// project, the branch list, the endpoint hosts - so the plan it prints is the real one rather
// than a template.
//
// On failure it KEEPS the branch and prints the delete command, because a failed restore is the
// one you want to look at. On success it deletes the branch unless `--keep` says otherwise.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { readExpectedMigrations, renderChecks, renderCounts, runProof } from './restore-proof.mjs';

const API = 'https://console.neon.tech/api/v2';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const REQUIRED_PREFIX = 'restore-drill-';
const HTTP_TIMEOUT_MS = 30_000;
const OPERATION_POLL_MS = 5_000; // Neon's own documented interval.
const OPERATION_TIMEOUT_MS = 10 * 60_000;
const CONNECT_ATTEMPTS = 10;
const CONNECT_RETRY_MS = 3_000;

/**
 * Names that must never be handed to `--target`.
 *
 * Belt and braces beside the live check against the project's real default branch below: this
 * list fires before a single HTTP call is made, so `--target main` is refused even with no API
 * key present, and refused for the right reason.
 */
const PRODUCTION_NAMES = new Set([
  'main',
  'master',
  'prod',
  'production',
  'primary',
  'default',
  'live',
  'clubchat',
  'clubchat-prod',
  'clubchat-production',
]);

/** Only `finished`, `skipped` and `cancelled` are terminal. `failed` is retryable, so it is not. */
const TERMINAL_OPERATION_STATES = new Set(['finished', 'skipped', 'cancelled']);

const USAGE = `
Restore drill: restore Neon history onto a NEW branch and prove it came back.

  node scripts/drills/restore-drill.mjs --target <name> [--at <RFC3339>] [--execute] [--keep]

  --target <name>   REQUIRED. The branch to create. Must start with "${REQUIRED_PREFIX}".
                    A production identifier is refused.
  --at <RFC3339>    The moment to restore to. Default: one hour ago.
  --execute         Actually create the branch. Without this, nothing is changed.
  --keep            Leave the branch behind after a successful drill.
  --help            This.

Environment:
  NEON_PROJECT_ID   REQUIRED, always.
  NEON_API_KEY      REQUIRED to --execute, and used for read-only reconnaissance in a dry run.

Neither is read from a file. Nothing in this repo holds either value (non-negotiable 5).
`;

function fail(message) {
  process.stderr.write(`\nREFUSED: ${message}\n`);
  process.exit(2);
}

/*
 * A drill is read by an operator, not by a developer with the file open.
 *
 * This script is a linear top-level-await program, matching the other scripts in this repo, and
 * an ESM top-level await that rejects prints a V8 stack trace and the offending source line. That
 * is the wrong output for "your API key is wrong": the message is buried in the middle of it.
 * These two turn any escaped failure into one line and a non-zero exit. Exit 1 rather than 2,
 * because 2 means "I refused" and 1 means "I tried and it did not work".
 */
const die = (error) => {
  process.stderr.write(`\nERROR: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
};
process.on('unhandledRejection', die);
process.on('uncaughtException', die);

function redactUri(uri) {
  return uri.replace(/\/\/[^@]*@/, '//***:***@');
}

async function neon(apiKey, method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    // Only the message field, never the whole body: a branch response carries role passwords.
    const message = parsed?.message ?? parsed?.error ?? `${text.slice(0, 200)}`;
    throw new Error(`${method} ${route} -> ${response.status}: ${message}`);
  }
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOperations(apiKey, projectId, operations) {
  const pending = operations.map((operation) => operation.id);
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;

  for (const id of pending) {
    for (;;) {
      const { operation } = await neon(apiKey, 'GET', `/projects/${projectId}/operations/${id}`);
      process.stdout.write(`  operation ${operation.action} ${operation.status}\n`);
      if (operation.status === 'finished' || operation.status === 'skipped') break;
      if (TERMINAL_OPERATION_STATES.has(operation.status)) {
        throw new Error(`operation ${id} (${operation.action}) ended ${operation.status}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`operation ${id} (${operation.action}) still ${operation.status} after 10m`);
      }
      await sleep(OPERATION_POLL_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Arguments, and the refusals that come before any network call
// ---------------------------------------------------------------------------

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      target: { type: 'string' },
      at: { type: 'string' },
      execute: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  }));
} catch (error) {
  process.stderr.write(`${error.message}\n${USAGE}`);
  process.exit(2);
}

if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const target = args.target?.trim();
if (!target) fail(`no --target. Name the branch to create, e.g. --target ${REQUIRED_PREFIX}2026-08-25.${USAGE}`);

const lowered = target.toLowerCase();
if (PRODUCTION_NAMES.has(lowered) || lowered.includes('prod') || lowered.startsWith('br-')) {
  fail(
    `"${target}" reads as a production identifier. This drill only ever creates a NEW branch, ` +
      'and it will not be pointed at an existing one.',
  );
}
if (!target.startsWith(REQUIRED_PREFIX)) {
  fail(
    `"${target}" must start with "${REQUIRED_PREFIX}" so that every branch this drill leaves ` +
      'behind is identifiable at a glance.',
  );
}
if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(target)) {
  fail(`"${target}" is not a usable branch name. Lower case, digits, dot, dash, underscore.`);
}

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) fail('NEON_PROJECT_ID is not set. It is the project to drill, and it has no default.');

const apiKey = process.env.NEON_API_KEY?.trim();
if (!apiKey && args.execute) {
  fail('NEON_API_KEY is not set, so --execute cannot do anything. Export it for this shell only.');
}

const restoredTo = args.at ? new Date(args.at) : new Date(Date.now() - 60 * 60_000);
if (Number.isNaN(restoredTo.getTime())) fail(`--at "${args.at}" is not a date. Use RFC 3339, e.g. 2026-08-25T09:00:00Z.`);
if (restoredTo.getTime() > Date.now()) fail(`--at ${restoredTo.toISOString()} is in the future.`);

process.stdout.write('ClubChat restore drill\n');
process.stdout.write('======================\n\n');
process.stdout.write(`project        ${projectId}\n`);
process.stdout.write(`new branch     ${target}\n`);
process.stdout.write(`restore point  ${restoredTo.toISOString()}\n`);
process.stdout.write(`mode           ${args.execute ? 'EXECUTE' : 'dry run (nothing will change)'}\n\n`);

// ---------------------------------------------------------------------------
// Read-only reconnaissance
// ---------------------------------------------------------------------------

const migrations = await readExpectedMigrations(ROOT);
process.stdout.write(
  `this repo expects ${migrations.count} migrations, newest stamped ${migrations.latestWhen}\n\n`,
);

if (!apiKey) {
  process.stdout.write(
    'NEON_API_KEY is not set, so the live checks below were skipped:\n' +
      '  - that the restore point is inside the project history window\n' +
      '  - that the target name is free\n' +
      '  - which endpoint hosts belong to production\n\n' +
      'Export NEON_API_KEY and run this again to see the real plan.\n',
  );
  process.exit(0);
}

const { branches } = await neon(apiKey, 'GET', `/projects/${projectId}/branches`);
const defaultBranch = branches.find((branch) => branch.default);
if (!defaultBranch) fail('this project has no default branch, which should be impossible. Stopping.');

const clash = branches.find((branch) => branch.name === target || branch.id === target);
if (clash) {
  fail(
    `branch "${target}" already exists (${clash.id}). This drill only ever creates a branch, ` +
      'never reuses one. Pick another name, or delete that branch first.',
  );
}
if (target === defaultBranch.name || target === defaultBranch.id) {
  fail(`"${target}" IS the project default branch. Absolutely not.`);
}

const { project } = await neon(apiKey, 'GET', `/projects/${projectId}`);
const retentionSeconds = project.history_retention_seconds ?? 0;
const oldestRestorable = new Date(Date.now() - retentionSeconds * 1000);
if (restoredTo < oldestRestorable) {
  fail(
    `--at ${restoredTo.toISOString()} is outside this project's history window of ` +
      `${retentionSeconds}s. The oldest restorable moment right now is ` +
      `${oldestRestorable.toISOString()}.`,
  );
}

const { endpoints } = await neon(apiKey, 'GET', `/projects/${projectId}/endpoints`);
const productionHosts = new Set(
  endpoints.filter((endpoint) => endpoint.branch_id === defaultBranch.id).map((e) => e.host),
);

process.stdout.write(`project name       ${project.name}\n`);
process.stdout.write(`parent branch      ${defaultBranch.name} (${defaultBranch.id})\n`);
process.stdout.write(`history window     ${retentionSeconds}s, oldest ${oldestRestorable.toISOString()}\n`);
process.stdout.write(`production hosts   ${[...productionHosts].join(', ') || '(none found)'}\n\n`);

process.stdout.write('plan\n');
process.stdout.write('----\n');
process.stdout.write(`1. POST /projects/${projectId}/branches\n`);
process.stdout.write(
  `     { branch: { name: "${target}", parent_id: "${defaultBranch.id}",\n` +
    `                parent_timestamp: "${restoredTo.toISOString()}" },\n` +
    '       endpoints: [{ type: "read_write" }] }\n',
);
process.stdout.write('2. Wait for every operation to reach a terminal state.\n');
process.stdout.write('3. Refuse to continue if the new branch is default or protected, or if its\n');
process.stdout.write('   host is one of the production hosts above.\n');
process.stdout.write('4. Connect to the NEW branch and run the proof: tables-present,\n');
process.stdout.write('   migration-ledger, row-counts, point-in-time, referential-integrity, writable.\n');
process.stdout.write(
  `5. ${args.keep ? 'Keep the branch (--keep).' : 'DELETE the branch this run created, and nothing else.'}\n`,
);
process.stdout.write('\nThis run will NEVER call POST /branches/{id}/restore. That endpoint rewrites an\n');
process.stdout.write('existing branch in place and has no place in a drill.\n\n');

if (!args.execute) {
  process.stdout.write('dry run complete. Nothing was created, changed or deleted.\n');
  process.stdout.write('Add --execute to perform the drill.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

process.stdout.write('creating the branch\n');
const created = await neon(apiKey, 'POST', `/projects/${projectId}/branches`, {
  branch: {
    name: target,
    parent_id: defaultBranch.id,
    parent_timestamp: restoredTo.toISOString(),
  },
  endpoints: [{ type: 'read_write' }],
});

const branchId = created.branch.id;
process.stdout.write(`  branch ${branchId} created, state ${created.branch.current_state}\n`);
await waitForOperations(apiKey, projectId, created.operations ?? []);

// Re-read rather than trusting the create response, because everything after this point acts on
// what this says.
const { branch } = await neon(apiKey, 'GET', `/projects/${projectId}/branches/${branchId}`);
if (branch.default || branch.protected || branch.id === defaultBranch.id) {
  fail(`branch ${branchId} came back marked default/protected. Refusing to touch it further.`);
}

// `POST /branches` returns `connection_uris` when it creates an endpoint, which is the normal
// path. The GET is the fallback for a project shaped so that it does not, and it needs the role
// and database by name rather than guessing them.
let uri = created.connection_uris?.[0]?.connection_uri;
if (!uri) {
  const database = created.databases?.[0]?.name;
  const role = created.roles?.[0]?.name;
  if (!database || !role) {
    fail(
      `branch ${branchId} came back with no connection URI and no role/database to ask for one. ` +
        'Read the connection string off the Neon console for that branch and investigate.',
    );
  }
  const query = new URLSearchParams({
    branch_id: branchId,
    database_name: database,
    role_name: role,
  });
  ({ uri } = await neon(apiKey, 'GET', `/projects/${projectId}/connection_uri?${query}`));
}
if (!uri) fail('Neon returned no connection URI for the new branch, so nothing can be proved.');

const host = new URL(uri).hostname;
if (productionHosts.has(host)) {
  fail(`the connection URI points at ${host}, which is a PRODUCTION endpoint. Stopping.`);
}
process.stdout.write(`  connecting to ${host} (${redactUri(uri)})\n\n`);

let client = null;
for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
  try {
    const candidate = new pg.Client({ connectionString: uri, connectionTimeoutMillis: 10_000 });
    await candidate.connect();
    client = candidate;
    break;
  } catch (error) {
    process.stdout.write(`  attempt ${attempt}/${CONNECT_ATTEMPTS}: ${error.message}\n`);
    if (attempt === CONNECT_ATTEMPTS) throw error;
    await sleep(CONNECT_RETRY_MS);
  }
}

let result;
try {
  result = await runProof(client, { migrations, restoredTo, allowWrite: true });
} finally {
  await client.end();
}

process.stdout.write('\nproof\n-----\n');
process.stdout.write(renderChecks(result.checks));
process.stdout.write('\nrow counts on the restored branch\n');
process.stdout.write(renderCounts(result.counts));

const deleteCommand =
  `curl -X DELETE -H "Authorization: Bearer $NEON_API_KEY" ` +
  `${API}/projects/${projectId}/branches/${branchId}`;

if (!result.ok) {
  process.stderr.write(
    `\nDRILL FAILED. Branch ${branchId} has been LEFT IN PLACE so you can look at it.\n` +
      `Delete it when you are done:\n  ${deleteCommand}\n`,
  );
  process.exit(1);
}

process.stdout.write('\nDRILL PASSED: a real database came back and answered every question.\n');

if (args.keep) {
  process.stdout.write(`\nBranch ${branchId} kept (--keep). Delete it with:\n  ${deleteCommand}\n`);
  process.exit(0);
}

process.stdout.write(`\ndeleting ${branchId}\n`);
const { branch: doomed } = await neon(apiKey, 'GET', `/projects/${projectId}/branches/${branchId}`);
if (doomed.id !== branchId || doomed.default || doomed.protected) {
  fail(`refusing to delete ${branchId}: it is not the branch this run created. Delete it by hand.`);
}
const deletion = await neon(apiKey, 'DELETE', `/projects/${projectId}/branches/${branchId}`);
await waitForOperations(apiKey, projectId, deletion.operations ?? []);
process.stdout.write('  deleted\n\nDrill complete. Production was never touched.\n');
