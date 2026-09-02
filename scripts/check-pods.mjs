#!/usr/bin/env node
//
// AGENTS.md failure mode 41: the simulator's installed build drifts from package.json, and the
// app's launch-time death reads as "the simulator will not open".
//
// A native module is linked by CocoaPods at build time and imported by JS at bundle load. Those
// two facts live in different files that nothing keeps in agreement: add a dependency to
// package.json, forget `pod install`, and Metro will happily serve an import for a module the
// binary has never contained. The app then dies on launch behind a full screen redbox, which
// looks exactly like broken tooling rather than a stale build. On 2026-09-02 that cost a session:
// expo-image was added on 2026-08-27, Podfile.lock was last written on 2026-08-17, and eight pods
// were missing from the build. Reinstalling the .app cannot fix it, because the build products
// are the stale part.
//
// This script compares the two files directly, so the drift is caught before the app launches.
//
// It matches by PODSPEC PATH (`node_modules/<pkg>/`) rather than by pod name. Pod names are
// mangled from package names by no fixed rule (expo-image -> ExpoImage, but
// react-native-gesture-handler -> RNGestureHandler), so guessing them produces false passes. The
// path is written verbatim into Podfile.lock and needs no guessing.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE = join(ROOT, 'apps', 'mobile');
const LOCK = join(MOBILE, 'ios', 'Podfile.lock');

// The two places a workspace dependency can be installed: hoisted to the root, or kept local.
const NODE_MODULES = [join(ROOT, 'node_modules'), join(MOBILE, 'node_modules')];

/**
 * Does Podfile.lock reference this package's podspec?
 *
 * Matching stops at a NAME BOUNDARY, and getting that boundary right is the whole function.
 *
 * A bare `lock.includes('node_modules/' + pkg)` reports expo-image as present when only
 * expo-image-picker is there, so a missing pod passes. Requiring a trailing slash instead fixes
 * that but breaks the other half: a package whose podspec sits at its root is written as
 * `node_modules/react-native-svg` with nothing after it, so six correctly linked pods get
 * reported missing. Both spellings are real and both appear in this lockfile.
 *
 * So: the package path, not followed by another character that could continue a package name.
 * `expo-image-picker` is rejected (a hyphen follows), `expo-image/ios` and a path ending at a
 * backtick or quote are accepted. selfTest below pins all three cases.
 */
function lockReferences(lock, pkg) {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`node_modules/${escaped}(?![A-Za-z0-9_.-])`).test(lock);
}

/** The podspec files a package ships, if any. A package with none needs no pod. */
function podspecsFor(pkg) {
  for (const nm of NODE_MODULES) {
    const base = join(nm, pkg);
    if (!existsSync(base)) continue;
    const found = [];
    for (const dir of [base, join(base, 'ios')]) {
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) if (f.endsWith('.podspec')) found.push(f);
      } catch {
        // not a directory, or unreadable; treated as shipping no podspec
      }
    }
    if (found.length > 0) return found;
    return []; // package resolved here and ships none; do not fall through to the other root
  }
  return []; // not installed at all, which `npm install` is responsible for, not this check
}

/**
 * A checker that cannot fail is worse than no checker, because it reports success.
 *
 * Both halves are pinned: that the matcher finds a package that IS present, and that it does not
 * match a longer package name sharing a prefix.
 */
function selfTest() {
  // Every line here is a real spelling copied out of apps/mobile/ios/Podfile.lock.
  const sample = [
    '  - ExpoImagePicker (from `../../../node_modules/expo-image-picker/ios`)',
    '  - RNSVG (from `../../../node_modules/react-native-svg`)',
    '  - "RNSentry (from `../../../node_modules/@sentry/react-native`)"',
  ].join('\n');

  const cases = [
    // [package, expected, why it is here]
    ['expo-image', false, 'a prefix of expo-image-picker must not count as present'],
    ['expo-image-picker', true, 'podspec under ios/, path continues with a slash'],
    ['react-native-svg', true, 'podspec at package root, path ends at a backtick'],
    ['@sentry/react-native', true, 'scoped name, path ends at a quote'],
  ];

  for (const [pkg, expected, why] of cases) {
    if (lockReferences(sample, pkg) !== expected) {
      process.stderr.write(
        `detector self-test FAILED for ${pkg}: expected ${expected} (${why}).\n` +
          'Aborting rather than reporting clean.\n',
      );
      process.exit(2);
    }
  }
}

selfTest();

// Nothing to check before `expo prebuild` has produced an ios directory. Not a failure: a
// checkout that has never built for iOS is a legitimate state.
if (!existsSync(join(MOBILE, 'ios'))) {
  process.stdout.write('no apps/mobile/ios yet, nothing to check\n');
  process.exit(0);
}

if (!existsSync(LOCK)) {
  process.stderr.write(
    'apps/mobile/ios exists but Podfile.lock does not.\n\n' +
      '  Fix:  cd apps/mobile/ios && pod install\n',
  );
  process.exit(1);
}

const lock = readFileSync(LOCK, 'utf8');
const pkg = JSON.parse(readFileSync(join(MOBILE, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {}).sort();

const missing = [];
let needPod = 0;
for (const dep of deps) {
  const specs = podspecsFor(dep);
  if (specs.length === 0) continue; // JS only, no pod to link
  needPod += 1;
  if (lockReferences(lock, dep)) continue;
  missing.push({ dep, version: pkg.dependencies[dep], specs });
}

if (missing.length > 0) {
  const width = Math.max(...missing.map((m) => m.dep.length));
  process.stderr.write('apps/mobile/ios/Podfile.lock is stale.\n\n');
  process.stderr.write('In package.json but not linked into the iOS build:\n');
  for (const m of missing) {
    process.stderr.write(`  - ${m.dep.padEnd(width)}  ${m.version}\n`);
  }
  process.stderr.write(
    '\nThe app will die at launch with "Cannot find native module", which fills the\n' +
      'screen and reads as a broken simulator. Reinstalling the .app does NOT fix it:\n' +
      'the build products are the stale part. See AGENTS.md failure mode 41.\n\n' +
      '  Fix:  cd apps/mobile/ios && pod install\n' +
      '        then rebuild before launching\n',
  );
  process.exit(1);
}

process.stdout.write(
  `Podfile.lock links all ${needPod} mobile dependencies that need a pod ` +
    `(of ${deps.length} total)\n`,
);
