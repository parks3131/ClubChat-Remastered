#!/usr/bin/env node
//
// Derive a media variant for photos that were uploaded before that variant existed.
//
//   node --env-file=.env scripts/backfill-media-variants.mjs --target local --dry-run
//   node --env-file=.env scripts/backfill-media-variants.mjs --target local
//   node --env-file=.env scripts/backfill-media-variants.mjs --target production --limit 500
//
// WHY IT EXISTS. Derivation happens exactly once, at upload, off the `media.uploaded` outbox
// event. So the day a size is added to `VARIANTS` in packages/server/src/media/derive.ts, every
// photo the project has ever stored is missing it - not for the few seconds a worker takes to
// catch up, but permanently. `bubble` was added on 2026-08-27 and every photo before that date
// has only `thumb` and `display`.
//
// Nothing BREAKS in that state: `resolveMediaRedirects` falls back down `VARIANT_FALLBACKS`, so a
// request for `bubble` on an old photo answers a `display` URL and the picture renders. It just
// renders as the heavy image the new variant exists to stop sending, which is why this is worth
// running rather than worth waiting out.
//
// WHAT IT DOES. It calls `deriveVariants` - the same function the worker calls, unchanged - once
// per photo that is missing the variant. It does not resize anything itself, and it deliberately
// does not enqueue `media.uploaded` events: those would queue in the outbox alongside real
// effects, so a backfill over a whole bucket would sit in front of somebody's notifications.
//
// WHAT IT COSTS on a row that is already done: nothing. The query does not select it and
// `deriveVariants` would skip it anyway, so a second run reads a count and stops. Interrupting it
// is safe; starting it again resumes from where the data is rather than from where the run was.
//
// IT WRITES TO OBJECT STORAGE AND TO THE DATABASE, which is why it takes `--target` and has no
// default. See scripts/drills/target-gate.mjs.

import { parseDrillArgs } from './drills/target-gate.mjs';
import { loadConfig } from '../packages/server/src/config.ts';
import { createDb, createPool } from '../packages/server/src/db/client.ts';
import { S3MediaStore } from '../packages/server/src/media/store.ts';
import { VARIANTS } from '../packages/server/src/media/derive.ts';
import {
  backfillVariant,
  countMissingVariant,
} from '../packages/server/src/media/backfill-variants.ts';

const { target, has } = parseDrillArgs(process.argv, {
  script: 'scripts/backfill-media-variants.mjs',
  targets: [
    'production   the live database and bucket. Writes derived objects into R2.',
    'local        a development database and its MinIO bucket.',
  ],
  flags: ['--dry-run', '--variant', '--limit'],
});

/** A flag that takes a value. `parseDrillArgs` has already refused any flag not declared above. */
function valueOf(flag) {
  const at = process.argv.indexOf(flag);
  if (at === -1) return undefined;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`refusing to run: ${flag} needs a value.\n`);
    process.exit(2);
  }
  return value;
}

// `bubble` by default because it is the reason this script was written, and because a backfill
// nobody has to think about the arguments of is one that actually gets run.
const variant = valueOf('--variant') ?? 'bubble';
if (!Object.hasOwn(VARIANTS, variant)) {
  process.stderr.write(
    `refusing to run: '${variant}' is not a derived variant.\n` +
      `Derived variants are: ${Object.keys(VARIANTS).join(', ')}.\n`,
  );
  process.exit(2);
}

const rawLimit = valueOf('--limit');
const limit = rawLimit === undefined ? undefined : Number(rawLimit);
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  process.stderr.write(`refusing to run: --limit must be a positive whole number, not '${rawLimit}'.\n`);
  process.exit(2);
}

/*
 * The environment is read AFTER the gate above, never before.
 *
 * A script that connected first and validated second would already have reached production by the
 * time it told you off - the property `drills.test.ts` asserts for the two drills, and the reason
 * every `process.exit(2)` above sits between the import list and this line.
 *
 * `loadConfig` rather than five hand-read variables, so this demands exactly what the worker
 * demands and cannot drift into accepting an environment the worker would refuse.
 */
const config = loadConfig();

/** The host and database, never the credentials. Confirming what you are about to write to. */
function describeDatabase(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return 'an unparseable DATABASE_URL';
  }
}

const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);
const store = new S3MediaStore({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  accessKeyId: config.S3_ACCESS_KEY_ID,
  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
});

process.stdout.write(
  `backfill: media variant '${variant}' (${VARIANTS[variant]}px wide)\n` +
    `  target   ${target}\n` +
    `  database ${describeDatabase(config.DATABASE_URL)}\n` +
    `  storage  ${config.S3_ENDPOINT}\n` +
    `  limit    ${limit ?? 'none, every photo missing it'}\n` +
    `  mode     ${has('--dry-run') ? 'dry run, nothing is written' : 'writing'}\n\n`,
);

let exitCode = 0;
try {
  if (has('--dry-run')) {
    const missing = await countMissingVariant(db, variant);
    process.stdout.write(
      `  ${missing} photo(s) are missing '${variant}'.\n\n` +
        (missing === 0
          ? `Nothing to do. Every completed photo already has a '${variant}' object.\n`
          : `Re-run without --dry-run to derive them.\n`),
    );
  } else {
    const started = Date.now();
    const result = await backfillVariant(db, store, {
      variant,
      limit,
      // Every row says something. A backfill over a real bucket is minutes of silence otherwise,
      // and an operator watching nothing cannot tell a slow run from a stuck one.
      onEvent: (event) => {
        if (event.kind === 'derived') {
          process.stdout.write(`  derived ${event.variants.join(', ')}  ${event.mediaId}\n`);
        } else if (event.kind === 'undecodable') {
          process.stdout.write(`  UNDECODABLE  ${event.mediaId}  (recorded on the row, not retried)\n`);
        } else if (event.kind === 'failed') {
          process.stdout.write(`  FAILED  ${event.mediaId}  ${event.reason}\n`);
        } else {
          process.stdout.write(`  skipped  ${event.mediaId}\n`);
        }
      },
    });

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(
      `\n  missing when this started  ${result.missingAtStart}\n` +
        `  visited                    ${result.visited}\n` +
        `  derived                    ${result.derived}\n` +
        `  skipped                    ${result.skipped}\n` +
        `  undecodable                ${result.undecodable}\n` +
        `  failed                     ${result.failed}\n` +
        `  took                       ${seconds}s\n\n`,
    );

    const remaining = await countMissingVariant(db, variant);
    process.stdout.write(`  still missing '${variant}': ${remaining}\n\n`);

    if (result.abandoned) {
      exitCode = 1;
      process.stdout.write(
        'ABANDONED after a run of consecutive failures. That shape is object storage being down\n' +
          'rather than one odd photo, so the run stopped instead of reporting the same error for\n' +
          'every remaining row. Fix the store and run this again; it resumes.\n',
      );
    } else if (result.failed > 0) {
      exitCode = 1;
      process.stdout.write(
        `${result.failed} photo(s) failed and were left alone. They are transient by assumption,\n` +
          'so running this again picks them up. If the same ids fail twice, they are not transient.\n',
      );
    } else if (remaining === 0) {
      process.stdout.write(`Done. Every completed photo now has a '${variant}' object.\n`);
    } else {
      process.stdout.write(
        `${remaining} photo(s) still lack '${variant}'. With --limit that is expected: run it again.\n` +
          'Without one, they were uploaded while this was running - the worker derives those on\n' +
          'its own, so there is nothing to do. Rows whose bytes do not decode are not counted\n' +
          'here at all: they carry `derive_error` and are deliberately never retried.\n',
      );
    }
  }
} catch (error) {
  exitCode = 1;
  process.stderr.write(`backfill failed: ${error instanceof Error ? error.message : error}\n`);
} finally {
  await pool.end();
}

process.exit(exitCode);
