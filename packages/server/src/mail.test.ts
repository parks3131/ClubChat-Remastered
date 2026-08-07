/**
 * The Resend transport, which is worth asserting on precisely because nothing else ever sees it.
 *
 * better-auth calls `sendResetPassword` through `runInBackgroundOrAwait` and discards what it
 * throws (ADR-0019). So a wrong header, a `from` the account cannot send as, or a body field
 * Resend ignores all present identically to the member: a page saying "check your inbox", and an
 * inbox that stays empty. There is no integration test that can catch that and no user report
 * that will describe it. The request shape is the only place it can be pinned down.
 *
 * `fetch` is injected rather than globally stubbed - the same argument that puts `Mailer` in the
 * constructor of `createAuth` instead of having it reach for a transport itself.
 */

import { describe, expect, it } from 'vitest';
import { ResendMailer, passwordResetMessage, type Message } from './mail.ts';

const API_KEY = 're_test_key_not_real';
const FROM = 'ClubChat <noreply@test.invalid>';

const MESSAGE: Message = {
  to: 'member@test.invalid',
  subject: 'Reset your ClubChat password',
  text: 'Open the link.',
};

/** Captures the one call and answers with whatever the test needs Resend to have said. */
function capturingFetch(response: { status: number; body?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(response.body ?? JSON.stringify({ id: 'a-message-id' }), {
      status: response.status,
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

/** The JSON body of the single captured call. */
function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe('sending through Resend', () => {
  it('posts the message to the documented endpoint, authorized as JSON', async () => {
    const { calls, fetch } = capturingFetch({ status: 200 });

    await new ResendMailer({ apiKey: API_KEY, from: FROM, fetch }).send(MESSAGE);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe('https://api.resend.com/emails');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers).toMatchObject({
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
    });
  });

  it("carries the message's own fields, and the transport's from address", async () => {
    const { calls, fetch } = capturingFetch({ status: 200 });

    await new ResendMailer({ apiKey: API_KEY, from: FROM, fetch }).send(MESSAGE);

    // `from` belongs to the transport and the rest to the message. That split is why the sending
    // identity can change domains without a caller knowing.
    expect(bodyOf(calls[0]!)).toEqual({
      from: FROM,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    });
  });

  it('sends the reset mail as text only, never as HTML', async () => {
    // The `Message` type allows only plain text, and this is the assertion that keeps the
    // transport honest about it: an `html` field here would silently become the version every
    // client renders, leaving the tested wording unused.
    const { calls, fetch } = capturingFetch({ status: 200 });

    await new ResendMailer({ apiKey: API_KEY, from: FROM, fetch }).send(
      passwordResetMessage({ to: 'member@test.invalid', name: 'Sam', url: 'https://x.invalid/r' }),
    );

    const body = bodyOf(calls[0]!);
    expect(body).not.toHaveProperty('html');
    expect(String(body['text'])).toContain('https://x.invalid/r');
  });

  it('abandons a send that never comes back', async () => {
    // Nobody is holding this promise, so a request that never settles is a socket and a task
    // that never return. The signal is the only thing that ends it.
    const { calls, fetch } = capturingFetch({ status: 200 });

    await new ResendMailer({ apiKey: API_KEY, from: FROM, fetch }).send(MESSAGE);

    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('when Resend refuses the message', () => {
  it("throws carrying the status and Resend's reason", async () => {
    // An unverified sending domain is the overwhelmingly likely first failure, and it is
    // invisible unless the reason survives into the log line `auth.ts` writes.
    const { fetch } = capturingFetch({
      status: 403,
      body: JSON.stringify({ message: 'The clubchatapp.com domain is not verified' }),
    });

    const send = new ResendMailer({ apiKey: API_KEY, from: FROM, fetch }).send(MESSAGE);

    await expect(send).rejects.toThrow(/403/);
    await expect(send).rejects.toThrow(/domain is not verified/);
  });

  it('never puts the API key in the error', async () => {
    // That error is logged, and non-negotiable 5 says a key that bypasses authorization must
    // not appear in a log. Built from the response rather than the request for this reason.
    const { fetch } = capturingFetch({ status: 401, body: 'invalid api key' });

    const send = new ResendMailer({ apiKey: API_KEY, from: FROM, fetch }).send(MESSAGE);

    await expect(send).rejects.toThrow();
    await send.catch((error: unknown) => {
      expect(String(error)).not.toContain(API_KEY);
    });
  });
});
