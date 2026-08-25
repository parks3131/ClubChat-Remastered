/**
 * `POST /webhooks/resend` - the one route in this API that is unauthenticated on purpose and
 * writes to the database.
 *
 * > **Nothing consumed Resend's webhooks, so a reset link that went nowhere looked exactly like
 * > one that arrived.** ADR-0020 recorded it as its own follow-up and ADR-0047 closes it.
 *
 * Registered from `app.ts` on the ROOT instance, beside `/health`, `/ready` and `/__parity`, for
 * the reason that file's docblock gives: an unauthenticated route cannot be added by forgetting
 * something, only by editing `app.ts`. It lives in its own module rather than under `routes/`
 * because every module there is handed the SCOPED instance and is documented as being inside the
 * session hook, and this one is deliberately not.
 *
 * The same three placement decisions `/ready` and `/__parity` each record, with one difference:
 *
 *  1. **On the root instance.** Resend holds no session and never will.
 *  2. **Outside the per-user limiter**, which keys on `request.userId` and therefore cannot serve
 *     a public route at all. It has a bucket of its own instead, consumed after the signature
 *     verifies - see `MAIL_WEBHOOK_BUCKET`.
 *  3. **It answers with its own status code for everything it anticipates**, so the caller learns
 *     nothing but whether the request was accepted. The one case it does NOT handle itself is a
 *     database failure, which is left to throw into `setErrorHandler`: that answers 500, captures
 *     the error, and a 500 is precisely what makes Resend retry the delivery instead of dropping
 *     it. Handling it here would turn a transient outage into a permanently lost bounce.
 *
 * ---
 *
 * **The raw body is the whole difficulty, and it is why this route brings its own content-type
 * parser.** Fastify's default parser consumes the stream and hands a handler the PARSED object,
 * and `JSON.stringify` of that object is not the bytes that were signed - key order survives, but
 * whitespace does not. Resend states it plainly: "the cryptographic signature is sensitive to even
 * the slightest change". A verifier built on the parsed body 401s every genuine delivery, with a
 * correct secret, and looks exactly like a wrong one.
 *
 * A content-type parser is encapsulated in the scope it is declared in, so registering one inside
 * this plugin changes nothing for the rest of the API. Two are registered rather than one:
 * `application/json` OVERRIDES the inherited default for this scope, and `*` catches anything else
 * - so whichever way Fastify resolves a content type carrying a `charset`, it lands on a parser
 * that hands over the raw string.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { recordMailEvents } from '../domain/mail-events.ts';
import {
  isReportable,
  parseMailEvent,
  verifyWebhookSignature,
  type MailEventKind,
} from '../mail-webhook.ts';
import type { AppDeps } from './plumbing.ts';
import { MAIL_WEBHOOK_BUCKET, MAIL_WEBHOOK_LIMIT_KEY, type Bucket } from './rate-limit.ts';

/** Where the route answers. Configured on Resend's side; changing it means changing it there too. */
export const MAIL_WEBHOOK_PATH = '/webhooks/resend';

/**
 * How large a webhook body may be.
 *
 * Resend's own examples are well under two kilobytes. The ceiling is here because the signature
 * check is an HMAC over the whole body, so an unbounded body is unbounded work for an unsigned
 * caller - and Fastify's global default is a megabyte. 64KB is two orders of magnitude of headroom
 * over anything real and still bounds the work.
 */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/**
 * Register the webhook, on whichever instance the caller hands over.
 *
 * `refuseTooMany` is passed in rather than rebuilt, the way `registerDevDashboard` takes its
 * `log`: it is a closure inside `buildApp` and it carries the one refusal shape every limited
 * route in this API uses, `Retry-After` included. A second copy here would be a second definition
 * of a rule that has one.
 */
export function registerMailWebhook(
  app: FastifyInstance,
  options: {
    deps: AppDeps;
    refuseTooMany: (reply: FastifyReply, bucket: Bucket) => unknown;
  },
): void {
  const { deps, refuseTooMany } = options;

  /**
   * Configured with no signing secret, this route cannot tell Resend from anybody else.
   *
   * Reported ONCE, for the reason `/ready` reports a missing Redis once: it cannot recover on its
   * own - nothing will hand this process a secret later - so the transition rule that suits a real
   * dependency would report it on every delivery forever. Once at error level is enough, and it is
   * the message that explains why no bounce has ever been recorded.
   */
  let unconfiguredReported = false;

  app.register(async (scope) => {
    const keepRaw = (
      _request: unknown,
      body: string,
      done: (error: Error | null, body?: string) => void,
    ) => done(null, body);

    scope.addContentTypeParser('application/json', { parseAs: 'string' }, keepRaw);
    scope.addContentTypeParser('*', { parseAs: 'string' }, keepRaw);

    scope.post(
      MAIL_WEBHOOK_PATH,
      { bodyLimit: MAX_WEBHOOK_BODY_BYTES },
      async (request, reply) => {
        if (deps.config.RESEND_WEBHOOK_SECRET === undefined) {
          request.log.error(
            { route: MAIL_WEBHOOK_PATH },
            'a Resend webhook arrived and RESEND_WEBHOOK_SECRET is not set, so it cannot be verified',
          );
          if (!unconfiguredReported) {
            unconfiguredReported = true;
            deps.monitor.capture(
              new Error(
                'RESEND_WEBHOOK_SECRET is not set, so bounces and complaints are being refused unverified',
              ),
              'api.mail.webhook',
              { reason: 'not_configured' },
            );
          }
          return reply.code(503).send({ error: 'not_configured' });
        }

        /*
         * VERIFY FIRST, before anything in the body is read, let alone trusted. The body reaches
         * here as a string because of the parsers above; if it somehow did not, an empty string
         * fails the HMAC, which is the right answer rather than a crash.
         */
        const rawBody = typeof request.body === 'string' ? request.body : '';
        const verified = verifyWebhookSignature({
          secret: deps.config.RESEND_WEBHOOK_SECRET,
          headers: request.headers,
          rawBody,
          nowMs: Date.now(),
        });

        if (!verified.ok) {
          /*
           * Logged, never captured. Anybody who can reach the port can produce this, so capturing
           * it would hand a stranger a way to fill the error tracker - and the one cause that
           * really is ours, an unusable secret, is already a boot failure in `config.ts`.
           *
           * The reason is in the log and not in the response: a caller learns that the request was
           * refused and nothing about which check refused it.
           */
          request.log.warn(
            { route: MAIL_WEBHOOK_PATH, reason: verified.reason },
            'a Resend webhook failed signature verification',
          );
          return reply.code(401).send({ error: 'bad_signature' });
        }

        // Only a verified caller can spend the bucket. See `MAIL_WEBHOOK_BUCKET` for why that
        // ordering is what makes a single constant key safe here.
        if (!(await deps.limiter.tryConsume(MAIL_WEBHOOK_LIMIT_KEY, MAIL_WEBHOOK_BUCKET))) {
          request.log.warn({ route: MAIL_WEBHOOK_PATH }, 'rate limited');
          return refuseTooMany(reply, MAIL_WEBHOOK_BUCKET);
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          payload = undefined;
        }

        const receivedAt = new Date();
        const parsed = payload === undefined
          ? ({ ok: false, reason: 'unreadable' } as const)
          : parseMailEvent(payload, receivedAt);

        if (!parsed.ok) {
          /*
           * This one IS captured, and the signature check above is what earns it: a payload we
           * cannot read, carrying a signature made with our own secret, means Resend changed their
           * schema. That is silent in every other way - the deliveries keep arriving, the table
           * keeps not growing - and it is exactly the class of failure this whole feature exists
           * to end.
           *
           * The body is not attached. It carries member addresses, and a schema change is
           * diagnosed from Resend's own dashboard, which holds the payload already.
           */
          deps.monitor.capture(
            new Error('a verified Resend webhook carried a payload that could not be read'),
            'api.mail.webhook',
            { reason: parsed.reason, bytes: rawBody.length },
          );
          return reply.code(400).send({ error: 'unreadable' });
        }

        /*
         * A type we do not record - `email.sent`, `email.delivered`, and anything else somebody
         * widens the subscription to in the dashboard. Acknowledged with a 200, because Resend
         * retries anything that is not a 2xx for ten hours.
         */
        if (parsed.events.length === 0) return reply.code(200).send({ ok: true, recorded: 0 });

        /*
         * Left to throw on a database failure. `setErrorHandler` answers 500 and captures it, and
         * the 500 is what makes Resend redeliver - which the unique index then absorbs if the
         * write had in fact landed.
         */
        const recorded = await recordMailEvents(deps.db, {
          providerEventId: verified.deliveryId,
          events: parsed.events,
        });

        for (const event of parsed.events) {
          /*
           * Reported only for a row that was actually written, and only for the kinds that are
           * worth waking somebody for. The first half is what stops Resend's retry schedule
           * becoming six copies of one incident; the second is what stops a full mailbox, which
           * clears on its own, burying a hard bounce.
           */
          if (!recorded.has(event.email) || !isReportable(event)) continue;

          deps.monitor.capture(
            new Error(`mail to ${event.email} ${summaryFor(event.kind)}`),
            `api.mail.${event.kind}`,
            {
              /*
               * The address is here deliberately, and it is the one PII decision in this file.
               * A bounce report that does not say WHICH address bounced is not actionable - the
               * only response to it is a database query - and the volume is a handful a month
               * against a product that sends single-digit mails a day. `mail_events` is still the
               * system of record; this is a copy in the alarm. ADR-0047 records the trade-off.
               */
              email: event.email,
              bounceType: event.bounceType,
              detail: event.detail,
              providerMessageId: event.providerMessageId,
              occurredAt: event.occurredAt.toISOString(),
            },
          );
        }

        /*
         * `recorded` rather than a bare `ok`. Resend's dashboard shows the response body against
         * every delivery, so this is where an operator reads "it arrived and it was new" without
         * opening a database - and a redelivery answering `recorded: 0` is the idempotency
         * visibly working rather than something to take on trust.
         */
        return reply.code(200).send({ ok: true, recorded: recorded.size });
      },
    );
  });
}

/**
 * How a kind reads in the one sentence a monitoring alert leads with.
 *
 * The message is what groups an issue in Sentry alongside the `where` tag, so it says what
 * happened rather than naming an exception type - "mail to sam@x hard bounced" is the whole
 * report at a glance.
 */
function summaryFor(kind: MailEventKind): string {
  if (kind === 'bounced') return 'hard bounced';
  if (kind === 'complained') return 'was marked as spam';
  return 'was never sent';
}
