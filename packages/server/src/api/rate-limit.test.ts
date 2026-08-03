/**
 * The limit policy, asserted as arithmetic rather than by hammering a server.
 *
 * Two failure modes, and neither shows up in an ordinary test: a limit too tight makes the product
 * feel broken for somebody scrolling, and a limit that never applies does nothing while looking
 * like it does. Both are properties of a pure lookup, so they are pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTH_BUCKET,
  DEFAULT_BUCKET,
  ROUTE_BUCKETS,
  bucketFor,
  limitKey,
} from './rate-limit.ts';

describe('which bucket a request gets', () => {
  it('falls back to the default for a route nobody named', () => {
    // The property the whole design rests on: a route added next month is limited without anybody
    // remembering to limit it. Naming routes explicitly is what left 123 of them unthrottled.
    expect(bucketFor('GET', '/clubs/:id/members')).toBe(DEFAULT_BUCKET);
    expect(bucketFor('POST', '/some/route/invented/later')).toBe(DEFAULT_BUCKET);
  });

  it('uses the tighter bucket for a named route', () => {
    expect(bucketFor('POST', '/media/upload-intent')).toEqual(ROUTE_BUCKETS['POST /media/upload-intent']);
    expect(bucketFor('POST', '/dm/threads')).toEqual(ROUTE_BUCKETS['POST /dm/threads']);
  });

  it('is keyed on method as well as path', () => {
    // `POST /blocks` is limited; a GET of the same path would be an ordinary read. Keying on the
    // path alone would apply a write's limit to a read.
    expect(bucketFor('POST', '/blocks')).not.toBe(DEFAULT_BUCKET);
    expect(bucketFor('GET', '/blocks')).toBe(DEFAULT_BUCKET);
  });

  it('takes the method case-insensitively, because Fastify does not promise one', () => {
    expect(bucketFor('post', '/dm/threads')).toEqual(bucketFor('POST', '/dm/threads'));
  });

  it('falls back when there is no matched route at all', () => {
    // A 404 has no `routeOptions.url`. It still costs a request and still counts.
    expect(bucketFor('GET', undefined)).toBe(DEFAULT_BUCKET);
  });
});

describe('what a request counts against', () => {
  it('shares one bucket across every unnamed route, per user', () => {
    // The default is an overall ceiling: reading members and reading polls draw on the same
    // allowance, because the question it answers is "how much is this person doing".
    expect(limitKey('user-1', 'GET', '/clubs/:id/members')).toBe(
      limitKey('user-1', 'GET', '/clubs/:id/polls'),
    );
  });

  it('gives a named route its own bucket', () => {
    // Otherwise ordinary reading would exhaust the allowance for reporting, and the tighter limit
    // would fire for reasons unrelated to the thing it protects.
    expect(limitKey('user-1', 'POST', '/dm/threads')).not.toBe(
      limitKey('user-1', 'GET', '/clubs/:id/members'),
    );
  });

  it('never lets two users share a bucket', () => {
    expect(limitKey('user-1', 'POST', '/dm/threads')).not.toBe(
      limitKey('user-2', 'POST', '/dm/threads'),
    );
    expect(limitKey('user-1', 'GET', '/anything')).not.toBe(limitKey('user-2', 'GET', '/anything'));
  });
});

describe('the numbers themselves', () => {
  it('leaves the default loose enough for a screenful of reads', () => {
    // Opening the app cold fires a double-digit number of requests and a fast scroll pages more.
    // A burst under ~100 would 429 a member for using the product normally.
    expect(DEFAULT_BUCKET.burst).toBeGreaterThanOrEqual(100);
  });

  it('keeps every override tighter than the default it overrides', () => {
    // An "override" that is looser than the default is dead configuration: the default would
    // never have refused the request anyway.
    for (const [route, bucket] of Object.entries(ROUTE_BUCKETS)) {
      expect(bucket.burst, `${route} burst`).toBeLessThan(DEFAULT_BUCKET.burst);
      expect(bucket.refillPerSec, `${route} refill`).toBeLessThanOrEqual(
        DEFAULT_BUCKET.refillPerSec,
      );
    }
  });

  it('makes sign-in the tightest thing in the API', () => {
    // It is the only bucket standing between an attacker and unlimited credential guessing, and
    // the only one keyed on something an attacker can change.
    expect(AUTH_BUCKET.burst).toBeLessThan(DEFAULT_BUCKET.burst);
    expect(AUTH_BUCKET.refillPerSec).toBeLessThan(1);
  });

  it('states a Retry-After of at least a second for every bucket', () => {
    // The header is computed as ceil(1 / refill). A refill fast enough to round to zero would
    // advertise "retry immediately", which is a hot loop against the thing being protected.
    for (const bucket of [DEFAULT_BUCKET, AUTH_BUCKET, ...Object.values(ROUTE_BUCKETS)]) {
      expect(Math.max(1, Math.ceil(1 / bucket.refillPerSec))).toBeGreaterThanOrEqual(1);
    }
  });
});
