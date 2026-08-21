import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.ts';

/**
 * The first tests of `loadConfig` itself.
 *
 * Every other suite in this package builds a partial object and casts it `as unknown as Config`,
 * which is fine for exercising a route and means the schema has never been exercised at all. The
 * things asserted here are the ones whose failure mode is a server that boots and is wrong, rather
 * than a server that refuses to start:
 *
 *  - a variable the process never reads still gates the boot of all three roles
 *  - a trailing slash that survives into a URL nothing will ever fetch
 *  - a default that decides which of two serving modes production runs in
 */

/** A complete, minimal environment. Every test below starts from this and changes one thing. */
const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db.example.com/clubchat',
  REDIS_URL: 'redis://default:p@redis.example.com:6379',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'https://api.clubchatapp.com',
  S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  S3_ACCESS_KEY_ID: 'access-key-id',
  S3_SECRET_ACCESS_KEY: 'secret-access-key',
  S3_BUCKET_PUBLIC: 'clubchat-identity',
  S3_BUCKET_PRIVATE: 'clubchat-content',
  MEDIA_SIGNING_SECRET: 'y'.repeat(32),
  MEDIA_CDN_BASE_URL: 'https://cdn.clubchatapp.com',
} as unknown as NodeJS.ProcessEnv;

describe('MEDIA_CDN_BASE_URL', () => {
  /**
   * The failure this prevents: `signedMediaUrl` joins the base to the object key with a `/`, and
   * the signature covers the key alone. With a trailing slash the URL carries `//photo/...`, the
   * edge validates the signature happily because it recomputes from the key it parsed, and the
   * bucket read then misses by one leading slash. Every photo broken, signature check innocent.
   */
  it('strips a trailing slash, which would otherwise double the separator', () => {
    expect(loadConfig({ ...base, MEDIA_CDN_BASE_URL: 'https://cdn.clubchatapp.com/' }).MEDIA_CDN_BASE_URL)
      .toBe('https://cdn.clubchatapp.com');
  });

  it('strips more than one', () => {
    expect(loadConfig({ ...base, MEDIA_CDN_BASE_URL: 'https://cdn.clubchatapp.com///' }).MEDIA_CDN_BASE_URL)
      .toBe('https://cdn.clubchatapp.com');
  });

  it('leaves a value with no trailing slash alone', () => {
    expect(loadConfig(base).MEDIA_CDN_BASE_URL).toBe('https://cdn.clubchatapp.com');
  });

  /**
   * Required to BOOT in both modes, because one flat schema serves all three roles and neither the
   * gateway nor the outbox worker ever reads this. Asserted so that "the gateway will not start
   * without a variable it does not use" is a recorded property rather than a surprise at 2am.
   */
  it('is required, even though presign mode never reads it', () => {
    const { MEDIA_CDN_BASE_URL: _omitted, ...without } = base as Record<string, string>;
    expect(() => loadConfig({ ...without, MEDIA_URL_MODE: 'presign' } as NodeJS.ProcessEnv))
      .toThrow(/MEDIA_CDN_BASE_URL/);
  });

  it('refuses something that is not a URL', () => {
    expect(() => loadConfig({ ...base, MEDIA_CDN_BASE_URL: 'cdn.clubchatapp.com' }))
      .toThrow(/MEDIA_CDN_BASE_URL/);
  });
});

describe('MEDIA_SIGNING_SECRET', () => {
  it('is required, and is what the edge must hold byte-identically', () => {
    const { MEDIA_SIGNING_SECRET: _omitted, ...without } = base as Record<string, string>;
    expect(() => loadConfig(without as NodeJS.ProcessEnv)).toThrow(/MEDIA_SIGNING_SECRET/);
  });

  it('refuses a short secret rather than accepting a weak one', () => {
    expect(() => loadConfig({ ...base, MEDIA_SIGNING_SECRET: 'too-short' }))
      .toThrow(/MEDIA_SIGNING_SECRET/);
  });
});

describe('MEDIA_URL_MODE', () => {
  /**
   * The default is `cdn`, deliberately: a missing value in production must not silently start
   * handing out store-signed URLs. The cost of that choice is that an environment which forgets it
   * gets the mode requiring a Worker, so this is pinned rather than assumed.
   */
  it('defaults to cdn, so an absent value cannot silently downgrade production', () => {
    expect(loadConfig(base).MEDIA_URL_MODE).toBe('cdn');
  });

  it('accepts presign', () => {
    expect(loadConfig({ ...base, MEDIA_URL_MODE: 'presign' }).MEDIA_URL_MODE).toBe('presign');
  });

  it('refuses anything else rather than falling back', () => {
    expect(() => loadConfig({ ...base, MEDIA_URL_MODE: 'CDN' })).toThrow(/MEDIA_URL_MODE/);
  });
});
