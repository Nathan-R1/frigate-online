# frigate-online

A lightweight browser-based tabletop battle map. Place coloured piece/flip-token images on a shared grid, move them around, and mark them with counters — all synced between players over the internet in near real time.

## What it is

- **`client/frigate.html`** — the whole frontend (single file). Pan/zoom the board, click to create, drag to move, right-click to mark a piece exhausted, middle-click to ping a cell. Pieces start in your chosen colour.
- **`client/pieces/images/`** — drop PNGs here; they appear automatically in the create menu and on the server-hosted board.
- **`server/board.php`** — the tiny shared-state server. Persists the board to `server/board-state.json` and serves the piece catalog. Actions (`create`, `move`, `counter`, `exhaust`, `ping`, `resize`) are serialised with `flock` and saved atomically.
- **`run.sh`** — starts a local PHP dev server so you can test alone or with friends.

Because the state lives on the server, any number of browsers pointed at the same server see the same board — that's the multiplayer part.

## Run locally

Requires PHP (any 8.x) with `php-cli`.

```bash
./run.sh
```

Then open **http://localhost:8000/client/frigate.html** in your browser.

- To test multiplayer, open the same URL in two browser windows/tabs (pick a different colour in each) and refresh.
- To pick a different port: `PORT=9000 ./run.sh`
- Stop the server: `kill $(pgrep -f "php -S.*:8000")` (use your port if changed)
- Server log: `/tmp/frigate-server.log`

## Serve on the internet

Upload `server/board.php` (and the `client/` folder, keeping the `client/pieces/images` layout) to any PHP host; the whole folder can just be dropped behind a web server. The board state file is created automatically in `server/` on first write.

## API

| Request | Effect |
| --- | --- |
| `GET /server/board.php?get` | Full board state as JSON |
| `GET /server/board.php?pieces` | Catalog of PNGs in `client/pieces/images` |
| `POST /server/board.php` | One action or `batch` of actions: `resize`, `create`, `move`, `counter`, `exhaust`, `ping` |