# Frigate Board — SSE Live Updates Design

Date: 2026-09-12
Status: Validated (design approved by owner)

## Goal

Give every board browser **live updates** — when one player creates, moves, counts,
pings, or resizes, all other browsers see it within ~1 second **without polling** and
without needing Refresh/Save clicks. This supersedes the *"clients poll `board.php?get`
every ~500 ms"* model in the 2026-09-05 design, which was disabled in production because
the host's anti-DDoS protection rate-limits per-IP request bursts (500 ms polling from
multiple tabs flagged as an attack and blocked the owner for 10 minutes).

## Hosting facts (verified)

- Server: nginx in front of Apache PHP, Plesk Linux shared hosting.
- PHP 7.4.33; folder `RaisSoftware/frigate/` is writable.
- Multi-process PHP (Apache worker pool) → a streaming PHP request does **not** block
  other requests. This is the whole reason SSE is viable here; the dev `php -S` server is
  single-threaded and would stall (mitigated in dev via `PHP_CLI_SERVER_WORKERS`).

## Architecture

- **One shared board, no rooms/lobbies** (unchanged). `board.php` remains the **single
  writer** of `board-state.json`; saves still POST the exact same batched actions.
- **Push, not poll.** Each client opens one long-lived SSE connection to
  `board.php?stream`. The stream **carries the full board state** as its event data:
  on connect it sends the current state, and every time the state file changes it
  re-sends the whole state, which clients `applyServer` directly. There is **no**
  per-change `?get` anymore — the only HTTP requests in the whole loop are the save
  POSTs themselves, so traffic scales with actual editing, not time.
- **No new processes, ports, or TLS.** SSE is a plain HTTP response on the same origin —
  nothing to deploy, no proxy rules, works in every modern browser via `EventSource`.
- **Graceful degradation.** If SSE fails (proxy buffering, forced timeouts, network
  drop), `EventSource` auto-reconnects (each reconnect re-receives the full state, so
  nothing is missed); if it stays closed, the client falls back to a slow safe poll
  (~10 s) — or the manual Save/Refresh buttons — so behavior is never worse than today.

## SSE wire format

```
> GET /server/board.php?stream
< 200, Content-Type: text/event-stream
< Cache-Control: no-cache
< X-Accel-Buffering: no
< data: {"rev":7,"grid":{...},"pieces":[...],"chips":[...],"pings":{...}}\n\n
<      # on connect AND on every change: full state JSON, single line
< : ping\n\n               # heartbeat every ~15 s so proxies don't idle-close
```

The event data **is** the state. Clients parse it and `applyServer` immediately; they
skip an event whose `rev` is ≤ the last rev they already applied (their own save echoes
back through the stream, and they already have that state from the POST response).
`JSON_UNESCAPED_SLASHES`-style single-line JSON means an SSE `data:` line never splits.

## Server (server/board.php)

New GET mode `?stream` handled before the normal logic:

1. `header('Content-Type: text/event-stream')`, `Cache-Control: no-cache`,
   `X-Accel-Buffering: no`, `ob_implicit_flush(true)`.
2. `set_time_limit(0)` (best effort — some shared hosts forbid it; the client's
   reconnect + fallback covers forced timeouts).
3. On connect: read `board-state.json`, emit `data: <raw state>`.
4. Loop every ~500 ms:
   - `clearstatcache()` then re-read the file's raw content; if it differs from the last
     sent content, emit `data: <new raw state>`. Comparing **content**, not mtime,
     means rapid same-second saves are never missed.
   - Heartbeat `: ping` every ~15 s.
   - `connection_aborted()` → break (releases the worker).
5. No locking, no writes — the stream only ever reads the file, so it cannot conflict
   with save writers.

Reconnect safety: each connection immediately re-receives the full current state, so a
missed event during a gap is harmless.

## Client (client/board.html)

- Globals: `sseEl`, `sseFallbackTimer`, `refreshBusy`, `refreshQueued`.
- `initSse()` (skipped on Windows dev — the single-threaded `php -S` would stall; the
  client slow-polls instead):
  - `new EventSource('../server/board.php?stream&_=' + Date.now())`.
  - `onopen` → `stopSlowPoll()` (no refresh — the first stream event is the current state).
  - `onmessage`: `JSON.parse(ev.data)`; skip if it has no numeric `rev`, if there are
    unsaved edits pending, or if `d.rev <= state.rev` (own echo); otherwise
    `applyServer(d)`.
  - `onerror`: only when `readyState === EventSource.CLOSED` → `startSlowPoll()`.
- `startSlowPoll()`: fallback `setInterval(scheduleRefresh, 10000)` — a single tab at
  10 s is far below any anti-DDoS threshold; only engages if SSE stays down.
- `scheduleRefresh()`/`doRefresh()`: still used by the manual REFRESH button, the slow
  poll, page load, and `visibilitychange` catch-up; busy/queued guard prevents stacking
  GETs and never clobbers unsaved edits.
- Saving on ping: middle-click ping queues the `pg:` action **and calls `saveChanges()`**
  so a ping reaches everyone immediately via the SSE push. General auto-save stays off.
- Manual Refresh/Save buttons remain (explicit control + fallback).

## Dev server (run.sh)

`php -S` is single-threaded, so one open SSE connection would block every other request.
Start it with worker processes so saves and streams run concurrently:

```sh
export PHP_CLI_SERVER_WORKERS="${PHP_CLI_SERVER_WORKERS:-6}"
nohup php -S "${HOST}:${PORT}" -t "$APP_DIR" ...
```

**Linux/WSL only** — `PHP_CLI_SERVER_WORKERS` is a no-op on Windows, where `php -S` stays
single-threaded and an open stream blocks saves. The client deliberately bypasses SSE on
Windows (UA check) and slow-polls instead, so local dev stays usable; production Plesk
(nginx → Apache PHP) is multi-process and unaffected. Production nginx/Apache needs no
change.

## Testing

- `php -l server/board.php`; `node --check` on the extracted inline script.
- E2E (temp copy of `board.php` + `php -S`):
  - connect an SSE stream with `curl -N` to a file;
  - confirm the first event is `data: {…state JSON…}` reflecting the file's rev;
  - overwrite `board-state.json` with a new rev (as a real save would) and confirm the
    stream re-emits the full new state, and emits nothing while idle afterwards;
  - a save POST while no stream is open still works (`?get` baseline proves the
    non-stream path is unchanged).
- Full stream + save concurrency is a property of the multi-process Plesk server;
  reproducible locally on Linux/WSL with `PHP_CLI_SERVER_WORKERS`.

## Files touched

- `server/board.php` — add `?stream` mode (full-state SSE push).
- `client/board.html` — EventSource wiring (apply pushed state directly, rev self-echo
  skip, slow-poll fallback), save-on-ping.
- `run.sh` — `PHP_CLI_SERVER_WORKERS` for dev concurrency.
