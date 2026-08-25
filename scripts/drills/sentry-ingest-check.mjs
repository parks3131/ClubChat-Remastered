#!/usr/bin/env node
//
// Ask Sentry whether a DSN actually works, which is the one thing nothing else here can tell you.
//
//   node scripts/drills/sentry-ingest-check.mjs "$SENTRY_DSN"
//   fly ssh console -a clubchat-api -C "sh -c 'node -e ...'"   # see README note below
//
// ## Why this exists
//
// On 2026-08-25, production error reporting was found to have NEVER worked. `fly/*.toml` carried
// a DSN whose key was invented: it shared its first eight characters with the real one and was
// fabricated after that. Sentry answered every single event with
//
//   HTTP 403  {"detail":"event submission rejected with_reason: ProjectId"}
//
// and nothing in the system could see it. Every layer reported success:
//
//  - `loadConfig` accepted it, because the value is present and shaped like a DSN.
//  - The config-completeness check that feeds each `[env]` block through the real `loadConfig`
//    passed, because it proves PRESENCE and cannot prove VALIDITY.
//  - `Sentry.init` accepted it, because the SDK does not validate a DSN against the server.
//  - The transport delivered the bytes and `Sentry.flush()` returned TRUE, because the queue
//    drained. Sentry accepted the CONNECTION and rejected the EVENT.
//  - `Monitor.flush` swallows even that flag by design, so the drill could not have reported it.
//
// The only way to know is to post an event and read the status code. That is all this does.
//
// ## Reading the result
//
//   200  the DSN works. The response body carries the event id Sentry stored it under.
//   403  the key does not belong to that project. Usually a mistyped or invented key.
//   429  rate limited: quota exhausted, or spike protection is holding the project down.
//   401  the key is disabled.
//
// It sends ONE event, tagged `environment=dsn-check`, so a real environment's history is not
// polluted by a configuration test. Hide that environment in Sentry if it bothers you.

const dsn = process.argv[2] ?? process.env.SENTRY_DSN;

if (!dsn) {
  console.error('usage: node scripts/drills/sentry-ingest-check.mjs <dsn>   (or set SENTRY_DSN)');
  process.exit(2);
}

let key, host, project;
try {
  key = dsn.split('//')[1].split('@')[0];
  host = dsn.split('@')[1].split('/')[0];
  project = dsn.split('/').pop();
  if (!key || !host || !project) throw new Error('missing part');
} catch {
  console.error(`REFUSED: "${dsn}" does not parse as a DSN (https://<key>@<host>/<project>)`);
  process.exit(2);
}

console.log(`host    ${host}`);
console.log(`project ${project}`);
console.log(`key     ${key.slice(0, 8)}... (${key.length} chars)`);

const response = await fetch(`https://${host}/api/${project}/store/`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${key}, sentry_client=clubchat-dsn-check/1.0`,
  },
  body: JSON.stringify({
    message: 'ClubChat DSN validity check - safe to ignore or delete',
    level: 'info',
    platform: 'node',
    environment: 'dsn-check',
  }),
});

const body = await response.text();
console.log(`\nHTTP ${response.status} ${response.statusText}`);
console.log(body.slice(0, 300));

if (response.status === 200) {
  console.log('\nOK: Sentry accepted the event. This DSN works.');
  process.exit(0);
}

console.error(
  '\nFAILED: Sentry refused the event. Reporting from anything using this DSN is going ' +
    'nowhere, and every layer above will still report success.',
);
process.exit(1);
