#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

if ! command -v php >/dev/null 2>&1; then
  echo "ERROR: php is not installed." >&2
  echo "Install it, e.g.: apt-get install php-cli" >&2
  exit 1
fi

if curl -sf "http://localhost:${PORT}/server/board.php?get" >/dev/null 2>&1; then
  echo "Already running at http://localhost:${PORT}/client/board.html"
  exit 0
fi

# The built-in server is single-threaded; live-update SSE connections stay
# open for the whole session, so run multiple workers so saves still get
# served. Linux/WSL only — PHP ignores this on Windows (dev there is
# single-threaded; production is nginx+Apache on Plesk, unaffected).
export PHP_CLI_SERVER_WORKERS="${PHP_CLI_SERVER_WORKERS:-6}"

nohup php -S "${HOST}:${PORT}" -t "$APP_DIR" >/tmp/frigate-server.log 2>&1 &
PID=$!

for i in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/server/board.php?get" >/dev/null 2>&1; then
    echo "Frigate running at http://localhost:${PORT}/client/board.html"
    echo "PID ${PID} — log: /tmp/frigate-server.log"
    exit 0
  fi
  sleep 0.2
done

echo "ERROR: server failed to start. See /tmp/frigate-server.log" >&2
exit 1