/**
 * Environment configuration, parsed and validated once at startup.
 *
 * Parsing eagerly means a missing or malformed variable is a startup failure with a
 * readable message, rather than an `undefined` that surfaces as a confusing runtime
 * error on the first request that happens to need it.
 */

import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(3000),
  GATEWAY_PORT: z.coerce.number().int().positive().default(3001),
  CLIENT_ORIGIN: z.string().default('http://localhost:8081'),
  // SPEC/TECH/05-authorization.md: token bucket, burst 30, refill 1/sec per sender,
  // enforced BEFORE the insert.
  SEND_RATE_BURST: z.coerce.number().int().positive().default(30),
  SEND_RATE_REFILL_PER_SEC: z.coerce.number().positive().default(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * How many proxies sit in front of this process, or which ones to believe.
   *
   * > **Defaults to `false`, and the default is the safe one rather than the convenient one.**
   * > Without this, `request.ip` is the socket's peer - which behind a proxy is the *proxy*, so
   * > every caller in the world shares one bucket and the per-IP sign-in limit becomes a single
   * > global limit. That fails closed (everybody is throttled together) rather than open, but it
   * > makes the one rate limit that is a security control rather than an abuse ceiling useless as
   * > credential-stuffing protection.
   * >
   * > The opposite mistake is worse and is why this is not simply `true` in production: trusting
   * > `X-Forwarded-For` unconditionally on a process that is directly reachable lets any caller
   * > forge a header and get a fresh bucket per request, which removes the limit entirely. Trust
   * > has to be stated, not assumed, which is the whole reason it is configuration.
   *
   * Accepted forms, matching what Fastify hands to `proxy-addr`:
   *
   * - `false` (the default) - no proxy. Development, and any direct exposure.
   * - a **number** - hop count. `1` is right on Fly.io, where the edge proxy is the only ingress
   *   and appends the client address to `X-Forwarded-For`.
   * - `true` - trust every hop. Correct only when nothing can reach the process directly.
   * - a comma-separated list of addresses or CIDR ranges to believe.
   */
  TRUST_PROXY: z.string().default('false'),

  // --- Error monitoring ---
  /**
   * Where captured errors are sent, or absent.
   *
   * **Optional on purpose.** Development and CI run without it and still exercise every capture
   * path, because `initMonitoring` logs locally either way - see `monitoring.ts`. Making this
   * required would mean the reporting code only ever ran in production, which is the one place
   * nobody is watching it work.
   */
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default('development'),
  /**
   * The commit this build came from, so a stack trace maps to a source.
   *
   * Set by the deploy, not by hand. Absent locally, where the source is on disk anyway.
   */
  SENTRY_RELEASE: z.string().optional(),

  // --- Object storage ---
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_PUBLIC: z.string().min(1),
  S3_BUCKET_PRIVATE: z.string().min(1),
  // Distinct from BETTER_AUTH_SECRET on purpose: a leak of one must not become a leak of
  // the other.
  MEDIA_SIGNING_SECRET: z.string().min(16),
  MEDIA_CDN_BASE_URL: z.string().url(),
  /**
   * Who signs a download URL.
   *
   * `cdn` - the production shape. A signature-validating CDN fronts the bucket and checks the
   * hour-aligned `exp`/`sig` pair at the edge, which is what makes one cache entry serve every
   * viewer (roadmap debt 7).
   *
   * `presign` - no CDN in front of the bucket, so the object store signs instead. Development
   * runs this way against MinIO: the custom HMAC means nothing to the store, so pointing that
   * URL at it is an unauthenticated GET on private content and is correctly refused.
   *
   * Defaults to `cdn` so a missing value in production cannot silently start handing out
   * store-signed URLs.
   */
  MEDIA_URL_MODE: z.enum(['cdn', 'presign']).default('cdn'),

  // --- Outbound mail (ADR-0019 for the port, ADR-0020 for the provider) ---
  /**
   * Resend's API key, or absent.
   *
   * **Optional for exactly the reason `SENTRY_DSN` is.** Development and CI have to run the
   * whole password-reset flow without one, and `LoggingMailer` is what makes that possible.
   * Absent here does not mean mail is broken; it means the laptop transport. What stops that
   * transport reaching production is `assertProductionMailer` at boot, not this field.
   */
  RESEND_API_KEY: z.string().optional(),
  /**
   * Who the mail comes from - `Name <address@domain>`, or a bare address.
   *
   * The domain must be one verified in the Resend dashboard, which refuses the send otherwise.
   * Kept separate from the key because the sending identity moves and the secret does not: this
   * points at whichever domain is verified today and changes to `clubchatapp.com` later without
   * anybody touching a credential.
   */
  MAIL_FROM: z.string().optional(),
}).refine((env) => !env.RESEND_API_KEY || Boolean(env.MAIL_FROM), {
  /*
   * A key with no From address is the one half-configuration worth catching at boot. Resend
   * rejects such a send, better-auth throws that away in the background, and the member is told
   * to check an inbox that will never receive anything - the exact failure ADR-0019 built
   * `assertProductionMailer` to prevent, arriving through the door it does not watch.
   */
  message: 'MAIL_FROM is required when RESEND_API_KEY is set - Resend rejects a send with no From',
  path: ['MAIL_FROM'],
});

export type Config = z.infer<typeof Env>;

/**
 * `TRUST_PROXY` as Fastify wants it.
 *
 * A string in the environment, three different types at the call site. Parsed here rather than
 * inline so there is one answer to "what does this value mean", and so `'false'` cannot be read
 * as the truthy string it technically is - which would silently trust every hop and is the exact
 * inversion of the setting's purpose.
 */
export function trustProxyOption(value: string | undefined): boolean | number | string {
  // Absent means the same as `'false'`, which is what the schema default already supplies in
  // production. Accepting it here is for the partial `as unknown as Config` objects the test
  // suites build - and it fails in the safe direction anyway: no proxy trusted.
  const trimmed = (value ?? '').trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'false') return false;
  if (trimmed.toLowerCase() === 'true') return true;
  // A bare integer is a hop count. `Number()` rather than `parseInt`, so "1abc" is not silently
  // read as 1 and quietly trusted.
  const hops = Number(trimmed);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  // Otherwise it is an address or CIDR list, which proxy-addr parses itself.
  return trimmed;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment:\n${issues}\n\nCopy .env.example to .env.`);
  }
  return parsed.data;
}
