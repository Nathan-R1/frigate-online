# frigate-online

A browser game of fleet combat on a square grid. Build a ship out of modules and tech cards,
then fight it — against the computer on one screen, or against other people over the network.

## What is here

| | |
| --- | --- |
| **`client/game.html`** | The game. Board, hand, log, settings, the new-game roster, and online play. |
| **`shared/engine.js`** | The rules. Pure state and rules, no DOM: turn order, movement, line of sight, damage, the effect queue that drives every card. Loaded by the browser *and* the server. |
| **`shared/ai/`** | The computer player — knowledge, pathing, placement, doctrine, and the commander that ties them together. Runs in the tab offline, on the server online. |
| **`client/game/pieces.js`** | The silhouettes drawn on the board, one shape per module class. |
| **`client/game/net.js`** | The browser's half of online play: sends intents, receives state. |
| **`client/sheet-builder/sheet-builder.html`** | The ship builder. Pick a hull, spend points on crew skills, choose modules and a deck. Builds hand back to the game. |
| **`shared/presets/`** | The card and module data. This is the source of truth for what a card does. |
| **`server/game-server.js`** | The authoritative server for online play. Runs the same `engine.js` the browser does. |
| **`server/store.js`** | Where games are kept: files locally, PostgreSQL when `DATABASE_URL` is set. |
| **`tools/validate-effects.js`** | Checks every preset has behaviour and every op is reachable. |

## Playing on one screen

Open `client/game.html` — it needs no server at all. Set up the roster, choose Local player or
Computer for each seat, and start. Everything runs in the browser.

## Playing online

```bash
./run-online.sh            # start
./run-online.sh status     # is it up?
./run-online.sh stop       # shut it down
./run-online.sh restart
```

Then open **http://localhost:8080/client/game.html**. Press **Host online…** on the new-game
screen; you get a six-character room code. Everyone else opens the same address, presses
**Join a game…**, enters the code and takes a seat.

- Others on your network use `http://<your-ip>:8080/client/game.html` — the script prints it.
- The page finds the server by itself, so it also works served from somewhere else; add
  `?server=http://host:8080` if it needs telling.
- A different port: `PORT=9000 ./run-online.sh` — and the same when stopping it.
- Server log: `/tmp/frigate-online.log`

### How online play works

The server is the only place the game advances. A browser sends an *intent* — play this card,
answer this prompt, end my turn — and never state. The server runs the rules, refuses anything
they forbid, and pushes the result to every watcher over an event stream. Each watcher gets
their own view: the board is public, your own cards are yours, and everyone else's hand and
deck arrive as the right number of blanks.

A seat is yours until you leave it. Close the tab, come back tomorrow, and it is still there —
your browser remembers the seat and takes it back silently. Nothing expires on a timer. Press
**Leave** and the seat is free for anybody; until then the game waits for you.

Whoever sat down first is the **leader**, and only they can free somebody else's seat, under
**Settings → Game → Kick a player**. If the leader leaves, the mantle passes to whoever sat
down next. Freeing a seat does not remove that player from the room: they keep watching and can
take any free seat, including the one they just lost. It is there for the case a timer used to
handle — somebody who is never coming back.

Seats set to **Computer** in the roster are played by the computer, on the server. A seat meant
for a person is never played for them.

### Games are saved

Every game is written down whenever it is *settled* — no prompt waiting, nothing queued. Stop
the server, deploy over it, pull the plug: the room comes back where it was, with everyone
still in their seats.

The dice are part of what is saved. Each game carries a seed and its generator's position, so a
restored game rolls exactly what it was always going to roll — a crash cannot deal anybody a
better hand. The one cost, stated plainly: if the process dies while somebody has a prompt
open, the game resumes from just before the action that opened it, and that action is taken
again.

## Where games are kept

| | |
| --- | --- |
| no `DATABASE_URL` | JSON files under `server/data/`, one per room, written atomically. Nothing to install or run. This is local play. |
| `DATABASE_URL` set | PostgreSQL — Supabase, or any other. `npm install` first. |

Two tables, created on first boot: `games` (one row per room, the state in a `jsonb` column)
and `game_seats`. A seat's token is never stored, only its SHA-256, so a copy of the database
hands nobody a seat.

## Deploying to Render + Supabase

`render.yaml` is a blueprint for a single web service that serves both the client and the API.

1. In Supabase, create a project and copy the connection string from **Connect → Session
   pooler** (the IPv4 one, port 5432).
2. Create the Render service from `render.yaml` and set `DATABASE_URL` in the dashboard. Never
   commit it.
3. Deploy. The schema is created on first boot; `/healthz` reports the store in use.

**Keep it at one instance.** The live game is held in the process between settled points, so
two instances would each believe they own a room. That is a scaling limit, not a durability
one — the game itself is safe in Postgres.

### Environment

| | |
| --- | --- |
| `PORT` | what to listen on (Render sets this) |
| `DATABASE_URL` | Postgres connection string; unset means files |
| `PGSSL` | `off` to disable TLS, `on` to force it; sensible default either way |
| `FRIGATE_AI_TICK` | ms between computer actions (default 380) |
| `FRIGATE_FLUSH` | ms before a settled game is written down (default 500) |
| `FRIGATE_EVICT` | ms before an unwatched room leaves memory (default 10 min) |
| `FRIGATE_ROOM_TTL_DAYS` | delete rooms older than this; default 0, meaning never |

## Checks

```bash
node tools/validate-effects.js
```

## Requirements

Node 18+ for online play, and `npm install` only if you are using Postgres. Single-screen play
needs only a browser.
