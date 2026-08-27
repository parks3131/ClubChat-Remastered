/**
 * Give photos already in the database a derived size that did not exist when they were uploaded.
 *
 * **Derivation happens once, at upload**, off the `media.uploaded` event - so the day a size is
 * added to `VARIANTS` every photo the project has ever stored is missing it, permanently, until
 * something goes back over them. `resolveMediaRedirects` covers that with a fallback so nothing
 * breaks, but a fallback is a heavier image than the one that was asked for, and for `bubble`
 * specifically the heavier image is the whole problem being fixed.
 *
 * **The work itself is `deriveVariants`, unchanged - the same function the worker calls.** This
 * module only decides which rows to hand it and counts what came back. That is deliberate: a
 * backfill with its own resize would be a second implementation of the thing it is catching up
 * with, and the two would eventually write different pixels for the same name.
 *
 * Three properties, each of which the operator is relying on:
 *
 *  - **Idempotent.** A row that already has every variant is skipped inside `deriveVariants`,
 *    and it does not match the query here in the first place, so a second run reads nothing and
 *    writes nothing.
 *  - **Restartable.** Rows are paged by a keyset over the primary key rather than by an offset,
 *    so interrupting the run and starting it again resumes rather than repeating - and a row
 *    that fails cannot be handed back forever, which an offset-free "select what is still
 *    missing" loop would do.
 *  - **Bounded.** A storage outage makes every row fail identically, so a run of consecutive
 *    failures stops the whole thing rather than grinding through the table reporting the same
 *    error a hundred thousand times.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { deriveVariants, type DerivedVariant } from './derive.ts';
import type { MediaStore } from './store.ts';

/** How many consecutive failures mean "the store is down" rather than "this object is odd". */
export const CONSECUTIVE_FAILURE_LIMIT = 10;

/** One row's outcome, as it happens, so a long run says something while it is running. */
export type BackfillEvent =
  | { kind: 'derived'; mediaId: string; variants: string[] }
  | { kind: 'skipped'; mediaId: string }
  | { kind: 'undecodable'; mediaId: string }
  | { kind: 'failed'; mediaId: string; reason: string };

export type BackfillResult = {
  /** Rows missing the variant when the run started. Counted before anything is written. */
  missingAtStart: number;
  /** Rows actually handed to `deriveVariants`. Below `missingAtStart` when `limit` cut the run. */
  visited: number;
  /** Rows that gained the variant. */
  derived: number;
  /** Rows `deriveVariants` skipped - already complete, or not an image after all. */
  skipped: number;
  /** Rows whose bytes do not decode. Recorded on the row by `deriveVariants`, not retried. */
  undecodable: number;
  /** Rows that threw. Transient by assumption, so a later run picks them up again. */
  failed: number;
  /** True when the run stopped early on consecutive failures rather than finishing. */
  abandoned: boolean;
};

/**
 * The rows this backfill is for: a completed image that has no object under the new name.
 *
 * `derive_error IS NOT NULL` is excluded because those bytes are already known not to decode and
 * the object key is immutable, so re-reading them buys a second identical failure. `status` must
 * be `ready`: a pending upload has nothing behind its key yet, and the nightly GC will remove it.
 *
 * `jsonb_exists` rather than the `?` operator, spelled out: `?` is a placeholder in enough
 * database drivers that writing it into a template is a habit worth not having.
 */
const missingVariant = (variant: DerivedVariant) => sql`
  status = 'ready'
  AND mime LIKE 'image/%'
  AND derive_error IS NULL
  AND NOT jsonb_exists(variants, ${variant})
`;

/** How many photos are missing this variant right now. The dry run, and the "before" number. */
export async function countMissingVariant(db: Db, variant: DerivedVariant): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM media_objects WHERE ${missingVariant(variant)}
  `);
  return Number(rows.rows[0]?.n ?? '0');
}

/**
 * Derive one missing variant across every photo that lacks it.
 *
 * `onEvent` is called per row rather than returned at the end, because a backfill over a real
 * bucket is minutes of silence otherwise and an operator watching nothing cannot tell a slow run
 * from a stuck one.
 */
export async function backfillVariant(
  db: Db,
  store: MediaStore,
  opts: {
    variant: DerivedVariant;
    /** Stop after this many rows. Absent means "all of them". */
    limit?: number | undefined;
    /** How many ids to fetch per page. Only affects round trips, never the outcome. */
    pageSize?: number | undefined;
    onEvent?: ((event: BackfillEvent) => void) | undefined;
  },
): Promise<BackfillResult> {
  const { variant, limit, onEvent } = opts;
  const pageSize = opts.pageSize ?? 200;

  const result: BackfillResult = {
    missingAtStart: await countMissingVariant(db, variant),
    visited: 0,
    derived: 0,
    skipped: 0,
    undecodable: 0,
    failed: 0,
    abandoned: false,
  };

  /*
   * A keyset over the primary key, not an offset and not "whatever is still missing".
   *
   * A re-query of "still missing" would hand back a row that failed on the previous pass every
   * time, forever, which turns one unreadable object into an infinite loop. An OFFSET would skip
   * rows as earlier ones stop matching. The cursor moves past every row this run has looked at,
   * whatever happened to it.
   */
  let cursor: string | null = null;
  let consecutiveFailures = 0;

  for (;;) {
    if (limit !== undefined && result.visited >= limit) break;

    const remaining = limit === undefined ? pageSize : Math.min(pageSize, limit - result.visited);
    /*
     * The annotation on `page` is load-bearing, not decoration.
     *
     * Without it TypeScript reports `TS7022: 'page' implicitly has type any because it is
     * referenced directly or indirectly in its own initializer`: the query reads `cursor`, the
     * loop below writes `cursor` from a row of `page`, and inferring the row type therefore
     * needs the row type. Stating it breaks the cycle, and it is the shape a raw read should
     * carry anyway - see AGENTS.md failure mode 8 on what a hand-written row type over
     * `db.execute` is and is not.
     */
    const page: { rows: { id: string }[] } = await db.execute<{ id: string }>(sql`
      SELECT id::text AS id
        FROM media_objects
       WHERE ${missingVariant(variant)}
         ${cursor === null ? sql`` : sql`AND id > ${cursor}::uuid`}
       ORDER BY id
       LIMIT ${remaining}
    `);
    if (page.rows.length === 0) break;

    for (const row of page.rows) {
      cursor = row.id;
      result.visited += 1;

      let outcome: Awaited<ReturnType<typeof deriveVariants>>;
      try {
        outcome = await deriveVariants(db, store, row.id);
      } catch (error) {
        /*
         * Counted and reported, never swallowed and never fatal on its own.
         *
         * One object that cannot be read is not a reason to stop deriving the other ninety
         * thousand, and a later run picks this row up again because nothing about it changed.
         * A RUN of them is a different fact - see the break below.
         */
        result.failed += 1;
        consecutiveFailures += 1;
        const reason = error instanceof Error ? error.message : String(error);
        onEvent?.({ kind: 'failed', mediaId: row.id, reason });
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          result.abandoned = true;
          return result;
        }
        continue;
      }

      consecutiveFailures = 0;
      if (outcome.undecodable) {
        result.undecodable += 1;
        onEvent?.({ kind: 'undecodable', mediaId: row.id });
      } else if (outcome.derived.length > 0) {
        result.derived += 1;
        onEvent?.({ kind: 'derived', mediaId: row.id, variants: outcome.derived });
      } else {
        result.skipped += 1;
        onEvent?.({ kind: 'skipped', mediaId: row.id });
      }
    }
  }

  return result;
}
