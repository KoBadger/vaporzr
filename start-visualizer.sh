#!/usr/bin/env bash
# Vaporzr visualizer — broadcast mode. POSIX counterpart to "Start Visualizer.cmd".
#
#   ./start-visualizer.sh
#   VAPORZR_WS=ws://localhost:4876/ws ./start-visualizer.sh   # override endpoint
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1
WS="${VAPORZR_WS:-wss://vaporzr.duckdns.org/ws}"

cat <<'BANNER'

  VAPORZR VISUALIZER - broadcast mode
  -----------------------------------
  A clean window will open (no borders, no cursor).

  Hover the mouse over it to reveal the controls,
  or press Esc to close it.

  Leave this terminal open while you use it.
  Closing it (or Ctrl-C) stops the visualizer.

BANNER

npm --prefix apps/player run broadcast -- --ws="$WS"
status=$?

echo
echo "  The visualizer has stopped."
exit "$status"
