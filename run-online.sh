#!/usr/bin/env bash
# The authoritative game server for online play.
#
#   ./run-online.sh          start it (or say so if it is already up)
#   ./run-online.sh stop     shut it down
#   ./run-online.sh restart  stop, then start
#   ./run-online.sh status   is it running, and where
#
# It serves the client as well, so this is the only thing that needs to be running: open
# http://localhost:8080/client/game.html, press "Host online…", and give the code to whoever
# else is playing. Single-screen play needs no server at all: just open client/game.html.
#
# A different port with PORT=9000 ./run-online.sh — and the same on the way back down, since
# stopping goes by port, not by a remembered process id that a reboot would invalidate.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
CMD="${1:-start}"
LOG=/tmp/frigate-online.log

up() { curl -sf "http://localhost:${PORT}/api/list" >/dev/null 2>&1; }

# Whichever node is serving this port, whether this script started it or not.
pids() { pgrep -f "game-server\.js ${PORT}\b" 2>/dev/null || true; }

stop_it() {
  local found
  found="$(pids)"
  if [ -z "$found" ]; then
    if up; then
      echo "Something is answering on port ${PORT}, but it is not this game server." >&2
      return 1
    fi
    echo "Not running on port ${PORT}."
    return 0
  fi
  # Ask first. A game in progress lives in memory, so a server that is given a moment to go
  # quietly is the difference between players seeing their stream close and seeing it hang.
  kill $found 2>/dev/null || true
  for _ in $(seq 1 25); do
    [ -z "$(pids)" ] && { echo "Stopped (was PID ${found})."; return 0; }
    sleep 0.2
  done
  kill -9 $(pids) 2>/dev/null || true
  echo "Stopped (had to force PID ${found})."
}

start_it() {
  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node is not installed." >&2
    echo "Install it, e.g.: apt-get install nodejs" >&2
    exit 1
  fi
  if up; then
    echo "Already running at http://localhost:${PORT}/client/game.html"
    exit 0
  fi

  # How long a seat is held once nobody is watching it. It counts absence, not thinking time.
  export FRIGATE_SEAT_TTL="${FRIGATE_SEAT_TTL:-60000}"

  nohup node "$APP_DIR/server/game-server.js" "$PORT" >"$LOG" 2>&1 &
  local pid=$!

  for _ in $(seq 1 30); do
    if up; then
      echo "Frigate online at http://localhost:${PORT}/client/game.html"
      echo "  others on your network: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}/client/game.html"
      echo "PID ${pid} — log: ${LOG}"
      echo "  stop it with: ./run-online.sh stop"
      exit 0
    fi
    sleep 0.2
  done

  echo "ERROR: server failed to start. See ${LOG}" >&2
  exit 1
}

case "$CMD" in
  start)   start_it ;;
  stop)    stop_it ;;
  restart) stop_it; start_it ;;
  status)
    if up; then
      echo "Running on port ${PORT} (PID $(pids | tr '\n' ' ')) — http://localhost:${PORT}/client/game.html"
    else
      echo "Not running on port ${PORT}."
      exit 1
    fi
    ;;
  *)
    echo "usage: $0 [start|stop|restart|status]" >&2
    exit 2
    ;;
esac
