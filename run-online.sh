#!/usr/bin/env bash
# Start the authoritative game server for online play.
#
# It serves the client as well, so this is the only thing that needs to be running: open
# http://localhost:8080/client/game.html, press "Host online…", and give the code to whoever
# else is playing. run.sh stays as it is — that is the PHP battle map, a different thing.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed." >&2
  echo "Install it, e.g.: apt-get install nodejs" >&2
  exit 1
fi

if curl -sf "http://localhost:${PORT}/api/list" >/dev/null 2>&1; then
  echo "Already running at http://localhost:${PORT}/client/game.html"
  exit 0
fi

# How long a seat is held once nobody is watching it. It counts absence, not thinking time.
export FRIGATE_SEAT_TTL="${FRIGATE_SEAT_TTL:-60000}"

nohup node "$APP_DIR/server/game-server.js" "$PORT" >/tmp/frigate-online.log 2>&1 &
PID=$!

for i in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/api/list" >/dev/null 2>&1; then
    echo "Frigate online at http://localhost:${PORT}/client/game.html"
    echo "  others on your network: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}/client/game.html"
    echo "PID ${PID} — log: /tmp/frigate-online.log"
    exit 0
  fi
  sleep 0.2
done

echo "ERROR: server failed to start. See /tmp/frigate-online.log" >&2
exit 1
