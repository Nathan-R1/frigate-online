# Playable game — design and build plan

`client/game.html`: a self-contained, two-sided playable build of the frigate game.
Player vs enemy, both driven by the same sheet model. Traits/Officers are out of scope.

## 1. What already exists and what it is worth reusing

| Asset | Reuse |
|---|---|
| `presets/tech-presets.js`, `mod-presets.js` | **Yes, unchanged.** Card names, prose, rarity, class, costs. |
| `css/style.css`, `css/frigate.css` | **Yes.** Palette and theming come free. |
| `board.html` grid model | **Model only.** Square grid, `CELL = 72px`, integer `{x,y}` cells, `occupancy()`. |
| `board.html` sync/`board.php` | **No.** That is a shared multiplayer whiteboard with rev-based sync. The game needs local authoritative state. |
| `frigate.html` sheet | **No, but mirror its stat derivation.** hull = base + Engineering, speed = max(1, Navigation), sensors = 2 × Sensors, draw = base + Cyber, storage cap = Logistics, capacity cap = Leadership. |
| `hand.html` | **Layout inspiration only.** Its BroadcastChannel protocol assumes a separate window. |

## 2. Why a separate effects file

`tech-presets.js` / `mod-presets.js` hold **prose**, which the sheet builder and the
frigate sheet render directly. Restructuring them would break both.

New file **`client/frigate-sheet/presets/card-effects.js`** maps card name → machine-readable
behaviour. One source of truth for display text, one for behaviour, cross-validated by a test
asserting every preset has an effects entry and every entry names a real preset.

## 3. Data model

```js
Game = {
  turn, active,                      // 0 = player, 1 = enemy
  phase: 'upkeep'|'draw'|'play'|'end'|'over',
  players: [Side, Side],
  cells: { "x,y": {kind, owner, id} },   // module | deployable | asteroid | anomaly
  pending: null,                     // open prompt, see §5
  log: []
}

Side = {
  name, skills:{9 skills}, stats:{...}, shield, shieldMax,
  deck:[], hand:[], played:[], discard:[], trash:[],
  cards:   { id: {name, charges, heat, exhausted, durations:[]} },
  modules: { id: {name, x, y, hull, hullMax, exhausted, tokens:{}} },
  deployables: { id: {name, x, y, hull, speed, duration, charges} },
  coreId,                            // hull 0 here = game over
  moveLeft, playsLeft
}
```

## 4. Effect DSL

Every card compiles to a list of **ops**. Roughly 20 primitives cover all 69 cards.

```js
'Rocket Array': {
  onPlay:    [ {op:'addCharge', target:'self', n:1}, {op:'exhaustSelf'} ],
  activate:  { cost:   [ {op:'exhaustSelf'}, {op:'spendCharge', n:1} ],
               effect: [ {op:'attack', range:9, from:'any', attacks:8, dmg:1} ] }
}
```

**Ops**: `createModule` `createDeployable` `attack` `gainMove` `moveObject` `addCharge`
`spendCharge` `addHeat` `spendHeat` `addToken` `gainShield` `gainHull` `draw` `play`
`discardSelf` `trashSelf` `exhaustSelf` `refresh` `exhaust` `buff` `reroll` `destroy`
`createAsteroid` `chooseAndRun`.

Any op's `target` may be `'choose'`, which raises a prompt.

**Triggers** for passives: `onMove` `onDamaged` `onShieldDamaged` `onDealDamage`
`onFailCheck` `onExhaustMovement` `onWouldTrash` `onTargeted` `onTurnStart` `onTurnEnd`
`static` (continuous modifiers such as Divert Power).

## 5. Resolution engine — the key decision

A **step queue with suspendable prompts**. Ops push steps; a step needing input sets
`game.pending = {kind, filter, onResolve}` and returns. The UI renders the prompt, the
player confirms, the engine resumes.

This makes the required flows fall out of one mechanism:
- *Move* → `pending {kind:'move'}`, board becomes interactive, Confirm resumes.
- *Attack* → `pending {kind:'target', filter}` → Confirm → roll attacks.
- *Draw/play/token* → `pending {kind:'card'|'module'}`.

The AI resolves the same prompts through a policy function instead of the UI, so there is
exactly one rules path.

## 6. Turn loop

1. **Upkeep** — refresh cards and modules, tick durations, fire `onTurnStart`.
2. **Draw** — `drawDrawBase + Cyber` cards.
3. **Play** — up to `drawPlayBase` plays; activations are free but exhaust-limited.
4. **End** — fire `onTurnEnd`, pass.

Win check runs after every mutation: any side's Core hull ≤ 0 → `phase = 'over'`.

## 7. Combat

`attack{attacks, dmg, check?}` resolves per attack: roll vs DC 7 modified by the named
skill. On a hit, damage lands on the targeted **module**: the owner's shield pool absorbs
first, the remainder comes off module hull. A module at 0 hull is destroyed and its cell
freed. The Core is a module like any other — it just ends the game.

## 8. UI

```
┌──────────────────────────────────────────────┐
│ turn banner · both stat bars · end turn      │
├───────────────────────────┬──────────────────┤
│  board (square grid)      │  log             │
│  modules, deployables,    │  prompt panel    │
│  asteroids                │  enemy sheet     │
├───────────────────────────┴──────────────────┤
│  your hand — play / activate                 │
└──────────────────────────────────────────────┘
```

## 9. Build order

1. `card-effects.js` + validator script
2. Engine core: state, op queue, prompts, turn loop
3. Board renderer, ship placement from core options
4. Combat and win condition
5. Hand UI, play/activate
6. AI policy
7. Author all 69 card effect entries
8. Cross-validation: every preset implemented, every op reachable

## 10. Known open rules questions

These block exact implementation and currently have no answer in the presets:

- **Dice.** No dice system exists in the repo. DC is 7; the die is unspecified. Plan assumes **d20 + skill vs DC**.
- **Refresh** is a new keyword (Full Volley) with no definition. Assumed: clear Exhausted.
- **Module placement** — `req` is prose ("Adjacent to Core", "2 spaces from Core"). Needs parsing into a placement predicate.
- **Starting ship** — which modules a side begins with. Assumed: Core plus whatever the core-option grants create.
- **Deployable movement** — `speed` exists but turn-by-turn movement rules are unstated.
