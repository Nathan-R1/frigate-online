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
  `board.php?stream`. When the state file changes, every streaming response emits a
  `changed` event. Clients then perform *one* normal `?get` refresh (the existing Refresh
  routine) and `applyServer`. One connection + occasional GETs stay far below any
  rate-limit threshold.
- **No new processes, ports, or TLS.** SSE is a plain HTTP response on the same origin —
  nothing to deploy, no proxy rules, works in every modern browser via `EventSource`.
- **Graceful degradation.** If SSE fails (proxy buffering, forced timeouts, network
  drop), `EventSource` auto-reconnects; if it stays closed, the client falls back to a
  slow safe poll (~10 s) — or the manual Save/Refresh buttons — so behavior is never
  worse than today.

## SSE wire format

```
> GET /server/board.php?stream
< 200, Content-Type: text/event-stream
< Cache-Control: no-cache
< X-Accel-Buffering: no
< data: hello\n\n          # on connect — client does one baseline refresh
< data: changed\n\n        # every time board-state.json's mtime changes
< : ping\n\n               # heartbeat every ~15 s so proxies don't idle-close
```

The stream carries **no state payload** — it is purely a "go fetch" signal. The client's
existing `?get` + `applyServer` path (mtime/rev reconciliation) does the data transfer,
so refresh semantics and the first-write-wins merge from this branch apply unchanged.

## Server (server/board.php)

New GET mode `?stream` handled before the normal logic:

1. `header('Content-Type: text/event-stream')`, `Cache-Control: no-cache`,
   `X-Accel-Buffering: no`, `ob_implicit_flush(true)`.
2. `set_time_limit(0)` (best effort — some shared hosts forbid it; the client's
   reconnect + fallback covers forced timeouts).
3. Emit `data: hello`, then loop:
   - Every ~250 ms `clearstatcache()` and `stat()` the state file's mtime.
   - If mtime changed since last seen → emit `data: changed`.
   - Heartbeat `: ping` every ~15 s.
   - `connection_aborted()` → break (releases the worker).
   - `usleep(250000)` between ticks. `usleep` on Linux does not consume the connection;
     nginx keeps it open.
4. No locking, no writes — the stream only ever reads file metadata, so it cannot
   conflict with save writers.

Reconnect safety: on reconnect the client always does one baseline refresh, so a missed
`changed` event during a gap is harmless.

## Client (client/board.html)

- New globals: `sseEl`, `sseFallbackTimer`, `refreshBusy`, `refreshQueued`.
- `initSse()`:
  - `new EventSource('server/board.php?stream')`.
  - `onopen` → one baseline `scheduleRefresh()`.
  - `onmessage`: `data === 'changed'` → `scheduleRefresh()`.
  - `onerror`: only when `readyState === EventSource.CLOSED` → `startSlowPoll()`.
- `scheduleRefresh()`: if a refresh is in flight, mark `refreshQueued` and return;
  otherwise `refresh()`. After each `refresh()` completes, run again if queued. This both
  debounces bursts of `changed` events and never stacks parallel GETs.
- `startSlowPoll()`: fallback `setInterval(scheduleRefresh, 10000)` — a single tab at
  10 s is far below any anti-DDoS threshold; only engages if SSE stays down, and is
  cleared if the EventSource reconnects (`onopen` clears it).
- Lock-on-tab-visible: `refresh()` already skips when the tab is hidden (`document.hidden`
  guard exists); on `visibilitychange` to visible, one refresh catches up.
- Manual Refresh/Save buttons remain (explicit control + fallback).

## Dev server (run.sh)

`php -S` is single-threaded, so one open SSE connection would block every other request.
Start it with worker processes so saves and streams run concurrently:

```sh
export PHP_CLI_SERVER_WORKERS="${PHP_CLI_SERVER_WORKERS:-6}"
nohup php -S "${HOST}:${PORT}" -t "$APP_DIR" ...
```

**Linux/WSL only** — `PHP_CLI_SERVER_WORKERS` is a no-op on Windows, where `php -S` stays
single-threaded and an open stream blocks saves. That is acceptable for dev: production
(Plesk nginx → Apache PHP) is multi-process and unaffected, and SSE is exercised before
deploy via the mtime-touch test below. Production nginx/Apache needs no change.

## Testing

- `php -l server/board.php`; `node --check` on the extracted inline script.
- E2E (temp copy of `board.php` + `php -S`):
  - connect an SSE stream with `curl -N` to a file;
  - confirm `data: hello` arrives on connect;
  - bump `board-state.json`'s mtime (as a real save would) and confirm exactly one
    `data: changed` per bump, and none while idle;
  - a save POST while no stream is open still works (`?get` baseline proves the
    non-stream path is unchanged).
- Full stream + save concurrency is a property of the multi-process Plesk server;
  reproducible locally on Linux/WSL with `PHP_CLI_SERVER_WORKERS`.

## Files touched

- `server/board.php` — add `?stream` mode.
- `client/board.html` — EventSource wiring, refresh debounce, slow-poll fallback.
- `run.sh` — `PHP_CLI_SERVER_WORKERS` for dev concurrency.