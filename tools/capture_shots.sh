#!/usr/bin/env bash
# Render documentation screenshots of the REAL side panel via headless Chrome.
#
# Builds docs/demo.html (real markup + real CSS + real sidepanel.js driven by a realistic
# mid-game state), then captures the whole panel and each section to docs/img/*.png.
#
#   bash tools/capture_shots.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$ROOT/docs/img"
mkdir -p "$OUT"

node "$ROOT/tools/make_screenshots.js"

shoot() {           # shoot <name> <scene> <width> <height>
  local name="$1" scene="$2" w="$3" h="$4"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
            --virtual-time-budget=4000 --window-size="$w,$h" \
            --screenshot="$OUT/$name.png" \
            "file://$ROOT/docs/demo.html?scene=$scene" >/dev/null 2>&1
  echo "  $name.png  ($(du -h "$OUT/$name.png" | cut -f1))"
}

echo "capturing:"
shoot panel      full      400 981
shoot coach      coach     400 311
shoot setup      setup     400 600
shoot dice-odds  odds      400 239
shoot dice-dist  dist      400 196
shoot opponent   opponent  400 214
echo "done -> docs/img/"
