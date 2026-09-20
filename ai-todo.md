# Pre-deploy review — outstanding work

A three-part review of `e45ce03` (networking, storage, rules) found **19 defects**. Two corrupt
game state, two lose data. The rules findings were verified by running the engine, not by
reading it, so each has a reproduction.

**Not ready to deploy.** Several defects are interactions between changes that are each correct
alone: stream tickets live in memory while seats are persisted; the host now arrives as a
watcher while open games are publicly listed; mines can now attack while the queue still refuses
to drain during movement.

---

## P0 — corruption and data loss

- [ ] **1. `removeSelf` vacates the square the overrunning module now stands on.**
  `shared/engine.js:1286-1290`. `moveModule` vacates the mine's cell then `occupy()`s it with
  the mover; the queued `removeSelf` later calls `vacate(d.x, d.y)` on the *mover's*
  coordinates. Verified: `Cannon at 6,12  Core at 6,12` — two modules on one square. The cell
  stops blocking line of sight (`lineBlocked` reads `cellAt`), a second piece can be placed
  there, and a later `vacate` of the true occupant is a no-op. Fires on the mainline path: any
  module overrunning any mine.
  **Fix:** vacate only when the cell still refers to this deployable — `var c = cellAt(d.x,
  d.y); if (c && c.id === d.id) vacate(...)`. Apply the same guard anywhere a *delayed* removal
  vacates.

- [ ] **2. A game that ends mid-blast can never be saved again.**
  `shared/engine.js:537` (`!G.over` in the `step()` guard) and `:394-397` (`endTurn` returns
  before clearing). An `auto` AoE enqueues one `__shot` per target; if an early shot kills the
  last Core, `G.over` is set, `step()` bails, and the rest stay queued. Verified: `queue length:
  2, settled(): false, save(): null` — permanently. The finished game is never persisted.
  **Fix:** when `checkWin()` declares a winner, clear `G.queue` and `G.pending`. Nothing queued
  can matter once the game is over, and `settled()` must become true.

- [ ] **3. A restart strands every seated player, permanently.**
  Tickets are memory-only (`server/game-server.js:514`); seats persist. `wire()`'s `es.onerror`
  (`client/game/net.js:370`) only logs, so the browser retries the *same dead ticket*; the server
  attaches the stream as a watcher and pushes `seat: null`; the client's branch at
  `client/game/net.js:350-355` concludes the seat was freed and calls `forget(ST.room)`,
  destroying the only copy of the token. The seat is still held server-side, so `/api/claim`
  answers 409 — and if that player was the leader, nobody can kick the seat either.
  **Fix**, all in `client/game/net.js`:
  - record whether the live stream carried a ticket, and gate the demote-to-watcher branch on
    it — `seat: null` without a ticket means *unauthenticated*, not *evicted*
  - reconnect from `es.onerror` by calling `connect()` so a fresh ticket is minted; backoff
    1s→15s, reset on a good message, relying on the existing `gen` guard
  - in `release()` (`:271-273`) keep the token until the server confirms, and give the caller at
    `client/game.html:3066` the rejection branch it lacks

- [ ] **4. An unvalidated `seq` poisons every Postgres write for a room.**
  `server/game-server.js:1239` accepts any `typeof === 'number'`; `server/store.js:214` declares
  `last_seq integer`. A float or a value above 2³¹ makes every later `_writeSeats` raise *value
  out of range*, and because seats share a transaction with the `games` UPDATE the whole save
  rolls back — then retries every 500 ms forever. The FileStore accepts it happily, so it never
  reproduces locally.
  **Fix:** accept only `Number.isInteger(seq) && seq >= 0 && seq <= 2147483647`; otherwise 400.

---

## P1 — wrong in play

- [ ] **5. The AI flies its own modules off the hull and destroys them.**
  `shared/ai/ai-commander.js:327-355`. `answer()` routes *every* `moveObject` prompt to
  `flyObject`, which closes on the nearest enemy — but the engine opens that same prompt kind
  for `what:'ownModule'` (Recycle Jet) and for enemy pieces on a beam (Tract Beam, Tug Craft).
  Verified: `gun at 9,13  meetsReq=false … breaks apart`.
  **Fix:** use `flyObject` only when `p.objId` is a deployable the AI owns; answer `null`
  otherwise. A smarter policy for shoving enemies can come later — flying your own hull off the
  ship must stop now.

- [ ] **6. A mine does not hit whoever ran it over.**
  `shared/engine.js:1552`, `:1562`, `:536`. `moveModule` fires the passive then calls `step()`,
  but `step()` opens with `while (!G.pending…)` and the `kind:'move'` prompt is always open
  during movement — so the blast waits in the queue until **Done**, then resolves from the
  mine's old square against whoever is standing there now. The comment at `:1559-1561` asserts
  the opposite.
  **Fix:** drain the detonation at overrun time — lift the move prompt, `step()`, restore it
  unless the drain opened its own. Combine with the empty-blast fix below so a blast with no
  targets never prompts. Careful: `prompt()` overwrites rather than stacks (`:547`), and the
  move prompt's `onResolve` is the only thing that zeroes `moveLeft`.

- [ ] **7. A mine can detonate twice.**
  `shared/engine.js:477-490`. `fire()` runs while the mine is still listed and `removeSelf` is
  queued behind the shots, so a mine destroyed mid-detonation is found again by
  `passiveHolders`. Verified at seed 4: `A passive — Fusion Mine` twice, damage dealt twice.
  **Fix:** remove the deployable from `s.deployables` before firing, keeping the object
  reference in the payload; or set a `firing` flag `passiveHolders` skips.

- [ ] **8. Moving seats leaves your ship behind and hands it to a stranger.**
  `server/game-server.js:1058-1065` carries `tokenHash`, `away`, `lastSeq`, `joinedAt` — but not
  `setup` or `name`. You fly whatever the new chair was built with, your build stays on the old
  seat, and whoever claims it inherits and can read it through `/api/seat-setup`, contradicting
  that endpoint's own comment.
  **Fix:** move `setup` and `name` with the token; clear them on the vacated seat.

- [ ] **9. `?room=CODE` invite links are broken.**
  `server/game-server.js:821` redirects `/` to a literal `/client/game.html`, dropping the
  query; `client/game.html:3100` reads the code from `location.search`. A regression from
  `f5b2e7c` — the feature now works only in the long URL form, which nothing in the UI produces.
  **Fix:** carry the query through, but only when it matches the room-code shape
  (`/^\?room=[A-Z0-9]{6}$/i`), so nothing from the request line reaches a response header.

- [ ] **10. Returning from the sheet builder shows the Local game screen in an online lobby.**
  `CAME_BACK` may be an object `{lobby, seat}` (`client/game.html:730`), and `:3383` passes it to
  `openSetup(mode)`, which tests `mode === 'online'`.
  **Fix:** only call `openSetup` for the string forms; the object case is already handled at
  `:3103`.

---

## P2 — correctness

- [ ] `lastSeq` not reset on plain reclaim (`server/game-server.js:1061-1066`) — after a reload
  the client's `ST.seq` restarts at 0, so the first N commands return `duplicate:true` and are
  **silently swallowed**. Reset it, as the seat-move path already does.
- [ ] `FRIGATE_TRUST_PROXY=0` / `false` / `no` all mean **on** (`:613-615`). Accept
  `/^(off|0|false|no)$/i` as off.
- [ ] No guard against Render with no database (`server/store.js:401`) — silently uses the
  ephemeral file store and loses every game each deploy. Refuse to start when `RENDER` is set
  and `DATABASE_URL` is not; `FRIGATE_ALLOW_EPHEMERAL=on` as the escape.
- [ ] `walkRoute` reports success when every step was refused (after the `break`). Count applied
  steps; refuse when zero. A *partial* walk stays a success.
- [ ] Version conflict deletes a room without closing its streams (`:372-374`) — clients keep a
  frozen board and the subs leak against `MAX_SUBS_TOTAL`. End the streams first, as
  `evictOverflow()` does.
- [ ] TTL sweep can never reach old rooms (`server/store.js:359`, `ORDER BY updated DESC LIMIT
  500`) — and it is now **on by default** at 7 days (`server/game-server.js:82-84`). Give the
  store a `listStale(cutoff)` with `WHERE updated < cutoff` rather than paging the newest.
- [ ] `includeSelf:true` does not exhaust the Quantum Disrupter (`shared/engine.js:1138-1143`) —
  `exhaustPool` stops excluding self but then picks by insertion order, so a QD built after other
  guns is never chosen. The card text says otherwise. Prefer self when `includeSelf`.
- [ ] Log lines from passive-triggered attacks are coloured by the active side, not the side they
  are about (`shared/engine.js:851`, `:865`, `:1289`, `:1550`). Pass the owning side.
- [ ] A refused seat move is reported as success (`:1052` falls through to the reload branch).
  409 when the game has started.
- [ ] An empty `auto` blast still opens an interactive prompt and parks it on the **wrong
  player** — `shared/engine.js:756-766` runs before the `o.auto` check at `:775`. Move the
  empty-target return inside the non-`auto` branch.
- [ ] `dealtDamage` credits `side()` rather than the attacker (`:465-467`), so a mine belonging
  to B firing on A's turn triggers **A's** Target Locking.

---

## Open games: an unlisted flag

`/api/open` is unauthenticated and lists in-progress games as well as lobbies. Combined with the
host now arriving as a watcher, there is a window between `/api/create` and the host's first
claim where every seat is free and the room sorts first — so a poller can take seat 0, become
leader by earliest `joinedAt`, and kick the real host.

- [ ] `/api/create` accepts `unlisted: true`; store `listed` on the room. The server comment at
  `server/game-server.js:962-963` already names this as the place.
- [ ] `listOpenRooms` filters on it, in both drivers.
- [ ] A checkbox on the host screen, defaulting to listed.
- [ ] Suppress rooms with no seat taken — closes the leader race without removing the feature,
  since an unadvertised room is still reachable by code, which is how the host joins it.
- [ ] Schema: `ALTER TABLE games ADD COLUMN IF NOT EXISTS listed boolean NOT NULL DEFAULT true`.
  `games` has no ALTER path today (only `game_seats` does, `server/store.js:221`) — add one now
  rather than at the first migration that cannot wait.

---

## Documentation

- [ ] **README** — `FRIGATE_RATE_CAP` default is 240, not 120; `/api/ticket` costs 2 and is
  missing from the cost list; state which values disable `FRIGATE_TRUST_PROXY`; name `RENDER`,
  which the code reads and nothing documents. Soften the dice claim: the generator is identical
  across a restore, but the AI commander's `brains` (`shared/ai/ai-commander.js:12`) is module
  state holding function references, is never saved, and starts empty — so a computer seat
  rethinks its plan.
- [ ] **`shared/engine.js`** — `restore()`'s comment claims an undo point "belongs to an
  activation that is over"; it can be open at save time, so Undo silently disappears after a
  restart.
- [ ] **`shared/ai/ai-knowledge.js:115-117`** — still says `onHit`; the key is now `onSuccess`.
- [ ] **`server/game-server.js:560-562`** — `autoSeat`'s comment says a human seat is never
  played by a stand-in, which `/api/seatkind` now lets the leader do mid-game. Correct the
  comment, or gate the human→computer direction on `status === 'lobby'`.
- [ ] **`render.yaml`** — the `region: singapore` comment and the header note contradict each
  other about which side should move.

---

## Verification

**Repair the harness first.** `net1`, `net5`, `net6` and `cors` still open streams the
pre-ticket way (`?token=`), and the server now silently demotes them to watchers rather than
refusing — so they report misleading results instead of failing. Make them POST `/api/ticket`
first. Delete `net2`: it tests the presence timeout that no longer exists. The six jsdom tests
go through the real `net.js` and are already correct.

Scratchpad:
`/tmp/claude-1000/-home-nathrais-other-fonline/d1441e5e-0459-42fa-a8bf-be9f63d0cc9b/scratchpad`

**Reproduce before fixing** — each of these was observed during the review:

| | Reproduction |
|---|---|
| 1 | Overrun a mine, then check `G.cells` for that square: two module ids, one cell |
| 2 | An AoE whose first shot ends the game → `settled()` false, `save()` null, forever |
| 3 | Two browsers, `SIGTERM`, restart: before, both lose their seats irrecoverably |
| 4 | `POST /api/cmd {seq: 2147483648}` against **Postgres**, then watch saves fail in a loop |
| 5 | AI seat with Recycle Jet: a module walks off the hull and breaks apart |
| 6 | Drive over a mine and keep going — the blast lands at Done, on the wrong square |
| 7 | Two opposing mines in range: `A passive — Fusion Mine` twice (seed 4) |
| 8 | Claim seat 0, build a ship, move to seat 2 — you fly seat 2's build |
| 9 | Open `/?room=ABC123` — lands on the New Game menu instead of joining |
| 10 | Edit a ship from an online lobby — the Local game screen appears |

**Then the full suite**, on both stores. Postgres needs a real database:

```bash
docker run -d --name frigate-pg -e POSTGRES_PASSWORD=frigate -e POSTGRES_DB=frigate \
  -p 55432:5432 postgres:16-alpine

node tools/validate-effects.js
node <scratchpad>/rng.js       # seeded dice, save/restore identical, refuses mid-prompt
node <scratchpad>/durable.js   # SIGTERM and SIGKILL survival; then again with DATABASE_URL
node <scratchpad>/leader.js    # leader election and kick permissions
node <scratchpad>/net3.js net4.js net7.js kick.js debugsafe.js
node <scratchpad>/sweep2.js 12 # AI sanity: medians 15-40 turns, zero formation breaks
```

`sweep2` is the regression test for fix 5 — an AI that destroys its own modules shows up as
formation breaks.

Two operational notes that have already cost time: space the browser suites, because
`/api/create` costs 30 of 240 rate-limit credits and four back to back trip the limiter for
reasons unrelated to the change; and kill servers **by port** (`ss -lntp | grep :8080`) rather
than by process pattern, because a stale instance holding the port makes the next start die with
`EADDRINUSE` and the tests then silently measure the old build.
