#!/usr/bin/env node
//
// The self-test for the restore drill's PROOF, run against a throwaway Postgres container.
//
// Why this file exists at all. `restore-drill.mjs` cannot be run outside a real Neon project, so
// the only part of it anybody could ever exercise on a laptop is the part that decides whether a
// restored database is actually a restored database. That part is `restore-proof.mjs`, and a
// proof that has never been seen to FAIL has proved nothing (AGENTS.md standing instruction 11):
// a gate asserting `count(*) >= 1` against a table that was already full is indistinguishable
// from a gate that is not wired up.
//
// So this drives the proof through three states of one real database and asserts what it says
// about each:
//
//   1. EMPTY          - no schema at all. The table check must FAIL.
//   2. MIGRATED       - the repo's own migrations applied, no rows. The schema and migration
//                       ledger checks must PASS and the row-count gate must FAIL. This is the
//                       state a "successful" restore of the wrong thing would land in, and it is
//                       the whole reason the drill asserts rows rather than an API status code.
//   3. SEEDED         - a handful of real rows, from the same fixtures `constraint-proof.sql`
//                       uses. Everything must PASS.
//
// Plus one more, because the point-in-time check is the one that is easiest to write in a way
// that can never fail:
//
//   4. SEEDED, with the restore timestamp set BEFORE the rows were written. The point-in-time
//      check must FAIL, proving it compares something.
//
// Run with:  node scripts/drills/restore-proof.selftest.mjs
// It needs Docker. It starts and destroys its own container and touches nothing else - in
// particular it never looks at DATABASE_URL, so it cannot reach the development stack.

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { readExpectedMigrations, renderChecks, runProof } from './restore-proof.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The same fixtures `packages/server/src/db/constraint-proof.sql` opens with.
 *
 * Copied rather than imported, because that file is a transaction that rolls itself back and
 * exists to prove constraints fire. Here the rows have to survive, and the only property that
 * matters is that they are rows a real deployment could hold.
 */
const SEED = `
INSERT INTO users (id, full_name, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'alice@drill.invalid'),
  ('22222222-2222-4222-8222-222222222222', 'Bob',   'bob@drill.invalid');

INSERT INTO clubs (id, name, invite_token, member_invite_token) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Drill Running Club', 'tok-a', 'mtok-a');

INSERT INTO club_memberships (club_id, user_id, role) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner');

INSERT INTO channels (id, club_id, scope, scope_id) VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'club',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

INSERT INTO messages (channel_id, seq, sender_id, type, body, client_msg_id) VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1,
   '11111111-1111-4111-8111-111111111111', 'text', 'first',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
`;

let failures = 0;

function expect(label, actual, wanted) {
  if (actual === wanted) {
    process.stdout.write(`ok    ${label} (${actual})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`FAIL  ${label}: wanted ${wanted}, got ${actual}\n`);
}

function checkNamed(checks, name) {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`the proof reported no check named "${name}"`);
  return found;
}

async function proofAgainst(uri, options) {
  const client = new pg.Client({ connectionString: uri });
  await client.connect();
  try {
    return await runProof(client, options);
  } finally {
    await client.end();
  }
}

const container = await new PostgreSqlContainer('postgres:17-alpine').start();
const uri = container.getConnectionUri();
process.stdout.write(`throwaway postgres up: ${uri.replace(/:[^:@]*@/, ':***@')}\n\n`);

try {
  const migrations = await readExpectedMigrations(root);
  process.stdout.write(
    `repo expects ${migrations.count} migrations, newest stamped ${migrations.latestWhen}\n\n`,
  );

  // 1. EMPTY
  process.stdout.write('--- state 1: empty database ---\n');
  const empty = await proofAgainst(uri, { migrations, allowWrite: true, restoredTo: null });
  process.stdout.write(renderChecks(empty.checks));
  expect('empty database is rejected', empty.ok, false);
  expect('empty database: tables-present fails', checkNamed(empty.checks, 'tables-present').ok, false);

  // 2. MIGRATED, no rows
  process.stdout.write('\n--- state 2: migrated, no rows ---\n');
  execFileSync('node', ['packages/server/src/db/migrate.ts'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: uri },
    stdio: 'inherit',
  });
  const migrated = await proofAgainst(uri, { migrations, allowWrite: true, restoredTo: null });
  process.stdout.write(renderChecks(migrated.checks));
  expect('migrated but empty is rejected', migrated.ok, false);
  expect('migrated: tables-present passes', checkNamed(migrated.checks, 'tables-present').ok, true);
  expect(
    'migrated: migration-ledger passes',
    checkNamed(migrated.checks, 'migration-ledger').ok,
    true,
  );
  expect('migrated: row-counts fails', checkNamed(migrated.checks, 'row-counts').ok, false);
  expect('migrated: writable passes', checkNamed(migrated.checks, 'writable').ok, true);

  // 3. SEEDED
  process.stdout.write('\n--- state 3: seeded with real rows ---\n');
  const seeder = new pg.Client({ connectionString: uri });
  await seeder.connect();
  await seeder.query(SEED);
  await seeder.end();

  const seeded = await proofAgainst(uri, {
    migrations,
    allowWrite: true,
    restoredTo: new Date(Date.now() + 60_000),
  });
  process.stdout.write(renderChecks(seeded.checks));
  expect('seeded database passes', seeded.ok, true);
  expect('seeded: row-counts passes', checkNamed(seeded.checks, 'row-counts').ok, true);
  expect(
    'seeded: referential-integrity passes',
    checkNamed(seeded.checks, 'referential-integrity').ok,
    true,
  );
  expect('seeded: point-in-time passes', checkNamed(seeded.checks, 'point-in-time').ok, true);

  // 4. SEEDED, restore timestamp before the rows exist
  process.stdout.write('\n--- state 4: seeded, restore timestamp in the past ---\n');
  const stale = await proofAgainst(uri, {
    migrations,
    allowWrite: true,
    restoredTo: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  process.stdout.write(renderChecks(stale.checks));
  expect('rows newer than the restore point are rejected', stale.ok, false);
  expect('stale: point-in-time fails', checkNamed(stale.checks, 'point-in-time').ok, false);
} finally {
  await container.stop();
  process.stdout.write('\nthrowaway postgres destroyed\n');
}

if (failures > 0) {
  process.stderr.write(`\n${failures} self-test expectation(s) unmet\n`);
  process.exit(1);
}
process.stdout.write('\nrestore proof self-test: all expectations met\n');
