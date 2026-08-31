#!/usr/bin/env bash
#
# The machine rollback drill: roll ONE role back to its previous image and forward again,
# checking readiness at every step.
#
#   ./scripts/drills/rollback-drill.sh --app clubchat-api
#   ./scripts/drills/rollback-drill.sh --app clubchat-api --execute
#
# **The half of rollback that is already decided is the schema half, and this drill is not it.**
# A schema change is never rolled back, only followed forward: migrations are additive and run as
# the api app's `release_command`, on a temporary machine, before any machine is updated. So the
# previous image always runs correctly against the newer schema, and there is nothing to un-apply.
# What has never been performed is the MACHINE rollback, against a schema that stays exactly where
# it is. That is what this does.
#
# One machine's image, changed in place, rather than `fly deploy --image`, and the difference is
# the whole design. `fly deploy` against `fly/api.toml` would run `release_command` again - a
# migration, during a rollback drill, which is precisely the thing this drill must not do.
# Changing one machine's image runs no release command at all, and it is surgical: it names a
# machine, so it cannot fan out.
#
# **The swap goes through the Machines API rather than `fly machine update`, and that is a repair
# rather than a preference.** flyctl 0.4.95 corrupts a digest-pinned reference: it appends the
# resolved digest to a string that already carries one, producing `repo@sha256:X@sha256:X`, which
# the platform rejects as `config.image: invalid image identifier`. Every image this deployment
# builds is digest-only - `fly machine list --json` reports a `registry`, a `repository` and a
# `digest`, and no tag - so there is no spelling of `--image` that survives the bug. The API is
# handed the machine's OWN config with exactly one field changed, which is both what
# "byte-identical" actually means and immune to how any CLI version chooses to spell a reference.
#
# Found on 2026-08-31, live: the roll-forward failed with that error and left clubchat-worker on
# the previous image, which is the one outcome this drill must never produce by itself.
#
# ## What it refuses
#
#   - No `--app`. There is no default, so there is nothing to run by accident.
#   - Anything but exactly one of the three known apps. `--app all` is refused by name, because it
#     is the thing somebody will try.
#   - More than one machine on the app. This drill is written for the one-machine-per-role shape
#     that SPEC/TECH/21 describes, and a two-machine app needs a decision, not a default.
#   - Acting at all, without `--execute` AND typing the app name at a prompt.
#   - Rolling to an image that equals the one already running. That is not a rollback.
#
# `--skip-health-checks` is never passed. The health check is the instrument.
#
# ## What it proves
#
# Not "the command exited 0". At each of the two steps it first waits for the NEW instance to
# reach `started`, so that what answers next cannot be the process being replaced, and only then
# waits for the role's own readiness signal - `/ready` returning 200 through the public hostname
# for the api and the gateway, and a NEW boot log line for the worker, which has no health gate
# because it has no ingress. At the end it re-reads the machine's image and asserts it is
# byte-identical to the one running before the drill started.
#
# **Every one of those three words is load-bearing, and each replaced a weaker check that could
# pass without proving anything.** "New instance" replaced an immediate probe that the old process
# could answer. "New boot line" replaced any boot line, which a previous boot already satisfied.
# And the final assertion is re-read from the platform rather than inferred from exit codes.
set -euo pipefail

# **flyctl upgrades ITSELF mid-run unless told not to, and on 2026-08-31 it did.** It went
# 0.4.87 -> 0.4.95 between step 1 and step 1's readiness check, in the middle of a live drill,
# by shelling out to `brew upgrade`. Two things broke in the same instant: `fly machine status`
# lost its `--json` flag, so the worker's readiness check parsed a usage message and reported a
# HEALTHY rollback as a failure; and `fly machine update --image` began corrupting digest-pinned
# references, so the roll-forward could not run at all.
#
# A tool that rewrites itself under a rollback script rewrites it at the worst possible moment -
# during an incident, at speed, when nobody is reading the output carefully. So the drill pins the
# tool for the length of its own run, and prints the version it actually used so a change is
# visible in the transcript rather than inferred afterwards.
export FLY_NO_UPDATE_CHECK=1
export FLY_UPDATE_CHECK=0
export HOMEBREW_NO_AUTO_UPDATE=1

READY_ATTEMPTS=40
READY_INTERVAL=5
BOOT_LINE='worker started, draining outbox and running the scheduler'
MACHINES_API='https://api.machines.dev/v1'

usage() {
  cat <<'USAGE'
Machine rollback drill: roll one Fly app's machine back one image and forward again.

  ./scripts/drills/rollback-drill.sh --app <app> [--to <image>] [--execute]

  --app <app>    REQUIRED. Exactly one of: clubchat-api, clubchat-gateway, clubchat-worker.
  --to <image>   The image to roll back TO. Default: the previous release's image.
  --execute      Actually update the machine. Without this, nothing is changed.
  --help         This.

Never runs against more than one app. Run it three times if you want all three,
and read the result of each before starting the next.
USAGE
}

refuse() {
  printf '\nREFUSED: %s\n' "$1" >&2
  exit 2
}

die() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}

app=''
to_image=''
execute=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ -z $app ]] || refuse "--app given twice. This drill runs against exactly one app."
      app=${2:-}
      shift 2
      ;;
    --to)
      to_image=${2:-}
      shift 2
      ;;
    --execute) execute=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; refuse "unknown argument: $1" ;;
  esac
done

[[ -n $app ]] || { usage >&2; refuse "no --app. Name the one app to drill."; }

case "$app" in
  clubchat-api)
    role=api
    probe='https://api.clubchatapp.com/ready'
    ;;
  clubchat-gateway)
    role=gateway
    probe='https://ws.clubchatapp.com/ready'
    ;;
  clubchat-worker)
    role=worker
    probe=''
    ;;
  all|ALL|*,*)
    refuse "this drill never runs against more than one app at a time. Pick one of clubchat-api, clubchat-gateway, clubchat-worker."
    ;;
  *)
    refuse "\"$app\" is not one of this deployment's three apps: clubchat-api, clubchat-gateway, clubchat-worker."
    ;;
esac

for tool in fly jq curl; do
  command -v "$tool" >/dev/null 2>&1 || refuse "$tool is not on PATH, and this drill needs it."
done

printf 'ClubChat machine rollback drill\n'
printf '==============================\n\n'
printf 'app            %s\n' "$app"
printf 'role           %s\n' "$role"
printf 'mode           %s\n' "$([[ $execute == true ]] && echo 'EXECUTE' || echo 'dry run (nothing will change)')"
# Printed rather than assumed: on 2026-08-31 the version changed DURING a run, and the only way
# anybody could tell afterwards was that flyctl announced its own upgrade in the transcript.
printf 'flyctl         %s\n' "$(fly version 2>/dev/null | head -1)"
if [[ -n $probe ]]; then
  printf 'readiness      GET %s must return 200\n' "$probe"
else
  printf 'readiness      no ingress, so the gate is the boot log line:\n               "%s"\n' "$BOOT_LINE"
fi
printf '\n'

# ---------------------------------------------------------------------------
# Read-only reconnaissance. Everything here lists; nothing here changes anything.
# ---------------------------------------------------------------------------

machines_json=$(fly machine list --app "$app" --json) || die "could not list machines on $app. Is 'fly auth whoami' the right account?"
machine_count=$(jq 'length' <<<"$machines_json")

if [[ $machine_count -ne 1 ]]; then
  refuse "$app has $machine_count machines. This drill is written for the one-machine-per-role shape SPEC/TECH/21 describes. Roll a multi-machine app with 'fly deploy --image' after deciding what the other machines should be doing."
fi

machine_id=$(jq -r '.[0].id // .[0].ID // empty' <<<"$machines_json")
machine_state=$(jq -r '.[0].state // .[0].State // empty' <<<"$machines_json")
machine_region=$(jq -r '.[0].region // .[0].Region // empty' <<<"$machines_json")
current_image=$(jq -r '.[0].config.image // .[0].Config.image // .[0].Config.Image // empty' <<<"$machines_json")

[[ -n $machine_id ]] || die "could not read a machine id out of 'fly machine list --json'."
[[ -n $current_image ]] || die "could not read the current image out of 'fly machine list --json'. Read it from 'fly image show --app $app' and pass --to yourself."

printf 'machine        %s  region %s  state %s\n' "$machine_id" "$machine_region" "$machine_state"
printf 'running now    %s\n' "$current_image"

[[ $machine_state == started ]] || refuse "machine $machine_id is '$machine_state', not 'started'. Fix that before drilling a rollback on it."

if [[ -z $to_image ]]; then
  releases_json=$(fly releases --app "$app" --image --json) || die "could not list releases on $app."

  # flyctl v0.4.87 marshals fly.Release with Go's field names, so the key is `ImageRef`, not
  # `imageRef`. Measured against the real app on 2026-08-25, because published examples show the
  # camelCase form and it silently yields null. The chain covers both rather than picking one:
  # jq's `//` treats null as absent, so whichever spelling a future flyctl uses still resolves,
  # and a spelling nobody anticipated produces the empty refusal below rather than a wrong image.
  release_images=$(jq -r '
      [ .[] | (.imageRef // .ImageRef // .image_ref // .image // empty) ]
      | map(select(. != null and . != ""))
      | .[]' <<<"$releases_json")

  if [[ -z $release_images ]]; then
    printf '\nCould not read any image reference out of the release list:\n\n' >&2
    fly releases --app "$app" --image >&2 || true
    refuse "'fly releases --json' did not carry an image reference this script recognises. Read the digest off the table above and pass it with --to."
  fi

  to_image=$(grep -vxF "$current_image" <<<"$release_images" | head -n 1 || true)

  if [[ -z $to_image ]]; then
    release_count=$(wc -l <<<"$release_images" | tr -d ' ')
    printf '\nEvery one of this app'"'"'s %s releases carries the SAME image digest:\n  %s\n' \
      "$release_count" "$current_image" >&2
    printf '\nA release is created by a secret or config change as well as by a deploy, so several\n' >&2
    printf 'releases of one image is normal. It also means this app has never run a second image,\n' >&2
    printf 'and there is therefore nothing to roll back TO.\n' >&2
    refuse "no previous image exists. This drill becomes runnable after the second image deploy. Until then the honest answer is that rollback is untested because it is not yet possible."
  fi
fi

[[ $to_image != "$current_image" ]] || refuse "--to is the image already running. That is not a rollback."
[[ $to_image == registry.fly.io/* ]] || refuse "--to \"$to_image\" is not a Fly registry reference. Expected registry.fly.io/<app>@sha256:<digest>."

printf 'roll back to   %s\n\n' "$to_image"

cat <<PLAN
plan
----
1. POST this machine's own config back to the Machines API with config.image set to
     $to_image
   then wait for the NEW instance to reach "started"
2. wait for the role's readiness signal
3. POST it again with config.image restored to
     $current_image
   then wait for that new instance in the same way
4. wait for the readiness signal again
5. assert the machine's image is byte-identical to the one it started on

Three things this deliberately does NOT do:
  - It never asks the platform to skip a health check. The check is the instrument.
  - It never runs 'fly deploy', so release_command never runs and NO MIGRATION IS APPLIED
    OR UNDONE. The schema stays exactly where it is, which is the decided policy: a schema
    change is followed forward, never rolled back.
  - It never lets flyctl upgrade itself mid-run, and it never swaps the image through
    'fly machine update --image'. The note at the top of this file says why both matter.

PLAN

if [[ $execute != true ]]; then
  printf 'dry run complete. Nothing was changed.\n'
  printf 'Add --execute to perform the drill.\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# Confirmation. Explicit, typed, and from a terminal.
# ---------------------------------------------------------------------------

[[ -e /dev/tty ]] || refuse "--execute needs a terminal to confirm at. This drill is not for CI."
printf 'This will restart %s twice, in production. Type the app name to confirm: ' "$app"
read -r typed </dev/tty || refuse "could not read a confirmation."
[[ $typed == "$app" ]] || refuse "you typed \"$typed\", not \"$app\". Nothing was changed."
printf '\n'

# ---------------------------------------------------------------------------
# The drill
# ---------------------------------------------------------------------------

# Swap one machine's image, by handing the Machines API that machine's OWN config with exactly one
# field changed. The note at the top of this file carries the reason; the short version is that
# flyctl 0.4.95 cannot express a digest-pinned image and every image here is digest-only.
set_machine_image() {
  local target=$1 token cfg payload http instance

  token=$(fly auth token 2>/dev/null) || { printf '  could not obtain a Fly API token\n' >&2; return 1; }
  [[ -n $token ]] || { printf "  'fly auth token' returned nothing\\n" >&2; return 1; }

  cfg=$(curl -sS --max-time 30 "$MACHINES_API/apps/$app/machines/$machine_id" \
        -H "Authorization: Bearer $token") \
    || { printf '  could not read the machine from the Machines API\n' >&2; return 1; }

  # `.config` verbatim with one key replaced. Anything this script does not understand about the
  # machine - guest size, env, restart policy, metadata - travels through untouched, which is the
  # property that makes "byte-identical to the one it started on" true of more than the image.
  payload=$(jq -ce --arg img "$target" '{config: (.config | .image = $img)}' <<<"$cfg") \
    || { printf '  the Machines API response carried no config this script could read\n' >&2; return 1; }

  http=$(curl -sS --max-time 120 -o /tmp/rollback_drill_update -w '%{http_code}' \
         -X POST "$MACHINES_API/apps/$app/machines/$machine_id" \
         -H "Authorization: Bearer $token" \
         -H 'Content-Type: application/json' \
         --data "$payload") \
    || { printf '  the update request itself failed\n' >&2; return 1; }

  if [[ $http != 200 ]]; then
    printf '  Machines API answered %s: %s\n' "$http" "$(head -c 300 /tmp/rollback_drill_update 2>/dev/null || true)" >&2
    return 1
  fi

  # **Wait for the NEW instance specifically. This is what makes the readiness check below mean
  # anything at all.**
  #
  # The POST returns when the update is ACCEPTED, not when the swap has happened. A probe fired
  # straight afterwards can therefore be answered by the process being replaced - so `/ready`
  # returning 200 would say "the old image is healthy" at the moment the drill reads it as "the
  # new image is healthy", and the two are the opposite claim. Nothing in the run of 2026-08-31
  # hit it: every first probe came back `000` because the old process had already gone. That was
  # timing, and the next run's timing is not this run's.
  #
  # `instance_id` changes on every restart while the machine id never does, so waiting on the
  # instance is a statement about the process that is about to serve. Waiting on the machine would
  # be satisfied by the one already running.
  instance=$(jq -r '.instance_id // .InstanceID // empty' /tmp/rollback_drill_update)
  if [[ -z $instance ]]; then
    printf '  the update was accepted but carried no instance id, so this script cannot tell the\n' >&2
    printf '  new process from the one it replaced. Refusing to guess - see the note at this line.\n' >&2
    return 1
  fi

  http=$(curl -sS --max-time 180 -o /dev/null -w '%{http_code}' \
         "$MACHINES_API/apps/$app/machines/$machine_id/wait?instance_id=$instance&state=started&timeout=120" \
         -H "Authorization: Bearer $token") \
    || { printf '  the wait request itself failed\n' >&2; return 1; }

  if [[ $http != 200 ]]; then
    printf '  instance %s never reached "started" (wait answered %s)\n' "$instance" "$http" >&2
    return 1
  fi

  printf '  instance %s started\n' "$instance"
  return 0
}

# The machine's state, read through `fly machine list --json`.
#
# NOT `fly machine status --json`: flyctl 0.4.95 removed `--json` from that subcommand, so it
# prints a usage message, jq dies on the word "Usage:", and the state reads as empty forever. The
# worker's readiness check did exactly that on 2026-08-31 and reported a perfectly healthy
# rollback as a failure for all forty attempts. `machine list --json` still carries the field.
machine_state_now() {
  fly machine list --app "$app" --json 2>/dev/null \
    | jq -r --arg id "$machine_id" '.[] | select((.id // .ID) == $id) | (.state // .State) // empty'
}

# How many times the worker has announced a boot inside the log window flyctl will show us.
#
# The check this replaces grepped for the line with no notion of WHEN, so a boot line from an
# EARLIER boot - still sitting in the buffer - satisfied it instantly, and the drill would have
# called a machine ready before it had finished restarting. Requiring the count to RISE ties the
# signal to this restart. A count that falls because an old line aged out of the window reads as
# "not ready yet", which is the safe direction to be wrong in.
boot_count() {
  fly logs --app "$app" --machine "$machine_id" --no-tail 2>/dev/null | grep -cF "$BOOT_LINE" || true
}

wait_ready() {
  local label=$1 attempt code state seen
  printf '  waiting for readiness (%s)\n' "$label"
  for ((attempt = 1; attempt <= READY_ATTEMPTS; attempt++)); do
    if [[ -n $probe ]]; then
      code=$(curl -sS -o /tmp/rollback_drill_body -w '%{http_code}' --max-time 10 "$probe" 2>/dev/null || echo 000)
      if [[ $code == 200 ]]; then
        printf '  ready: %s -> 200 after %ss\n' "$probe" "$(((attempt - 1) * READY_INTERVAL))"
        return 0
      fi
      printf '    attempt %s/%s -> %s %s\n' "$attempt" "$READY_ATTEMPTS" "$code" "$(head -c 80 /tmp/rollback_drill_body 2>/dev/null || true)"
    else
      state=$(machine_state_now)
      seen=$(boot_count)
      if [[ $state == started ]] && [[ ${seen:-0} -gt ${boot_before:-0} ]]; then
        printf '  ready: machine started and logged a NEW boot line after %ss\n' "$(((attempt - 1) * READY_INTERVAL))"
        return 0
      fi
      printf '    attempt %s/%s -> state=%s, boot lines %s (was %s)\n' \
        "$attempt" "$READY_ATTEMPTS" "${state:-unknown}" "${seen:-0}" "${boot_before:-0}"
    fi
    sleep "$READY_INTERVAL"
  done
  return 1
}

recovery_note() {
  cat >&2 <<RECOVER

To put $app back on the image it started with, by hand:

  TOKEN=\$(fly auth token)
  curl -sS "$MACHINES_API/apps/$app/machines/$machine_id" \\
       -H "Authorization: Bearer \$TOKEN" \\
    | jq -c '{config: (.config | .image = "$current_image")}' \\
    | curl -sS -X POST "$MACHINES_API/apps/$app/machines/$machine_id" \\
           -H "Authorization: Bearer \$TOKEN" \\
           -H "Content-Type: application/json" --data @-

NOT 'fly machine update --image'. flyctl 0.4.95 corrupts a digest-pinned reference
and refuses with "config.image: invalid image identifier".
RECOVER
}

# Only the worker reads the log, so only the worker pays for a log fetch. `boot_before` is a
# global on purpose: `wait_ready` compares against the count taken immediately before the update
# that it is waiting on, and re-taking it inside the loop would compare a number with itself.
[[ -n $probe ]] || boot_before=$(boot_count)

printf 'step 1: rolling BACK to %s\n' "$to_image"
if ! set_machine_image "$to_image"; then
  recovery_note
  die "the rollback update failed. The machine may be part way through; check 'fly machine list --app $app --json'."
fi

if ! wait_ready 'on the previous image'; then
  recovery_note
  die "$app did not become ready on the previous image. THIS IS THE RESULT THE DRILL EXISTS TO FIND: the image you would roll back to does not serve traffic. Do not treat rollback as available until this is understood."
fi

[[ -n $probe ]] || boot_before=$(boot_count)

printf '\nstep 2: rolling FORWARD to %s\n' "$current_image"
if ! set_machine_image "$current_image"; then
  recovery_note
  die "the roll-forward update failed. The app is still on the PREVIOUS image."
fi

if ! wait_ready 'back on the current image'; then
  recovery_note
  die "$app did not become ready after rolling forward. It is running the image it started on but is not answering."
fi

# ---------------------------------------------------------------------------
# The assertion. Not "the commands exited 0" - what is actually running now.
# ---------------------------------------------------------------------------

printf '\nverifying\n'
# Selected by id, and tolerant of all three spellings the read at the top of this file tolerates.
# The narrower version of this line dropped `.Config.Image`, so a flyctl that used that spelling
# would have yielded an empty string here and reported a SUCCESSFUL roll-forward as a machine that
# never came back - sending whoever ran it to fix something that was not broken.
final_image=$(fly machine list --app "$app" --json \
  | jq -r --arg id "$machine_id" '.[] | select((.id // .ID) == $id)
           | (.config.image // .Config.image // .Config.Image) // empty')
printf '  started on  %s\n' "$current_image"
printf '  running now %s\n' "$final_image"

if [[ $final_image != "$current_image" ]]; then
  recovery_note
  die "the machine did NOT come back to the image it started on."
fi

if [[ -n $probe ]]; then
  fly checks list --app "$app" || true
fi

printf '\nDRILL PASSED: %s rolled back to its previous image, served readiness there, and rolled\n' "$app"
printf 'forward to exactly the image it started on. No migration ran in either direction.\n'
