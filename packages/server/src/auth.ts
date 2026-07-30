/**
 * Authentication.
 *
 * better-auth, self-hosted, in our own Postgres. Identity living in the same
 * transactional store as the domain is the point: account deletion becomes
 * anonymise-and-block in ONE transaction rather than a two-system dance. See
 * ADR-0011.
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import type { Db } from './db/client.ts';
import { accounts, sessions, users, verifications } from './db/schema.ts';

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(
  db: Db,
  config: { secret: string; baseURL: string; clientOrigin?: string; dev?: boolean },
) {
  return betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    /**
     * Origins allowed to call the auth endpoints.
     *
     * better-auth rejects a request with a missing or null `Origin` as a CSRF risk, and
     * a native client does not send one - so without this, sign-up from the phone fails
     * with MISSING_OR_NULL_ORIGIN. The app's own scheme is the fix.
     *
     * Note what this is NOT: `advanced.disableCSRFCheck` would also make the error go
     * away, by removing the protection for every caller including browsers. Listing the
     * origins we actually trust keeps the check doing its job.
     */
    trustedOrigins: [
      ...(config.clientOrigin ? [config.clientOrigin] : []),
      // The app's registered scheme, matching `scheme` in app.json.
      'clubchat://',
      // Expo Go serves over exp:// on a LAN address that changes per machine and per
      // session. Development only: these must never be trusted in production, where the
      // client is a real build using the scheme above.
      ...(config.dev ? ['exp://', 'exp://**', 'http://localhost:8081'] : []),
    ],
    database: drizzleAdapter(db, {
      provider: 'pg',
      // Our tables are plural and carry extra profile columns, so the mapping is
      // explicit: the adapter resolves better-auth's logical model names against
      // these keys. The Drizzle *property* names inside each table already match
      // better-auth's field names (`name` is the property, `full_name` the column),
      // so no per-field mapping is needed on top of this.
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
      },
    }),
    // uuid rather than better-auth's default base62 string, so every id column in
    // the schema can be a real `uuid` and SYSTEM_ACTOR_ID is the same shape as any
    // other user id.
    advanced: {
      database: {
        generateId: 'uuid',
      },
    },
    emailAndPassword: {
      enabled: true,
    },
    user: {
      additionalFields: {
        // Declared so better-auth tolerates and round-trips the columns it does not
        // own. None of them are settable from client input.
        bio: { type: 'string', required: false, input: false },
        city: { type: 'string', required: false, input: false },
        school: { type: 'string', required: false, input: false },
        isPlatformModerator: {
          type: 'boolean',
          required: false,
          defaultValue: false,
          input: false,
        },
      },
    },
    plugins: [
      // Cookies are the default, but the Expo client and the WebSocket `auth` frame
      // both need to present a token explicitly - SPEC/TECH/10-protocol.md defines
      // that frame as carrying `{ token, device_id, platform }`. The bearer plugin
      // accepts `Authorization: Bearer <session token>` alongside cookies.
      bearer(),
    ],
  });
}

/**
 * Resolve a session from a raw bearer token.
 *
 * Used by the gateway, which receives a token in a WebSocket frame rather than in
 * HTTP headers and so has no request object to hand to better-auth. Synthesising the
 * header is deliberate: it keeps ONE session-verification path rather than a second
 * implementation that could diverge from the HTTP one.
 */
export async function resolveSessionFromToken(auth: Auth, token: string) {
  return auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });
}
