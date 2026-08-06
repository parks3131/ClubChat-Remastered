/**
 * A limiter that always allows, for route tests.
 *
 * **A test suite is the most rate-limit-exceeding client this API will ever have**: it drives
 * hundreds of requests as one user in a few seconds, with none of the human pauses the buckets
 * are sized around. Pointing the real limiter at a real Redis here would make the suite's own
 * speed a source of failures, and the failures would be flaky rather than reproducible.
 *
 * The policy itself is asserted directly in `rate-limit.test.ts`, where it is a pure function and
 * can be pinned exactly. This file is only about not throttling the tests.
 */

import type { KeyedRateLimiter } from '../bus/redis.ts';

export function allowAll(): KeyedRateLimiter {
  return { async tryConsume() { return true; } };
}

/**
 * A limiter that refuses after `n` calls, without Redis.
 *
 * For asserting that a route actually consults the limiter and returns 429 with `Retry-After` -
 * which is a different question from whether the bucket arithmetic is right.
 */
/**
 * A limiter that allows everything and remembers what it was asked about.
 *
 * For the questions `allowFirst` cannot answer: not "does this route consult a limiter" but
 * "**which bucket** did it consult, and under what key". Password reset is limited twice - once
 * per caller and once per email address - and the second is invisible to a counter, since both
 * calls simply return true.
 */
export function recordingLimiter(): KeyedRateLimiter & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async tryConsume(key: string) {
      keys.push(key);
      return true;
    },
  };
}

export function allowFirst(n: number): KeyedRateLimiter {
  let seen = 0;
  return {
    async tryConsume() {
      seen += 1;
      return seen <= n;
    },
  };
}
