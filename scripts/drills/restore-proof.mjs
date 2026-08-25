#!/usr/bin/env node
//
// What "the restore worked" actually means, expressed as queries against the restored database.
//
// This module holds the assertions and nothing else. It opens no connection, reads no
// environment, and takes no action - `restore-drill.mjs` creates the branch and hands this an
// already-connected client. That split exists so the assertions can be exercised on a laptop
// against a throwaway container (`restore-proof.selftest.mjs`) rather than only ever running for
// the first time against a real restore, at the moment somebody needs the answer.
//
// **The failure this file exists to catch is a restore that succeeds and restores nothing.**
// Neon answering `201 Created` and an operation reaching `finished` says the branch exists. It
// says nothing about whether the branch holds the schema, the rows, or a moment in time anybody
// asked for, and all three have the same shape from the API: a green response. So every check
// below is a question the database has to answer with data.
//
// The checks, and what each one rules out:
//
//   tables-present         The restore produced an EMPTY branch, or a branch of the wrong project.
//   migration-ledger       The restore landed on a schema that is not the one this code expects,
//                          which is what a point in time before the last migration looks like.
//   row-counts             The restore produced a correctly migrated database with nothing in it.
//                          This is the one that makes the whole drill worth running.
//   point-in-time          The branch is a copy of HEAD rather than of the requested moment. It
//                          can only ever prove "not newer than", which is stated here rather
//                          than implied, because that is genuinely all a timestamp can prove.
//   referential-integrity  The restore is internally torn: rows pointing at parents that are not
//                          there.
//   writable               The branch is a real database you could promote, not just one you can
//                          read. Proved by running a transaction, on the drill branch only.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The tables the restore has to have brought back, and the ones whose counts get printed.
 *
 * A fixed list rather than "every table in the schema", because this is a proof an operator reads
 * at 2am: twelve numbers that mean something beat sixty that do not. Every name here is a
 * constant in this file and never interpolated from an argument - they are inlined into SQL.
 */
export const CORE_TABLES = [
  'users',
  'clubs',
  'club_memberships',
  'channels',
  'messages',
  'calendar_events',
  'news_posts',
  'media_objects',
  'devices',
  'notifications',
  'outbox',
  'emoji_catalog',
];

/**
 * The gate. A restored production database that fails any of these is not a restored production
 * database, whatever the API said.
 *
 * One row is deliberately the bar rather than a number close to production's real count. The
 * question this drill answers is "did the data come back", and a count that has to be updated
 * whenever the club grows is a gate that gets loosened until it means nothing.
 *
 * **`users` alone would not catch an empty restore, which is why the other four are here.**
 * Migration `0001_seed_system_actor` inserts a user, so a freshly migrated database with no usage
 * at all already satisfies `users >= 1`. Measured, not assumed: state 2 of the self-test reports
 * `below the gate: clubs=0, club_memberships=0, channels=0, messages=0` and does not mention
 * `users`, because that one had already passed. Those four have no seeded rows, and they are the
 * ones doing the work.
 */
export const DEFAULT_MIN_ROWS = {
  users: 1,
  clubs: 1,
  club_memberships: 1,
  channels: 1,
  messages: 1,
};

/** Tables with a `created_at` the point-in-time check can compare against. */
const RECENCY_TABLES = ['users', 'clubs', 'messages'];

/**
 * Tolerance on the point-in-time comparison.
 *
 * Not for clock skew between this laptop and Neon's storage, which is not something five seconds
 * would rescue. It is here so that a restore requested at "now" - which the drill discourages and
 * allows - does not fail on a row written in the same second the request was made.
 */
const RECENCY_TOLERANCE_MS = 5_000;

const ORPHAN_CHECKS = [
  {
    label: 'club_memberships without a club',
    sql: `SELECT count(*)::int AS n FROM club_memberships m
            LEFT JOIN clubs c ON c.id = m.club_id WHERE c.id IS NULL`,
  },
  {
    /*
     * A DM channel has no club BY DESIGN, and the schema enforces it:
     * `check('channels_dm_has_no_club', (club_id is null) = (scope = 'dm'))`.
     *
     * The first version of this check omitted the scope and reported production's four direct
     * message channels as orphans, on the first real run of the drill. That is the worse kind of
     * failure for a drill to have: it cries wolf on healthy data, and a drill nobody believes is
     * a drill nobody runs. Excluding `dm` is the whole fix.
     */
    label: 'club channels without a club',
    sql: `SELECT count(*)::int AS n FROM channels ch
            LEFT JOIN clubs c ON c.id = ch.club_id
           WHERE c.id IS NULL AND ch.scope <> 'dm'`,
  },
  {
    /* The other half of the same constraint, which nothing was checking at all. */
    label: 'dm channels that wrongly carry a club',
    sql: `SELECT count(*)::int AS n FROM channels WHERE scope = 'dm' AND club_id IS NOT NULL`,
  },
  {
    label: 'messages without a channel',
    sql: `SELECT count(*)::int AS n FROM messages m
            LEFT JOIN channels ch ON ch.id = m.channel_id WHERE ch.id IS NULL`,
  },
];

/**
 * What the repo says the schema should be, read from the migration journal.
 *
 * The journal rather than a count of `.sql` files, because the journal is what the migrator
 * writes into `drizzle.__drizzle_migrations`: one row per entry, with `created_at` set to that
 * entry's `when`. Comparing both the count and the newest stamp turns "a schema" into "this
 * schema" - a branch restored to a point before the last deploy fails on the count, and a branch
 * carrying somebody else's migrations fails on the stamp.
 *
 * The `.sql` files are counted too, purely to catch a journal that has drifted from the folder,
 * which would make every other assertion here quietly wrong.
 */
export async function readExpectedMigrations(repoRoot) {
  const folder = path.join(repoRoot, 'packages', 'server', 'src', 'db', 'migrations');
  const journal = JSON.parse(await readFile(path.join(folder, 'meta', '_journal.json'), 'utf8'));
  const entries = journal.entries ?? [];
  const files = (await readdir(folder)).filter((name) => name.endsWith('.sql'));

  if (entries.length !== files.length) {
    throw new Error(
      `migration journal lists ${entries.length} entries but the folder holds ${files.length} ` +
        '.sql files. Fix that before trusting a restore proof.',
    );
  }

  return {
    count: entries.length,
    latestWhen: Math.max(...entries.map((entry) => entry.when)),
  };
}

async function safeQuery(client, sql, params) {
  try {
    return { rows: (await client.query(sql, params)).rows, error: null };
  } catch (error) {
    return { rows: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkTablesPresent(client) {
  const { rows, error } = await safeQuery(
    client,
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [CORE_TABLES],
  );
  if (error) return { name: 'tables-present', ok: false, detail: error };

  const found = new Set(rows.map((row) => row.table_name));
  const missing = CORE_TABLES.filter((table) => !found.has(table));
  return {
    name: 'tables-present',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `all ${CORE_TABLES.length} core tables exist`
        : `missing: ${missing.join(', ')}`,
  };
}

async function checkMigrationLedger(client, expected) {
  const { rows, error } = await safeQuery(
    client,
    `SELECT count(*)::int AS applied, max(created_at)::text AS newest
       FROM drizzle."__drizzle_migrations"`,
  );
  if (error) return { name: 'migration-ledger', ok: false, detail: error };

  const applied = rows[0].applied;
  const newest = rows[0].newest;
  const countOk = applied === expected.count;
  const stampOk = String(newest) === String(expected.latestWhen);
  return {
    name: 'migration-ledger',
    ok: countOk && stampOk,
    detail:
      `applied=${applied} expected=${expected.count}, ` +
      `newest=${newest} expected=${expected.latestWhen}`,
  };
}

async function checkRowCounts(client, minRows) {
  const union = CORE_TABLES.map(
    (table) => `SELECT '${table}' AS relation, count(*)::bigint AS n FROM ${table}`,
  ).join(' UNION ALL ');
  const { rows, error } = await safeQuery(client, union);
  if (error) return { name: 'row-counts', ok: false, detail: error, counts: null };

  const counts = new Map(rows.map((row) => [row.relation, Number(row.n)]));
  const short = [];
  for (const [table, minimum] of Object.entries(minRows)) {
    const actual = counts.get(table) ?? 0;
    if (actual < minimum) short.push(`${table}=${actual} (needs >= ${minimum})`);
  }
  return {
    name: 'row-counts',
    ok: short.length === 0,
    detail:
      short.length === 0
        ? Object.keys(minRows)
            .map((table) => `${table}=${counts.get(table)}`)
            .join(' ')
        : `below the gate: ${short.join(', ')}`,
    counts,
  };
}

async function checkPointInTime(client, restoredTo) {
  if (!restoredTo) {
    return {
      name: 'point-in-time',
      ok: true,
      detail: 'skipped: no restore timestamp was supplied',
    };
  }

  const ceiling = restoredTo.getTime() + RECENCY_TOLERANCE_MS;
  const newest = [];
  for (const table of RECENCY_TABLES) {
    const { rows, error } = await safeQuery(client, `SELECT max(created_at) AS newest FROM ${table}`);
    if (error) return { name: 'point-in-time', ok: false, detail: error };
    if (rows[0].newest) newest.push({ table, at: new Date(rows[0].newest) });
  }

  if (newest.length === 0) {
    return {
      name: 'point-in-time',
      ok: false,
      detail: 'no timestamped rows to compare, so the restore point cannot be confirmed',
    };
  }

  const after = newest.filter((entry) => entry.at.getTime() > ceiling);
  const latest = newest.reduce((a, b) => (a.at > b.at ? a : b));
  return {
    name: 'point-in-time',
    ok: after.length === 0,
    detail:
      after.length === 0
        ? `newest row ${latest.table} @ ${latest.at.toISOString()} <= ${restoredTo.toISOString()}`
        : `rows newer than the restore point: ${after
            .map((entry) => `${entry.table} @ ${entry.at.toISOString()}`)
            .join(', ')}`,
  };
}

async function checkReferentialIntegrity(client) {
  const broken = [];
  for (const { label, sql } of ORPHAN_CHECKS) {
    const { rows, error } = await safeQuery(client, sql);
    if (error) return { name: 'referential-integrity', ok: false, detail: error };
    if (rows[0].n > 0) broken.push(`${label}: ${rows[0].n}`);
  }
  return {
    name: 'referential-integrity',
    ok: broken.length === 0,
    detail: broken.length === 0 ? `${ORPHAN_CHECKS.length} orphan checks clean` : broken.join(', '),
  };
}

/**
 * The branch is a database, not a snapshot you can only read.
 *
 * `allowWrite` is false unless the caller created this branch itself. Nothing in this repo should
 * make it easy to run DDL against a connection whose provenance was not just established.
 */
async function checkWritable(client, allowWrite) {
  if (!allowWrite) {
    return { name: 'writable', ok: true, detail: 'skipped: write probe not permitted here' };
  }
  const { error } = await safeQuery(
    client,
    `CREATE TABLE IF NOT EXISTS drill_restore_probe (id int PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())`,
  );
  if (error) return { name: 'writable', ok: false, detail: error };

  const inserted = await safeQuery(
    client,
    `INSERT INTO drill_restore_probe (id) VALUES (1)
       ON CONFLICT (id) DO UPDATE SET at = now() RETURNING at::text AS at`,
  );
  const dropped = await safeQuery(client, 'DROP TABLE drill_restore_probe');

  if (inserted.error) return { name: 'writable', ok: false, detail: inserted.error };
  if (dropped.error) {
    return {
      name: 'writable',
      ok: false,
      detail: `wrote, but could not drop the probe table: ${dropped.error}`,
    };
  }
  return { name: 'writable', ok: true, detail: `wrote and dropped a probe row at ${inserted.rows[0].at}` };
}

/**
 * Run every check against an already-connected client.
 *
 * @param {import('pg').Client} client connected to the RESTORED branch, never to production.
 * @param {{ migrations: {count:number, latestWhen:number},
 *           minRows?: Record<string, number>,
 *           restoredTo?: Date | null,
 *           allowWrite?: boolean }} options
 */
export async function runProof(client, options) {
  const minRows = options.minRows ?? DEFAULT_MIN_ROWS;
  const checks = [];
  checks.push(await checkTablesPresent(client));
  checks.push(await checkMigrationLedger(client, options.migrations));
  const counts = await checkRowCounts(client, minRows);
  checks.push(counts);
  checks.push(await checkPointInTime(client, options.restoredTo ?? null));
  checks.push(await checkReferentialIntegrity(client));
  checks.push(await checkWritable(client, options.allowWrite ?? false));

  return { ok: checks.every((check) => check.ok), checks, counts: counts.counts ?? null };
}

/** The same shape `scripts/surface-gate.sh` prints, for the same reason: it is skimmable. */
export function renderChecks(checks) {
  return checks
    .map((check) => `${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(22)} ${check.detail}\n`)
    .join('');
}

/** A count table, printed whether or not the gate passed. The numbers are the evidence. */
export function renderCounts(counts) {
  if (!counts) return '';
  const width = Math.max(...CORE_TABLES.map((table) => table.length));
  return CORE_TABLES.map((table) => `  ${table.padEnd(width)}  ${counts.get(table) ?? '?'}\n`).join(
    '',
  );
}
