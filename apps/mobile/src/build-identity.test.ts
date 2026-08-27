/**
 * The version line, asserted branch by branch.
 *
 * **Every case here is a state a real phone reaches**, which is why there are six of them rather
 * than one. A fresh install runs the embedded bundle; the same phone an hour later runs a
 * downloaded one; a development build has no update identity at all; web has no native version
 * either; and an update that will not start puts the app back on the embedded bundle while
 * reporting that it did. Those last two are the ones a version line exists for and the ones
 * nothing else in the system can tell apart.
 *
 * Dates are asserted through `formatInstant` rather than against literal text, because that
 * function renders in the reader's locale and timezone and a literal would pass on this laptop
 * and fail on any other machine. What is being checked is that the instant reaches the line at
 * all, not how a locale spells a Tuesday.
 */

import { describe, expect, it } from 'vitest';
import { describeBuild, shortUpdateId, type BuildFacts } from './build-identity.ts';
import { formatInstant } from './dates.ts';

const UPDATE_ID = '3f9c2a1b-7d4e-4c11-9a5b-2e0f8c6d1a44';
const PUBLISHED = '2026-08-27T15:10:22.000Z';

/** A production iOS build running a downloaded update. Every other case varies from this one. */
const downloaded: BuildFacts = {
  nativeVersion: '1.0.0',
  nativeBuild: '5',
  updateId: UPDATE_ID,
  isEmbeddedLaunch: false,
  publishedAt: PUBLISHED,
  channel: 'production',
  runtimeVersion: '7d3ffda1f1f71a38b15e0d92511d40e6eb3f1c7c',
  isEmergencyLaunch: false,
  emergencyLaunchReason: null,
};

describe('the native version, which an update cannot change', () => {
  it('reads as version and build number together', () => {
    expect(describeBuild(downloaded).version).toBe('Version 1.0.0 (5)');
  });

  /*
   * Both are null on web, where there is no binary to read an Info.plist out of. The line has to
   * say so rather than render "Version  ()", which looks like a defect in the app.
   */
  it('says so plainly when there is no binary to ask', () => {
    expect(describeBuild({ ...downloaded, nativeVersion: null, nativeBuild: null }).version).toBe(
      'Version unavailable',
    );
  });

  it('still reports whichever half it has', () => {
    expect(describeBuild({ ...downloaded, nativeBuild: null }).version).toBe('Version 1.0.0');
    expect(describeBuild({ ...downloaded, nativeVersion: null }).version).toBe('Build 5');
  });
});

describe('which bundle is running, which is the whole point', () => {
  it('names a downloaded update by its short id and when it was published', () => {
    expect(describeBuild(downloaded).bundle).toBe(
      `Update 3f9c2a1b, published ${formatInstant(PUBLISHED)}.`,
    );
  });

  /*
   * The state a phone is in between installing a build and taking its first update, and the state
   * the founder's phone is in right now. It has an update id - the embedded bundle is an update
   * like any other - so the id alone cannot distinguish it. `isEmbeddedLaunch` can.
   */
  it('distinguishes the bundle that shipped inside the build from one that arrived later', () => {
    const embedded = describeBuild({ ...downloaded, isEmbeddedLaunch: true });
    expect(embedded.bundle).toBe(
      `No update yet. Running the bundle built into the app on ${formatInstant(PUBLISHED)}.`,
    );
    expect(embedded.bundle).not.toContain('published');
  });

  /*
   * A development build loads its JavaScript from Metro and `expo-updates` is disabled, so there
   * is no id, no channel and no runtime version. Saying "no update yet" there would be a claim
   * about a mechanism that is not running.
   */
  it('does not pretend a development build is waiting for an update', () => {
    const dev = describeBuild({
      ...downloaded,
      updateId: null,
      publishedAt: null,
      channel: null,
      runtimeVersion: null,
    });
    expect(dev.bundle).toBe('Development bundle. Over-the-air updates are off in this build.');
  });

  /*
   * The failure this line exists for. `expo-updates` falls back to the embedded bundle when a
   * downloaded update cannot start, and every other signal in the system is identical to an
   * update that simply never arrived: same bundle, no error, nothing in Sentry. The two want
   * opposite responses, so the sentence has to separate them.
   */
  it('reports an update that was found and would not start', () => {
    const failed = describeBuild({
      ...downloaded,
      isEmergencyLaunch: true,
      emergencyLaunchReason: 'Failed to launch the update',
    });
    expect(failed.bundle).toBe(
      'An update would not start, so this is the bundle built into the app.',
    );
    expect(failed.report).toContain('Emergency launch: Failed to launch the update');
  });
});

describe('the short id', () => {
  it('is the first eight characters, which is what fits beside a date', () => {
    expect(shortUpdateId(UPDATE_ID)).toBe('3f9c2a1b');
  });

  /*
   * `expo-updates` reports the empty string rather than null for some of these on web. An empty
   * string is absent, and collapsing the two here is what stops `Update .` reaching a screen.
   */
  it('treats absent and empty as the same thing', () => {
    expect(shortUpdateId(null)).toBeNull();
    expect(shortUpdateId('')).toBeNull();
    expect(shortUpdateId('   ')).toBeNull();
  });
});

describe('the report, which is what gets pasted into a message', () => {
  it('carries the values too long to read off a screen', () => {
    const report = describeBuild(downloaded).report;
    expect(report).toContain('Version 1.0.0 (5)');
    expect(report).toContain(`Update id: ${UPDATE_ID}`);
    expect(report).toContain(`Published: ${PUBLISHED}`);
    expect(report).toContain('Channel: production');
    expect(report).toContain(
      'Runtime version: 7d3ffda1f1f71a38b15e0d92511d40e6eb3f1c7c',
    );
  });

  /*
   * The runtime version is the one value that answers pitfall 42 from the device. An update is
   * only ever offered to a binary whose runtime version matches the one it was published against,
   * and a mismatch is silent on both ends - so being able to read the phone's own is the only way
   * to check a publish against the thing it was aimed at.
   */
  it('keeps every line when a value is missing, so an absence is visible', () => {
    const report = describeBuild({
      ...downloaded,
      channel: '',
      runtimeVersion: null,
    }).report;
    expect(report).toContain('Channel: none');
    expect(report).toContain('Runtime version: none');
  });

  /*
   * No emergency, no line. The report has a fixed shape everywhere else on purpose; this one is
   * an exception because a line saying "Emergency launch: no" on every healthy phone trains
   * whoever reads it to skip the row that matters.
   */
  it('mentions an emergency launch only when there was one', () => {
    expect(describeBuild(downloaded).report).not.toContain('Emergency launch');
  });
});
