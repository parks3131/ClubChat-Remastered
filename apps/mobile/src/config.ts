/**
 * Client configuration.
 *
 * `EXPO_PUBLIC_*` variables are inlined into the bundle, so only values that are safe to
 * ship in a client may go here. That is the whole list: two URLs and a Sentry DSN. Any key
 * that bypasses authorization must never appear in a client bundle (AGENTS.md
 * non-negotiable 5).
 */

import { Platform } from 'react-native';

/**
 * `localhost` resolves to the device itself on a physical phone, so a real device needs
 * the host machine's LAN address. Set EXPO_PUBLIC_API_URL when testing off-simulator.
 */
const defaultHost = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';

export const config = {
  apiUrl: process.env['EXPO_PUBLIC_API_URL'] ?? `http://${defaultHost}:3000`,
  wsUrl: process.env['EXPO_PUBLIC_WS_URL'] ?? `ws://${defaultHost}:3001`,
  /**
   * Where a crash on the phone goes.
   *
   * **A DSN is safe in a client and is not a secret**, which is worth stating because
   * non-negotiable 5 sits two paragraphs up. It is a write-only ingest address: holding it lets
   * somebody *send* events to the project, never read them. The value that must never ship is
   * the auth token used to upload source maps, and that one lives in the build environment and
   * nowhere near this file.
   *
   * **Absent is a supported state, not a degraded one** - the same property the server's
   * `monitoring.ts` is built around. With no DSN the reporter writes to the console instead, so
   * every `capture` call site runs on every development launch rather than executing for the
   * first time in production, which is when nobody is watching.
   */
  sentryDsn: process.env['EXPO_PUBLIC_SENTRY_DSN'] ?? '',
} as const;
