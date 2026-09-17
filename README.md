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
- Games live in memory, so stopping the server ends whatever is in progress.

### How online play works

The server is the only place the game advances. A browser sends an *intent* — play this card,
answer this prompt, end my turn — and never state. The server runs the rules, refuses anything
they forbid, and pushes the result to every watcher over an event stream. Each watcher gets
their own view: the board is public, your own cards are yours, and everyone else's hand and
deck arrive as the right number of blanks.

A seat is held for as long as that browser is watching it. Sixty seconds after the last
connection for a seat closes, it empties and anybody can take it — the game waits until
somebody does. Reloading puts you back in the seat you had.

Seats set to **Computer** in the roster are played by the computer, on the server.

## Checks

```bash
node tools/validate-effects.js
```

## Requirements

Node (any 20+) for online play. Single-screen play needs only a browser.
