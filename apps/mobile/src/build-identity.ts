/**
 * Which build this is, and which JavaScript bundle it is running.
 *
 * **The app displayed neither, and over-the-air updates turned that from untidy into a hole.** A
 * binary changes only through TestFlight or the App Store, so "which build is on this phone" was
 * answerable by remembering what was last installed. A JavaScript bundle now changes on its own,
 * in the background, on somebody else's phone - and the question that follows every publish,
 * *did it land?*, had no answer from the device.
 *
 * It has no answer anywhere else either, which is the part worth stating. `SPEC/TECH/14` pitfall
 * 42 records that an `eas update` published against the wrong runtime version does not fail: it
 * uploads, reports success, and is offered to no phone in existence. Nothing on the laptop, in
 * Sentry, or on the device says so. The only evidence that an update arrived is the phone showing
 * a different bundle than it showed before, and that requires the phone to show one at all.
 *
 * ## Two values, and they answer different questions
 *
 * `expo-application` reads the binary's own `Info.plist` at runtime, so `nativeVersion` and
 * `nativeBuild` are facts about the **installed app** and an update cannot move them. `expo-updates`
 * reports which **bundle** that binary chose to run, which is exactly what an update does move.
 * Showing one without the other is how somebody concludes an update landed because the version
 * string looks new, or that it did not because the version string looks old.
 *
 * `expo-constants` would have been the obvious source for a version and is the wrong one here.
 * `Constants.expoConfig` is read from the *manifest of the running update*, so after an update it
 * reports the `version` in the bundle's copy of `app.json` rather than the version of the binary
 * underneath it - the two are allowed to differ, and `eas.json` sets `appVersionSource: remote`,
 * which means nothing maintains `app.json`'s version by hand in the first place.
 *
 * ## Pure on purpose
 *
 * Nothing here imports a native module, so it can be tested - the mobile app has deliberately no
 * component or hook harness (`AGENTS.md`), and what can be tested is what can be read as a value.
 * The caller reads the constants off `expo-application` and `expo-updates` and passes them in, the
 * same split `config.ts` and `endpoint.ts` already make one layer down.
 */

import { formatInstant } from './dates.ts';

/**
 * What the device says about itself.
 *
 * Every field is nullable because every one of them genuinely is. On web both native values are
 * `null` and there is no update identity at all; in a development build `expo-updates` is disabled
 * and reports nothing. Those are supported states rather than errors, and each has its own line
 * below rather than a shared "unknown".
 */
export type BuildFacts = {
  /** `Application.nativeApplicationVersion` - `CFBundleShortVersionString`, e.g. `"1.0.0"`. */
  nativeVersion: string | null;
  /** `Application.nativeBuildVersion` - `CFBundleVersion`, e.g. `"5"`. */
  nativeBuild: string | null;
  /** `Updates.updateId` - the running bundle's uuid, or `null` where updates are disabled. */
  updateId: string | null;
  /** `Updates.isEmbeddedLaunch` - true while running the bundle compiled into the binary. */
  isEmbeddedLaunch: boolean;
  /** `Updates.createdAt`, as an ISO instant. The build's commit time for an embedded launch. */
  publishedAt: string | null;
  /** `Updates.channel` - `production` or `preview`, and the value a mis-aimed publish gets wrong. */
  channel: string | null;
  /** `Updates.runtimeVersion` - the fingerprint an update has to match to be offered at all. */
  runtimeVersion: string | null;
  /** `Updates.isEmergencyLaunch` - an update was found, could not start, and was abandoned. */
  isEmergencyLaunch: boolean;
  /** `Updates.emergencyLaunchReason` - why, when the above is true. */
  emergencyLaunchReason: string | null;
};

export type BuildIdentity = {
  /** The binary. `"Version 1.0.0 (5)"`. Only a store release changes this. */
  version: string;
  /** The JavaScript, in one plain sentence. An over-the-air update DOES change this. */
  bundle: string;
  /** Both of the above plus the values too long to read off a screen, for the clipboard. */
  report: string;
};

/**
 * Eight characters of the uuid.
 *
 * Enough to tell two updates apart by eye and short enough to sit on one line beside a date, which
 * a 36-character uuid is not. The whole value is still in `report`, because the short form is for
 * recognising and the long form is for matching against what `eas update` printed.
 */
const SHORT_ID_LENGTH = 8;

export function shortUpdateId(updateId: string | null): string | null {
  const full = present(updateId);
  return full === null ? null : full.slice(0, SHORT_ID_LENGTH);
}

/**
 * `null` for anything that is not a usable string.
 *
 * `expo-updates` reports the empty string rather than `null` for `channel` and `runtimeVersion` on
 * web, so a plain null check would put `Channel: ` in the report and call it a value. Absent and
 * empty mean the same thing here and are collapsed once, at the edge.
 */
function present(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function versionText(facts: BuildFacts): string {
  const version = present(facts.nativeVersion);
  const build = present(facts.nativeBuild);
  if (version === null && build === null) return 'Version unavailable';
  if (version === null) return `Build ${build}`;
  if (build === null) return `Version ${version}`;
  return `Version ${version} (${build})`;
}

/**
 * One sentence naming which JavaScript is running, in the order the cases matter.
 *
 * The emergency launch goes first because it is the only one that reports something being wrong.
 * `expo-updates` falls back to the embedded bundle when a downloaded update cannot start, and
 * without this line that is indistinguishable from an update that never arrived - the same
 * silence, from the opposite cause, and the two want opposite responses.
 */
function bundleText(facts: BuildFacts): string {
  const short = shortUpdateId(facts.updateId);
  const published = present(facts.publishedAt);
  const when = published === null ? null : formatInstant(published);

  if (facts.isEmergencyLaunch) {
    return 'An update would not start, so this is the bundle built into the app.';
  }
  if (short === null) {
    return 'Development bundle. Over-the-air updates are off in this build.';
  }
  if (facts.isEmbeddedLaunch) {
    return when === null
      ? `No update yet. Running the bundle built into the app, ${short}.`
      : `No update yet. Running the bundle built into the app on ${when}.`;
  }
  return when === null ? `Update ${short}.` : `Update ${short}, published ${when}.`;
}

/**
 * Every line, always, with `none` where there is no value.
 *
 * A fixed shape rather than a compacted one, so a missing channel reads as a missing channel
 * instead of looking like a line somebody forgot to add. This is pasted into a message when
 * somebody is trying to work out why an update did not arrive, and at that moment the absence of
 * a value is itself the finding.
 */
function reportText(facts: BuildFacts, version: string, bundle: string): string {
  const lines = [
    version,
    bundle,
    `Update id: ${present(facts.updateId) ?? 'none'}`,
    `Published: ${present(facts.publishedAt) ?? 'none'}`,
    `Channel: ${present(facts.channel) ?? 'none'}`,
    `Runtime version: ${present(facts.runtimeVersion) ?? 'none'}`,
  ];
  if (facts.isEmergencyLaunch) {
    lines.push(`Emergency launch: ${present(facts.emergencyLaunchReason) ?? 'no reason given'}`);
  }
  return lines.join('\n');
}

export function describeBuild(facts: BuildFacts): BuildIdentity {
  const version = versionText(facts);
  const bundle = bundleText(facts);
  return { version, bundle, report: reportText(facts, version, bundle) };
}
