# AI strategy design

How the enemy commander thinks. All of this lives in `client/game/ai/` and is loaded by
`game.html`; no AI logic sits in `game.html`, `engine.js` or any PHP file.

## 1. Why the current AI is weak

| Problem | Cause |
|---|---|
| Freezes behind a single asteroid | Greedy stepping with a 3-square perpendicular hack, no real pathfinding |
| Plays whatever is first in hand | No notion of what a card is *for* |
| Wastes Boost / Dynamo | Treats extra plays as an ordinary card rather than free value |
| One behaviour in all situations | No state, no doctrine |
| Fights at whatever range it drifts to | Single `desiredRange()` number, no plan |

## 2. Architecture

```
ai/ai-knowledge.js   what is true      — card roles, ranges, threat, deck reading
ai/ai-path.js        how to get there  — BFS over formation translations
ai/ai-doctrine.js    what to want      — Cautious / Aggressive / Tactical
ai/ai-commander.js   what to do now    — phase machine, the only entry point
```

`game.html` calls exactly one thing: `AI.Commander.tick(sideIndex)`. Everything else is internal.

## 3. Card roles

Read from `card-effects.js` ops rather than hardcoded lists, so new cards classify themselves.

| Role | Detected by | Prep value |
|---|---|---|
| `tempo` | `grantPlays` or `draw` | **Always play first** — strictly free |
| `engine` | `createModule` | High — permanent board presence |
| `mobility` | `gainMove` | High — reach is prerequisite to everything |
| `bank` | `addCharge` with an `activate` that spends them | High, and wants charging *before* contact |
| `burst` | `attack` with a one-shot cost | Low in prep, high in combat |
| `control` | `attack` with `dmg: 0` and an `onSuccess` | Doctrine-dependent |
| `reactive` | passive with `onDamaged` / `onTargeted` | Play early, it defends passively |

## 4. Phase machine

```
PREP ──────────────► ENGAGE ──────────────► FINISH
 │                     │                      ▲
 │ all engine cards    │ doctrine drives      │ enemy core
 │ played, banks       │ range + targeting    │ is killable
 │ charged, enemy      │                      │
 │ still far           └──► RECOVER (cautious only)
 ▼                               shields low → withdraw, recharge
```

**PREP** — the AI is setting up, not fighting. Priorities in order:

1. Play every `tempo` card (free plays, no downside — never hold these)
2. Play `engine` and `mobility` cards
3. Play `bank` cards and **charge them** (Shield Generator to 2 charges, Asteroid Builder to 2)
4. Close only to `engagementRange + safetyMargin`, never inside the enemy envelope

Exits when: no engine/bank cards left worth playing **and** banks are charged to target,
**or** the enemy has closed inside our standoff band (forced engagement).

**ENGAGE** — doctrine takes over (§5).

**FINISH** — expected damage this turn ≥ enemy shield + core hull. Drop all caution,
ignore standoff, target the Core.

**RECOVER** — cautious only. Shields below 40% → break contact to outside enemy range,
spend turns recharging, return when shields are back above 70%.

## 5. Doctrines

Each doctrine answers three questions: **where do I want to be**, **what do I shoot**,
and **when do I leave this phase**.

### Cautious — hit and run
- **Band**: `theirMaxRange + 1` to `myMaxRange`. Sit at the outer edge of *my* envelope.
- If no such band exists (their reach ≥ mine), fight at my longest range and accept trades.
- **Shots**: prefer targets that reduce incoming damage — their weapons, then their engines.
- **Withdraw** when shields < 40%, return at > 70%.
- Never ends a turn inside enemy range if it has Move to avoid it.

### Aggressive — close and overwhelm
- **Band**: distance 1. Adjacency maximises short-range weapons (P.D. is 3 × 2 at range 2).
- **Shots**: maximum expected damage — deployables only if they block LoS.
- Ignores shields and withdrawal entirely.

### Tactical — build around one keystone
- Picks a **keystone** at first engagement: the highest-leverage card in play, scored by
  `leverage = effectValue × rangeFlexibility × repeatability`.
  Tract Beam scores highly — repeatable, long ranged, and it moves enemies out of position.
- **Band**: whatever keeps the keystone usable — its range, with LoS, every turn.
- **Shots**: whatever maximises the keystone's value. With Tract Beam that means dragging
  the target where our guns already point, not simply shooting the best module.
- Re-picks the keystone if it is destroyed or becomes unusable.

## 6. Pathfinding

The current greedy stepper is replaced by **BFS over formation translations**.

The fleet is a rigid shape. A translation `(dx, dy)` is legal when every module's destination
is empty or currently held by one of our own modules. BFS outward from `(0,0)` over the
lattice of reachable offsets, bounded by the smallest module Move budget, gives:

- true routing around asteroids, not a 3-square hack
- guaranteed formation integrity, so requirements are never broken by movement
- a set of reachable destinations to score

The doctrine scores each reachable offset and the commander walks to the best:

```
score(offset) = bandFit(offset)          how close to the doctrine's ideal distance
              + losBonus(offset)         can our guns see a target from there
              - exposure(offset)         how many enemy weapons bear on us
              + keystoneFit(offset)      tactical only
```

## 7. State the AI keeps between turns

`{ phase, doctrine, keystoneId, chargeTargets, lastKnownEnemyCore }` — persisted on the
commander, not in game state, so it survives without touching the engine.

## 8. Choosing a doctrine

At game start, from its own deck composition:

- mostly short range (P.D., SPEAR) → **Aggressive**
- has a repeatable control card (Tract Beam, Unwinder Array) → **Tactical**
- otherwise, and especially with a Shield Generator → **Cautious**

Recomputed once at the PREP → ENGAGE transition, when the board is known.
