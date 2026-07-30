// Metro configuration.
//
// Two things beyond the Expo defaults, both required by this repo's shape.
//
// 1. `wasm` as an asset extension. expo-sqlite's web implementation is wa-sqlite, which
//    imports a .wasm binary; without this Metro fails to resolve it and the WHOLE web
//    bundle fails. Note that the runtime try/catch in src/sqlite-store.ts cannot save
//    you here - a bundle-time resolution failure happens before any of our code runs, so
//    the graceful in-memory fallback never gets a chance to fire. The symptom is a screen
//    that spins forever, which is exactly the failure PRD/03 calls out.
//
// 2. Workspace-root watching. This is an npm-workspaces monorepo and the app imports
//    @clubchat/shared and @clubchat/client-core from source, so Metro has to watch and
//    resolve outside apps/mobile.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.resolver.assetExts = [...config.resolver.assetExts, 'wasm'];

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
