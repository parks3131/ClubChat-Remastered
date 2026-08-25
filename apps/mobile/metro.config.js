// Metro configuration.
//
// Three things beyond the Expo defaults, all three required by this repo's shape.
//
// 1. Sentry's Expo config wrapper. It wraps `getDefaultConfig`, so everything below still
//    applies to the result.
//
//    **It is not what produces the Debug ID, and the note that used to be here said it was.**
//    Measured both ways with `npx expo export -p ios --source-maps`: Expo SDK 57 already ends the
//    bundle with `//# debugId=<uuid>` and writes the matching `debugId` into the map, with or
//    without this wrapper. So the id - the thing that lets Sentry match an uploaded map to a
//    bundle by identity rather than by two release strings agreeing - was never missing.
//
//    What the wrapper actually adds here: Sentry's own debug-id plugin through Expo's
//    `unstable_beforeAssetSerializationPlugins` hook, which is the supported path and keeps
//    working if Expo ever stops stamping one; the dev-server middleware that gives a stack frame
//    its source context while developing; collapsed Sentry frames in LogBox; release constants
//    for Expo Web; and the replay exclusion below.
//
//    Nothing here uploads anything. The upload happens in the native build (apps/mobile/app.json's
//    @sentry/react-native plugin, and the Xcode "Upload Debug Symbols to Sentry" phase) and needs
//    SENTRY_AUTH_TOKEN in the EAS build environment. That is the one remaining piece, and it is a
//    secret that must never be in this repository.
//
// 2. `wasm` as an asset extension. expo-sqlite's web implementation is wa-sqlite, which
//    imports a .wasm binary; without this Metro fails to resolve it and the WHOLE web
//    bundle fails. Note that the runtime try/catch in src/sqlite-store.ts cannot save
//    you here - a bundle-time resolution failure happens before any of our code runs, so
//    the graceful in-memory fallback never gets a chance to fire. The symptom is a screen
//    that spins forever, which is exactly the failure PRD/03 calls out.
//
// 3. Workspace-root watching. This is an npm-workspaces monorepo and the app imports
//    @clubchat/shared and @clubchat/client-core from source, so Metro has to watch and
//    resolve outside apps/mobile.

const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

// `includeWebReplay: false` because Session Replay is off by a privacy decision, not by accident:
// src/monitoring.ts sets both replay sample rates to 0 and says why (PRD/16 allows no analytics or
// third-party data sharing, and this app shows private one-to-one conversations). The default here
// is `true`, which would bundle the replay package into the web build to sit there unused.
const config = getSentryExpoConfig(projectRoot, { includeWebReplay: false });

config.resolver.assetExts = [...config.resolver.assetExts, 'wasm'];

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
