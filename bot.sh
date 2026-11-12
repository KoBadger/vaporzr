#!/usr/bin/env bash
# Vaporzr bot process manager — POSIX (Linux + macOS) counterpart to bot.ps1.
#
#   ./bot.sh [start|stop|restart|status|logs]
#
# Same contract as bot.ps1: the authoritative "is it running?" signal is the
# listening socket on port 4876, never a stale pid file. Windows users keep
# using bot.ps1 / bot.bat.
set -uo pipefail

ACTION="${1:-start}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${VAPORZR_PORT:-4876}"
PID_FILE="$ROOT/bot.pid"
LOG_FILE="$ROOT/bot.log"
ERR_FILE="$ROOT/bot.log.err"

# ---------- helpers ----------
# PIDs listening on $PORT. Prefers lsof (macOS + most Linux), then ss, then fuser.
port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$PORT" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u
  elif command -v pgrep >/dev/null 2>&1; then
    # Last resort (no socket tooling): match the bot's entrypoint by command line.
    pgrep -f 'apps/bot/src/index\.ts' 2>/dev/null | sort -u
  fi
}

is_running() { [ -n "$(port_pids)" ]; }

rotate_log() {
  # Cap log sizes: rotate an oversized log to a single .old backup.
  local limit=$((5 * 1024 * 1024))
  for f in "$LOG_FILE" "$ERR_FILE"; do
    if [ -f "$f" ]; then
      local size
      size=$(wc -c <"$f" 2>/dev/null | tr -d ' ')
      if [ -n "$size" ] && [ "$size" -gt "$limit" ]; then
        [ -f "$f.old" ] && mv -f "$f.old" "$f.old2" 2>/dev/null
        mv -f "$f" "$f.old" 2>/dev/null
      fi
    fi
  done
}

start_bot() {
  if is_running; then
    echo "Vaporzr bot is already running (port $PORT)."
    return 0
  fi
  rotate_log
  if [ ! -f "$ROOT/node_modules/tsx/dist/cli.mjs" ]; then
    echo "missing $ROOT/node_modules/tsx — run: npm install" >&2
    return 1
  fi
  # Detach so the process survives the shell that launched it. setsid gives a
  # new session/process group where available (Linux, and macOS via util-linux);
  # nohup + disown is the portable fallback.
  local launcher=(node "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/apps/bot/src/index.ts")
  if command -v setsid >/dev/null 2>&1; then
    ( cd "$ROOT/apps/bot" && setsid "${launcher[@]}" >>"$LOG_FILE" 2>>"$ERR_FILE" </dev/null & )
  else
    ( cd "$ROOT/apps/bot" && nohup "${launcher[@]}" >>"$LOG_FILE" 2>>"$ERR_FILE" </dev/null & )
  fi
  disown 2>/dev/null || true
  echo "Vaporzr bot starting (hidden, logs: bot.log / bot.log.err)."
  local pids="" i
  for i in $(seq 1 20); do
    pids="$(port_pids)"
    [ -n "$pids" ] && break
    sleep 1
  done
  if [ -n "$pids" ]; then
    echo "$(echo "$pids" | head -n1)" >"$PID_FILE"
    echo "Vaporzr bot is online (PID $(cat "$PID_FILE"))."
  else
    echo "Started; waiting for it to come online... (check bot.log.err)"
  fi
}

stop_bot() {
  local killed=0 pid
  for pid in $(port_pids); do
    [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null || continue
    kill -TERM "$pid" 2>/dev/null && killed=1
  done
  # Give them a moment, then force anything still bound to the port.
  sleep 2
  for pid in $(port_pids); do
    [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null
  done
  # Librespot bridge + player helpers (same targets bot.ps1 kills).
  pkill -f 'bridge\.cjs' 2>/dev/null
  pkill -f 'librespot' 2>/dev/null
  rm -f "$PID_FILE"
  if [ "$killed" = 1 ]; then echo "Vaporzr bot stopped."; else echo "Vaporzr bot was not running."; fi
}

show_status() {
  if is_running; then
    echo "Vaporzr bot: RUNNING"
    local pid
    for pid in $(port_pids); do echo "  PID $pid listening on $PORT"; done
    if [ -f "$LOG_FILE" ]; then
      echo "--- last log lines ---"
      tail -n 6 "$LOG_FILE"
    fi
  else
    echo "Vaporzr bot: NOT RUNNING"
  fi
}

show_logs() {
  if [ -f "$LOG_FILE" ]; then
    echo "=== bot.log (tail) ==="
    tail -n 30 "$LOG_FILE"
  fi
  if [ -f "$ERR_FILE" ]; then
    echo "=== bot.log.err (tail) ==="
    tail -n 15 "$ERR_FILE"
  fi
}

case "$ACTION" in
  start)   start_bot ;;
  stop)    stop_bot ;;
  restart) stop_bot; sleep 2; start_bot ;;
  status)  show_status ;;
  logs)    show_logs ;;
  *) echo "usage: $0 [start|stop|restart|status|logs]" >&2; exit 2 ;;
esac
