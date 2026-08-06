/**
 * Outbound mail.
 *
 * One method, and two implementations that are both in the tree on purpose. See ADR-0019:
 * choosing a provider means verifying a sending domain over DNS, which is a wait rather than a
 * decision, and blocking password reset on it would have blocked a feature that is otherwise
 * finished. So the transport is a port, and the provider slots in behind it later.
 *
 * The shape deliberately matches `MediaStore`/`FakeMediaStore` and `Monitor`/`silentMonitor()` -
 * a real one for production, a fake the tests assert against, injected from the entrypoint. A
 * reader who has met one of the three has met all of them.
 */

import type { FastifyBaseLogger } from 'fastify';

export type Message = {
  to: string;
  subject: string;
  /**
   * Plain text, and only plain text.
   *
   * The one thing this product sends is a reset link, which needs no layout. HTML mail means a
   * template, an inliner, and a second copy of every message to keep in step with the first -
   * all to render a sentence and a URL. It also renders more reliably: a plain-text link is
   * clickable in every client, where an HTML one depends on the client not rewriting it.
   */
  text: string;
};

export interface Mailer {
  send(message: Message): Promise<void>;
}

/**
 * The development transport: log the message instead of sending it.
 *
 * **The reset URL is logged in full, and that is the point** - it is what makes the flow
 * runnable end to end on a laptop with no provider account and no DNS. Which is also exactly why
 * this must never run in production, and why `assertProductionMailer` exists below rather than
 * being left to a comment.
 */
export class LoggingMailer implements Mailer {
  /*
   * Assigned in the body rather than declared as a parameter property: the entrypoints run
   * TypeScript through Node's strip-only mode, which cannot erase `constructor(private x)` -
   * there is nothing to strip, only code to generate. `scripts/check-node-parse.mjs` catches it,
   * and it catches it in every file that transitively imports this one.
   */
  private readonly logger: Pick<FastifyBaseLogger, 'info'>;

  constructor(logger: Pick<FastifyBaseLogger, 'info'>) {
    this.logger = logger;
  }

  async send(message: Message): Promise<void> {
    this.logger.info(
      { to: message.to, subject: message.subject, text: message.text },
      '[mail] not sent - no transport configured. The message follows in full.',
    );
  }
}

/**
 * The test fake: keep every message, send nothing.
 *
 * Fifteen suites build `createAuth(...)`, and none of them may reach a network. More usefully,
 * this is what turns "the reset mail went to the right person, once, carrying a token that
 * works" into an assertion instead of something discovered in production.
 */
export class RecordingMailer implements Mailer {
  readonly sent: Message[] = [];
  /** Set to simulate a provider that is down, since a send failure never reaches the caller. */
  failWith: Error | null = null;

  async send(message: Message): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }

  /** The most recent message to an address, which is all any test needs. */
  lastTo(email: string): Message | undefined {
    return [...this.sent].reverse().find((message) => message.to === email);
  }
}

/**
 * Refuse to start in production without a real transport.
 *
 * ADR-0019 calls this the load-bearing part of deferring the provider. Booting production on
 * `LoggingMailer` would be worse than shipping without the feature: members would ask for a
 * reset, be told to check their inbox, receive nothing, and the working link would sit in a log
 * stream. A crash at boot is the honest version of that, and it happens before any traffic.
 */
export function assertProductionMailer(mailer: Mailer, env: string | undefined): void {
  if (env === 'production' && mailer instanceof LoggingMailer) {
    throw new Error(
      'refusing to start: NODE_ENV=production with no mail transport configured. ' +
        'LoggingMailer writes password-reset URLs to the log instead of sending them. ' +
        'See SPEC/decisions/0019-outbound-mail-is-a-port-with-a-deferred-provider.md.',
    );
  }
}

/**
 * The one message this product sends.
 *
 * Built here rather than inline in `auth.ts` so its wording is testable and lives next to the
 * thing that sends it. `url` is better-auth's own: an HTTPS link at our API that validates the
 * token and then redirects to the app. Mailing that rather than a raw `clubchat://` link is
 * deliberate - mail clients frequently decline to linkify a custom scheme, and an unclickable
 * reset link is a reset that did not happen.
 */
export function passwordResetMessage(input: { to: string; name: string; url: string }): Message {
  return {
    to: input.to,
    subject: 'Reset your ClubChat password',
    text: [
      `Hi ${input.name},`,
      '',
      'Someone asked to reset the password for this ClubChat account. Open the link below to',
      'choose a new one:',
      '',
      input.url,
      '',
      'The link works once and expires in an hour. Setting a new password also signs you out',
      'everywhere else.',
      '',
      "If this wasn't you, you can ignore this email - nothing has changed.",
    ].join('\n'),
  };
}
