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
  clear: () => removeItem(TOKEN_KEY),
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
 * Verify a stored token, racing the check against a timeout.
 *
 * PRD/03 edge case: **a hung auth check must fall back to signed-out rather than
 * hanging on a spinner.** A hung check previously presented as an app that never
 * loaded, which is indistinguishable from a crash to the person holding the phone.
 */
export async function verifySession(
  apiBase: string,
  token: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const check = (async () => {
    try {
      const response = await fetch(`${apiBase}/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  })();

  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });

  return Promise.race([check, timeout]);
}
