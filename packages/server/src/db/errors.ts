/**
 * Driver error inspection.
 *
 * Lived inside `append-message.ts` until a second handler needed it, which is the point at
 * which AGENTS.md failure mode 9 says to extract rather than to add a case to a copy.
 */

export const UNIQUE_VIOLATION = '23505';

/**
 * Is this a unique-constraint violation, possibly wrapped?
 *
 * The cause chain matters. Drizzle wraps driver errors in its own error type, so the pg
 * `code` is NOT on the thrown object - it is on `.cause`. Checking only the top level looks
 * correct and silently never matches, which turns an idempotent-retry path into an unhandled
 * 500 under exactly the concurrency it exists to absorb. Found by a concurrency test rather
 * than by reading the function.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      (current as { code?: unknown }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
