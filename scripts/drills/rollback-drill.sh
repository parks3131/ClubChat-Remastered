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
# `fly machine update` rather than `fly deploy --image`, and the difference is the whole design.
# `fly deploy` against `fly/api.toml` would run `release_command` again - a migration, during a
# rollback drill, which is precisely the thing this drill must not do. `fly machine update`
# updates one machine's image and runs no release command at all. It is also surgical: it names a
# machine, so it cannot fan out.
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
# Not "the command exited 0". At each of the two steps it waits for the role's own readiness
# signal - `/ready` returning 200 through the public hostname for the api and the gateway, and the
# worker's boot log line for the worker, which has no health gate because it has no ingress. At
# the end it re-reads the machine's image and asserts it is byte-identical to the one running
# before the drill started.
set -euo pipefail

READY_ATTEMPTS=40
READY_INTERVAL=5
WAIT_TIMEOUT=300
BOOT_LINE='worker started, draining outbox and running the scheduler'

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
1. fly machine update $machine_id --app $app --image $to_image --yes --wait-timeout $WAIT_TIMEOUT
2. wait for the role's readiness signal
3. fly machine update $machine_id --app $app --image $current_image --yes --wait-timeout $WAIT_TIMEOUT
4. wait for the readiness signal again
5. assert the machine's image is byte-identical to the one it started on

Two things this deliberately does NOT do:
  - It never passes --skip-health-checks. The check is the instrument.
  - It never runs 'fly deploy', so release_command never runs and NO MIGRATION IS APPLIED
    OR UNDONE. The schema stays exactly where it is, which is the decided policy: a schema
    change is followed forward, never rolled back.

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

wait_ready() {
  local label=$1 attempt code
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
      state=$(fly machine status "$machine_id" --app "$app" --json 2>/dev/null | jq -r '.state // .State // empty')
      if [[ $state == started ]] && fly logs --app "$app" --machine "$machine_id" --no-tail 2>/dev/null | grep -qF "$BOOT_LINE"; then
        printf '  ready: machine started and logged the boot line after %ss\n' "$(((attempt - 1) * READY_INTERVAL))"
        return 0
      fi
      printf '    attempt %s/%s -> state=%s, boot line not seen yet\n' "$attempt" "$READY_ATTEMPTS" "${state:-unknown}"
    fi
    sleep "$READY_INTERVAL"
  done
  return 1
}

recovery_note() {
  printf '\nTo put %s back on the image it started with, by hand:\n  fly machine update %s --app %s --image %s --yes\n' \
    "$app" "$machine_id" "$app" "$current_image" >&2
}

printf 'step 1: rolling BACK to %s\n' "$to_image"
if ! fly machine update "$machine_id" --app "$app" --image "$to_image" --yes --wait-timeout "$WAIT_TIMEOUT"; then
  recovery_note
  die "the rollback update failed. The machine may be part way through; check 'fly machine status $machine_id --app $app'."
fi

if ! wait_ready 'on the previous image'; then
  recovery_note
  die "$app did not become ready on the previous image. THIS IS THE RESULT THE DRILL EXISTS TO FIND: the image you would roll back to does not serve traffic. Do not treat rollback as available until this is understood."
fi

printf '\nstep 2: rolling FORWARD to %s\n' "$current_image"
if ! fly machine update "$machine_id" --app "$app" --image "$current_image" --yes --wait-timeout "$WAIT_TIMEOUT"; then
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
final_image=$(fly machine list --app "$app" --json | jq -r '.[0].config.image // .[0].Config.image // empty')
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
