/**
 * Session storage and the auth calls.
 *
 * The token is a credential, so it lives in SecureStore on native. Web has no secure
 * equivalent, so it falls back to localStorage - which is the honest trade for a
 * surface the product treats as primarily a development and testing one.
 *
 * PRD/03 rule 3: the session persists across app restarts. A returning user lands in
 * the app, not on sign-in.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const TOKEN_KEY = 'clubchat.session.token';
/**
 * The signed-in user's id, cached alongside the token.
 *
 * Needed for an offline launch: without it the app cannot tell which stored messages are its
 * own, and every bubble renders as received. Not sensitive - it is this device's own user.
 */
const USER_ID_KEY = 'clubchat.session.userId';

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return globalThis.localStorage?.getItem(key) ?? null;
  }
  return SecureStore.getItemAsync(key);
}

async function removeItem(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export const sessionStore = {
  save: (token: string) => setItem(TOKEN_KEY, token),
  load: () => getItem(TOKEN_KEY),
  saveUserId: (userId: string) => setItem(USER_ID_KEY, userId),
  loadUserId: () => getItem(USER_ID_KEY),
  clear: async () => {
    await removeItem(TOKEN_KEY);
    await removeItem(USER_ID_KEY);
  },
};

export type AuthResult = { token: string; userId: string };

function authUrl(apiBase: string, path: string): string {
  return `${apiBase}/api/auth${path}`;
}

/**
 * Headers for an auth request, including an explicit `Origin`.
 *
 * A native client does not set `Origin` itself, and better-auth rejects a request
 * without one as a CSRF risk (MISSING_OR_NULL_ORIGIN). Sending the app's own scheme -
 * which the server lists in `trustedOrigins` - satisfies the check honestly.
 *
 * The alternative was `advanced.disableCSRFCheck` on the server, which would also make
 * the error go away by removing the protection for every caller including browsers.
 * Verified: this origin returns 200 and an untrusted one returns INVALID_ORIGIN, so the
 * check is still doing its job.
 */
const AUTH_ORIGIN = 'clubchat://';

function authHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', Origin: AUTH_ORIGIN };
}

async function readAuthResponse(response: Response): Promise<AuthResult> {
  const text = await response.text();
  if (!response.ok) {
    // Surface the server's own message. An inline error that says nothing is the same
    // as a silent failure from the user's point of view.
    let message = `request failed (${response.status})`;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      if (text) message = text;
    }
    throw new Error(message);
  }

  const body = JSON.parse(text) as {
    token?: string;
    user?: { id?: string };
  };
  // better-auth also returns the token in a set-auth-token header on some paths.
  const token = body.token ?? response.headers.get('set-auth-token') ?? null;
  if (!token || !body.user?.id) {
    throw new Error('sign-in succeeded but returned no session token');
  }
  return { token, userId: body.user.id };
}

export async function signUp(
  apiBase: string,
  input: { name: string; email: string; password: string },
): Promise<AuthResult> {
  const response = await fetch(authUrl(apiBase, '/sign-up/email'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(input),
  });
  return readAuthResponse(response);
}

export async function signIn(
  apiBase: string,
  input: { email: string; password: string },
): Promise<AuthResult> {
  const response = await fetch(authUrl(apiBase, '/sign-in/email'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(input),
  });
  return readAuthResponse(response);
}

/**
 * The three possible answers about a stored token.
 *
 * The distinction between `invalid` and `unreachable` is the whole point, and it took a
 * collision between two requirements to notice it was needed:
 *
 *  - `PRD/03` says a hung auth check must fall back to signed-out rather than hanging on a
 *    spinner. A hung check previously presented as an app that never loaded.
 *  - Phase 3 requires chat to be readable in airplane mode.
 *
 * Implement the first naively and you break the second: offline becomes signed-out becomes no
 * chat. But "the server said no" and "I could not reach the server" are different facts.
 * The first is grounds to sign somebody out; the second is grounds to carry on with what we
 * already know and re-verify when the network returns.
 */
export type SessionCheck = 'valid' | 'invalid' | 'unreachable';

/**
 * Verify a stored token, racing the check against a timeout.
 *
 * Never hangs - that is the requirement it was written for. But a timeout or a thrown fetch
 * reports `unreachable`, not `invalid`: only an actual 401 from a server we reached is proof
 * that the token is dead.
 */
export async function verifySession(
  apiBase: string,
  token: string,
  timeoutMs = 5_000,
): Promise<SessionCheck> {
  const check = (async (): Promise<SessionCheck> => {
    try {
      const response = await fetch(`${apiBase}/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return 'valid';
      // The server answered and rejected us. That IS proof.
      if (response.status === 401 || response.status === 403) return 'invalid';
      // A 500 is the server's problem, not the token's - do not sign somebody out over it.
      return 'unreachable';
    } catch {
      // Could not reach it at all.
      return 'unreachable';
    }
  })();

  const timeout = new Promise<SessionCheck>((resolve) => {
    setTimeout(() => resolve('unreachable'), timeoutMs);
  });

  return Promise.race([check, timeout]);
}
