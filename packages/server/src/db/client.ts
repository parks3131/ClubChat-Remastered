/**
 * The database client.
 *
 * The API connects as a single application role. Every other role - including any
 * future service, analytics job, or leaked credential - is denied by default at the
 * grant level. There are deliberately NO per-row policies: enforcement lives in one
 * layer, in one place, fully tested. Mirroring the policy module as RLS "for defence
 * in depth" means two definitions of every rule that must be kept in sync, and drift
 * between two definitions of isClubAdmin is literally how the v1 bugs happened.
 * See ADR-0002.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof createDb>;
export type Schema = typeof schema;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    // The sequence-allocating transaction holds a row lock until commit, so a
    // starved pool shows up as send latency on one channel. Keep headroom.
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}

export { schema };
