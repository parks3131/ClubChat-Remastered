/**
 * What the global setup and the per-file harness both have to agree about.
 *
 * These three constants used to live in `harness.ts`, when the harness started its own container
 * per file. It no longer does, so the address of the one container has to travel from the process
 * that starts it to the workers that use it, and both ends need the same names for the pieces.
 */

/**
 * How long to wait for the container's WAIT STRATEGY, which is not the timeout that was failing.
 *
 * > **Recorded because it was diagnosed wrong first.** The suite kept failing with
 * > `Timed out after 10000ms while waiting for container ports to be bound to the host`, on a
 * > different file each run. Raising this looked like the fix and is inert against that error:
 * > testcontainers binds ports in `inspectContainerUntilPortsExposed`, whose timeout is a
 * > **hardcoded 10 seconds** taken from a default parameter and never passed from here.
 * > `withStartupTimeout` governs the wait strategy that runs afterwards - a different clock.
 *
 * The real cause was measured rather than assumed: Docker took **~4.3 seconds** to bind a port for
 * a single container on an otherwise quiet machine, against that 10 second ceiling, and the suite
 * asked for two dozen of them. The fix was to stop asking, which is what `global-setup.ts` does.
 * This value is kept because bounding the wait strategy is still correct, and because one start
 * that is slow to become healthy should still be waited for rather than failed.
 */
export const CONTAINER_STARTUP_TIMEOUT_MS = 120_000;

/**
 * The database the migrations are run into once, and that every file's database is copied from.
 *
 * `CREATE DATABASE x TEMPLATE y` is a file copy inside Postgres, so a file pays for a copy of an
 * empty schema instead of replaying every migration. That is the second half of the saving and it
 * is the larger one: the containers cost seconds each, and 36 migration replays cost more.
 *
 * **Nothing may hold a connection to it.** Postgres refuses to copy a template another session is
 * connected to, so the setup ends its pool before providing the address, and no test ever opens
 * this name.
 */
export const TEMPLATE_DATABASE = 'clubchat_template';

/**
 * The same server, a different database on it.
 *
 * Parsed rather than concatenated because the container's URI carries credentials and a port, and
 * a string join that happens to work on `postgresql://user:pass@host:port/test` is one unusual
 * password away from not working.
 */
export function withDatabase(connectionUri: string, database: string): string {
  const url = new URL(connectionUri);
  url.pathname = `/${database}`;
  return url.toString();
}

declare module 'vitest' {
  interface ProvidedContext {
    /**
     * The one Postgres container's URI, pointing at its own default database.
     *
     * Provided by `global-setup.ts` and read by `startTestDb`, which connects to it only long
     * enough to `CREATE DATABASE` its own.
     */
    pgAdminUri: string;
  }
}
