/**
 * The router, the method guard, the headers every response carries, and the two small files.
 *
 * The property worth stating up front: **`blockApi` is armed for every test in this file**, so any
 * route here that made an outbound request would throw rather than quietly succeed. Only
 * `/join/:token` may talk to the api, and that is proved as an ordering fact rather than inferred
 * from a status code - the same tripwire shape `packages/cdn-worker` uses on its R2 bindings.
 */

import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiRequests, blockApi, get, releaseApi, SITE_ORIGIN } from './harness.ts';

beforeEach(blockApi);
afterEach(releaseApi);

/** Every path that must answer without the api being reachable at all. */
const OFFLINE_PATHS = [
  '/',
  '/privacy',
  '/terms',
  '/styles.css',
  '/robots.txt',
  '/.well-known/apple-app-site-association',
  '/.well-known/assetlinks.json',
  '/__parity',
];

describe('the method guard', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s with Allow', async (method) => {
    const response = await SELF.fetch(`${SITE_ORIGIN}/`, { method });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('refuses before routing, so an unknown path is still a 405 rather than a 404', async () => {
    // The method check is true of every path, so it comes first. A POST to a path that does not
    // exist telling the caller "not found" would say the method would have been fine.
    const response = await SELF.fetch(`${SITE_ORIGIN}/nope`, { method: 'POST' });

    expect(response.status).toBe(405);
  });

  it('answers HEAD with the headers and no body', async () => {
    const response = await SELF.fetch(`${SITE_ORIGIN}/`, { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.headers.get('content-length')).toMatch(/^\d+$/);
    expect(await response.text()).toBe('');
  });
});

describe('an unknown path', () => {
  it('is a clean 404 with a page on it, not a stack trace', async () => {
    const { response, body } = await get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(body).toContain('<!doctype html>');
    expect(body.toLowerCase()).not.toContain('error:');
  });

  it.each([
    '/join',
    '/join/',
    '/join/a/b',
    '/privacy/extra',
    '/.well-known/',
    '/.well-known/other',
    '/styles.css/x',
  ])('404s %s without touching the api', async (path) => {
    const { response } = await get(path);

    expect(response.status).toBe(404);
    expect(apiRequests()).toEqual([]);
  });
});

describe('trailing slashes', () => {
  it.each(['/privacy/', '/terms/'])('serves %s as the page without one', async (path) => {
    const { response } = await get(path);

    expect(response.status).toBe(200);
  });

  it('serves the root, which is the one path whose slash is not trailing', async () => {
    const { response } = await get('/');

    expect(response.status).toBe(200);
  });
});

describe('the headers every response carries', () => {
  it.each(OFFLINE_PATHS)('sets the security headers on %s', async (path) => {
    const { response } = await get(path);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
  });

  it.each(OFFLINE_PATHS)('sets a script-free content security policy on %s', async (path) => {
    const { response } = await get(path);

    const policy = response.headers.get('content-security-policy') ?? '';
    // `default-src 'none'` with no `script-src` override means scripts fall back to none, which is
    // what makes "there is no JavaScript on this site" enforced rather than merely true today.
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('unsafe-inline');
  });

  it('sets the same headers on a 404', async () => {
    const { response } = await get('/does-not-exist');

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});

describe('the stylesheet', () => {
  it('is served as CSS from its own route, so no page needs an inline style', async () => {
    const { response, body } = await get('/styles.css');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/css/);
    expect(body).toContain(':root');
  });

  it('is cacheable, because it is the same bytes for every visitor', async () => {
    const { response } = await get('/styles.css');

    expect(response.headers.get('cache-control')).toMatch(/max-age=\d+/);
  });

  it('is what the pages link to', async () => {
    const { body } = await get('/');

    expect(body).toContain('<link rel="stylesheet" href="/styles.css">');
    expect(body).not.toContain('<style');
    expect(body).not.toContain('<script');
  });
});

describe('robots.txt', () => {
  it('keeps crawlers out of the invite pages', async () => {
    const { response, body } = await get('/robots.txt');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(body).toContain('Disallow: /join/');
  });
});
