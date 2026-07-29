#!/usr/bin/env bash
#
# Re-export the system overview diagram from SPEC/TECH/17-diagrams.md.
#
# The Mermaid source in SPEC/TECH/17-diagrams.md is authoritative. The exported
# image is a convenience for viewers that do not render Mermaid, and it goes
# stale the moment the source changes. Run this in the same change as any edit
# to the first diagram block.
#
# Usage:  ./scripts/render-diagrams.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/SPEC/TECH/17-diagrams.md"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BG='#141414'
WIDTH=2600

# Use the system Chrome if present. Otherwise let puppeteer resolve its own,
# which means a large first-run download.
for CANDIDATE in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "$(command -v google-chrome || true)" \
  "$(command -v chromium || true)"
do
  if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ]; then
    export PUPPETEER_EXECUTABLE_PATH="$CANDIDATE"
    echo "using browser: $CANDIDATE"
    break
  fi
done

echo '{"args":["--no-sandbox"]}' > "$TMP/puppeteer.json"

# Extract the first fenced mermaid block: the system overview.
node -e '
  const fs = require("fs");
  const src = fs.readFileSync(process.argv[1], "utf8");
  const blocks = [...src.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(m => m[1]);
  if (!blocks.length) { console.error("no mermaid blocks found"); process.exit(1); }
  fs.writeFileSync(process.argv[2], blocks[0]);
  console.error(`extracted system overview (${blocks[0].split("\n").length} lines)`);
' "$SRC" "$TMP/system-overview.mmd"

for FMT in png svg; do
  npx --yes @mermaid-js/mermaid-cli \
    -i "$TMP/system-overview.mmd" \
    -o "$ROOT/SPEC/TECH/assets/system-overview.$FMT" \
    -p "$TMP/puppeteer.json" \
    -b "$BG" \
    -w "$WIDTH" \
    ${FMT:+$([ "$FMT" = png ] && echo "-s 2")} >/dev/null
  echo "wrote SPEC/TECH/assets/system-overview.$FMT"
done

# Guard against silently shipping an empty render.
for FMT in png svg; do
  if [ ! -s "$ROOT/SPEC/TECH/assets/system-overview.$FMT" ]; then
    echo "ERROR: SPEC/TECH/assets/system-overview.$FMT is empty" >&2
    exit 1
  fi
done

echo "done"
