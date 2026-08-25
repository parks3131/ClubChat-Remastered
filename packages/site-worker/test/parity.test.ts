/**
 * `GET /__parity`, the same convention `packages/cdn-worker` follows, pointed at this Worker's own
 * likeliest failures.
 *
 * The CDN's parity route answers one question - do the api and the Worker hold the same signing
 * secret - because that is its one silent failure. This Worker has different ones, and every one of
 * them is silent in the same way: nothing throws, nothing 5xxes, and the symptom appears somewhere
 * else entirely.
 *
 *  - `API_ORIGIN` wrong or cleared: every join page is the degraded one. Looks like the api is down.
 *  - `IOS_APP_ID` wrong: universal links stop opening the app. Looks like an entitlement problem.
 *  - `IOS_INSTALL_URL` unset: every page says the app is in private beta and offers no download.
 *  - `ANDROID_CERT_FINGERPRINTS` unset: Android app links never verify. Looks like an app bug.
 *  - the legal documents not bundled: `/privacy` serves an empty page. Looks like a routing bug.
 *
 * So this route prints what the Worker is actually holding, and the legal documents' lengths rather
 * than their text, which answers "did the words deploy" without publishing them twice.
 */

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_ORIGIN, blockApi, get, releaseApi } from './harness.ts';

const CONFIGURED_FINGERPRINTS = env.ANDROID_CERT_FINGERPRINTS;
const CONFIGURED_INSTALL_URL = env.IOS_INSTALL_URL;

beforeEach(blockApi);
afterEach(() => {
  env.ANDROID_CERT_FINGERPRINTS = CONFIGURED_FINGERPRINTS;
  env.IOS_INSTALL_URL = CONFIGURED_INSTALL_URL;
  releaseApi();
});

type ParityBody = {
  apiOrigin: string | null;
  iosAppId: string;
  installUrl: string | null;
  androidPackageName: string;
  androidFingerprints: number;
  legal: { privacy: number; terms: number };
  version: string;
};

async function parity(): Promise<{ response: Response; body: ParityBody }> {
  const { response, body } = await get('/__parity');
  return { response, body: JSON.parse(body) as ParityBody };
}

describe('the parity route', () => {
  it('answers the contract shape as JSON with no-store', async () => {
    const { response, body } = await parity();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    // A cached answer is worse than no answer here: this is the route you reach WHILE something is
    // misconfigured, and it would report what the Worker held before the fix.
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(body).sort()).toEqual([
      'androidFingerprints',
      'androidPackageName',
      'apiOrigin',
      'installUrl',
      'iosAppId',
      'legal',
      'version',
    ]);
  });

  it('prints the api origin it will actually call', async () => {
    const { body } = await parity();

    expect(body.apiOrigin).toBe(API_ORIGIN);
  });

  it('prints the app ids the two association files publish', async () => {
    const { body } = await parity();

    expect(body.iosAppId).toBe('NT7NNC4FJC.com.parkstechusa.clubchat.remastered');
    expect(body.androidPackageName).toBe('com.parkstechusa.clubchat.remastered');
  });

  it('reports no install url while the app is in private beta, which is the shipped state', async () => {
    // The one switch that turns the download button back on across every page. Null here and a
    // "private beta" page in a browser are the same fact, which is the point of printing it: the
    // question "why is there no download button" is one request rather than a read of three files.
    const { body } = await parity();

    expect(body.installUrl).toBeNull();
  });

  it('prints the install url once one is configured', async () => {
    env.IOS_INSTALL_URL = 'https://apps.apple.com/app/id6804458376';

    const { body } = await parity();

    expect(body.installUrl).toBe('https://apps.apple.com/app/id6804458376');
  });

  it('reports a non-https install url as none, rather than as configured', async () => {
    // A var is editable in the Cloudflare dashboard, and a value that is not an https URL is a
    // typo rather than a destination. Reporting it as configured would send somebody looking at
    // the pages for a button that the pages are right not to render.
    env.IOS_INSTALL_URL = 'apps.apple.com/app/id6804458376';

    const { body } = await parity();

    expect(body.installUrl).toBeNull();
  });

  it('counts the Android fingerprints rather than printing them', async () => {
    env.ANDROID_CERT_FINGERPRINTS = 'AA:BB, CC:DD';

    const { body } = await parity();

    expect(body.androidFingerprints).toBe(2);
  });

  it('reports zero fingerprints while none is configured, which is the shipped state', async () => {
    env.ANDROID_CERT_FINGERPRINTS = '';

    const { body } = await parity();

    expect(body.androidFingerprints).toBe(0);
  });

  it('reports the size of each bundled legal document, so an empty one is visible', async () => {
    const { body } = await parity();

    expect(body.legal.privacy).toBeGreaterThan(0);
    expect(body.legal.terms).toBeGreaterThan(0);
  });

  it('reports the deployed version', async () => {
    const { body } = await parity();

    expect(typeof body.version).toBe('string');
  });

  it('answers with the api unreachable, because that is when it is asked', async () => {
    // `blockApi` is armed for every test in this file, so this is already true of all of them. It
    // is stated as its own test because it is the property that matters: the diagnostic must not
    // depend on the thing it diagnoses.
    const { response } = await parity();

    expect(response.status).toBe(200);
  });
});
