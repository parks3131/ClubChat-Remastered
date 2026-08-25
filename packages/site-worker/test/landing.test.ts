/**
 * `GET /`, the apex landing page.
 *
 * The apex served nothing at all before this Worker, so anything here is an improvement on a blank
 * response - which is exactly the condition under which a landing page acquires a testimonial, a
 * pricing table and a launch date that nobody ever agreed to. **The assertions below are as much
 * about what the page must NOT say as about what it says**, and they are written as a list of
 * forbidden words rather than as a matter of taste, so that the next edit to the copy has to argue
 * with a red test rather than with nobody.
 */

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockApi, get, releaseApi } from './harness.ts';

const CONFIGURED_INSTALL_URL = env.IOS_INSTALL_URL;

beforeEach(blockApi);
afterEach(() => {
  // The binding object is shared across the isolate, so a var set by one test is still set for the
  // next one. Same obligation `associations.test.ts` states about the fingerprints.
  env.IOS_INSTALL_URL = CONFIGURED_INSTALL_URL;
  releaseApi();
});

describe('the landing page', () => {
  it('names the product', async () => {
    const { response, body } = await get('/');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(/<h1>([\s\S]*?)<\/h1>/.exec(body)?.[1]).toContain('ClubChat');
  });

  it('links to both legal pages', async () => {
    const { body } = await get('/');

    expect(body).toContain('href="/privacy"');
    expect(body).toContain('href="/terms"');
  });

  it('makes no claim about price, popularity or a launch date', async () => {
    const { body } = await get('/');

    const forbidden = [
      'free',
      'trial',
      'pricing',
      'per month',
      'testimonial',
      'trusted by',
      'thousands',
      'coming soon',
      'launching',
      'award',
      'the best',
      'loved by',
    ];
    for (const claim of forbidden) {
      expect(body.toLowerCase()).not.toContain(claim);
    }
  });

  it('is indexable, unlike the join pages', async () => {
    const { response, body } = await get('/');

    expect(response.headers.get('x-robots-tag')).toBeNull();
    expect(body).not.toContain('noindex');
  });

  it('is cacheable', async () => {
    const { response } = await get('/');

    expect(response.headers.get('cache-control')).toMatch(/max-age=\d+/);
  });
});

/**
 * The state the product is actually in, and the one the page has to be honest about.
 *
 * The app has never been released. App Store Connect app id 6804458376 exists, and
 * `https://apps.apple.com/app/id6804458376` is a 404 today because a record in App Store Connect is
 * not a listing: `https://itunes.apple.com/lookup?id=6804458376` answers `{"resultCount":0}`.
 * Distribution is TestFlight internal only. So a "get it on the App Store" button was the primary
 * call to action on this page and it sent every visitor to an Apple error page.
 *
 * These tests pin the honest state AND the way out of it, because a beta notice with no switch
 * behind it is the next thing to rot: `IOS_INSTALL_URL` is the single var that turns the button
 * back on, and the last test here is the proof that it does.
 */
describe('the landing page while ClubChat is in private beta', () => {
  it('offers no App Store link, because there is no listing behind one', async () => {
    const { body } = await get('/');

    expect(body).not.toContain('apps.apple.com');
    expect(body).not.toContain('6804458376');
  });

  it('says what the state is and what to do instead of downloading it', async () => {
    const { body } = await get('/');

    expect(body).toMatch(/private beta/i);
    expect(body).toMatch(/invite/i);
  });

  it('renders no empty button row, so the page does not read as half-finished', async () => {
    // An `.actions` div is a flex row with a gap. Emitting it with nothing in it is the shape that
    // looks like a button failed to render rather than like a page that has no button.
    const { body } = await get('/');

    expect(body).not.toContain('<div class="actions"></div>');
  });

  it('offers the download again the moment one configuration value is set', async () => {
    env.IOS_INSTALL_URL = 'https://apps.apple.com/app/id6804458376';

    const { body } = await get('/');

    expect(body).toContain('href="https://apps.apple.com/app/id6804458376"');
    expect(body).not.toMatch(/private beta/i);
  });

  it('takes a public TestFlight link as readily as a store listing', async () => {
    // The other way this ends, and the reason the var holds a URL rather than a store id: a public
    // TestFlight link is a destination the same button can carry, with no code change.
    env.IOS_INSTALL_URL = 'https://testflight.apple.com/join/AbCdEfGh';

    const { body } = await get('/');

    expect(body).toContain('href="https://testflight.apple.com/join/AbCdEfGh"');
  });

  it('ignores a value that is not an https URL, rather than emitting a broken link', async () => {
    env.IOS_INSTALL_URL = 'javascript:alert(1)';

    const { body } = await get('/');

    expect(body).not.toContain('javascript:');
    expect(body).toMatch(/private beta/i);
  });
});
