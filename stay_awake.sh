#!/usr/bin/env bash
# Keep this machine reachable so the Vaporzr bot + tunnel links stay alive.
# POSIX counterpart to stay_awake.ps1.
#
#   ./stay_awake.sh            # hold an inhibitor (foreground; Ctrl-C releases it)
#   ./stay_awake.sh --check    # report what would be inhibited; always exits 0
#
# The Windows script *pins persistent AC power settings* (survives reboot).
# Neither macOS nor Linux exposes a clean per-user equivalent, so this instead
# holds a sleep inhibitor for as long as it runs. To make it permanent, run it
# as a service (macOS: a LaunchAgent; Linux: a systemd --user unit) so it is
# re-established on every login.
set -uo pipefail

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1
REASON="Vaporzr bot + tunnels stay awake"
OS="$(uname -s)"

case "$OS" in
  Darwin)
    # -i: no idle sleep, -s: no system sleep while on AC power.
    CMD=(caffeinate -i -s)
    ;;
  Linux)
    CMD=(systemd-inhibit --what=idle:sleep --mode=block --why="$REASON" sleep infinity)
    ;;
  *)
    if [ "$CHECK" = 1 ]; then
      echo "[check] unsupported platform: $OS (on Windows use stay_awake.ps1)"
      exit 0
    fi
    echo "Unsupported platform: $OS. On Windows use stay_awake.ps1." >&2
    exit 1
    ;;
esac

if [ "$CHECK" = 1 ]; then
  echo "[check] platform: $OS"
  if command -v "${CMD[0]}" >/dev/null 2>&1; then
    echo "[check] would run: ${CMD[*]}"
  else
    echo "[check] '${CMD[0]}' not found — install systemd/libsystemd (Linux), or use 'caffeine'"
  fi
  exit 0
fi

if ! command -v "${CMD[0]}" >/dev/null 2>&1; then
  echo "'${CMD[0]}' not found." >&2
  [ "$OS" = Linux ] && echo "  options: install systemd, use 'caffeine' (GNOME/KDE), or set HandleLidSwitch=ignore in logind.conf" >&2
  exit 1
fi

echo "=== Vaporzr stay-awake ($OS) ==="
echo "Holding sleep inhibitor. Press Ctrl-C to release."
echo "  command: ${CMD[*]}"
exec "${CMD[@]}"
