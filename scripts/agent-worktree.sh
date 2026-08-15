#!/usr/bin/env bash
#
# One command that gives an agent a working tree of its own, on its own branch, with its own ports.
#
#   ./scripts/agent-worktree.sh moderation
#
# Why this exists rather than four commands in a document. Several agents work on this repo at
# once, and when they share ONE directory a collision is SILENT: on 2026-08-15 two of them edited
# `apps/mobile/src/api-types.ts` in the same afternoon, and whichever committed first would have
# taken the other's unfinished work into its commit with no error, no marker and nothing to
# review. On separate branches that same collision is a merge conflict, which stops you and shows
# you both sides. A conflict is the GOOD outcome here. See AGENTS.md section 2.5.
#
# WATCH OUT for the trap this script exists to make unmissable: **do not symlink `node_modules`
# into a worktree.** The workspace links inside it are relative, so `node_modules/@clubchat/shared`
# resolves back to the ORIGINAL tree - and you then typecheck your code against whatever another
# agent has half-written in `packages/shared`. That produced a phantom error in `worker/audience.ts`,
# a file nobody had touched. `npm install` is slower and correct.
#
# Ports are assigned rather than discovered, because two stacks on one port do not fail loudly
# either: `npm run dev:api` exits with EADDRINUSE and the tests then pass against whatever OLD
# process still owns the port. The founder keeps 3000/3001/8081; this hands out 3100/3101/8082,
# then 3200/3201/8083, and so on.
set -euo pipefail

name=${1:-}
if [[ -z $name || ! $name =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "usage: ./scripts/agent-worktree.sh <name>   (lower case, digits and dashes)" >&2
  exit 2
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target="$(dirname "$root")/ClubChat-$name"

if [[ -e $target ]]; then
  echo "$target already exists. Pick another name, or remove it with:" >&2
  echo "  git worktree remove $target" >&2
  exit 1
fi

# The lowest slot whose three ports are all free. Slot 0 is the founder's own stack and is never
# handed out, so an agent can never take the ports the phone is pointed at.
free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }
slot=0
for candidate in 1 2 3 4 5 6 7 8; do
  if free $((3000 + candidate * 100)) && free $((3001 + candidate * 100)) && free $((8081 + candidate)); then
    slot=$candidate
    break
  fi
done
if [[ $slot -eq 0 ]]; then
  echo "no free port slot between 3100 and 3800. Something is still listening from a dead session:" >&2
  echo "  lsof -nP -iTCP:3100 -sTCP:LISTEN" >&2
  exit 1
fi

api=$((3000 + slot * 100))
gateway=$((3001 + slot * 100))
expo=$((8081 + slot))

echo "==> worktree $target on branch $name"
git -C "$root" worktree add "$target" -b "$name"

# Never a symlink. See the header.
echo "==> npm install (a few minutes, and it is not optional - see the header)"
(cd "$target" && npm install)

cat <<INFO

Ready. Hand the agent this:

  Work in $target, on branch $name. It is your own worktree, so
  nothing you do there can disturb the other agents and you may commit freely.

  Your ports are API $api, gateway $gateway, Expo $expo. Start servers with all
  three set, or you will serve the wrong client and the app will report itself offline:

    cd packages/server
    API_PORT=$api CLIENT_ORIGIN=http://localhost:$expo npm run dev:api
    GATEWAY_PORT=$gateway npm run dev:gateway
    npm run dev:worker

  You do NOT have the founder's phone or the dev database on 3000/3001/8081. Verify with
  \`npm run typecheck && npm test\` - the handler tests start their own throwaway containers,
  so they need nothing shared. Ask before taking the running stack or the device.

  When you are done: commit on your branch, then

    git fetch origin && git rebase origin/main   # safe here, this tree is yours alone
    git push -u origin $name

  Read AGENTS.md section 2.5 before your first commit.

INFO
