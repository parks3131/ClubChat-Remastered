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
});

export type Config = z.infer<typeof Env>;

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
