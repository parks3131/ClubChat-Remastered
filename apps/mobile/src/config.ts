/**
 * Client configuration.
 *
 * `EXPO_PUBLIC_*` variables are inlined into the bundle, so only values that are safe
 * to ship in a client may go here. That is the whole list: two URLs. Any key that
 * bypasses authorization must never appear in a client bundle (AGENTS.md
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
} as const;
