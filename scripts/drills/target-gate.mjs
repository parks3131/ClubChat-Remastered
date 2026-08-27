//
// The one gate every operational script shares: you have to say what you are pointing at.
//
// Each of them does something an operator would not want to do by accident, in a place they might
// not have meant. One posts a fake incident into a live Sentry project and wakes whoever the alert
// rule names; the other two write to whatever database DATABASE_URL happens to be pointing at,
// which on a laptop with a stale shell is not always the one you think.
//
// `script` is the path a caller should type, repo-relative, because the callers no longer all live
// in this directory: `scripts/backfill-media-variants.mjs` uses this gate too.
//
// So there is no default target and there never will be one. `--target production` is four extra
// words and it is the entire protection, in the same spirit as `scripts/surface-gate.sh` taking
// its host from `API=` rather than guessing: a tool that reaches a running system says which one
// out loud.
//
// The refusal happens BEFORE anything is read out of the environment or connected to, which is
// asserted in packages/server/src/test/drills.test.ts. A script that connected first and validated
// second would already have reached production by the time it told you off.

/** What a drill script gets back once it has been allowed to run. */
export function parseDrillArgs(argv, { script, targets, flags = [] }) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write(usage(script, targets, flags));
    process.exit(2);
  }

  const at = args.indexOf('--target');
  const target = at === -1 ? undefined : args[at + 1];

  if (target === undefined || target.startsWith('--')) {
    process.stderr.write(
      `refusing to run: no target named.\n\n${usage(script, targets, flags)}`,
    );
    process.exit(2);
  }

  const unknown = args.filter(
    (arg, index) =>
      arg.startsWith('--') && arg !== '--target' && !flags.includes(arg) && index !== at + 1,
  );
  if (unknown.length > 0) {
    // A misspelled flag on a drill is worth stopping for. `--revert` typed as `--revery` would
    // otherwise run the drill again rather than undoing the one that is live.
    process.stderr.write(
      `refusing to run: unrecognised ${unknown.join(' ')}\n\n${usage(script, targets, flags)}`,
    );
    process.exit(2);
  }

  return { target, has: (flag) => args.includes(flag) };
}

function usage(script, targets, flags) {
  const lines = [
    `usage: node ${script} --target <name>${flags.map((f) => ` [${f}]`).join('')}`,
    '',
    'The target is required and has no default. It names what this run is pointed at:',
    ...targets.map((line) => `  ${line}`),
    '',
  ];
  return `${lines.join('\n')}`;
}

/**
 * Where a DSN points, without ever printing the DSN.
 *
 * The key half is write-only and safe to hold, but printing a credential into a terminal that is
 * probably being pasted into a chat window is a habit worth not having. The host and the numeric
 * project id are the two things an operator actually wants confirmed before they fire a drill:
 * "am I about to page myself about the production project or the one I made to test this".
 */
export function describeDsn(dsn) {
  try {
    const url = new URL(dsn);
    const project = url.pathname.replace(/^\//, '');
    return `${url.host} project ${project}`;
  } catch {
    return 'an unparseable DSN';
  }
}
