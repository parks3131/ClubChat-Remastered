/**
 * The two addresses the app cannot work without, and what a build does when they are absent.
 */

import { describe, expect, it } from 'vitest';
import { resolveEndpoint } from './endpoint.ts';

const api = (raw: string | undefined, isDevelopment: boolean): string =>
  resolveEndpoint({
    variable: 'EXPO_PUBLIC_API_URL',
    raw,
    protocols: ['http:', 'https:'],
    developmentFallback: 'http://localhost:3000',
    isDevelopment,
  });

describe('a release bundle, which has no development server behind it', () => {
  it('refuses to start when the variable is unset', () => {
    expect(() => api(undefined, false)).toThrow(/EXPO_PUBLIC_API_URL/);
  });

  it('refuses to start on an empty string, which is what an unset build variable inlines', () => {
    expect(() => api('', false)).toThrow(/EXPO_PUBLIC_API_URL/);
  });

  it('takes the address it was built with', () => {
    expect(api('https://api.clubchatapp.com', false)).toBe('https://api.clubchatapp.com');
  });
});

describe('a development bundle, where the laptop IS the server', () => {
  it('falls back to the local address when the variable is unset', () => {
    expect(api(undefined, true)).toBe('http://localhost:3000');
  });

  it('still takes an explicit address, which is how a phone reaches the LAN', () => {
    expect(api('http://192.168.1.10:3000', true)).toBe('http://192.168.1.10:3000');
  });
});

describe('an address that is there but wrong', () => {
  it('refuses a value that is not a URL, in a development build too', () => {
    expect(() => api('api.clubchatapp.com', true)).toThrow(/EXPO_PUBLIC_API_URL/);
    expect(() => api('api.clubchatapp.com', false)).toThrow(/EXPO_PUBLIC_API_URL/);
  });

  it('refuses a socket URL given as the API address', () => {
    expect(() => api('wss://ws.clubchatapp.com', false)).toThrow(/EXPO_PUBLIC_API_URL/);
  });
});
