# Hand Filter/Sort + Deck Management Bugfixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix five small hand/deck issues: default hand filter/sort, a "Deck All Cards" game action, import resetting turn phase, charge double-click playing the card, and a charge hover affordance.

**Architecture:** Pure client-side vanilla JS/HTML/CSS. The hand (`hand.html`) is an iframe in `board.html`; it renders a snapshot of the tech cards broadcast by the player sheet (`frigate.html`) over a `BroadcastChannel`. Deck state and charges live in `frigate.html`. `board.html` → `frigate.html` communication is done via `postMessage` to the `playerFrame` iframe (there is currently no board→sheet messages, so we add one).

**Tech Stack:** Vanilla HTML/CSS/JS, `BroadcastChannel`, `window.postMessage`. No build system, no test framework.

---

### Task 1: Default hand sort = State, default filter = Actionable

**Files:**
- Modify: `client/frigate-sheet/hand.html:73` (`var HAND_SORT`)
- Modify: `client/frigate-sheet/hand.html:76` (`var HAND_FILTERS`)
- Modify: `client/frigate-sheet/hand.html:29-34` (sort `<select>` markup)

**Step 1: Change default sort constant**

In `hand.html`, line 73:
```js
var HAND_SORT = 'az';
```
→
```js
var HAND_SORT = 'state';
```

**Step 2: Change default filter**

Line 76:
```js
var HAND_FILTERS = { hand:'', type:'', trait:'' };
```
→
```js
var HAND_FILTERS = { hand:'actionable', type:'', trait:'' };
```

**Step 3: Mark State as the selected sort option**

The sort `<select>` markup currently has no explicit `selected` (first option `az` wins). Change the State option so the dropdown matches `HAND_SORT` on first render:
```html
<option value="state">State</option>
```
→
```html
<option value="state" selected>State</option>
```

**Step 4: Verify**
- Open `http://localhost:8000/client/board.html` (or run `./run.sh`).
- Hand cards are ordered by state (deck → hand → played → exhausted → discarded → trashed).
- Filter badge shows `1`, only "actionable" cards visible (state not deck/discarded/trashed).

**Step 5: Commit**
```bash
git add client/frigate-sheet/hand.html
git commit -m "feat: default hand sort State + filter Actionable"
```
Skip this commit if implementing tasks together in one commit at the end.

---

### Task 2: "Deck All Cards" button under Settings → Game

**Files:**
- Modify: `client/board.html:52` (add button in Game submenu)
- Modify: `client/board.html` (~line 1297, after `gameAsteroidsBtn` wiring)
- Modify: `client/frigate-sheet/frigate.html` (add `deckAllCards()` + message listener)

**Step 1: Add the button**

In `board.html`, in the `gameMenu` submenu, immediately after the Asteroids button (line 52):
```html
<button type="button" class="settings-item" id="gameDeckAllBtn" title="Put all tech cards back into your deck and reset their charges to 0">Deck All Cards</button>
```

**Step 2: Wire the button**

After the `gameAsteroidsBtn` handler (line 1294-1297):
```js
document.getElementById('gameDeckAllBtn').addEventListener('click', function () {
  closeSettingsMenu();
  var pf = document.getElementById('playerFrame');
  if (pf && pf.contentWindow) {
    pf.contentWindow.postMessage({ t: 'deckall' }, '*');
  }
});
```

**Step 3: Handle the message in the sheet**

In `frigate.html`, add a `deckAllCards()` function immediately after `boardSaveRefresh()` (line 960-962):
```js
function deckAllCards(){
  var grid = document.getElementById('techGrid');
  if(!grid) return;
  for(var i=0;i<grid.children.length;i++){
    var card = grid.children[i];
    setTechState(card, 'deck');
    var inp = card.querySelector('.tcharges-input');
    if(inp) inp.value = '0';
    refreshTechSections(card);
  }
  handBroadcast();
  broadcastHullStats();
  scheduleSheetAutosave();
  boardSaveRefresh();
}
window.addEventListener('message', function(e){
  var m = e.data;
  if(!m || typeof m !== 'object' || m.t !== 'deckall') return;
  deckAllCards();
});
```

**Step 4: Verify**
- Settings → Game → Deck All Cards.
- In the hand: every card shows `deck` state, charge chips read `0`.
- Sheet grid: all tech cards show deck state and charges `0`.

**Step 5: Commit**

```bash
git add client/board.html client/frigate-sheet/frigate.html
git commit -m "feat: Deck All Cards action under settings/game"
```

---

### Task 3: Import resets to the new-turn state

**Files:**
- Modify: `client/frigate-sheet/frigate.html:1809` (`applySheet`)

**Step 1: Post turn phase after writeTech**

In `applySheet`, immediately after `writeTech(json.tech);` (line 1809):
```js
if(HAND_CHANNEL) HAND_CHANNEL.postMessage({ t:'turn', phase:'new' });
```
(This is a no-op during initial page-load restore because `HAND_CHANNEL` is still `null`, but on a live import the hand flips back to "New Turn".)

**Step 2: Verify**
- In the hand, click **New Turn** so the button reads **End Turn**.
- Settings → Export then re-Import the sheet JSON.
- The hand button reads **New Turn** again, and the next click performs a fresh draw.

**Step 3: Commit**

```bash
git add client/frigate-sheet/frigate.html
git commit -m "fix: importing a deck resets hand to new-turn state"
```

---

### Task 4: Charge double-click no longer plays the card

**Files:**
- Modify: `client/frigate-sheet/hand.html:160-163` (`dblclick` handler)

**Step 1: Guard the dblclick handler**

The card's `dblclick` bubbles up from the charge chip (which already stops `click` propagation but not `dblclick`), so a fast double-click on charges increments twice *and* activates/plays the card. Ignore dblclicks originating on the charge chip:
```js
el.addEventListener('dblclick', function(e){
  e.preventDefault();
  if(e.target && e.target.closest && e.target.closest('.hc-charges')) return;
  if(onActivate) onActivate();
});
```

**Step 2: Verify**
- Click the charge chip twice quickly.
- Charge value rises by 2.
- Card state stays the same (does **not** become `played`).
- Double-click on the card body still plays it.

**Step 3: Commit**

```bash
git add client/frigate-sheet/hand.html
git commit -m "fix: double-clicking charges no longer plays the card"
```

---

### Task 5: Charge chip hover affordance

**Files:**
- Modify: `client/frigate-sheet/css/hand.css:444-457` (`.hc-charges`)

**Step 1: Add transition to the base chip**

In `.hand-card .hc-charges`, add a smooth transition:
```css
transition:transform .12s ease, filter .12s ease;
```

**Step 2: Add the hover state**

After the base `.hand-card .hc-charges` block (and the `svg` rule), add:
```css
.hand-card .hc-charges:hover{
  transform:scale(1.15);
  filter:brightness(1.35) saturate(1.15);
  box-shadow:0 0 6px var(--icon-charged);
}
```

**Step 3: Verify**
- Hovering the charge chip on any hand card scales it up ~15% and brightens it.
- Non-hovered chips are unaffected.

**Step 4: Commit**

```bash
git add client/frigate-sheet/css/hand.css
git commit -m "feat: charge chip hover highlight in hand"
```

---

## Verification (manual, no test runner exists)

No automated tests in this project (pure static HTML/JS served by PHP). Verify end-to-end in the browser:

1. `./run.sh` (or reuse a running instance) and open `http://localhost:8000/client/board.html`.
2. **Task 1:** Hand opens sorted by State; only actionable cards shown; filter badge = 1.
3. **Task 2:** Settings → Game → Deck All Cards → all cards in deck, charges `0`.
4. **Task 3:** With hand in "End Turn" phase, Export then Import the sheet → button returns to "New Turn".
5. **Task 4:** Double-click charge chip → charges +2, card not played; card double-click still plays.
6. **Task 5:** Hover charge chip → scales + brightens.

## Notes
- `docs/plans/2026-09-08-gameplay-board-features.md` is currently untracked; do not include it in commits.
- Server log: `/tmp/frigate-server.log` (WSL/bash environment only).