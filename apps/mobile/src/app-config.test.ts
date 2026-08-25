/**
 * The native configuration, asserted against the values the rest of the system already depends on.
 *
 * Everything checked here fails SILENTLY when it is wrong. A universal link that the app does not
 * claim opens a web page instead of the app, with nothing logged on either side. An Android
 * package name that does not match the one published in `assetlinks.json` fails verification with
 * no error anywhere. An over-the-air update sent to the wrong channel installs itself on the wrong
 * builds. None of those produces a stack trace, a red screen, or a failing request - they produce
 * a thing that quietly does not happen, which is the slowest class of defect to find.
 *
 * So the file reads `app.json` and `eas.json` as data and pins the handful of values that two
 * separate systems have to agree on. It mirrors `legal.test.ts`, which reads the legal markdown
 * from the repository for the same reason: the mobile app has deliberately no component or hook
 * test harness (see `AGENTS.md`), so what can be tested is what can be read as a value.
 *
 * **The other half of the link association lives in `packages/site-worker`** and is asserted
 * there, against the exact documents it serves. Neither half is any use alone.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVITE_LINK_ORIGIN } from './invite-link.ts';

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));

type IntentFilterData = { scheme?: string; host?: string; pathPrefix?: string };

type IntentFilter = {
  action?: string;
  autoVerify?: boolean;
  category?: string[];
  data?: IntentFilterData[];
};

type AppConfig = {
  expo: {
    scheme?: string;
    runtimeVersion?: { policy?: string } | string;
    updates?: {
      url?: string;
      fallbackToCacheTimeout?: number;
      checkAutomatically?: string;
    };
    extra?: { eas?: { projectId?: string } };
    ios?: { bundleIdentifier?: string; associatedDomains?: string[] };
    android?: { package?: string; intentFilters?: IntentFilter[] };
  };
};

type EasConfig = { build: Record<string, { channel?: string } | undefined> };

const app = (readJson('../app.json') as AppConfig).expo;
const eas = readJson('../eas.json') as EasConfig;

/** The host both association files are written for, taken from the link the app hands out. */
const INVITE_HOST = new URL(INVITE_LINK_ORIGIN).hostname;

describe('iOS universal links', () => {
  it('claims the host the invite link is built on', () => {
    expect(app.ios?.associatedDomains).toEqual([`applinks:${INVITE_HOST}`]);
  });

  /*
   * Expo's own documentation calls this out as "a common mistake that will result in the universal
   * links not working", and it is invisible: `applinks:https://clubchatapp.com` is a well-formed
   * string that Apple never matches against anything.
   */
  it('carries no protocol in the value, which is the classic way to get this wrong', () => {
    for (const domain of app.ios?.associatedDomains ?? []) {
      expect(domain).not.toContain('https');
      expect(domain).not.toContain('//');
    }
  });
});

describe('Android app links', () => {
  const httpsFilters = (app.android?.intentFilters ?? []).filter((filter) =>
    (filter.data ?? []).some((datum) => datum.scheme === 'https'),
  );

  it('declares exactly one https filter, so there is one place this is decided', () => {
    expect(httpsFilters).toHaveLength(1);
  });

  it('auto-verifies, without which the OS never claims the link at all', () => {
    expect(httpsFilters[0]?.autoVerify).toBe(true);
  });

  it('is a browsable VIEW filter, which is what a tapped link delivers', () => {
    expect(httpsFilters[0]?.action).toBe('VIEW');
    expect(httpsFilters[0]?.category).toEqual(['BROWSABLE', 'DEFAULT']);
  });

  /*
   * `/join/` with the trailing slash, not `/join`. `pathPrefix` is a literal prefix match, so the
   * shorter spelling would also claim `/joinery` and any other path that happens to start with
   * those five letters - and every one of those would open the app on a route it does not have.
   * The trailing slash makes the prefix mean the path segment it looks like it means, and matches
   * the `/join/*` component the AASA file claims.
   */
  it('claims only the join path, on only the invite host', () => {
    expect(httpsFilters[0]?.data).toEqual([
      { scheme: 'https', host: INVITE_HOST, pathPrefix: '/join/' },
    ]);
  });
});

describe('the custom scheme, which has to keep working', () => {
  /*
   * Old links live in sent messages and on printed QR codes, and neither can be recalled. Dropping
   * the scheme would break every one of them for an installed user - the case that works today.
   */
  it('is still declared', () => {
    expect(app.scheme).toBe('clubchat');
  });
});

describe('the two halves of the association', () => {
  /*
   * `packages/site-worker/wrangler.jsonc` publishes ANDROID_PACKAGE_NAME as the iOS bundle id,
   * because app.json used to declare no Android package at all and that is what Expo defaults to.
   * The package is declared explicitly now, and this is the assertion that keeps the two equal:
   * if they ever diverge, `assetlinks.json` names an app that does not exist and Android app links
   * fail verification with nothing logged anywhere.
   */
  it('names an Android package equal to the iOS bundle id, which assetlinks.json assumes', () => {
    expect(app.android?.package).toBe('com.parkstechusa.clubchat.remastered');
    expect(app.android?.package).toBe(app.ios?.bundleIdentifier);
  });
});

describe('over-the-air updates', () => {
  /*
   * The single most consequential value in this file. A runtime version is the compatibility
   * contract between a JavaScript bundle and the native binary that runs it, and `fingerprint` is
   * the only policy that derives it from the native project itself rather than from a number a
   * human remembers to change. See ADR-0048.
   */
  it('uses the fingerprint runtime version policy', () => {
    expect(app.runtimeVersion).toEqual({ policy: 'fingerprint' });
  });

  it('points at the EAS Update endpoint for this project', () => {
    const projectId = app.extra?.eas?.projectId;
    expect(projectId).toBeTruthy();
    expect(app.updates?.url).toBe(`https://u.expo.dev/${projectId}`);
  });

  /*
   * Zero means the app never waits on the network to start. The app holds its own first frame on
   * the font gate already; a second gate in front of that one, on a request that can time out,
   * would make a cold start on a bad connection look like a hang.
   */
  it('never holds the launch waiting for an update', () => {
    expect(app.updates?.fallbackToCacheTimeout).toBe(0);
    expect(app.updates?.checkAutomatically).toBe('ON_LOAD');
  });

  /*
   * Nothing in `app/` or `src/` imports `expo-updates`: all of its behaviour is native and all of
   * its configuration is above. So it looks unused to anything that counts imports, and removing it
   * would leave an `updates` block that reads as configured while nothing implements it. This is
   * the assertion that makes that removal loud.
   */
  it('actually depends on expo-updates, which nothing imports', () => {
    const pkg = readJson('../package.json') as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.['expo-updates']).toBeTruthy();
  });

  it('gives preview and production separate channels', () => {
    expect(eas.build['preview']?.channel).toBe('preview');
    expect(eas.build['production']?.channel).toBe('production');
    expect(eas.build['preview']?.channel).not.toBe(eas.build['production']?.channel);
  });

  /*
   * The development profile builds a dev client, which loads its JavaScript from Metro. Giving it
   * a channel would be a claim that it takes updates, and it does not.
   */
  it('leaves the development profile without a channel', () => {
    expect(eas.build['development']?.channel).toBeUndefined();
  });
});
