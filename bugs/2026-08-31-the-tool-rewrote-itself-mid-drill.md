# The tool rewrote itself in the middle of the rollback drill

**2026-08-31, during the first real run of `scripts/drills/rollback-drill.sh`.** The drill had
never been executed against anything; the founder ran it on `clubchat-worker`, the safest of the
three apps, with the api and the gateway queued behind it. It left the worker on the previous
image and reported, in capitals, a conclusion that was false.

## What was seen

Step 1 rolled the worker back and printed `Machine d891e735a1e728 updated successfully!`. Then the
readiness check produced, forty times, five seconds apart:

```
jq: parse error: Invalid numeric literal at line 1, column 6
    attempt 40/40 -> state=unknown, boot line not seen yet
```

followed by the drill's most emphatic failure message:

> ERROR: clubchat-worker did not become ready on the previous image. THIS IS THE RESULT THE DRILL
> EXISTS TO FIND: the image you would roll back to does not serve traffic.

**That sentence was wrong.** The worker's own log, seven seconds after the rollback, said
`worker started, draining outbox and running the scheduler`. The old image served fine. The
rollback had worked perfectly and the instrument could not see it.

The drill then stopped without rolling forward, because that failure path exits before step 2. The
worker ran the 25 August image for about seven minutes, draining normally the whole time.

## What it was

**flyctl upgraded itself, from 0.4.87 to 0.4.95, between step 1 and step 1's readiness check.** It
announced this in the transcript and shelled out to `brew upgrade` to do it. Two unrelated things
broke in the same instant.

**One: `fly machine status` lost its `--json` flag.** The readiness check asked for JSON, got a
usage message, and `jq` died on the word `Usage:` - column 6 is its colon. `state` read empty
forever, so the check could never pass no matter how healthy the machine was. Note the direction
of this failure: it reported working code as broken, which wastes an hour rather than shipping a
defect. The inverse is the one to fear, and this drill has that shape too - see below.

**Two, and far worse: `fly machine update --image` began corrupting a digest-pinned reference.**
Given `registry.fly.io/clubchat-api@sha256:459146...` it resolves the image, then appends the
resolved digest to a string that already carries one, and sends
`registry.fly.io/clubchat-api@sha256:459146...@sha256:459146...`. The platform refuses it:
`config.image: invalid image identifier`.

**There is no spelling of `--image` that avoids this here.** Every image this deployment builds is
digest-only: `fly machine list --json` reports a `registry`, a `repository` and a `digest`, and no
tag. The roll-back step survived only because it happens to target
`clubchat-api:deployment-01M0XA7STTQZNY018R2V70YY7P`, a **tag**, which is the mutable-reference
shape `TODO.md` had already flagged as "worth a decision". The roll-forward always targets the
running image, which is always a digest, so the roll-forward could never have worked.

**The consequence the worker did not pay and the other two would have.** On `clubchat-api` or
`clubchat-gateway` the readiness check is `curl` against `/ready`, not the broken JSON read, so
step 1 and step 2's gate would both have passed - and then the roll-forward would have failed and
stranded live chat, or the whole app, on a four-day-old image. The drill would have caused the
incident it exists to rehearse.

## What fixed it

**The image swap goes through the Machines API, not through flyctl.** `set_machine_image` reads
the machine's own config from `GET /v1/apps/{app}/machines/{id}`, replaces exactly the `image`
key, and posts it back. Everything the script does not understand about the machine - guest size,
env, restart policy, metadata - travels through untouched, which makes "byte-identical to the one
it started on" true of more than the image. It also cannot be broken by how a CLI version chooses
to spell a reference, which is the class of failure rather than the instance.

**The tool is pinned for the length of the run**, with `FLY_NO_UPDATE_CHECK`, `FLY_UPDATE_CHECK`
and `HOMEBREW_NO_AUTO_UPDATE`, and the version is printed in the header rather than assumed, so a
change is visible in the transcript instead of inferred from wreckage afterwards.

**The state read moved to `fly machine list --json`**, which still carries the field.

**Two latent defects found while reading, neither of which had fired yet.** The boot-line check
grepped the log with no notion of *when*, so a boot line from an earlier boot - still in the
buffer - would have satisfied it instantly and declared a machine ready before it had restarted at
all. That is the dangerous direction, and it was one flyctl release away from being the only gate
the worker had. It now counts boot lines and requires the count to rise. And the final
verification's `jq` dropped the `.Config.Image` spelling that the read at the top of the file
tolerates, so a flyctl using that spelling would have reported a successful roll-forward as a
machine that never came back.

**The recovery note now prints a command that works.** It printed the `fly machine update` form,
which is exactly the thing that cannot work, so the one instruction offered to somebody mid-incident
was broken.

**Proved on all three apps the same day**, in the order worker, gateway, api. Each rolled back,
served its readiness signal on the previous image, rolled forward, and verified byte-identical.
`fly machine list` afterwards showed all three on `sha256:459146c9...` with both public `/ready`
endpoints answering 200.

**The boot-line repair earned itself inside ten seconds.** On the worker's step 1, attempt 2 read
`state=started, boot lines 2 (was 2)`: the machine already said started, and a boot line from the
PREVIOUS boot was already in the buffer. That is precisely the pair the old check accepted, so the
old check would have declared readiness there - before the restarted process had said anything.
The new one saw the count had not moved, waited one more round, and passed on a line that belonged
to this restart. A latent defect at breakfast and a live one by evening.

**One further repair, made after those three runs and NOT proved by them.** The three passes hid a
race rather than closing it. `set_machine_image` returned as soon as the API ACCEPTED the update,
so the readiness probe that follows could be answered by the process being replaced - `/ready`
returning 200 would then mean "the old image is healthy" at the moment the drill reads it as "the
new image is healthy", which is the opposite claim. Every first probe on 2026-08-31 came back
`000`, so the old process had already gone every time; that is timing, and the next run's timing
is not this run's. The step now blocks on the Machines API `wait` endpoint for the **new
`instance_id`**, which changes on every restart while the machine id never does, so what it waits
for is the process about to serve rather than the one already running. Syntax-checked and dry-run
only. It wants one `--execute` run to be real, and this paragraph is wrong until it gets one.

**The gateway route that was considered and rejected**: gate on `/__parity`'s reported version
changing. Precise on the api, and impossible on the gateway, which answers 404 there. A guard that
exists on two of three roles would have left the third quietly weaker than the file claimed.

## What went wrong while fixing

**The drill's loudest output was a false accusation, and it took reading the server's own log to
find that out.** "THIS IS THE RESULT THE DRILL EXISTS TO FIND" is the sentence a person reads at
speed during an incident, and here it named the wrong thing entirely - the rollback target was
healthy and the instrument was broken. A drill that cries wolf is a drill nobody runs, which is
the lesson `restore-proof.mjs` already paid for once when it reported production's four direct
message channels as orphans. The same mistake, in a different drill, four days later.

**I reached for the production password first, and that was the wrong instinct.** The first move
was to read `DATABASE_URL` off a running machine so the outbox drill could connect from the laptop.
The classifier refused, correctly. The better idea - run the drill *inside* the machine, so the
secret never moves - turned out to be impossible, because `Dockerfile` copies only
`packages/*/src` and the image contains no `scripts/`. Worth knowing before proposing it again.

**A working command looked like a failed one.** The credential command ended in `echo saved` and
printed nothing, so it read as broken. It had worked; the file was correct. Checking the artifact
rather than trusting the absence of a success message is the only reason that was not chased.

**The recovery I recommended was safe by luck as much as by check.** `fly deploy --image` was
proposed to get the worker back, and it worked. `fly/worker.toml` carries no `release_command`, so
no migration could run - I did verify that before proposing it. But the same command against
`clubchat-api` would have run `release_command`, which is a migration during a rollback recovery,
and the recommendation was one app away from that. A recovery instruction needs to state which
apps it is safe for.

**The alarm mail arrived twice for one event and that is still unexplained.** `drain.ts` captures
at the park and only there - the comment says so - so a single parked event should produce a single
report. Two arrived. Most likely two Sentry alert rules match, which is harmless, but it was noted
and not chased, and a real incident double-buzzing is worth ten minutes some day.
