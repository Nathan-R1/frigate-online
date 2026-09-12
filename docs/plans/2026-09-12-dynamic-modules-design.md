# Dynamic Module Pieces — Design

Branch: `dynamic-modules` (worktree at `.worktrees/dynamic-modules`). Scope: **client only** (`client/board.html`, `client/board.css`). No server changes.

## Goal
Replace the static PNG `<img>` pieces with generated, animated pieces so a
player's modules read as one cohesive, living ship — plus a placeholder
toggle to pick the connection style, and rocky slowly-spinning asteroids.

## Decisions (from brainstorming)
- Everything dynamic: modules, chips, asteroids.
- Asteroids: rough rocky blobs, each visually distinct, slow continuous spin.
- "Frigate" keeps its distinctive ship name + silhouette for now (remembered:
  it is just another module piece, no special role — rename revisited later
  when the piece->card mapping is finalised).
- Connections: 3 interchangeable styles, chosen via a placeholder
  `◫ CONNECT` topbar button (removed once the user picks one):
  - `mech` — rigid bolted struts with brackets + rivets (physical attachment).
  - `glow` — flowing energy line with pulse band + halo (matches move-path).
  - `station` — space-station tunnels: glass capsule edge-to-edge, ribs, a
    blinking running light, soft halo.
- Default = `glow`.

## Rendering approach
- Each `.piece` gets a generated inline `<svg class="module-svg">`
  (viewBox 0 0 72 72, 1 user unit = 1 px at CELL=72) via `moduleSvg(p)`.
- Colour custom property `--pc` is set on every `.piece` div; a
  `drop-shadow(... var(--pc))` glow on the svg makes the ship glow in the
  player's colour. `shade(hex, f)` derives light/dark tints.
- All animation is pure CSS keyframes (no JS tick loop).
- A new `#links` layer sits **under** `#pieces`; `renderConnections()`
  rebuilds an `svg.links-svg` (board-sized) each `renderPieces()`.
- New helpers: `svgEl`, `shade`, `hashStr` (stable per-piece seed).

## Shapes (`build*Svg`)
- circle — two broken rings spinning (`mod-spin`) + pulsing core.
- square — 4 corner LEDs blinking at staggered delays (`blink`), plus a scan
  bar sweeping across (`scan`).
- triangle — rotating inner frame (`mod-spin`) + two nodes orbiting (`mod-orbit`).
- hex — radar-ping hex ring expanding/fading (`hex-ping`) + pulsing core.
- diamond — spinning inner diamond (`mod-spin`) + shimmer cross (`mod-shimmer`).
- frigate — ship silhouette (nose up), flickering engine lights (`engine`).
  Whole svg rotated via `frigateAngle(p)`: nose points AWAY from the centroid
  of orthogonally-adjacent same-colour modules; upright (0°) when isolated.
- Unknown img → falls back to hexagon builder (server catalog is open).

## Asteroids (`buildAsteroidSvg`)
- Grey `square-module` pieces are asteroids (existing rule). Irregular rocky
  polygon (deterministic vertex jitter from `hashStr(p.id)`), craters, one or
  two small moonlet circles. Slow spin via `@keyframes astro-spin` using
  per-piece `--astro-start` / `--astro-speed` inline vars. No colour glow,
  desaturated. Never connects.

## Chips (~1/4 cell)
- Replace `<img>` with a `.chip-dot`: radial-gradient orb in the chip colour
  + soft `box-shadow` glow + `chip-breathe` pulse. Counters unchanged.
  (Tiny at CHIP size; distinct icons are lost, colours read instead.)

## Connections (per orthogonally-adjacent same-colour non-asteroid pair)
Drawn as SVG in `#links`:
- glow: halo line (op 0.12) + `conn-pulse` dash flow + `conn-base` marching dots.
- mech: dark strut `rect` (rounded) + end brackets + rivets, tinted by colour.
- station: glass capsule from face to face (rect rx=10), 2 mid ribs, a blinking
  center running light (`stn-blink`), soft `drop-shadow` halo.

## Files changed (client only)
- `client/board.html`: `#links` layer, `◫ CONNECT` button, `moduleSvg` +
  shape/asteroid/chip/connection builders, `renderPieces`/`renderChips`
  rewired to generated SVG, `connStyle` cycle.
- `client/board.css`: module piece styling + keyframes, `.chip-dot`, `.links-svg`,
  connection styles, `.conn-btn` state colours.

## Validation
- `node --check` on the inlined `<script>` (passes).
- Manual browser test at `http://localhost:8000/client/board.html` (new server
  serves the worktree; `server/board-state.json` copied in from `main` so the
  existing board renders with dynamic modules).

## Remaining/follow-ups
- Remove the `◫ CONNECT` button and lock the chosen style.
- Rename "frigate" later once the module-card mapping exists.