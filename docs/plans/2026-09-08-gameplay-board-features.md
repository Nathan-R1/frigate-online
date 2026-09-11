# Gameplay Board Features Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the board client with four gameplay features: free-position pings (anywhere on the board), persistent per-player ping markers that persist until replaced, line-of-sight highlighting via Bresenham, and a hover distance readout.

**Architecture:** Modify the inline client JS in `client/board.html` and its companion CSS `client/board.css`, plus the state model + validation in `server/board.php`. Pings change from a transient, TTL-pruned, multi-ping array to a **persistent per-player map** (one ping per color, replaced when the player pings elsewhere, remembered in server state until replaced). LOS uses Bresenham's line algorithm where pieces block and chips do not. This is a plain vanilla HTML/CSS/JS + PHP app with no build system; verification is `node --check` on the extracted script and `php -l` on board.php.

**Tech Stack:** Vanilla JS (inline in `board.html`), CSS, PHP (`board.php`). No framework, no npm.

---

## Design decisions (confirmed with owner)

- **Ping = persistent marker, one per player (color).** Placing a ping replaces your previous ping for everyone. Other players see the marker; when it moves (you reshould after your save), the bloom animation plays once then the marker stays solid. The server remembers your ping position until you ping somewhere else (no TTL expiry).
- **Pings can be placed anywhere on the board** — not locked to cell corners. Positions are fractional cell coordinates (floats) validated only by bounds (>= 0, < grid size).
- **LOS highlight:** hovering a cell while a piece is selected darkens all cells NOT in line of sight from the selected piece's cell. LOS = Bresenham straight line from source cell center to hovered cell center; any intermediate cell containing a **piece** blocks (chips never block). Perfect diagonals that only graze a corner do NOT count those corner cells as blocking.
- **Distance readout:** when a piece is selected and the mouse hovers a cell, show `|dx| + |dy|` (Manhattan distance from the selected piece's cell) in the bottom-right of the screen.

---

## Task 1: Server — replace ping model with persistent per-player map

**Files:**
- Modify: `server/board.php` (constants, normalize, actPing, actResize, defaultState, comment header)

### Step 1: Understand the changes

`board.php` currently keeps `pings` as a TTL-pruned array `[{color,x,y,t}]` with `PING_TTL = 4`. Replace with an object keyed by color: `pings: { "green": {"x":..,"y":..}, ... }`.

### Step 2: Update `PING_TTL` remove + defaultState

Remove the `PING_TTL` define (`board.php:23`). Update `defaultState()` (`board.php:35-37`) so `pings` is `array()` (an empty map). Update the header comment (`board.php:7`) to reflect persistent pings.

### Step 3: Update `normalize()`

In `normalize()` (`board.php:39-56`), replace the TTL-pruning loop (`board.php:50-55`) so that:
- `pings` is forced to an array/object (already done at 44-46).
- Each entry has the form `color => ['x'=>float, 'y'=>float]`.
- Drop any entry whose color is not in `$GLOBAL['VALID_COLORS']` and whose x/y are not numeric.

Example implementation:
```php
$pings = array();
foreach ($s['pings'] as $c => $p) {
    if (!is_array($p)) continue;
    $p = array('x' => (float)$p['x'], 'y' => (float)$p['y']);
    $pings[$c] = $p;
}
$s['pings'] = $pings;
```

### Step 4: Update `actResize()`

`actResize()` (`board.php:139-148`) prunes out-of-bounds pings via `array_filter` over a list. Since `pings` is now a color-keyed map, replace the pings filter with a loop that removes out-of-bounds per-color pings:
```php
$size = $s['grid']['size'];
foreach ($s['pings'] as $c => $p) {
    if ($p['x'] < 0 || $p['y'] < 0 || $p['x'] >= $size || $p['y'] >= $size) {
        unset($s['pings'][$c]);
    }
}
```
Keep the existing pieces/chips filters. Note `coordOk` uses strict `< size` and `>= 0`, matching this.

### Step 5: Update `actPing()`

Replace `actPing()` (`board.php:250-258`) so each ping **sets** the player's color entry (replacing the previous) instead of appending. Coordinates may be floats. Validate: color in whitelist; x,y numeric and within bounds:
```php
function actPing(&$s, $a) {
    $color = $a['color'];
    if (!in_array($color, $GLOBALS['VALID_COLORS'], true)) return array('error' => 'bad color');
    $sx = $s['grid']['size'];
    $x = (float)$a['x']; $y = (float)$a['y'];
    if (!is_numeric($a['x']) || !is_numeric($a['y'])) return array('error' => 'bad coords');
    if ($x < 0 || $y < 0 || $x >= $sx || $y >= $sx) return array('error' => 'out of bounds');
    $s['pings'][$color] = array('x' => $x, 'y' => $y);
    return null;
}
```

### Step 6: Verify PHP syntax

Run: `php -l server/board.php`
Expected: `No syntax errors detected in server/board.php`

### Step 7: Commit

```bash
git add server/board.php
git commit -m "feat(server): persistent per-player ping map"
```

---

## Task 2: Client — free-position ping placement (anywhere on board)

**Files:**
- Modify: `client/board.html` (clientToCell, add clientToBoard, middle-click handler, showPing)

### Step 1: Add `clientToBoard()` fractional helper

Current `clientToCell()` (`board.html:282-287`) floors to integer cells. Add a helper that returns **float** board coords (in cell units) without flooring, and keep `clientToCell` for cell-based actions:

```js
function clientToBoard(cx, cy) {
  var r = boardEl.getBoundingClientRect();
  var wx = (cx - r.left - view.x) / view.zoom;
  var wy = (cy - r.top - view.y) / view.zoom;
  return { x: wx / CELL, y: wy / CELL };
}
function clientToCell(cx, cy) {
  var c = clientToBoard(cx, cy);
  c.x = Math.floor(c.x);
  c.y = Math.floor(c.y);
  return c;
}
```

### Step 2: Update the middle-click ping handler to use float coords

In the middle-click handler (`board.html:431-440`), use `clientToBoard` and store float x/y. Bounds check stays the same:

```js
if (e.button === 1) {
  e.preventDefault();
  var c = clientToBoard(e.clientX, e.clientY);
  if (c.x >= 0 && c.y >= 0 && c.x < state.grid.size && c.y < state.grid.size) {
    placeLocalPing(c.x, c.y);                                   // Task 3
    queue('ping', { action: 'ping', x: c.x, y: c.y, color: actorColor });
  }
  return;
}
```
Note: the ping queue key becomes a single `'ping'` because there is only ever one local pending ping (Task 3). Actually, one per color is fine; use `'ping:' + actorColor` so it stays stable. See Task 3.

### Step 3: Verify JS syntax

The script is inline in `board.html`. Extract the `<script>` content to a temp `.js` file and run `node --check`. (Script starts at the line after `<script>` at `board.html:147` and ends before `</script>` at line 1480.) Provide the exact extraction command in Task 7's verification notes; for this task, spot-check by extraction + `node --check`.

Run: extract script to `%TEMP%\board-check.js`, then `node --check board-check.js`
Expected: no output (syntax OK).

### Step 4: Commit

```bash
git add client/board.html
git commit -m "feat(client): ping at free position via clientToBoard"
```

---

## Task 3: Client — persistent ping markers (one per color, no TTL)

**Files:**
- Modify: `client/board.html` (constants/globals, showPing -> persistent render, middle-click handler, actionKey, applyServer, remove TTL timers)
- Modify: `client/board.css` (`.ping`, add appearance animation that stops, remove auto-fade)

### Step 1: Replace ping globals and TTL

Remove `PING_TTL` (`board.html:155`) and the `shownPings` expiry-based logic. Replace `shownPings` (`board.html:187`) with markers keyed by color:

```js
var pingEls = {};      // color -> element for current marker of that color
var pingPos = {};      // color -> {x, y} last-rendered marker position
var pingAnim = {};     // color -> timer id for the "bloom to stop" animation
```

### Step 2: Rewrite `showPing` as `renderPing(color, x, y, animate)`

Replace `showPing` (`board.html:368-375`) with a function that maintains one persistent marker per color. It reuses the existing `.ping` element for that color, moves it, updates its background, and (when `animate` is true and position changed) plays a short bloom animation that **stops** (does not auto-remove):

```js
function renderPing(color, x, y, animate) {
  var key = color;
  var moved = false;
  if (pingPos[key] && (pingPos[key].x !== x || pingPos[key].y !== y)) moved = true;
  var d = pingEls[key];
  if (!d) {
    d = el('div', 'ping');
    d.style.background = PALETTE[color] || '#9aa4ae';
    pingsEl.appendChild(d);
    pingEls[key] = d;
    moved = true;                       // appearing counts as a move for animation
  }
  d.style.left = cellPx(x) + 'px';
  d.style.top = cellPx(y) + 'px';
  pingPos[key] = { x: x, y: y };
  if (animate && moved) playPingBloom(d);
}
```

`playPingBloom(d)` restarts the CSS animation so it plays once and stops:
```js
function playPingBloom(d) {
  d.classList.remove('bloom');
  void d.offsetWidth;                    // force reflow to restart animation
  d.classList.add('bloom');
}
```

The element is never auto-removed while the ping is active — it persists as a solid marker. It is removed only in `clearLocalPing`/when the marker disappears from server state (Task 4).

### Step 3: Add helper for the local optimistic ping

```js
function placeLocalPing(x, y) {
  renderPing(actorColor, x, y, false);   // you know where you clicked; no bloom
}
```

### Step 4: Update the middle-click handler

Wire `placeLocalPing(c.x, c.y)` in the handler (Task 2, Step 2) and queue the ping with a stable per-color key:
```js
queue('ping:' + actorColor, { action: 'ping', x: c.x, y: c.y, color: actorColor });
```

### Step 5: Update `actionKey`

In `actionKey` (`board.html:808-819`), change the ping case to:
```js
case 'ping': return 'pg:' + act.color;
```

### Step 6: Update `applyServer` ping reconciliation

Replace the ping loop + prune in `applyServer` (`board.html:879-893`) with logic that syncs server ping markers. For each color in `s.pings`, `renderPing(color, x, y, true)` (animate on change). Then remove markers for colors no longer present:

```js
var srv = s.pings || {};
for (var col in srv) {
  if (srv.hasOwnProperty(col)) {
    renderPing(col, srv[col].x, srv[col].y, true);
  }
}
for (col in pingEls) {
  if (pingEls.hasOwnProperty(col) && !(col in srv)) {
    removePing(col);
  }
}
```

`removePing(color)` removes the element and clears its timers/state:
```js
function removePing(color) {
  var d = pingEls[color];
  if (d && d.parentNode) d.parentNode.removeChild(d);
  delete pingEls[color];
  delete pingPos[color];
  if (pingAnim[color]) { clearTimeout(pingAnim[color]); delete pingAnim[color]; }
}
```

Remove the old `shownPings` references (lines 435-436 in the middle-click handler and 877, 879-893 in applyServer).

### Step 7: Update CSS

In `client/board.css`, update `.ping` (lines 194-203) and replace `pingfade` with `bloom`:
```css
.ping {
  position: absolute; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, .65); box-shadow: 0 0 12px rgba(255, 255, 255, .35);
  pointer-events: none; opacity: 1;
}
.ping.bloom { animation: pingbloom .9s ease-out forwards; }
@keyframes pingbloom {
  0% { opacity: 0; transform: scale(.4); }
  40% { opacity: 1; transform: scale(1.15); }
  100% { opacity: 1; transform: scale(1); }
}
```
The marker stays at full opacity (`opacity: 1`) after the bloom.

### Step 8: Verify JS syntax

Extract inline `<script>` to a temp file and run `node --check` (see Task 7 verification notes).

### Step 9: Commit

```bash
git add client/board.html client/board.css
git commit -m "feat(client): persistent per-player ping markers"
```

---

## Task 4: Client — ping removal lifecycle on local deselect/refresh guard

**Files:**
- Modify: `client/board.html`

### Step 1: Note the "remembered until replaced" behavior

Per the owner's spec, a ping is remembered in server state until the player pings elsewhere. There is **no** removal action. Client markers disappear only when:
1. The player places a new ping (old marker moves to the new spot), or
2. The server state no longer contains that color's ping (e.g. grid resize removed it).

Task 3's `applyServer` already removes markers for colors absent from server state (handles case 2). No further client removal code is required for the normal flow. **This task is verification only** — confirm there are no stray references to `shownPings`, `PING_TTL`, or the old fade between the extraction and a `node --check`.

### Step 2: Verify no stale references

Run: `rg -n "shownPings|PING_TTL|pingfade" client/`
Expected: no matches.

### Step 3: Commit

No code change expected. If the search finds stale references, fix them in Task 3 before committing.

---

## Task 5: Client — Bresenham line-of-sight highlight

**Files:**
- Modify: `client/board.html` (add LOS helpers, hover listeners, LOS overlay layer)
- Modify: `client/board.css` (LOS overlay styling)

### Step 1: Add LOS helpers

Bresenham from source cell center to target cell center. When the line passes exactly through a grid corner (perfect diagonal), the corner-grazed cells are NOT counted as blocking. The standard "diagonal obstruction" Bresenham trick: skip a cell if BOTH extensions (vertical AND horizontal) land exactly on grid lines. Implement:

```js
function lineBlocked(sx, sy, tx, ty) {
  // Centers in float cell units
  var x0 = sx + 0.5, y0 = sy + 0.5, x1 = tx + 0.5, y1 = ty + 0.5;
  var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  var sx2 = x0 < x1 ? 1 : -1, sy2 = y0 < y1 ? 1 : -1;
  var err = dx + dy;
  var cx = sx, cy = sy;           // current integer cell
  while (true) {
    if ((cx !== sx || cy !== sy) && (cx !== tx || cy !== ty)) {
      if (occupancy(cx, cy) === 'piece') return true;  // chips ignore
    }
    if (cx === tx && cy === ty) break;
    var e2 = 2 * err;
    var stepped = false;
    if (e2 >= dy) { err += dy; cx += sx2; stepped = true; }
    if (e2 <= dx) { err += dx; cy += sy2; stepped = true; }
    if (!stepped) break;          // safety
  }
  return false;
}
```

Note: this Bresenham variant naturally handles the "grazed corner" case — when the line crosses exactly at a corner, `e2` being equal on both branches advances x and y together, visiting only the diagonal cells in sequence and skipping the corner cells that share only a point.

### Step 2: Add cell-visibility computation

```js
function visibleCells(fromX, fromY) {
  var size = state.grid.size;
  var vis = [];
  var i, j;
  for (i = 0; i < size; i++) {
    vis[i] = [];
    for (j = 0; j < size; j++) vis[i][j] = !lineBlocked(fromX, fromY, i, j);
  }
  return vis;
}
```

### Step 3: Add LOS overlay layer + render/darken

Add a layer div after `#pings` in `board.html:66`:
```html
<div id="los" class="layer"></div>
```
`#los` sits above the grid but below pieces so the darkening is visible. Actually to darken all non-LOS cells (including under pieces), place it above pieces but with `pointer-events:none`. CSS:
```css
#los .shade { position: absolute; background: rgba(0,0,0,.55); }
```

Render function:
```js
var losEl = document.getElementById('los');
var losActive = false;
function renderLos(fromX, fromY) {
  var size = state.grid.size;
  losEl.innerHTML = '';
  var vis = visibleCells(fromX, fromY);
  for (var i = 0; i < size; i++) {
    for (var j = 0; j < size; j++) {
      if (!vis[i][j]) {
        var s = el('div', 'shade');
        s.style.left = cellPx(i) + 'px';
        s.style.top = cellPx(j) + 'px';
        s.style.width = CELL + 'px';
        s.style.height = CELL + 'px';
        losEl.appendChild(s);
      }
    }
  }
  losActive = true;
}
function clearLos() { losEl.innerHTML = ''; losActive = false; }
```

### Step 4: Add hover listeners

Track the hovered cell during mousemove (already have a global `mousemove` at `board.html:445`). When a piece is selected and the hover is over a valid cell, render LOS from the selected piece's cell; otherwise clear LOS:

In the existing `window mousemove` handler, after the drag logic, add:
```js
updateLosOnHover(e.clientX, e.clientY);
```
and define:
```js
function updateLosOnHover(cx, cy) {
  if (touchActive) return;
  var c = clientToCell(cx, cy);
  var size = state.grid.size;
  var inGrid = c.x >= 0 && c.y >= 0 && c.x < size && c.y < size;
  var pieceSel = sel && sel.type === 'piece';
  var from = pieceSel ? findObj('piece', sel.id) : null;
  if (from && inGrid) renderLos(from.x, from.y);
  else clearLos();
}
```

Call `clearLos()` in `setSelection` (line 398) and when the selection changes or view pans/zooms (see Task 6 for pan/zoom re-render). Ensure LOS is cleared on deselect (clicking selected piece again → `sel = null`).

### Step 5: Verify JS syntax

Extract `<script>` and `node --check`.

### Step 6: Commit

```bash
git add client/board.html client/board.css
git commit -m "feat(client): Bresenham LOS highlight on hover"
```

---

## Task 6: Client — distance readout (bottom-right)

**Files:**
- Modify: `client/board.html` (distance element + update in hover handler)
- Modify: `client/board.css` (bottom-right readout styling)

### Step 1: Add the readout element

Add to `board.html` (next to the HUD, before `</div>` at line 145):
```html
<div id="distReadout" class="dist-readout hidden"></div>
```

### Step 2: Add CSS

```css
.dist-readout {
  position: fixed; right: 14px; bottom: 56px; z-index: 90;
  font-family: 'JetBrains Mono', monospace; font-size: 20px; font-weight: 700;
  color: #35d0e0; background: rgba(10, 15, 22, .85); border: 1px solid #22303f;
  border-radius: 8px; padding: 6px 12px; pointer-events: none;
}
.dist-readout.hidden { display: none; }
```

### Step 3: Update readout in hover handler

In `updateLosOnHover` (Task 5), also update the distance readout. When a piece is selected and hovering in-grid, show `|dx| + |dy|`:
```js
var distEl = document.getElementById('distReadout');
function updateLosOnHover(cx, cy) {
  if (touchActive) return;
  var c = clientToCell(cx, cy);
  var size = state.grid.size;
  var inGrid = c.x >= 0 && c.y >= 0 && c.x < size && c.y < size;
  var pieceSel = sel && sel.type === 'piece';
  var from = pieceSel ? findObj('piece', sel.id) : null;
  if (from && inGrid) {
    renderLos(from.x, from.y);
    distEl.textContent = Math.abs(c.x - from.x) + Math.abs(c.y - from.y);
    distEl.classList.remove('hidden');
  } else {
    clearLos();
    distEl.classList.add('hidden');
  }
}
```

Ensure the readout hides on deselect (call in `setSelection` alongside `clearLos`).

### Step 4: Re-render on pan/zoom (keep LOS aligned)

The LOS overlay is drawn in `#world` coordinates, so it stays aligned automatically during pan/zoom (the whole `#world` transforms). No re-render needed for pan/zoom. Confirm `#los` is inside `#world` so it transforms with it.

### Step 5: Verify JS syntax

Extract `<script>` and `node --check`.

### Step 6: Commit

```bash
git add client/board.html client/board.css
git commit -m "feat(client): hover distance readout bottom-right"
```

---

## Task 7: Verification of all changes

**Files:**
- Modify: none (verification only)

### Step 1: PHP lint

Run: `php -l server/board.php`
Expected: `No syntax errors detected in server/board.php`

### Step 2: JS syntax check

Extract the inline `<script>` from `client/board.html` to a temp file and lint with node:

```powershell
$html = Get-Content 'client/board.html' -Raw
$m = [regex]::Match($html, '<script>([\s\S]*?)</script>')
Set-Content -Path "$env:TEMP\board-check.js" -Value $m.Groups[1].Value -Encoding UTF8
node --check "$env:TEMP\board-check.js"
```
Expected: no output (syntax OK). (`node --check` prints nothing on success.)

### Step 3: Check for stale references

Run: `rg -n "shownPings|PING_TTL|pingfade" client/`
Expected: no matches.

### Step 4: Live smoke test (manual)

Run the PHP dev server (`php -S localhost:8000 -t client` or the existing `run.sh`), open two browsers side by side:
- **Free ping:** middle-click partway into a cell → marker appears at the exact click point (not corner-locked).
- **Persistent ping:** marker stays solid. Hit SAVE, then in the other browser hit REFRESH → marker appears; if it moved, the bloom plays once then stops. Ping somewhere else + SAVE + REFRESH → marker relocates.
- **LOS:** select a piece, hover a cell → non-LOS cells darken (pieces block, chips don't). Place a chip in the line → still visible (chip ignored). Exact corners on perfect diagonals stay visible.
- **Distance:** with a piece selected, hover cells → bottom-right shows `|dx|+|dy|`; deselect hides it.

### Step 5: Commit any final fixes

```bash
git add -A
git commit -m "feat(board): pings, LOS, distance readout"
```
(Only if Task 7 found and fixed issues.)
