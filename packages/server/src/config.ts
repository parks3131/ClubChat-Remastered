/**
 * Environment configuration, parsed and validated once at startup.
 *
 * Parsing eagerly means a missing or malformed variable is a startup failure with a
 * readable message, rather than an `undefined` that surfaces as a confusing runtime
 * error on the first request that happens to need it.
 */

import { z } from 'zod';
import { decodeWebhookSecret } from './mail-webhook.ts';

/**
 * An optional variable where PRESENT AND EMPTY means the same thing as absent.
 *
 * `z.string().optional()` accepts `''`, and nothing downstream can tell that apart from a value
 * somebody meant to set. Three producers here supply exactly that, none of them by mistake:
 *
 *  - `Dockerfile` carries `ARG SENTRY_RELEASE` and `ENV SENTRY_RELEASE=${SENTRY_RELEASE}`. A
 *    Dockerfile cannot conditionally omit an `ENV`, so a build with no `--build-arg` sets the
 *    variable to the empty string. That is a property of `ENV`, not something to be fixed there.
 *  - `.env.example` ships `SENTRY_DSN=`, `SENTRY_RELEASE=` and `PLATFORM_MODERATORS=` as bare
 *    keys, and CI copies that file to `.env` and boots a live api from it.
 *  - `fly secrets set NAME=` sets an empty secret rather than unsetting one.
 *
 * So the empty string arrives on every path into production, and the place to decide what it
 * means is here, once, rather than at each reader. It was previously decided at one reader and
 * not the others: `monitoring.ts` guards `SENTRY_DSN` with an explicit `.length > 0`, while
 * `SENTRY_RELEASE` reached `Sentry.init` as `release: ''` and `/__parity` answered
 * `version: ""`, because `?? 'unknown'` fires on null and undefined and never on `''`.
 *
 * Whitespace counts as empty, and the trimmed value is what callers get. Both halves match what
 * `trustProxyOption` below and `parseModeratorList` already do: a value pasted into a secret store
 * carries a trailing newline more often than anybody admits, and neither reader should have to
 * know that.
 */
const optionalEnv = () =>
  z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed === undefined || trimmed === '' ? undefined : trimmed;
    });

/**
 * A sample rate where PRESENT AND EMPTY means the same thing as absent, and where a typo is a
 * boot failure rather than a silent zero.
 *
 * `z.coerce.number()` alone would be wrong in both directions on this field. It reads `''` as
 * `0` - and `''` is exactly what `fly secrets set NAME=` and a bare key in `.env.example`
 * produce, the same three producers `optionalEnv()` above exists for. It also reads `'off'` as
 * `NaN`, which `.min(0)` then rejects, and that half is right: the field is named in the error
 * and somebody fixes it, rather than tracing silently stopping because of a plausible word.
 *
 * Reading empty as zero is the specific failure this whole field exists to end. Tracing was off
 * because `monitoring.ts` said `tracesSampleRate: 0`; a config that reads an unset variable as
 * zero would put the same silence one layer down, where it looks configured.
 */
const rateEnv = (fallback: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().min(0).max(1).default(fallback),
  );

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

  // --- Platform moderation ---
  /**
   * Who may read the direct-message report queue, as a comma-separated list of email addresses.
   *
   * > **A platform moderator is an operator rather than a product role**, which is why it is
   * > configured here beside the proxy count and the mail transport instead of being granted from
   * > inside the app. Nobody earns this by using ClubChat; somebody holds it because they run the
   * > service. See `domain/platform-moderators.ts`, and the ADR for the alternatives rejected -
   * > notably first-user-wins and an in-app grant, both of which need a seed moderator anyway.
   *
   * The API reconciles `users.is_platform_moderator` against this at boot: named accounts are
   * granted it, and accounts holding it that are no longer named lose it. So revoking somebody is
   * deleting them from this line rather than remembering an inverse command.
   *
   * **Optional, and an empty list never revokes.** Unset means "leave the flag alone and warn",
   * because reconciling to zero moderators would unstaff the queue - and an absent secret after a
   * deploy looks exactly like a deliberate empty list while costing far more.
   */
  PLATFORM_MODERATORS: optionalEnv(),

  // --- Error monitoring ---
  /**
   * Where captured errors are sent, or absent.
   *
   * **Optional on purpose.** Development and CI run without it and still exercise every capture
   * path, because `initMonitoring` logs locally either way - see `monitoring.ts`. Making this
   * required would mean the reporting code only ever ran in production, which is the one place
   * nobody is watching it work.
   */
  SENTRY_DSN: optionalEnv(),
  SENTRY_ENVIRONMENT: z.string().default('development'),
  /**
   * What fraction of traffic is traced, between 0 and 1.
   *
   * > **Tracing was off by a constant, not by omission.** `monitoring.ts` carried
   * > `tracesSampleRate: 0` with a comment saying performance was a separate decision, and the
   * > separate decision was never made - so for the whole life of the deployment a slow request
   * > left no record anywhere, and the only way to change that was to edit code, rebuild an image
   * > and redeploy three apps.
   *
   * Here instead, so the rate is an operational dial: `fly secrets set
   * SENTRY_TRACES_SAMPLE_RATE=0.01` and a restart turns it down without shipping code. That
   * matters most in the case it exists for - a spike in traffic burning quota at 3am is a
   * situation where waiting on a Docker build is the wrong shape of fix.
   *
   * **A tenth, and the number is a cost decision rather than a technical one.** At one live club
   * it is a few hundred traces a day, which is enough to see a pattern and small enough that
   * nobody has to think about the bill; 1.0 on a live system is a bill the founder has not
   * agreed to. What it is NOT is a measure of coverage: errors are unaffected by this and are
   * always sent in full. This only decides how many *timings* are kept.
   *
   * The liveness routes are excluded from tracing entirely, whatever this says, because Fly polls
   * them every few seconds for ever and they measure nothing. See `monitoring.ts`.
   */
  SENTRY_TRACES_SAMPLE_RATE: rateEnv(0.1),
  /**
   * The commit this build came from, so a stack trace maps to a source.
   *
   * Set by the deploy, not by hand. Absent locally, where the source is on disk anyway.
   */
  SENTRY_RELEASE: optionalEnv(),

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
  /**
   * Where signed media URLs point, in `cdn` mode.
   *
   * **The trailing slash is stripped, and that is load-bearing.** `signedMediaUrl` joins this to
   * the object key with a `/`, and the signature covers the object key alone. A value ending in
   * `/` therefore yields `https://cdn.example.com//photo/...`: the HMAC still validates, because
   * the edge recomputes it from the key it parsed, and then the R2 read misses by one leading
   * slash. A config typo that presents as a storage bug, on a path where every photo is broken
   * and the signature check looks innocent.
   *
   * Required in BOTH modes, because one flat schema serves all three roles, and read only in
   * `cdn` mode. In `presign` mode any URL-shaped value is fine and none of it is used.
   */
  MEDIA_CDN_BASE_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, '')),
  /**
   * Who signs a download URL.
   *
   * `cdn` - the production shape. A signature-validating Cloudflare Worker fronts the bucket
   * and checks the hour-aligned `exp`/`sig` pair at the edge before it reads (roadmap debt 7).
   *
   * The alignment gives every viewer inside the window a byte-identical URL, which collapses the
   * cache KEY. **It does not produce one shared Cloudflare edge entry, and for a long time five
   * files said it did.** Caching a Worker's response needs Workers Caching, which is opt in via
   * `"cache": {"enabled": true}` in `wrangler.jsonc` and is deliberately off. So the header
   * reaches browsers and downstream caches only. See ADR-0044.
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
  RESEND_API_KEY: optionalEnv(),
  /**
   * Who the mail comes from - `Name <address@domain>`, or a bare address.
   *
   * The domain must be one verified in the Resend dashboard, which refuses the send otherwise.
   * Kept separate from the key because the sending identity moves and the secret does not: this
   * points at whichever domain is verified today and changes to `clubchatapp.com` later without
   * anybody touching a credential.
   */
  MAIL_FROM: optionalEnv(),
  /**
   * The secret Resend signs its webhooks with, or absent.
   *
   * Optional for the same reason `RESEND_API_KEY` is: development and CI run the whole flow
   * without one. Absent means `POST /webhooks/resend` refuses with a 503 and reports itself once,
   * rather than silently accepting anything - see `api/mail-webhook.ts`.
   *
   * **Validated here rather than at the first request, and that is the point of the refine.**
   * Resend presents this as `whsec_` plus base64; a value that is truncated, re-wrapped by an
   * editor, or pasted with a character missing produces a different, shorter key and then every
   * webhook 401s. That failure is invisible: it looks exactly like internet noise, and nothing
   * was ever going to be recorded to notice the absence of. A boot failure naming the field is
   * the honest version, and it is the same argument `assertProductionMailer` is built on.
   *
   * Distinct from `RESEND_API_KEY` on purpose. The key sends mail; this only verifies what comes
   * back, so a leak of one must not become a leak of the other (non-negotiable 5).
   */
  RESEND_WEBHOOK_SECRET: optionalEnv().refine(
    (value) => value === undefined || decodeWebhookSecret(value) !== null,
    {
      message:
        'RESEND_WEBHOOK_SECRET is not a usable signing secret - Resend presents it as ' +
        '"whsec_" followed by base64, and this one does not decode to at least 16 bytes',
    },
  ),
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
