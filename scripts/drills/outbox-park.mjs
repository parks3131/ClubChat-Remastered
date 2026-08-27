#!/usr/bin/env node
//
// Drill 2 of 2: park an outbox event on purpose, and un-park it afterwards.
//
//   DATABASE_URL='...' node scripts/drills/outbox-park.mjs --target production
//   DATABASE_URL='...' node scripts/drills/outbox-park.mjs --target production --revert
//
// A parked event is the worst failure this system has and the quietest: an effect that will now
// NEVER run - a notification nobody receives, a system message that never appears. `drain.ts`
// reports it once, at the moment it parks, through `worker.outbox.parked`. Three event types sat
// parked for the entire life of the Eboard space and nothing said so, which is why
// `effect-coverage.test.ts` exists. That alarm has never fired in production, so nobody knows
// whether it reaches anybody.
//
// WHAT HAPPENS. This writes one synthetic event into a partition of its own and waits. The
// RUNNING worker is what parks it, on its next 250ms tick, and the alarm that fires is the real
// one from the real process - not something this script sends on the worker's behalf. So the
// worker has to be running for this drill to do anything, and if it is not, that is a finding.
//
// It parks on the first attempt rather than the eighth, because `club.created` with an empty
// payload throws `PermanentEffectError` and a permanent failure goes straight to the floor. The
// alternative - an event type with no handler - is deliberately retryable and would take between
// 75 minutes and two and a half hours to reach the same place.
//
// WHAT IT CANNOT DO. It cannot park, delay or delete anything real:
//
//   - the event is written into `drill:monitoring:<uuid>`, and every real partition key is a bare
//     uuid written by domain code, so it queues behind nothing and nothing queues behind it;
//   - a parked row does not hold its partition anyway (see drain.ts, `earlier.attempts < 8`);
//   - `--revert` deletes by that partition prefix, NEVER by "parked". Deleting parked rows would
//     destroy the evidence that a real effect never ran, which is exactly what `retention.ts`
//     refuses to do on a timer.
//
// ALWAYS RUN --revert AFTERWARDS. The parked count is a standing number: retention never reduces
// it, and the hourly "outbox events are PARKED" line reads it. A drill left in place makes that
// number permanently wrong by one, which is worse than never having run the drill.

import { parseDrillArgs } from './target-gate.mjs';
import { createDb, createPool } from '../../packages/server/src/db/client.ts';
import {
  DRILL_PARTITION_PREFIX,
  insertDrillEvent,
  readDrillEvent,
  removeDrillEvents,
} from '../../packages/server/src/drills/outbox-park.ts';
import { parkedEventCount } from '../../packages/server/src/worker/retention.ts';

const { target, has } = parseDrillArgs(process.argv, {
  script: 'scripts/drills/outbox-park.mjs',
  targets: [
    'production   the live database the worker is draining. The real alarm fires.',
    'local        a development database, for checking this script itself.',
  ],
  flags: ['--revert'],
});

const databaseUrl = (process.env['DATABASE_URL'] ?? '').trim();
if (databaseUrl === '') {
  process.stderr.write(
    'refusing to run: DATABASE_URL is empty, so there is nothing to write to.\n' +
      'It is a secret and is not in this repository. Read it from `fly secrets` or your .env.\n',
  );
  process.exit(2);
}

/** The host and database, never the credentials. Confirming which database you are about to write to. */
function describeDatabase(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return 'an unparseable DATABASE_URL';
  }
}

const pool = createPool(databaseUrl);
const db = createDb(pool);

process.stdout.write(
  `drill: parked outbox event\n` +
    `  target   ${target}\n` +
    `  database ${describeDatabase(databaseUrl)}\n` +
    `  mode     ${has('--revert') ? 'revert' : 'park'}\n\n`,
);

try {
  if (has('--revert')) {
    const before = await parkedEventCount(db);
    const removed = await removeDrillEvents(db);
    const after = await parkedEventCount(db);
    process.stdout.write(
      `  removed ${removed} row(s) from ${DRILL_PARTITION_PREFIX}*\n` +
        `  parked events: ${before} -> ${after}\n\n` +
        (after === 0
          ? 'Clean. Nothing this drill wrote is left in the outbox.\n'
          : `${after} parked event(s) remain, and none of them are the drill's.\n` +
            'Those are real: an effect never ran. Look at `SELECT event_type, last_error FROM outbox\n' +
            'WHERE processed_at IS NULL AND attempts >= 8`.\n'),
    );
  } else {
    const before = await parkedEventCount(db);
    const event = await insertDrillEvent(db);
    process.stdout.write(
      `  wrote outbox id ${event.id} in partition ${event.partitionKey}\n` +
        `  parked events before: ${before}\n` +
        '  waiting for the worker to fail it...\n',
    );

    /*
     * Poll rather than sleep once. The interesting outcome is not only "it parked" but how long it
     * took: a worker that is running picks this up inside a second, and anything slower is itself
     * worth seeing. Sixty seconds is generous by two orders of magnitude on purpose, because the
     * failure this catches is "no worker is running at all" and that should not look like a hang.
     */
    const deadline = Date.now() + 60_000;
    let state = await readDrillEvent(db, event.id);
    while (!state?.parked && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await readDrillEvent(db, event.id);
    }

    if (!state?.parked) {
      process.stderr.write(
        `\n  NOT PARKED after 60s (attempts ${state?.attempts ?? 0}).\n` +
          '  The worker is not draining this database. That is a finding in itself: every effect\n' +
          '  in the system is currently queued rather than running. Check `fly status -a clubchat-worker`.\n' +
          `  Then run this again with --revert to remove the drill row.\n`,
      );
      process.exit(1);
    }

    process.stdout.write(
      `\n  PARKED after ${state.attempts} attempt(s): ${state.lastError ?? '(no error recorded)'}\n` +
        `  parked events now: ${await parkedEventCount(db)}\n\n` +
        'Now go and look. There should be a Sentry issue tagged service=worker,\n' +
        `where=worker.outbox.parked, with eventId ${event.id} and permanent=true in its context.\n` +
        'If it is there and nobody was notified, the gap is the alert rule rather than the code.\n\n' +
        `THEN UNDO IT:  node scripts/drills/outbox-park.mjs --target ${target} --revert\n`,
    );
  }
} finally {
  await pool.end();
}
