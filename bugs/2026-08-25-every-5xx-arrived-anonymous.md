# Every 5xx reached Sentry with no route, no method and no user

**Found** 2026-08-25, while turning performance tracing on. Live since the 2026-08-23 deploy, and
before that in every development run with a DSN set.

## What broke

`packages/server/src/api/app.ts` has a `setErrorHandler` that captures a failing request with the
things that make a report worth having: a `where` tag for grouping, and a `detail` context holding
the method, the route pattern and the user id. None of it was arriving. Every 500 in production
appeared in Sentry as a bare stack trace, and every one of them grouped into the same issue,
because `where` is what separates them.

## Why

`@sentry/node` 10 hooks Fastify 5's diagnostics channel and captures the error ITSELF, before the
application's error handler runs. Two captures of one `Error` object means the Dedupe integration
keeps the first and drops the second. The first is the SDK's, which knows nothing about this
application. Ours was the duplicate.

## What made it invisible

Nothing failed. `capture` was called, did not throw, and returned an event id. An issue appeared in
Sentry with the right stack trace. The only symptom was an absence: tags that were not there, on a
page nobody opens unless something is already wrong. No test could see it either, because every
assertion available from inside the process passes - the code did call capture, with the right
arguments.

## The fix

`integrations: [Sentry.fastifyIntegration({ shouldHandleError: () => false })]` in
`sentryInitOptions`. Only the SDK's error capture is turned off; its Fastify tracing instrumentation
stays, which is what names a transaction `GET /clubs/:id` rather than `GET /clubs/<uuid>`.

## What went wrong while fixing it

**It was found by accident.** The task was to enable tracing, not to audit error reporting. It
surfaced only because a drill was pointed at a local envelope collector and somebody read the
envelope, which is the second time in three days that reading what actually left the process found
something reading the code had not.

**The first version of the drill printed `flush completed`, which reads as proof of delivery.**
`Monitor.flush` deliberately swallows the SDK's own success flag, because reporting must never fail
a caller, so the line could not have meant that and said it anyway.

**The assertion needed a real client.** `monitoring.test.ts` deliberately does not start one, on
the argument that the SDK is somebody else's tested code. That argument has exactly this hole in
it: the SDK does things to our events that no assertion about our own code can see. Hence
`test/monitoring-sdk.test.ts`, which costs a real client and a real transport and is the only place
that could have caught this.
