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
