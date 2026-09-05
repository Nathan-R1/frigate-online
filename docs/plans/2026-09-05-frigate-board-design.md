# Frigate Board — Multiplayer Battle Map Design

Date: 2026-09-05
Status: Validated (design approved by owner)

## Goal

A standalone page that shows a square-grid **battle map** for the Starship Frigate TTRPG.
Every visitor to the page shares the *same* board: when one player creates, moves, counts,
pings, or resizes, all other browsers see it within ~1 second. Version 1 does **not** sync
character-sheet stats — players keep their own sheets. The board page is a separate file;
it will be merged into the existing sheet later.

## Hosting facts (verified)

- Server: nginx in front of Apache PHP, Plesk Linux shared hosting.
- PHP **works**: 7.4.33 (confirmed with `phptest.php`).
- Folder `RaisSoftware/frigate/` is **writable** (confirmed with `writetest.php`).
- All game files live under `RaisSoftware/frigate/`.

## File layout (server)

```
RaisSoftware/frigate/
  frigate.html          # entire client (markup, CSS, JS) — single file, like the sheet
  board.php             # only server code: get state, apply action, list pieces
  board-state.json      # shared board state (auto-created; never edited by hand)
  pieces/
    images/*.png        # piece art (white/grey); auto-scanned, never hardcoded
    config/             # deferred (not used in v1)
```

## Architecture

- **One shared board, no rooms/lobbies.** Everyone who opens the page edits the same
  state ("everyone on the page" model chosen by owner).
- **Canonical state** lives only in `board-state.json`. `board.php` is the single writer:
  it loads the file, applies a validated action, saves atomically (write temp + rename).
- **Clients poll** `board.php?get` every ~500 ms for changes; their own actions render
  instantly (optimistic) and are also POSTed as actions.
- **Conflicts:** last-writer-wins per object. Fine for a tabletop.

## Shared state model

```json
{
  "rev": 123,
  "grid": { "size": 18 },
  "pieces": [
    { "id": "p7", "img": "circle-module", "color": "green",
      "x": 3, "y": 5,
      "buttons": { "red": 0, "grey": 0 } }
  ],
  "chips": [
    { "id": "c2", "img": "square-module", "color": "blue",
      "x": 9, "y": 9,
      "buttons": { "red": 0, "grey": 0 } }
  ],
  "pings": [
    { "color": "green", "x": 4, "y": 4, "t": 1788567000 }
  ]
}
```

Counter values are integers clamped at 0; both start at 0.

## board.php endpoints

| Endpoint | Purpose |
| --- | --- |
| `board.php?get` | Full state JSON + `rev`. |
| `board.php?pieces` | Scan `pieces/images/` → sorted list of piece labels (first part of filename, e.g. `circle-module.png` → `circle`). |
| `POST board.php` (JSON action) | `resize`, `create`, `move`, `counter`, or `ping`. Validate, apply, save. |

Server-side validation: grid size 1–40; coordinates within grid; color from a fixed
palette whitelist; piece image must exist in `pieces/images/`; action type known.
This prevents junk injection via URL or popup. No rules are enforced beyond that.

## Client features (v1)

- **Grid:** square cells, default size 18×18, editable in a control at the top. Size is
  part of the shared state; changes replicate. **Shrink destroys** any piece/chip whose
  cell is outside the new bounds.
- **Pan & zoom:** drag to pan, mouse wheel to zoom (map-style).
- **Colors:** each player picks a color in a menu; remembered in the browser between
  visits. Every action is tagged with the actor's color.
- **Piece tinting:** white/grey art is colorized per player via a canvas pass; identical
  for all viewers.
- **Create popup:** clicking an empty cell opens the menu. It lists every image from
  `pieces/images/` (auto-scanned, thumbnails) with a **Pieces** / **Chips** toggle.
  A new object is created in the actor's color. Popup content is never hardcoded.
- **Pieces:** fill the whole cell. Max one piece per cell (and a piece never shares a
  cell with chips).
- **Chips:** ¼ of a cell; centred when alone in a cell, arranged in a grid when several
  chips share a cell. Any number of chips per cell; chips never share a cell with a piece.
- **Counters:** two small buttons per object — red and grey — shown on hover, e.g.
  `[0] [4]`. Left-click +1, right-click −1 (clamped ≥ 0). Replicates.
- **Move mode:** click a piece/chip → cyan highlight; click a destination cell → moves.
  Pieces may only land on empty cells; chips may land on cells holding chips.
- **Pings:** middle-click any cell drops a ping in the player's color; fades and is
  forgotten after 4 s for everyone.
- **Ownership:** nothing is owned; anyone can edit anything (per owner's model).

## Error handling

- Poll failure → small **"not syncing"** badge; board keeps working solo; retries in
  background. No data loss beyond unsynced moves.
- Atomic save prevents corrupt/half-written board state.
- Sizing/positioning validated client-side before send; server re-validates.

## Testing

- `node --check` on the extracted `<script>` block of `frigate.html`.
- `php -l` on `board.php` where PHP is available.
- Live two-browser test on the real server (two windows side by side):
  create, move, counters, pings, resize-shrink-destroy, chip stacking,
  piece/chip exclusion — all replicate both ways within ~1 s.

## Deployment (current build)

Upload the whole `frigate/` folder from this repo to
`RaisSoftware/frigate/` on the server. Two files + the art folder:

```
RaisSoftware/frigate/
  frigate.html          # game client
  board.php             # state server
  pieces/images/*.png   # placeholder art (replace with real art later)
```

`board-state.json` is created automatically on first write; do not upload one.

Server smoke test (open in a browser or curl):
- `frigate.html` — the game page.
- `board.php?get` — should return `{"ok":true,"state":{...}}`.
- `board.php?pieces` — should list `circle-module`, `square-module`, etc.

Two-player test: open `frigate.html` in two windows, then verify
create / move / counters / pings / board resize all appear in both windows
within ~1 second. Deleting the uploaded `phptest.php` is still pending from
the capability check.

## Deferred (later)

- `pieces/config/` behaviour (owner chose "skipped for now").
- Syncing character-sheet stats.
- Merging the board into the existing `frigate.html` sheet.
- Rooms/lobbies, piece ownership, turn rules.