/**
 * What every test in this package shares, and the one mechanism all of them depend on.
 *
 * ## Stubbing the api, and why it is not `fetchMock`
 *
 * `GET /join/:token` is the only route here that makes an outbound request, and every interesting
 * thing about it is a different answer from `GET /invites/:token/preview` on the api. So the suite
 * lives or dies on being able to control that answer.
 *
 * **`fetchMock` is gone from `cloudflare:test` in pool 0.22.** Every recipe and every answer still
 * says `import { fetchMock } from 'cloudflare:test'`, and in this version there is no such export:
 * `node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts` still DECLARES the
 * `MockAgent` class and its whole interceptor API and exports no instance of it, which is the worst
 * shape a removal can have - the types read as though it is there.
 *
 * The replacement is `vi.stubGlobal('fetch', ...)`, and it works for a documented reason rather
 * than by luck. The doc comment on `SELF` in that same declaration file says: "this `main` worker
 * runs in the same isolate/context as tests, so any global mocks will apply to it too." The Worker
 * calls `fetch(...)` as a bare global at call time, so the stub is what it reaches.
 *
 * **`SELF.fetch` itself is unaffected**, because it is a service binding rather than the global
 * `fetch`, so stubbing the global does not break the test's own way of driving the Worker. That is
 * the property that makes this work at all, and `it('reaches the Worker...')` in `join.test.ts`
 * asserts it directly rather than leaving the whole suite resting on it silently.
 *
 * ## The default stub throws
 *
 * `armApi` is called with an explicit handler in every test that expects an api call. A test that
 * forgets is not quietly allowed onto the real internet: `blockApi` installs a stub that throws,
 * and `afterEach` restores the real global. Without that, a test asserting the degraded page would
 * pass whether the code was right or the network was merely down.
 *
 * ## `SELF` is deprecated and is used anyway
 *
 * 0.22 marks it in favour of `import { exports } from 'cloudflare:workers'`. `packages/cdn-worker`
 * drives its Worker through `SELF`, and two sibling Workers tested two different ways is a worse
 * outcome than one deprecation warning. Both move together, or neither does.
 */

import { SELF } from 'cloudflare:test';
import { vi } from 'vitest';

/** The origin every request in this suite is made against. The apex, which is what ships. */
export const SITE_ORIGIN = 'https://clubchatapp.com';

/** The api origin `wrangler.jsonc` configures, so a test can assert the URL that was built. */
export const API_ORIGIN = 'https://api.clubchatapp.com';

/** A token of the shape `mintInviteToken` produces: 32 bytes of CSPRNG as base64url. */
export const TOKEN = 'Rk9PQkFSQkFaMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE0';

/** Every request the Worker made while a stub was armed, in order. */
export type RecordedRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
};

let recorded: RecordedRequest[] = [];

/** What the Worker asked the api for, since the last `armApi` or `blockApi`. */
export function apiRequests(): readonly RecordedRequest[] {
  return recorded;
}

function install(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  recorded = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    recorded.push({ url, method: init?.method ?? 'GET', headers });
    return handler(url, init);
  });
}

/** Answer the Worker's outbound request with this response. */
export function armApi(respond: () => Response | Promise<Response>): void {
  install(async () => respond());
}

/** Fail the Worker's outbound request the way a timeout or a refused connection does. */
export function armApiFailure(error: unknown = new Error('connection refused')): void {
  install(() => Promise.reject(error));
}

/**
 * Make any outbound request an error, for the routes that must not make one.
 *
 * This is the tripwire shape `packages/cdn-worker/test/harness.ts` uses on its R2 bindings: it
 * turns "did not call the api" from something inferred out of a status code into something that
 * would explode if it were false.
 */
export function blockApi(): void {
  install(() => {
    throw new Error('tripwire: the Worker called fetch() on a route that must not');
  });
}

/** Undo the stub. Every test file calls this in an `afterEach`. */
export function releaseApi(): void {
  vi.unstubAllGlobals();
  recorded = [];
}

/** The api's 200 for a live token, in the shape the interface contract fixes. */
export function previewBody(club: { name: string; memberCount?: number }): unknown {
  return {
    club: { name: club.name, memberCount: club.memberCount ?? 0 },
    expiresAt: null,
  };
}

/** A GET against the site, with the response and its text body already read. */
export async function get(path: string): Promise<{ response: Response; body: string }> {
  const response = await SELF.fetch(`${SITE_ORIGIN}${path}`);
  return { response, body: await response.text() };
}
