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

/**
 * An optional variable that is PRESENT AND EMPTY is a different thing from an absent one, and the
 * schema used to keep the difference.
 *
 * `z.string().optional()` accepts `''` happily, so every one of these fields could arrive as the
 * empty string and satisfy a `!== undefined` check. Three separate producers do exactly that, and
 * none of them is a mistake anybody would notice:
 *
 *  - `Dockerfile` had `ARG SENTRY_RELEASE=""` followed by `ENV SENTRY_RELEASE=${SENTRY_RELEASE}`.
 *    `ENV` cannot be conditionally omitted, so a build with no `--build-arg` SETS the variable to
 *    the empty string.
 *  - `.env.example` ships `SENTRY_DSN=`, `SENTRY_RELEASE=` and `PLATFORM_MODERATORS=` as bare
 *    keys, and CI copies that file to `.env` and boots a live api from it.
 *  - `fly secrets set NAME=` sets an empty secret rather than removing one.
 *
 * What it cost, before this was normalized here:
 *
 *  - `monitoring.ts` spread `release: ''` into `Sentry.init` instead of omitting the field, so
 *    every production error was tagged with an empty release and release health said nothing.
 *  - `/__parity` answered `version: ""`, because `SENTRY_RELEASE ?? 'unknown'` fires on null and
 *    undefined and never on `''`. That route is how an operator tells two deploys apart while
 *    every photo is 403ing, and an always-empty version field makes it useless for that.
 *
 * Whitespace counts as empty for the same reason it does in `trustProxyOption` and
 * `parseModeratorList`, both of which already trim before deciding whether a value is there: a
 * value pasted into a secret store carries a trailing newline more often than anybody admits.
 */
describe('optional variables that arrive empty', () => {
  const optionalFields = [
    'SENTRY_RELEASE',
    'SENTRY_DSN',
    'PLATFORM_MODERATORS',
    'RESEND_API_KEY',
  ] as const;

  /*
   * A Resend key with no From address is a startup failure by design, so the two tests that supply
   * a real value start from an environment that already carries one. Supplying it for the other
   * three costs nothing: the refine only looks at MAIL_FROM when a key is present.
   */
  const withFrom = { ...base, MAIL_FROM: 'ClubChat <noreply@clubchatapp.com>' };

  for (const field of optionalFields) {
    it(`reads ${field} as undefined when it is present and empty`, () => {
      expect(loadConfig({ ...base, [field]: '' })[field]).toBeUndefined();
    });

    it(`reads ${field} as undefined when it is whitespace only`, () => {
      expect(loadConfig({ ...base, [field]: '  \n' })[field]).toBeUndefined();
    });

    it(`leaves a real ${field} value alone`, () => {
      expect(loadConfig({ ...withFrom, [field]: 'a-real-value' })[field]).toBe('a-real-value');
    });

    it(`trims a ${field} value that a secret store padded`, () => {
      expect(loadConfig({ ...withFrom, [field]: ' a-real-value\n' })[field]).toBe('a-real-value');
    });
  }

  /**
   * MAIL_FROM is checked apart from the loop because the schema refuses a key with no From
   * address, so the loop's own fixture cannot be reused for it.
   */
  it('reads an empty MAIL_FROM as undefined', () => {
    expect(loadConfig({ ...base, MAIL_FROM: '   ' }).MAIL_FROM).toBeUndefined();
  });

  /**
   * The half-configuration `config.ts` already refuses must stay refused when the missing half is
   * empty rather than absent. An empty `MAIL_FROM` beside a real key would otherwise build a
   * `ResendMailer` with no From address, which Resend rejects and better-auth discards in the
   * background, telling the member to check an inbox that will never receive anything.
   */
  it('still refuses a Resend key whose MAIL_FROM is empty', () => {
    expect(() => loadConfig({ ...base, RESEND_API_KEY: 're_key', MAIL_FROM: '   ' }))
      .toThrow(/MAIL_FROM/);
  });
});
