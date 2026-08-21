-- What this database has spent its life on, across every process at once.
--
-- The per-request query counter in `dev/trace.ts` answers "what did THIS request
-- cost", which is the question that found both N+1s in SPEC/TECH/18 section 2.16.
-- This answers the other one: "what is this database spending its life on", across
-- the api, the worker and the gateway together, with no application instrumentation
-- involved at all. It is how you find the statement nobody suspected rather than
-- confirming the one you did. SPEC/TECH/18 section 6.2.
--
-- `CREATE EXTENSION` is here rather than in a migration, and deliberately so: it
-- wants rights the application role should not be assumed to have, and a migration
-- that can fail on a managed provider is a worse trade than a command run once.
-- It is idempotent, so this file is safe to run repeatedly.
--
-- The LIBRARY has to be preloaded at server start for any of this to record, which
-- is a server flag rather than anything SQL can do. `docker-compose.yml` sets it.
-- A container started before that line existed records nothing and reports nothing,
-- and the fix is `npm run db:down && npm run db:up` - which keeps the volume, so it
-- keeps the data. Only `db:nuke` destroys it.
--
-- Run with:  npm run db:stats

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

\echo ''
\echo '=== Most expensive by TOTAL time. Where the database actually spends itself. ==='
\echo ''

SELECT
  round(total_exec_time)::bigint AS total_ms,
  calls,
  round(mean_exec_time::numeric, 3) AS mean_ms,
  rows,
  left(regexp_replace(query, '\s+', ' ', 'g'), 100) AS query
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC
LIMIT 20;

\echo ''
\echo '=== Most CALLED. An absurd call count is what an N+1 looks like from down here. ==='
\echo ''

SELECT
  calls,
  round(total_exec_time)::bigint AS total_ms,
  round(mean_exec_time::numeric, 3) AS mean_ms,
  left(regexp_replace(query, '\s+', ' ', 'g'), 100) AS query
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'
ORDER BY calls DESC
LIMIT 20;

\echo ''
\echo 'Counters are cumulative since the last reset or server start. To start a clean'
\echo 'recording before driving the app:  npm run db:stats:reset'
\echo ''
