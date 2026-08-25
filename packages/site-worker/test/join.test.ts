/**
 * `GET /join/:token`, the reason this Worker exists.
 *
 * The defect it repairs: invites are link only and the link is `clubchat://join/<token>`, so a QR
 * code taped to a table and scanned by somebody without the app produces nothing at all. No prompt,
 * no error, no page. These tests pin the three answers that replace it - the club named, the invite
 * refused, and the api unreachable - and the two properties that make the third one honest: it is
 * not a 500, and it does not claim the invite is dead.
 */

import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  API_ORIGIN,
  apiRequests,
  armApi,
  armApiFailure,
  blockApi,
  get,
  previewBody,
  releaseApi,
  SITE_ORIGIN,
  TOKEN,
} from './harness.ts';

const CONFIGURED_INSTALL_URL = env.IOS_INSTALL_URL;

beforeEach(blockApi);
afterEach(() => {
  env.IOS_INSTALL_URL = CONFIGURED_INSTALL_URL;
  releaseApi();
});

const CLUB = 'Riverside Runners';

function livePreview(name = CLUB, memberCount = 12): void {
  armApi(() => Response.json(previewBody({ name, memberCount })));
}

describe('the mechanism the whole suite rests on', () => {
  it('reaches the Worker with a stubbed global fetch, so a stub is really what it calls', async () => {
    // `fetchMock` was removed from `cloudflare:test` in pool 0.22 and `vi.stubGlobal` replaced it.
    // Asserted rather than assumed: if the stub did NOT reach the Worker, every degraded-page test
    // below would still pass, because a real request to the api would also fail in CI.
    livePreview();

    await get(`/join/${TOKEN}`);

    expect(apiRequests().map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${API_ORIGIN}/invites/${TOKEN}/preview`,
    ]);
  });
});

describe('a live invite', () => {
  it('names the club', async () => {
    livePreview();

    const { response, body } = await get(`/join/${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(body).toContain(CLUB);
  });

  it('carries the deep link, so an installed app can take over', async () => {
    livePreview();

    const { body } = await get(`/join/${TOKEN}`);

    expect(body).toContain(`href="clubchat://join/${TOKEN}"`);
  });

  it('tells the visitor who does not have the app how to get it, and links nowhere dead', async () => {
    // This page is the whole point of the Worker: somebody scanned a QR code on a table and has
    // never heard of ClubChat. The button here used to be `apps.apple.com/app/id6804458376`, which
    // is a 404 - the app has never been released and is TestFlight internal only - so the primary
    // call to action handed that person an Apple error page.
    livePreview();

    const { body } = await get(`/join/${TOKEN}`);

    expect(body).not.toContain('apps.apple.com');
    expect(body).toMatch(/private beta/i);
    // The deep link stays either way: an installed app is still the thing this page hands over to.
    expect(body).toContain(`href="clubchat://join/${TOKEN}"`);
  });

  it('carries the download link once there is one to carry', async () => {
    env.IOS_INSTALL_URL = 'https://apps.apple.com/app/id6804458376';
    livePreview();

    const { body } = await get(`/join/${TOKEN}`);

    expect(body).toContain('href="https://apps.apple.com/app/id6804458376"');
    expect(body).not.toMatch(/private beta/i);
  });

  it('prints the member count the api reported', async () => {
    armApi(() => Response.json(previewBody({ name: CLUB, memberCount: 12 })));

    const { body } = await get(`/join/${TOKEN}`);

    expect(body).toMatch(/12 members/);
  });

  it('omits the member count rather than printing a made-up zero', async () => {
    // A 200 with no `memberCount` is the api answering a shape this page does not fully understand.
    // "0 members" would be a false statement on the one page whose job is to be trustworthy.
    armApi(() => Response.json({ club: { name: CLUB }, expiresAt: null }));

    const { response, body } = await get(`/join/${TOKEN}`);

    expect(response.status).toBe(200);
    expect(body).toContain(CLUB);
    expect(body).not.toMatch(/\b0 members\b/);
  });

  it('is never cached, because it names a club and reflects live state', async () => {
    livePreview();

    const { response } = await get(`/join/${TOKEN}`);

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('is not indexable, because the URL is the invite', async () => {
    livePreview();

    const { response, body } = await get(`/join/${TOKEN}`);

    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(body).toContain('content="noindex, nofollow"');
  });

  it('sends no referrer, so the token does not leak to the App Store', async () => {
    livePreview();

    const { response } = await get(`/join/${TOKEN}`);

    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('an invite the api refuses', () => {
  it('says the link is not valid any more, and does not error', async () => {
    armApi(() => new Response(JSON.stringify({ error: 'invite_invalid' }), { status: 404 }));

    const { response, body } = await get(`/join/${TOKEN}`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(body).toMatch(/not valid any more/i);
  });

  it('renders no empty button row while there is nothing at all to offer', async () => {
    // This page has no deep link by design, and no download while the app is in private beta. That
    // leaves an `.actions` flex row with nothing in it, which reads as a button that failed to
    // render rather than as a page that deliberately has none.
    armApi(() => new Response(null, { status: 404 }));

    const { body } = await get(`/join/${TOKEN}`);

    expect(body).not.toContain('<div class="actions"></div>');
    expect(body).not.toContain('apps.apple.com');
  });

  it('does not offer a deep link into a club that will refuse it', async () => {
    armApi(() => new Response(null, { status: 404 }));

    const { body } = await get(`/join/${TOKEN}`);

    expect(body).not.toContain('clubchat://join/');
  });

  it('answers a token outside the charset without asking the api at all', async () => {
    // `blockApi` is armed, so this test fails loudly if the Worker builds a URL out of it. The
    // token is the only caller-controlled part of the api URL this Worker constructs.
    const { response, body } = await get('/join/not%2Fa%2Ftoken');

    expect(response.status).toBe(404);
    expect(body).toMatch(/not valid any more/i);
    expect(apiRequests()).toEqual([]);
  });

  it('answers a token that is far too short without asking the api', async () => {
    const { response } = await get('/join/abc');

    expect(response.status).toBe(404);
    expect(apiRequests()).toEqual([]);
  });
});

describe('the api being unreachable', () => {
  it('renders a degraded page rather than a 500 when the connection fails', async () => {
    armApiFailure();

    const { response, body } = await get(`/join/${TOKEN}`);

    expect(response.status).toBe(200);
    expect(body).toMatch(/could not/i);
  });

  it('renders a degraded page rather than a 500 when the request times out', async () => {
    armApiFailure(new DOMException('The operation was aborted', 'TimeoutError'));

    const { response } = await get(`/join/${TOKEN}`);

    expect(response.status).toBe(200);
  });

  it('renders a degraded page when the api answers 500', async () => {
    armApi(() => new Response('upstream exploded', { status: 500 }));

    const { response, body } = await get(`/join/${TOKEN}`);

    expect(response.status).toBe(200);
    expect(body).toMatch(/could not/i);
  });

  it('renders a degraded page when the api answers 200 with something that is not JSON', async () => {
    armApi(() => new Response('<html>a proxy error page</html>', { status: 200 }));

    const { response } = await get(`/join/${TOKEN}`);

    expect(response.status).toBe(200);
  });

  it('renders a degraded page when the api answers 200 with no club name', async () => {
    armApi(() => Response.json({ club: { memberCount: 4 }, expiresAt: null }));

    const { response } = await get(`/join/${TOKEN}`);

    expect(response.status).toBe(200);
  });

  it('never says the invite is dead, because it has no evidence of that', async () => {
    armApiFailure();

    const { body } = await get(`/join/${TOKEN}`);

    expect(body).not.toMatch(/not valid any more/i);
  });

  it('still carries both ways into the app', async () => {
    env.IOS_INSTALL_URL = 'https://apps.apple.com/app/id6804458376';
    armApiFailure();

    const { body } = await get(`/join/${TOKEN}`);

    expect(body).toContain(`href="clubchat://join/${TOKEN}"`);
    expect(body).toContain('href="https://apps.apple.com/app/id6804458376"');
  });

  it('keeps the deep link and says how to get the app while there is no download', async () => {
    armApiFailure();

    const { body } = await get(`/join/${TOKEN}`);

    expect(body).toContain(`href="clubchat://join/${TOKEN}"`);
    expect(body).not.toContain('apps.apple.com');
    expect(body).toMatch(/private beta/i);
  });

  it('does not leak the upstream error into the page', async () => {
    armApiFailure(new Error('ECONNREFUSED 10.0.0.7:8080'));

    const { body } = await get(`/join/${TOKEN}`);

    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('10.0.0.7');
  });
});

describe('the shape of the request the Worker makes', () => {
  it('asks for JSON and asks the configured origin', async () => {
    livePreview();

    await SELF.fetch(`${SITE_ORIGIN}/join/${TOKEN}`);

    expect(apiRequests()[0]?.url).toBe(`${API_ORIGIN}/invites/${TOKEN}/preview`);
  });

  it('sends no cookie and no authorization, because the endpoint is public', async () => {
    livePreview();

    await SELF.fetch(`${SITE_ORIGIN}/join/${TOKEN}`, {
      headers: { cookie: 'better-auth.session_token=secret', authorization: 'Bearer secret' },
    });

    // The Worker builds its own request rather than forwarding the visitor's. A forwarded cookie
    // would be a session token from the apex arriving at the api on a page anybody can open.
    expect(apiRequests()).toHaveLength(1);
    expect(apiRequests()[0]?.headers['cookie']).toBeUndefined();
    expect(apiRequests()[0]?.headers['authorization']).toBeUndefined();
  });
});
