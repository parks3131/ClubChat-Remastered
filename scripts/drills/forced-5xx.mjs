#!/usr/bin/env node
//
// Drill 1 of 2: raise a real 500 and prove it reaches a human.
//
//   SENTRY_DSN='<the dsn from fly/api.toml>' node scripts/drills/forced-5xx.mjs --target production
//
// What it proves, which is the half no test can:
//
//   error thrown in a route
//     -> the real setErrorHandler in packages/server/src/api/app.ts
//       -> monitor.capture(error, 'api.request', { method, route, userId })
//         -> the Sentry SDK, with this build's release and environment
//           -> sentry.io, over the network, from wherever you ran this
//             -> the project's alert rule
//               -> somebody's phone
//
// The first two arrows are proved on every CI run: error-reporting.test.ts asserts the handler
// captures, and monitoring-sdk.test.ts asserts the event still carries `where` and the route
// pattern when the SDK is finished with it. That second test exists because THIS drill found it
// not to be true - the SDK was capturing Fastify errors itself and ours was being deduped away.
// The last four arrows have never been exercised once, which is why the founder's note says
// production error visibility is effectively off: the code reports, and nobody has ever received
// a report.
//
// WHY THERE IS NO ROUTE THAT DOES THIS. The obvious alternative is an endpoint on the live API
// that throws when asked. That is a permanent piece of attack surface, live for ever, bought for
// a drill that runs twice a year, and any guard on it is one more secret to rotate. Instead this
// builds the real app in THIS process, registers the throwing route on that instance, and lets it
// go when the process exits - the same trick error-reporting.test.ts uses, and the reason app.ts
// contains no route that fails on purpose.
//
// WHERE TO RUN IT FROM. A laptop is enough to prove the DSN, the project, the environment tag and
// the alert rule, which is the whole chain above except one link: that a Fly machine can reach
// Sentry. To prove that link too, run it inside the machine. The image carries
// packages/server/src but not scripts/, so it is the module rather than this file:
//
//   fly ssh console -a clubchat-api -C "node --input-type=module -e \
//     \"import {initMonitoring} from './packages/server/src/monitoring.ts'; \
//       import {forceFiveHundred} from './packages/server/src/drills/forced-5xx.ts'; \
//       import {loadConfig} from './packages/server/src/config.ts'; \
//       const m=initMonitoring(loadConfig(),'api',console); \
//       await forceFiveHundred(m); await m.flush(5000);\""
//
// That variant has NOT been run - it needs production and this pass was local only. See the task's
// outstanding list.
//
// AFTERWARDS: the issue in Sentry is titled with the drill's own message and its `route` context
// is /__drill/forced-5xx, so it is unmistakable. Resolve it by hand; nothing here cleans it up,
// because an incident somebody has seen is the artifact the drill exists to produce.

import { parseDrillArgs, describeDsn } from './target-gate.mjs';
import { initMonitoring } from '../../packages/server/src/monitoring.ts';
import { forceFiveHundred } from '../../packages/server/src/drills/forced-5xx.ts';

const { target } = parseDrillArgs(process.argv, {
  script: 'scripts/drills/forced-5xx.mjs',
  targets: [
    'production   the live Sentry project. Somebody gets paged. That is the point.',
    'development  a throwaway environment tag, for checking this script itself.',
  ],
});

const dsn = (process.env['SENTRY_DSN'] ?? '').trim();
if (dsn === '') {
  process.stderr.write(
    'refusing to run: SENTRY_DSN is empty, so this would report to nowhere and pass.\n' +
      'The DSN is not a secret - it is write-only and lives in fly/api.toml [env].\n\n' +
      "  SENTRY_DSN='<the value from fly/api.toml>' node scripts/drills/forced-5xx.mjs --target production\n",
  );
  process.exit(2);
}

/*
 * Only the four values `initMonitoring` reads.
 *
 * Not `loadConfig()`, deliberately: that would demand DATABASE_URL, REDIS_URL and the S3
 * credentials on whatever machine is running the drill, which is a high price for finding out
 * whether an alert rule works. The tracing rate is zero here because a drill is one request and
 * its timing is of no interest to anybody.
 */
const config = {
  SENTRY_DSN: dsn,
  SENTRY_ENVIRONMENT: target,
  SENTRY_RELEASE: (process.env['SENTRY_RELEASE'] ?? '').trim() || undefined,
  SENTRY_TRACES_SAMPLE_RATE: 0,
};

process.stdout.write(
  `drill: forced 5xx\n` +
    `  target       ${target}\n` +
    `  reporting to ${describeDsn(dsn)}\n` +
    `  release      ${config.SENTRY_RELEASE ?? '(none - the report will not name a build)'}\n\n`,
);

const monitor = initMonitoring(config, 'api', {
  error: (payload, message) => {
    process.stdout.write(`  local log: ${message ?? ''} ${JSON.stringify(payload.where ?? '')}\n`);
  },
});

const result = await forceFiveHundred(monitor);

if (result.status !== 500) {
  process.stderr.write(`\nFAIL: the drill route answered ${result.status}, not 500\n`);
  process.exit(1);
}
if (result.body !== '{"error":"internal"}') {
  // The response body is part of what is being drilled: a 500 that leaks the message is a defect
  // whether or not anybody was paged about it.
  process.stderr.write(`\nFAIL: the 500 body leaked something: ${result.body}\n`);
  process.exit(1);
}

/*
 * Flush before exiting.
 *
 * The SDK sends in the background, so a process that exits immediately after `capture` drops the
 * event and reports success. Every entrypoint flushes on SIGTERM for the same reason.
 *
 * **Returning is not delivery**, and this line is careful not to claim it is. `Monitor.flush`
 * swallows the SDK's own answer by design - reporting must never fail a caller - so all this can
 * say is that the wait finished. The proof of delivery is the issue appearing, which is why the
 * script ends by telling the operator to go and look rather than by declaring success.
 */
await monitor.flush(10_000);

process.stdout.write(
  `\n  ${result.status} ${result.body} at ${result.route}\n` +
    `  flush returned (that is not proof of delivery - the issue appearing is)\n\n` +
    `Now go and look. Within a minute or two there should be an issue in ${describeDsn(dsn)}\n` +
    `tagged environment=${target}, service=api, where=api.request, route=${result.route}.\n` +
    `If it is there and nobody was notified, the gap is the alert rule rather than the code.\n`,
);
