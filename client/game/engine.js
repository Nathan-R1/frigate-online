/* Frigate game engine. Pure state and rules — no DOM, no rendering.
   Loaded after tech-presets.js, mod-presets.js and card-effects.js.

   The one structural idea: effects are a queue of ops, and any op that needs a decision
   parks the queue in G.pending and returns. The UI (or the AI policy) answers the prompt
   and calls Engine.resolve(answer), which resumes the same queue. There is exactly one
   rules path, whoever is deciding. */
var Engine = (function () {
  'use strict';

  /* ---- rules constants ---- */
  var RULES = { attackDie: 6, attackHitsOn: 5,   /* d6, a 5 or 6 hits */
                checkDie: 12, dc: 7,             /* d12 + skill, 7 or higher succeeds */
                boardSize: 24, asteroidPct: 0.10, coreClearance: 3,
                asteroidHull: 3 };               /* terrain can be shot away */

  var G = null;                 // the live game
  var listeners = [];
  function onChange(fn) { listeners.push(fn); }
  function emit() { for (var i = 0; i < listeners.length; i++) listeners[i](G); }

  /* Log lines are coloured by side. That is the active seat almost always, but not during
     setup, where every side deploys its Starter Cards before anyone's turn has begun —
     `speaker` names who is acting while that is true. */
  var speaker = null;
  function log(msg) {
    G.log.push({ turn: G.turn, side: speaker === null ? G.active : speaker, msg: msg });
  }
  function uid(p) { return p + '_' + (G.seq++); }
  function key(x, y) { return x + ',' + y; }
  function findTech(n) { for (var i = 0; i < TECH_PRESETS.length; i++) if (TECH_PRESETS[i].name === n) return TECH_PRESETS[i]; return null; }
  function findMod(n) { for (var i = 0; i < MOD_PRESETS.length; i++) if (MOD_PRESETS[i].name === n) return MOD_PRESETS[i]; return null; }
  function fx(name, kind) { return (CARD_EFFECTS[kind] || {})[name] || {}; }
  function num(v, d) { var n = parseInt(v, 10); return isNaN(n) ? (d || 0) : n; }

  /* ---- derived stats, mirroring frigate.html ---- */
  function skill(s, n) { return Math.max(0, num(s.skills[n], 0)); }
  function speedOf(s) { return Math.max(1, skill(s, 'Navigation')); }
  function sensorsOf(s) { return 2 * skill(s, 'Sensors'); }
  function drawCountOf(s) { return num(s.stats.drawDrawBase, 4) + skill(s, 'Cyber'); }
  function playCountOf(s) { return num(s.stats.drawPlayBase, 1); }
  function storageCapOf(s) { return skill(s, 'Logistics'); }
  function capacityCapOf(s) { return skill(s, 'Leadership'); }

  /* ---- geometry: square grid, chebyshev distance (diagonals cost 1) ---- */
  /* Manhattan throughout, matching board.html's distance readout. A diagonal neighbour is
     2 away, so "adjacent" means orthogonal and "2 spaces from Core" clears the orthogonals. */
  function dist(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }
  var stepDist = dist;
  function adjacent(a, b) { return dist(a, b) === 1; }
  function cellAt(x, y) { return G.cells[key(x, y)] || null; }
  function occupy(x, y, ref) { G.cells[key(x, y)] = ref; }
  function vacate(x, y) { delete G.cells[key(x, y)]; }
  function inBounds(x, y) { return x >= 0 && y >= 0 && x < RULES.boardSize && y < RULES.boardSize; }

  /* ---- line of sight: centre to centre; any occupied square in between blocks.
     Ported from board.html lineBlocked(), with every occupant counting as a blocker. ---- */
  function lineBlocked(sx, sy, tx, ty) {
    var x0 = sx + 0.5, y0 = sy + 0.5, x1 = tx + 0.5, y1 = ty + 0.5;
    var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    var stepX = x0 < x1 ? 1 : -1, stepY = y0 < y1 ? 1 : -1;
    var err = dx + dy, cx = sx, cy = sy, guard = 0;
    while (guard++ < 4096) {
      if ((cx !== sx || cy !== sy) && (cx !== tx || cy !== ty) && cellAt(cx, cy)) return true;
      if (cx === tx && cy === ty) break;
      var e2 = 2 * err, stepped = false;
      if (e2 >= dy) { err += dy; cx += stepX; stepped = true; }
      if (e2 <= dx) { err += dx; cy += stepY; stepped = true; }
      if (!stepped) break;
    }
    return false;
  }
  function hasLos(a, b) { return !lineBlocked(a.x, a.y, b.x, b.y); }

  /* ================= setup ================= */
  function defaultSkills() {
    return { Cyber: 1, Diplomacy: 0, Engineering: 3, Leadership: 0,
             Logistics: 2, Navigation: 3, Piloting: 3, Sensors: 2, Science: -1 };
  }

  /* deckList: array of tech names (repeats allowed) */
  function makeSide(name, opts) {
    opts = opts || {};
    var s = {
      name: name,
      skills: Object.assign(defaultSkills(), opts.skills || {}),
      stats: Object.assign({ hullBase: 5, shieldBase: 6, drawPlayBase: 1, drawDrawBase: 4 }, opts.stats || {}),
      shield: 0, shieldMax: 0,
      deck: [], hand: [], played: [], discard: [], trash: [],
      cards: {}, modules: {}, deployables: {},
      coreId: null, moveLeft: 0, playsLeft: 0, statuses: {}
    };
    s.shieldMax = num(s.stats.shieldBase, 6);
    s.shield = s.shieldMax;
    return s;
  }

  /* A deck entry is a name, or { name, traits } when the sheet has given this particular copy
     traits of its own. Promoting one Cannon Unit to a Starter Card must not promote the other
     three, so traits live on the copy and fall back to the preset. */
  function addCardToDeck(s, entry) {
    var techName = (entry && entry.name) || entry;
    var t = findTech(techName); if (!t) return null;
    var id = uid('c');
    s.cards[id] = { id: id, name: techName, charges: 0, heat: 0, exhausted: false,
                    durations: [], owner: s.idx };
    if (entry && entry.traits !== undefined && entry.traits !== null) s.cards[id].traits = entry.traits;
    s.deck.push(id);
    return id;
  }

  function placeModule(s, modName, x, y) {
    var m = findMod(modName); if (!m) return null;
    if (!inBounds(x, y) || cellAt(x, y)) return null;
    var id = uid('m');
    var hull = num(m.hull, 1);
    s.modules[id] = { id: id, name: modName, x: x, y: y, hull: hull, hullMax: hull,
                      exhausted: false, tokens: {}, charges: num(m.charges, 0),
                      moveLeft: 0, owner: s.idx };
    occupy(x, y, { kind: 'module', owner: s.idx, id: id });
    return id;
  }

  function placeDeployable(s, depName, x, y) {
    var m = findMod(depName); if (!m) return null;
    if (!inBounds(x, y) || cellAt(x, y)) return null;
    var id = uid('d');
    s.deployables[id] = { id: id, name: depName, x: x, y: y, hull: num(m.hull, 1),
                          speed: num(m.speed, 0), charges: num(m.charges, 0), owner: s.idx };
    occupy(x, y, { kind: 'deployable', owner: s.idx, id: id });
    return id;
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* two sides face off across the middle; three or four take corners */
  function spawnPoints(n) {
    var m = RULES.boardSize, lo = 5, hi = m - 6, mid = Math.floor(m / 2);
    if (n <= 2) return [{ x: lo, y: mid }, { x: hi, y: mid }];
    return [{ x: lo, y: lo }, { x: hi, y: hi }, { x: hi, y: lo }, { x: lo, y: hi }];
  }

  /* newGame(configArray) — 2 to 4 sides. Each config may carry { name, team, ai, deck, modules }.
     A side with no team is its own team, so the default is a free-for-all. */
  function newGame(configs) {
    if (!Array.isArray(configs)) configs = Array.prototype.slice.call(arguments);
    configs = configs.slice(0, 4);
    G = { turn: 1, active: 0, phase: 'upkeep', cells: {}, players: [], pending: null,
          log: [], seq: 1, over: null, queue: [], asteroids: {} };
    var pts = spawnPoints(configs.length);
    configs.forEach(function (cfg, i) {
      var s = makeSide(cfg.name, cfg);
      s.idx = i;
      s.team = (cfg.team === undefined || cfg.team === null) ? i : cfg.team;
      s.ai = !!cfg.ai;
      s.dead = false;
      G.players.push(s);
      var p = pts[i] || pts[0];
      s.coreId = placeModule(s, 'Core', p.x, p.y);
      (cfg.modules || []).forEach(function (mn, k) {
        var spot = freeAdjacent(s, p.x, p.y, k);
        if (spot) placeModule(s, mn, spot.x, spot.y);
      });
      (cfg.deck || []).forEach(function (tn) { addCardToDeck(s, tn); });
      shuffle(s.deck);
    });
    scatterAsteroids();
    /* Anything in the deck carrying the Starter Card trait is played before combat, which is
       how a ship arrives with a hull already built rather than a bare Core. */
    G.setup = true;
    G.players.forEach(function (pl) {
      speaker = pl.idx;
      playStarterCards(pl);
    });
    speaker = null;
    G.setup = false;
    log(G.players.length + '-player game start.');
    startTurn();
    return G;
  }

  /* the presets spell it "Starter Card"; accept "Starting Card" too so a card tagged either
     way deploys rather than silently sitting in the deck */
  function hasStarterTrait(traits) { return /start(?:er|ing)\s*card/i.test(traits || ''); }
  function isStarterCard(name) {
    var t = findTech(name);
    return !!t && hasStarterTrait(t.traits);
  }
  /* a copy's own traits win over the preset's, so a promoted copy deploys and its siblings do not */
  function cardIsStarter(card) {
    if (!card) return false;
    if (card.traits !== undefined && card.traits !== null) return hasStarterTrait(card.traits);
    return isStarterCard(card.name);
  }

  function playStarterCards(s) {
    s.deck.slice().forEach(function (id) {
      var card = s.cards[id];
      if (!card || !cardIsStarter(card)) return;
      var i = s.deck.indexOf(id);
      if (i >= 0) s.deck.splice(i, 1);
      s.played.push(id);
      log(s.name + ' deploys ' + card.name + ' before combat.');
      run(fx(card.name, 'tech').onPlay || [], { side: s, card: card });
    });
  }

  /* ---- who is on whose side ---- */
  function alive(s) { return s && !s.dead && !!s.modules[s.coreId]; }
  function enemiesOf(s) {
    return G.players.filter(function (o) { return o.idx !== s.idx && o.team !== s.team && alive(o); });
  }
  function alliesOf(s) {
    return G.players.filter(function (o) { return o.idx !== s.idx && o.team === s.team && alive(o); });
  }
  function teamsAlive() {
    var t = {};
    G.players.forEach(function (s) { if (alive(s)) t[s.team] = true; });
    return Object.keys(t);
  }

  /* 10% of the interior, keeping the border clear and leaving each ship room to deploy */
  function scatterAsteroids() {
    var size = RULES.boardSize, cand = [];
    var cores = G.players.map(function (s) { return s.modules[s.coreId]; }).filter(Boolean);
    for (var y = 1; y < size - 1; y++) for (var x = 1; x < size - 1; x++) {
      if (cellAt(x, y)) continue;
      var tooClose = cores.some(function (c) { return dist({ x: x, y: y }, c) <= RULES.coreClearance; });
      if (tooClose) continue;
      cand.push({ x: x, y: y });
    }
    var count = Math.max(1, Math.round(size * size * RULES.asteroidPct)), placed = 0;
    while (placed < count && cand.length) {
      var c = cand.splice(Math.floor(Math.random() * cand.length), 1)[0];
      if (cellAt(c.x, c.y)) continue;
      addAsteroid(c.x, c.y);
      placed++;
    }
    log(placed + ' asteroids scattered.');
  }

  function addAsteroid(x, y) {
    if (!inBounds(x, y) || cellAt(x, y)) return null;
    var id = uid('a');
    G.asteroids[id] = { id: id, name: 'Asteroid', x: x, y: y,
                        hull: RULES.asteroidHull, hullMax: RULES.asteroidHull, asteroid: true };
    occupy(x, y, { kind: 'asteroid', id: id });
    return id;
  }
  function damageAsteroid(a, amount) {
    if (!a || amount <= 0) return 0;
    a.hull -= amount;
    log('Asteroid takes ' + amount + ' damage.');
    if (a.hull <= 0) { log('Asteroid is destroyed.'); vacate(a.x, a.y); delete G.asteroids[a.id]; }
    return amount;
  }

  function freeAdjacent(s, cx, cy, seed) {
    var ring = [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
    for (var r = 1; r < 5; r++) {
      for (var i = 0; i < ring.length; i++) {
        var o = ring[(i + (seed || 0)) % ring.length];
        var x = cx + o[0] * r, y = cy + o[1] * r;
        if (inBounds(x, y) && !cellAt(x, y)) return { x: x, y: y };
      }
    }
    return null;
  }

  /* ================= turn loop ================= */
  function side() { return G.players[G.active]; }
  /* the nearest living enemy, used wherever a single opposing side is needed */
  function foe(s) {
    s = s || side();
    var list = enemiesOf(s);
    if (!list.length) return G.players[(s.idx + 1) % G.players.length];
    var mine = s.modules[s.coreId];
    if (!mine) return list[0];
    var best = list[0], bd = 1e9;
    list.forEach(function (o) {
      var c = o.modules[o.coreId];
      if (!c) return;
      var d = dist(mine, c);
      if (d < bd) { bd = d; best = o; }
    });
    return best;
  }

  /* Everything a side spent comes back the moment its turn ends, not when its next one
     begins, so a fleet reads as ready all the way round the table instead of sitting greyed
     out through everyone else's turn. */
  function refresh(s) {
    Object.keys(s.cards).forEach(function (id) { s.cards[id].exhausted = false; });
    Object.keys(s.modules).forEach(function (id) { s.modules[id].exhausted = false; });
    Object.keys(s.deployables).forEach(function (id) { s.deployables[id].exhausted = false; });
  }

  function startTurn() {
    var s = side();
    G.phase = 'upkeep';
    tickDurations(s);
    s.moveLeft = 0;
    s.playsLeft = playCountOf(s);
    log(s.name + ' begins turn ' + G.turn + '.');
    G.phase = 'draw';
    drawCards(s, drawCountOf(s) - s.hand.length > 0 ? drawCountOf(s) - s.hand.length : 0);
    G.phase = 'play';
    emit();
  }

  /* leaving the play phase discards whatever is still in hand */
  function endPlayPhase() {
    if (G.phase !== 'play') return false;
    var s = side();
    if (s.hand.length) {
      log(s.name + ' discards ' + s.hand.length + ' card(s) from hand.');
      s.discard = s.discard.concat(s.hand);
      s.hand = [];
    }
    s.playsLeft = 0;
    G.phase = 'action';
    emit();
    return true;
  }

  /* ---- presentation channel ----
     Purely for the view: an actor may announce what it is about to do so the board can show
     it before it happens. Nothing here changes game state, and with no listener attached the
     announcement is a no-op. `telegraph` lets an actor ask whether anyone is watching, so a
     headless run never pays for the pause. */
  var watchers = [];
  function onAnnounce(fn) { watchers.push(fn); }
  function announce(e) { for (var i = 0; i < watchers.length; i++) watchers[i](e); }
  var telegraphOn = true;
  function setTelegraph(on) { telegraphOn = !!on; }
  function telegraph() { return telegraphOn && watchers.length > 0; }

  function nextLiving(from) {
    var n = G.players.length;
    for (var i = 1; i <= n; i++) {
      var k = (from + i) % n;
      if (alive(G.players[k])) return k;
    }
    return from;
  }

  function endTurn() {
    if (G.over) return;
    clearUndo();
    G.pending = null; G.queue = [];
    var s = side();
    failingModules(s).forEach(function (m) {
      log(m.name + ' does not meet its requirement and breaks apart.');
      destroyModule(s, m);
    });
    if (G.over) { emit(); return; }
    Object.keys(s.modules).forEach(function (id) { s.modules[id].moveLeft = 0; });
    s.moveLeft = 0;
    refresh(s);
    log(s.name + ' ends turn.');
    var nxt = nextLiving(G.active);
    if (nxt <= G.active) G.turn++;        /* wrapped past the end of the order */
    G.active = nxt;
    startTurn();
  }

  function tickDurations(s) {
    Object.keys(s.cards).forEach(function (id) {
      s.cards[id].durations = (s.cards[id].durations || []).filter(function (d) { return --d.turns > 0; });
    });
    s.statuses = {};
  }

  function drawCards(s, n) {
    for (var i = 0; i < n; i++) {
      if (!s.deck.length) {
        if (!s.discard.length) break;
        s.deck = shuffle(s.discard.slice()); s.discard = [];
        log(s.name + ' reshuffles the discard pile.');
      }
      var id = s.deck.shift();
      if (id) s.hand.push(id);
    }
  }

  /* ================= dice ================= */
  function die(n) { return 1 + Math.floor(Math.random() * n); }
  function roll6() { return die(6); }
  /* an attack is a flat d6 — no skill applies */
  function attackRoll() {
    var r = die(RULES.attackDie);
    return { roll: r, hit: r >= RULES.attackHitsOn, text: 'd6=' + r };
  }
  /* a check is d12 + the named skill against DC 7 */
  function check(s, skillName, dc) {
    var mod = skillName ? skill(s, skillName) : 0;
    var r = die(RULES.checkDie), t = r + mod, d = dc || RULES.dc;
    return { roll: r, mod: mod, total: t, dc: d, hit: t >= d,
             text: 'd12=' + r + (mod ? '+' + mod : '') + ' vs ' + d };
  }

  /* ================= damage ================= */
  function damageModule(targetSide, mod, amount) {
    if (!mod || amount <= 0) return 0;
    var absorbed = Math.min(targetSide.shield, amount);
    targetSide.shield -= absorbed;
    var rest = amount - absorbed;
    mod.hull -= rest;
    if (absorbed) log(targetSide.name + "'s shields absorb " + absorbed + '.');
    if (rest) log(targetSide.name + "'s " + mod.name + ' takes ' + rest + ' hull damage.');
    if (mod.hull <= 0) destroyModule(targetSide, mod);
    checkWin();
    return rest;
  }

  /* deployables sit outside the shield envelope, so damage lands straight on their hull */
  function damageDeployable(s, dep, amount) {
    if (!dep || amount <= 0) return 0;
    dep.hull -= amount;
    log(s.name + "'s " + dep.name + ' takes ' + amount + ' damage.');
    if (dep.hull <= 0) {
      log(s.name + "'s " + dep.name + ' is destroyed.');
      vacate(dep.x, dep.y);
      delete s.deployables[dep.id];
    }
    return amount;
  }

  function destroyModule(s, mod) {
    log(s.name + "'s " + mod.name + ' is destroyed.');
    vacate(mod.x, mod.y);
    delete s.modules[mod.id];
    checkWin();
  }

  function checkWin() {
    if (G.over) return true;
    /* mark anyone whose Core is gone as out, then see how many teams remain */
    G.players.forEach(function (s) {
      if (!s.dead && !s.modules[s.coreId]) {
        s.dead = true;
        /* the rest of the hull goes with the Core, so the wreck stops blocking the board */
        Object.keys(s.modules).forEach(function (id) {
          var m = s.modules[id]; vacate(m.x, m.y); delete s.modules[id];
        });
        Object.keys(s.deployables).forEach(function (id) {
          var d = s.deployables[id]; vacate(d.x, d.y); delete s.deployables[id];
        });
        s.moveLeft = 0;
        log(s.name + ' is eliminated — their Core is destroyed.');
      }
    });
    var teams = teamsAlive();
    if (teams.length <= 1) {
      var winners = G.players.filter(alive);
      G.over = { winners: winners.map(function (s) { return s.idx; }),
                 team: teams.length ? +teams[0] : null };
      G.phase = 'over';
      log(winners.length
        ? winners.map(function (s) { return s.name; }).join(' and ') +
          (winners.length > 1 ? ' win.' : ' wins.')
        : 'Everyone is destroyed.');
      return true;
    }
    return false;
  }

  /* ================= op queue with prompts ================= */
  function enqueue(ops, ctx) {
    G.queue = (ops || []).map(function (o) { return { op: o, ctx: ctx }; }).concat(G.queue);
  }
  function run(ops, ctx) { enqueue(ops, ctx); step(); }

  function step() {
    while (!G.pending && G.queue.length && !G.over) {
      var item = G.queue.shift();
      exec(item.op, item.ctx);
    }
    /* checked here, not inside playCard, so a card that grants extra plays keeps the phase open */
    if (!G.pending && !G.queue.length && !G.over &&
        G.phase === 'play' && side().playsLeft <= 0) endPlayPhase();
    emit();
  }

  function prompt(p) { G.pending = p; emit(); }

  function resolve(answer) {
    var p = G.pending;
    if (!p) return;
    G.pending = null;
    if (p.onResolve) p.onResolve(answer);
    step();
    /* the activation is over once nothing more is waiting on the player: commit it */
    if (!G.pending && !G.queue.length) clearUndo();
  }

  function cancel() { G.pending = null; G.queue = []; emit(); }

  /* ================= undo point =================
     An activation the player may still back out of. It covers everything moving can touch:
     where the pieces stand, what was exhausted or spent to get them moving, and any
     deployable overrun along the way. A computer seat never backs out, so it never pays for
     the copy. */
  var undoPoint = null;
  function copy(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

  function beginUndo(label) {
    var s = side();
    if (s.ai) { undoPoint = null; return; }
    /* Every side's pieces, not just yours: a tractor beam shoves an enemy module or a rock,
       and taking the activation back has to put those where they stood too. */
    undoPoint = {
      label: label, active: G.active, turn: G.turn,
      cells: copy(G.cells), moveLeft: s.moveLeft, playsLeft: s.playsLeft, shield: s.shield,
      cards: copy(s.cards), asteroids: copy(G.asteroids),
      modules: G.players.map(function (pl) { return copy(pl.modules); }),
      deployables: G.players.map(function (pl) { return copy(pl.deployables); }),
      shields: G.players.map(function (pl) { return pl.shield; })
    };
  }
  function clearUndo() { undoPoint = null; }
  function canUndo() {
    return !!undoPoint && undoPoint.active === G.active && undoPoint.turn === G.turn;
  }

  /* Put everything back as it stood before the activation and throw away what was queued. */
  function undo() {
    if (!canUndo()) return false;
    var u = undoPoint, s = G.players[u.active];
    G.cells = u.cells;
    G.asteroids = u.asteroids;
    s.moveLeft = u.moveLeft; s.playsLeft = u.playsLeft;
    s.cards = u.cards;
    G.players.forEach(function (pl, i) {
      pl.modules = u.modules[i];
      pl.deployables = u.deployables[i];
      pl.shield = u.shields[i];
    });
    G.pending = null; G.queue = [];
    undoPoint = null;
    log(s.name + ' cancels ' + u.label + '.');
    emit();
    return true;
  }

  /* ---- op implementations ---- */
  var OPS = {};

  OPS.createModule = function (o, ctx) {
    var s = ctx.side;
    if (G.setup) {
      /* deploying before the game begins: berth it ourselves, nearest the Core */
      var cell = firstLegalCell(s, o.module);
      if (cell) { placeModule(s, o.module, cell.x, cell.y); log(s.name + ' deploys ' + o.module + '.'); }
      else log(s.name + ' has nowhere to berth ' + o.module + '.');
      return;
    }
    prompt({ kind: 'space', label: 'Place ' + o.module, filter: placementFilter(s, o.module),
      onResolve: function (cell) {
        if (cell) { placeModule(s, o.module, cell.x, cell.y); log(s.name + ' builds ' + o.module + '.'); }
      } });
  };

  /* the legal berth closest to the Core, searched outward so a hull grows in a tight cluster */
  function firstLegalCell(s, modName) {
    var ok = placementFilter(s, modName);
    var core = s.modules[s.coreId];
    if (!core) return null;
    var best = null, bd = 1e9;
    for (var r = 1; r <= 6; r++) {
      for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) {
        var x = core.x + dx, y = core.y + dy;
        if (!ok(x, y)) continue;
        var d = Math.abs(dx) + Math.abs(dy);
        if (d < bd) { bd = d; best = { x: x, y: y }; }
      }
      if (best) return best;
    }
    return null;
  }

  OPS.createDeployable = function (o, ctx) {
    var s = ctx.side;
    prompt({ kind: 'space', label: 'Deploy ' + o.deployable, filter: deployFilter(s),
      onResolve: function (cell) {
        if (cell) { placeDeployable(s, o.deployable, cell.x, cell.y); log(s.name + ' deploys ' + o.deployable + '.'); }
      } });
  };

  /* everything a given side is allowed to shoot at, across every enemy team plus the rocks */
  function hostileObjects(s) {
    var pool = Object.keys(G.asteroids).map(function (id) { return G.asteroids[id]; });
    enemiesOf(s).forEach(function (e) {
      Object.keys(e.modules).forEach(function (id) { pool.push(e.modules[id]); });
      Object.keys(e.deployables).forEach(function (id) { pool.push(e.deployables[id]); });
    });
    return pool;
  }

  /* resolve an object id back to the thing and whoever owns it */
  function objectById(id) {
    if (G.asteroids[id]) return { obj: G.asteroids[id], kind: 'asteroid', owner: null };
    for (var i = 0; i < G.players.length; i++) {
      var p = G.players[i];
      if (p.modules[id]) return { obj: p.modules[id], kind: 'module', owner: p };
      if (p.deployables[id]) return { obj: p.deployables[id], kind: 'deployable', owner: p };
    }
    return null;
  }

  /* Everything a friendly beam may take hold of: your own hull and drones, and your allies'.
     A tractor beam does not care whose module it is pulling. */
  function friendlyObjects(s) {
    var out = [];
    [s].concat(alliesOf(s)).forEach(function (f) {
      Object.keys(f.modules).forEach(function (id) { out.push(f.modules[id]); });
      Object.keys(f.deployables).forEach(function (id) { out.push(f.deployables[id]); });
    });
    return out;
  }

  OPS.attack = function (o, ctx) {
    var s = ctx.side;
    var origins = attackOrigins(s, o, ctx);
    var reach = resolveRange(s, o.range);
    var pool = o.targets === 'any' ? hostileObjects(s).concat(friendlyObjects(s)) : hostileObjects(s);
    var targets = pool.filter(function (m) {
      /* a beam cannot grab the very module it is firing from */
      if (ctx.module && m.id === ctx.module.id) return false;
      return origins.some(function (or) { return dist(or, m) <= reach && hasLos(or, m); });
    });
    if (!targets.length) { log(s.name + ' has no target in range with line of sight.'); return; }
    prompt({ kind: 'target', label: 'Choose a target', targets: targets.map(function (m) { return m.id; }),
      envelope: firingEnvelope(origins, reach),
      onResolve: function (targetId) {
        var t = objectById(targetId);
        if (!t) return;
        /* name the piece that actually fires: the origin nearest the target that can see it */
        var from = null, fd = 1e9;
        origins.forEach(function (or) {
          var d = dist(or, t.obj);
          if (d <= reach && hasLos(or, t.obj) && d < fd) { fd = d; from = or; }
        });
        var n = resolveCount(s, o.attacks, ctx);
        var dmg = resolveCount(s, o.dmg, ctx);
        var hit = false;
        /* A check is a piloting problem, not a duel: aiming at your own hull or an ally's,
           nobody is trying to slip the beam, so it simply lands. */
        var friendly = !!t.owner && t.owner.team === s.team;
        /* The dice are about to be cast, so the activation can no longer be taken back. A
           rider's prompt may still be cancelled, but that cancels only the rider — the cost
           stays paid and the card stays exhausted. */
        clearUndo();
        /* a zero-damage beam is not an attack, and reads oddly as one when it grabs your own hull */
        log(s.name + (dmg > 0 ? ' attacks with ' : ' locks on with ') +
            (from ? from.name + ' ' + at(from) : 'its hull') +
            ' targeting ' + labelOf(t) + ' ' + at(t.obj) +
            (dmg > 0 ? ' — ' + n + (n === 1 ? ' attack, ' : ' attacks, ') + dmg + ' damage each.'
                     : '.'));
        for (var i = 0; i < n; i++) {
          /* a card naming a Check rolls d12 + that skill; everything else is a flat d6 */
          var c = (o.check && friendly) ? { hit: true, text: o.check + ' — no resistance' }
                : o.check ? check(s, o.check, RULES.dc) : attackRoll();
          if (c.hit) {
            log('  ' + c.text + ' — hit.');
            if (dmg > 0) {
              if (t.kind === 'asteroid') damageAsteroid(t.obj, dmg);
              else if (t.kind === 'deployable') damageDeployable(t.owner, t.obj, dmg);
              else damageModule(t.owner, t.obj, dmg);
            }
            /* riders such as a tractor beam's shove run once, on the first hit that lands.
               Queued rather than run, because we are inside the prompt being resolved. */
            if (o.onSuccess && !hit) {
              hit = true;
              var sub = {}; for (var k in ctx) sub[k] = ctx[k];
              sub.target = objectById(targetId);
              enqueue(o.onSuccess, sub);
            }
          } else log('  ' + c.text + ' — miss.');
          if (!objectById(targetId)) break;
        }
      } });
  };

  /* Every square this shot can see: in range of some origin, with a clear line to it. Worked
     out once when the prompt opens so the board can shade it without re-tracing lines on each
     repaint, and skipped entirely when nothing is watching. */
  function firingEnvelope(origins, reach) {
    if (!telegraph() || !origins.length) return null;
    var out = {}, n = RULES.boardSize;
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      for (var i = 0; i < origins.length; i++) {
        var o = origins[i];
        if (Math.abs(o.x - x) + Math.abs(o.y - y) > reach) continue;
        if (!hasLos(o, { x: x, y: y })) continue;
        out[x + ',' + y] = true;
        break;
      }
    }
    return out;
  }

  function at(o) { return o ? '(' + o.x + ',' + o.y + ')' : ''; }
  function labelOf(t) {
    if (!t) return 'nothing';
    if (t.kind === 'asteroid') return 'an asteroid';
    return t.owner.name + "'s " + t.obj.name;
  }

  OPS.gainMove = function (o, ctx) {
    var s = ctx.side;
    /* Move N is N for EACH module. "gain N Move for each module" is therefore just N —
       multiplying by the module count here would apply the same factor twice. */
    var n = (o.from === 'stat' && o.stat === 'speed') ? speedOf(s) : resolveCount(s, o.n, ctx);
    Object.keys(s.modules).forEach(function (id) { s.modules[id].moveLeft += n; });
    s.moveLeft = n;
    log(s.name + ' gains Move ' + n + ' per module.');
    prompt({ kind: 'move', label: 'Move your modules — ' + n + ' each',
      /* Done means done: unspent Move is lost rather than banked onto the next engine */
      onResolve: function () {
        Object.keys(s.modules).forEach(function (id) { s.modules[id].moveLeft = 0; });
        s.moveLeft = 0;
      } });
  };

  OPS.gainShield = function (o, ctx) {
    var s = ctx.side, n = resolveCount(s, o.n, ctx);
    function give(p) {
      p.shield = Math.min(p.shieldMax, p.shield + n);
      log(p.name + ' gains ' + n + ' shield.');
    }
    if (o.target !== 'choose') { give(s); return; }
    /* "an allied ship within Sensor range from this" — measured from the module doing it, and
       your own ship counts, since you are on your own team. A ship is in range when any of
       its modules is. */
    var from = ctx.module || ctx.deployable || s.modules[s.coreId];
    if (!from) { give(s); return; }
    var reach = sensorsOf(s);
    var picks = [s].concat(alliesOf(s)).filter(function (p) {
      return Object.keys(p.modules).some(function (id) { return dist(from, p.modules[id]) <= reach; });
    });
    if (!picks.length) { log(s.name + ' has no ship in Sensor range to shield.'); return; }
    if (picks.length === 1) { give(picks[0]); return; }
    prompt({ kind: 'choice', label: 'Shield which ship?',
      options: picks.map(function (p) { return p.name + ' — ' + p.shield + '/' + p.shieldMax; }),
      onResolve: function (i) { if (picks[i]) give(picks[i]); } });
  };

  OPS.gainHull = function (o, ctx) {
    var s = ctx.side, n = resolveCount(s, o.n, ctx);
    var m = o.target === 'core' ? s.modules[s.coreId] : null;
    if (m) { m.hull += n; if (o.mayExceed) m.hullMax = Math.max(m.hullMax, m.hull); log(s.name + ' gains ' + n + ' Hull.'); }
  };

  OPS.draw = function (o, ctx) { drawCards(ctx.side, resolveCount(ctx.side, o.n, ctx)); log(ctx.side.name + ' draws ' + o.n + '.'); };
  OPS.grantPlays = function (o, ctx) { ctx.side.playsLeft += resolveCount(ctx.side, o.n, ctx); log('+' + o.n + ' play.'); };

  OPS.addCharge = function (o, ctx) {
    var c = holderOf(ctx);
    if (c) c.charges = (c.charges || 0) + resolveCount(ctx.side, o.n, ctx);
  };
  /* charges, heat and tokens sit on whatever is being activated — a card, a module like the
     Repulsor Unit, or a deployable */
  function holderOf(ctx) { return ctx.card || ctx.module || ctx.deployable || null; }

  OPS.spendCharge = function (o, ctx) {
    var c = holderOf(ctx);
    if (c) c.charges = Math.max(0, (c.charges || 0) - resolveCount(ctx.side, o.n, ctx));
  };
  OPS.addHeat = function (o, ctx) { var c = holderOf(ctx); if (c) c.heat = (c.heat || 0) + resolveCount(ctx.side, o.n, ctx); };
  OPS.spendHeat = function (o, ctx) { var c = holderOf(ctx); if (c) { ctx.heatSpent = Math.min(c.heat || 0, resolveCount(ctx.side, o.n, ctx)); c.heat -= ctx.heatSpent; } };
  OPS.spendAllHeat = function (o, ctx) { var c = holderOf(ctx); if (c) { ctx.heatSpent = c.heat || 0; c.heat = 0; } };

  OPS.exhaustSelf = function (o, ctx) { if (ctx.card) ctx.card.exhausted = true; if (ctx.module) ctx.module.exhausted = true; };
  OPS.trashSelf = function (o, ctx) { moveCard(ctx.side, ctx.card, 'trash'); };
  OPS.discardSelf = function (o, ctx) { moveCard(ctx.side, ctx.card, 'discard'); };

  OPS.refresh = function (o, ctx) {
    var s = ctx.side, n = 0;
    Object.keys(s.modules).forEach(function (id) {
      var m = s.modules[id];
      if (m.exhausted && isOffenseModule(m)) { m.exhausted = false; n++; }
    });
    log('Refreshed ' + n + ' Offense Module(s).');
  };

  /* the pool a "remove a token from any of your cards" cost may draw on */
  /* Anything of yours carrying a charge or a heat token: cards in play, and the modules and
     deployables that hold them too — a Repulsor Unit's charges are as much yours as a card's. */
  function tokenSources(s, o) {
    var pool = s.played.map(function (id) { return s.cards[id]; });
    ['modules', 'deployables'].forEach(function (bag) {
      Object.keys(s[bag]).forEach(function (id) { pool.push(s[bag][id]); });
    });
    return pool.filter(function (c) {
      if (!c) return false;
      if (o.token === 'charge') return (c.charges || 0) > 0;
      if (o.token === 'heat') return (c.heat || 0) > 0;
      return (c.charges || 0) > 0 || (c.heat || 0) > 0;
    });
  }
  OPS.spendToken = function (o, ctx) {
    var n = resolveCount(ctx.side, o.n, ctx);
    var src = tokenSources(ctx.side, o);
    for (var i = 0; i < src.length && n > 0; i++) {
      var c = src[i];
      while (n > 0 && ((c.charges || 0) > 0 || (c.heat || 0) > 0)) {
        if ((c.charges || 0) > 0 && o.token !== 'heat') c.charges--;
        else if ((c.heat || 0) > 0 && o.token !== 'charge') c.heat--;
        else break;
        n--;
      }
    }
  };

  /* rocks within reach that an ability may eat */
  function asteroidsWithin(s, within) {
    var reach = resolveRange(s, within === undefined ? 'sensors' : within);
    var mods = Object.keys(s.modules).map(function (id) { return s.modules[id]; });
    return Object.keys(G.asteroids).map(function (id) { return G.asteroids[id]; })
      .filter(function (r) {
        return mods.some(function (m) { return dist(m, r) <= reach && hasLos(m, r); });
      });
  }
  OPS.consumeAsteroid = function (o, ctx) {
    var s = ctx.side, near = asteroidsWithin(s, o.within);
    if (!near.length) return;
    var best = near[0], core = s.modules[s.coreId];
    if (core) near.forEach(function (r) { if (dist(core, r) < dist(core, best)) best = r; });
    vacate(best.x, best.y);
    delete G.asteroids[best.id];
    log(s.name + ' consumes an asteroid at (' + best.x + ',' + best.y + ').');
  };

  /* modules this cost is allowed to exhaust */
  function exhaustPool(s, o, ctx) {
    var self = ctx.module || null;
    return Object.keys(s.modules).map(function (id) { return s.modules[id]; })
      .filter(function (m) {
        if (m.exhausted) return false;
        if (m === self && !o.includeSelf) return false;
        return matchModule(m, o.filter, self);
      });
  }
  OPS.exhaustOther = function (o, ctx) {
    var s = ctx.side, want = o.n === 'all' ? 99 : num(o.n, 1), done = 0;
    var pool = exhaustPool(s, o, ctx);
    pool.slice(0, want).forEach(function (m) { m.exhausted = true; done++; });
    ctx.exhaustedCount = done;
  };

  /* ================= costs are prerequisites =================
     An activation's cost is not a side effect of using it — it is the price of admission. If
     the whole cost cannot be paid, the ability does not happen and nothing is spent: three
     Offense Modules short of a Quantum Disrupter volley means no volley and no exhaustion,
     and a Rocket Array with no charges left does not fire. */
  function costShortfall(cost, ctx) {
    var s = ctx.side;
    for (var i = 0; i < (cost || []).length; i++) {
      var o = cost[i], holder = holderOf(ctx), n;
      switch (o.op) {
        case 'exhaustOther':
          var pool = exhaustPool(s, o, ctx);
          var want = o.n === 'all' ? 1 : num(o.n, 1);
          if (pool.length < want) {
            return want === 1 ? 'needs a module it can exhaust'
                              : 'needs ' + want + ' ready ' + (o.filter === 'offenseModule' ? 'Offense ' : '') +
                                'Modules to exhaust, and has ' + pool.length;
          }
          break;
        case 'spendCharge':
          n = resolveCount(s, o.n, ctx);
          if (!holder || (holder.charges || 0) < n)
            return 'needs ' + n + ' charge' + (n === 1 ? '' : 's') +
                   ', and has ' + ((holder && holder.charges) || 0);
          break;
        case 'spendHeat':
          n = resolveCount(s, o.n, ctx);
          if (!holder || (holder.heat || 0) < n)
            return 'needs ' + n + ' heat, and has ' + ((holder && holder.heat) || 0);
          break;
        case 'spendAllHeat':
          if (!holder || (holder.heat || 0) <= 0) return 'has no heat to spend';
          break;
        case 'spendToken':
          n = resolveCount(s, o.n, ctx);
          var have = tokenSources(s, o).reduce(function (a, c) {
            return a + (o.token === 'heat' ? 0 : (c.charges || 0)) +
                       (o.token === 'charge' ? 0 : (c.heat || 0)); }, 0);
          if (have < n) return 'needs ' + n + ' token' + (n === 1 ? '' : 's') + ' to remove';
          break;
        case 'consumeAsteroid':
          if (!asteroidsWithin(s, o.within).length) return 'has no asteroid in range to consume';
          break;
      }
    }
    return null;
  }

  /* Can this piece pay for its ability right now? A choice-mode ability counts if any one of
     its options is payable. Used by the AI so it does not keep reaching for an ability it
     cannot afford, and by the board to grey one out. */
  function affordable(s, obj, kind) {
    var e = fx(obj.name, kind === 'tech' ? 'tech' : 'mod');
    var a = e.activate;
    if (!a) return false;
    var ctx = kind === 'tech' ? { side: s, card: obj }
            : kind === 'dep' ? { side: s, module: obj, deployable: obj }
            : { side: s, module: obj };
    if (a.mode === 'choice')
      return (a.options || []).some(function (opt) { return !costShortfall(opt.cost, ctx); });
    return !costShortfall(a.cost, ctx);
  }

  /* Run an activation, but only if its cost can be met in full. */
  function activate(cost, effect, ctx, label, option) {
    var why = costShortfall(cost, ctx);
    if (why) {
      log(ctx.side.name + ' cannot activate ' + label + ' — it ' + why + '.');
      emit();
      return false;
    }
    /* Announced before the ops run, so the log reads as cause then consequence: the
       activation, then what it cost and what it did. */
    log(ctx.side.name + ' activates ' + label + (option ? ' — ' + option : '') + '.');
    run((cost || []).concat(effect || []), ctx);
    return true;
  }
  function matchModule(m, filter, self) {
    switch (filter) {
      case 'movementModule':       return isMovementModule(m);
      case 'offenseModule':        return isOffenseModule(m);
      case 'gravitonModule':       return m.name.indexOf('Graviton') === 0;
      case 'adjacentModule':       return self ? adjacent(m, self) : true;
      case 'offenseModuleAdjacent':return isOffenseModule(m) && (self ? adjacent(m, self) : true);
      default:                     return true;
    }
  }

  /* the shape a placement fills, as offsets from the square you pick */
  function patternSpots(name) {
    if (name === 'selfAndAllAdjacent')
      return [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    return [[0,0]];
  }

  OPS.createAsteroid = function (o, ctx) {
    var s = ctx.side;
    var spots = patternSpots(o.pattern);
    /* "within Sensor range" is part of the card, so the legal squares are limited to it */
    var reach = o.within ? resolveRange(s, o.within) : null;
    var mods = Object.keys(s.modules).map(function (id) { return s.modules[id]; });
    prompt({ kind: 'space', label: 'Place ' + (spots.length > 1 ? 'a debris field' : 'an Asteroid'),
      pattern: spots,
      filter: function (x, y) {
        if (cellAt(x, y)) return false;
        if (reach === null) return true;
        return mods.some(function (m) { return dist(m, { x: x, y: y }) <= reach; });
      },
      onResolve: function (cell) {
        if (!cell) return;
        var n = 0;
        spots.forEach(function (d) { if (addAsteroid(cell.x + d[0], cell.y + d[1])) n++; });
        log(s.name + ' scatters ' + n + ' asteroid' + (n === 1 ? '' : 's') +
            ' around (' + cell.x + ',' + cell.y + ').');
      } });
  };

  OPS.removeSelf = function (o, ctx) {
    var d = ctx.deployable; if (!d) return;
    vacate(d.x, d.y); delete ctx.side.deployables[d.id];
    log(d.name + ' is removed.');
  };
  /* Push whatever the shot caught. The prompt is the same one a deployable's own move uses,
     so the board already knows how to draw the route and walk it. */
  /* Walk a piece under its own power, `n` squares at a time. */
  function promptStepMove(obj, n) {
    if (n <= 0) return;
    prompt({ kind: 'moveObject', label: 'Move ' + obj.name + ' up to ' + n,
             objId: obj.id, left: n, onResolve: function () {} });
  }

  /* Lift a module and set it down somewhere else in one go — no route, no Move spent. The
     destination must be empty and beside a module of yours other than the one being lifted. */
  function promptRelocate(s, mod) {
    var others = Object.keys(s.modules).map(function (id) { return s.modules[id]; })
      .filter(function (m) { return m.id !== mod.id; });
    prompt({ kind: 'space', label: 'Set ' + mod.name + ' down',
      filter: function (x, y) {
        if (!inBounds(x, y) || cellAt(x, y)) return false;
        return others.some(function (m) { return adjacent({ x: x, y: y }, m); });
      },
      onResolve: function (cell) {
        if (!cell) return;
        vacate(mod.x, mod.y);
        mod.x = cell.x; mod.y = cell.y;
        occupy(cell.x, cell.y, { kind: 'module', owner: s.idx, id: mod.id });
        log(s.name + ' repositions ' + mod.name + ' to (' + cell.x + ',' + cell.y + ').');
      } });
  }

  /* Ask which of your modules this is about, then hand it to `then`. One candidate needs no
     asking; none means the ability simply has nothing to work with. */
  function withOwnModule(s, label, then) {
    var mods = Object.keys(s.modules).map(function (id) { return s.modules[id]; });
    if (!mods.length) { log(s.name + ' has no module to move.'); return; }
    if (mods.length === 1) { then(mods[0]); return; }
    prompt({ kind: 'target', label: label, targets: mods.map(function (m) { return m.id; }),
      onResolve: function (id) {
        var m = s.modules[id];
        if (m) then(m);
      } });
  }

  OPS.moveObject = function (o, ctx) {
    var s = ctx.side;
    if (o.what === 'ownModule') {
      var n = resolveCount(s, o.n, ctx);
      withOwnModule(s, 'Which module?', function (m) {
        if (o.placement === 'adjacentToOwnModule') promptRelocate(s, m);
        else promptStepMove(m, n);
      });
      return;
    }
    var t = (o.what === 'target') ? ctx.target : (ctx.deployable ? objectById(ctx.deployable.id) : null);
    if (!t) return;
    promptStepMove(t.obj, resolveCount(s, o.n, ctx));
  };

  OPS.moveSelf = function (o, ctx) {
    var d = ctx.deployable; if (!d) return;
    var n = resolveCount(ctx.side, o.n, ctx);
    prompt({ kind: 'moveObject', label: 'Move ' + d.name + ' up to ' + n, objId: d.id, left: n,
             onResolve: function () {} });
  };
  /* every remaining op is declared in card-effects.js but not yet simulated; it logs
     rather than throwing so a card is always playable and the gap is visible. */
  function notYet(name) { return function (o, ctx) { log('[' + name + '] not yet simulated.'); }; }

  function exec(o, ctx) {
    var fn = OPS[o.op] || notYet(o.op);
    try { fn(o, ctx || {}); } catch (e) { log('Error in ' + o.op + ': ' + e.message); }
  }

  /* ---- helpers used by ops ---- */
  function moveCard(s, card, to) {
    if (!card) return;
    ['hand', 'played', 'deck'].forEach(function (z) {
      var i = s[z].indexOf(card.id); if (i >= 0) s[z].splice(i, 1);
    });
    s[to].push(card.id);
  }
  function isOffenseModule(m) { var p = findMod(m.name); return p && p.tt === 'offense'; }
  function isMovementModule(m) { var p = findMod(m.name); return p && p.tt === 'movement'; }
  function resolveRange(s, r) {
    if (r === 'sensors') return sensorsOf(s);
    if (r === 'any') return 999;
    return num(r, 1);
  }
  function resolveCount(s, v, ctx) {
    if (typeof v === 'number') return v;
    if (v === 'heatSpent') return ctx.heatSpent || 0;
    if (v === 'charges') { var h = holderOf(ctx); return h ? (h.charges || 0) : 0; }
    if (v === '2xEngineering') return 2 * skill(s, 'Engineering');
    if (v === '2d6') return roll6() + roll6();
    if (v === 'upTo4') return Math.min(4, ctx.card ? ctx.card.heat : 0);
    return num(v, 0);
  }
  function attackOrigins(s, o, ctx) {
    if (o.from === 'self' && ctx.module) return [ctx.module];
    var list = Object.keys(s.modules).map(function (id) { return s.modules[id]; });
    if (o.from === 'offenseModule') list = list.filter(isOffenseModule);
    return list.length ? list : [s.modules[s.coreId]].filter(Boolean);
  }
  /* Where a module may be built. This asks exactly what meetsReq asks of a module already on
     the board, so a berth that is legal to build is a berth that stays legal — and anything
     counting as a Core, such as the Citadel, satisfies "adjacent to Core" here too. */
  function placementFilter(s, modName) {
    var e = fx(modName, 'mod');
    return function (x, y) {
      if (!inBounds(x, y) || cellAt(x, y)) return false;
      /* only hull that is itself joined to the Core can carry a new module */
      var reach = connectedToCore(s);
      var mods = Object.keys(s.modules).map(function (id) { return s.modules[id]; })
        .filter(function (m) { return reach[m.id]; });
      var cores = mods.filter(function (m) { return isCoreLike(s, m); });
      var p = { x: x, y: y };
      if (e.placement === 'adjacentToCore')
        return cores.some(function (c) { return adjacent(p, c); });
      if (e.placement === 'adjacentToAnyAndAwayFromCore')
        return mods.some(function (m) { return adjacent(p, m); }) &&
               cores.every(function (c) { return stepDist(p, c) >= (e.minCoreDistance || 2); });
      return mods.some(function (m) { return adjacent(p, m); });
    };
  }
  function deployFilter(s) {
    return function (x, y) {
      if (!inBounds(x, y) || cellAt(x, y)) return false;
      return Object.keys(s.modules).some(function (id) { return adjacent({ x: x, y: y }, s.modules[id]); });
    };
  }

  /* ================= player actions ================= */
  function playCard(cardId) {
    var s = side();
    if (G.phase !== 'play' || G.pending || G.over) return false;
    if (s.playsLeft <= 0) { log('No plays left this turn.'); emit(); return false; }
    var i = s.hand.indexOf(cardId); if (i < 0) return false;
    var card = s.cards[cardId];
    s.hand.splice(i, 1); s.played.push(cardId);
    s.playsLeft--;
    log(s.name + ' plays ' + card.name + '.');
    var e = fx(card.name, 'tech');
    run(e.onPlay || [], { side: s, card: card });
    return true;
  }

  function activateCard(cardId) {
    var s = side();
    if (G.pending || G.over) return false;
    if (G.phase === 'play') { log('Finish the play phase first.'); emit(); return false; }
    var card = s.cards[cardId];
    if (!card || card.exhausted) return false;
    if (s.played.indexOf(cardId) < 0) { log('That card is not in play.'); emit(); return false; }
    var e = fx(card.name, 'tech');
    if (!e.activate) return false;
    var a = e.activate;
    beginUndo(card.name);
    if (a.mode === 'choice') {
      prompt({ kind: 'choice', label: card.name, options: a.options.map(function (x) { return x.label; }),
        onResolve: function (idx) {
          var opt = a.options[idx]; if (!opt) return;
          activate(opt.cost, opt.effect, { side: s, card: card }, card.name, opt.label);
        } });
      return true;
    }
    return activate(a.cost, a.effect, { side: s, card: card }, card.name);
  }

  function activateModule(modId) {
    var s = side();
    if (G.pending || G.over) return false;
    if (G.phase === 'play') { log('Finish the play phase first.'); emit(); return false; }
    var m = s.modules[modId];
    if (!m || m.exhausted) return false;
    if (!meetsReq(s, m)) { log(m.name + ' is out of position and cannot be activated.'); emit(); return false; }
    var e = fx(m.name, 'mod');
    if (!e.activate) return false;
    var a = e.activate;
    beginUndo(m.name);
    if (a.mode === 'choice') {
      prompt({ kind: 'choice', label: m.name, options: a.options.map(function (x) { return x.label; }),
        onResolve: function (idx) {
          var opt = a.options[idx]; if (!opt) return;
          activate(opt.cost, opt.effect, { side: s, module: m }, m.name, opt.label);
        } });
      return true;
    }
    return activate(a.cost, a.effect, { side: s, module: m }, m.name);
  }

  /* a deployable acts like a module: exhaust-gated, unlimited per turn */
  function activateDeployable(depId) {
    var s = side();
    if (G.pending || G.over) return false;
    if (G.phase === 'play') { log('Finish the play phase first.'); emit(); return false; }
    var d = s.deployables[depId];
    if (!d || d.exhausted) return false;
    var e = fx(d.name, 'mod');
    if (!e.activate) return false;
    var a = e.activate;
    beginUndo(d.name);
    var ctx = { side: s, module: d, deployable: d };
    if (a.mode === 'choice') {
      prompt({ kind: 'choice', label: d.name, options: a.options.map(function (x) { return x.label; }),
        onResolve: function (idx) {
          var opt = a.options[idx]; if (!opt) return;
          activate(opt.cost, opt.effect, ctx, d.name, opt.label);
        } });
      return true;
    }
    return activate(a.cost, a.effect, ctx, d.name);
  }

  /* one module steps one square, spending that module's own Move */
  function moveModule(modId, dx, dy) {
    var s = side();
    if (G.phase === 'play') return false;
    var m = s.modules[modId];
    if (!m || m.moveLeft <= 0) return false;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return false;   /* orthogonal steps only */
    var nx = m.x + dx, ny = m.y + dy;
    if (!inBounds(nx, ny)) return false;
    var c = cellAt(nx, ny);
    if (c) {
      /* a module may overrun a deployable, but nothing else */
      if (c.kind !== 'deployable') return false;
      var od = G.players[c.owner].deployables[c.id];
      if (od) { vacate(od.x, od.y); delete G.players[c.owner].deployables[c.id];
                log(m.name + ' overruns ' + od.name + '.'); }
    }
    vacate(m.x, m.y);
    m.x = nx; m.y = ny; m.moveLeft--;
    occupy(nx, ny, { kind: 'module', owner: s.idx, id: m.id });
    emit();
    return true;
  }

  /* ---- placement requirements are ongoing, not just a build-time check ---- */
  /* A module that stands in for the Core. The Citadel says so in its own static passive, so
     the rule is read off the card rather than hardcoded against its name. */
  function isCoreLike(s, m) {
    if (!m) return false;
    if (m.id === s.coreId) return true;
    var e = fx(m.name, 'mod');
    if (e.core || e.countsAsCore) return true;
    return (e.passive || []).some(function (pas) {
      return (pas.effect || []).some(function (o) { return o.op === 'countsAsCore'; });
    });
  }
  /* Everything joined to the Core by a chain of adjacent modules. This is the rule beneath
     every card's own requirement: a module may satisfy "adjacent to any" against a neighbour
     and still be invalid, because that pair is drifting on its own with no path home. */
  function connectedToCore(s) {
    var mods = Object.keys(s.modules).map(function (id) { return s.modules[id]; });
    var core = s.modules[s.coreId];
    var seen = {};
    if (!core) return seen;
    seen[core.id] = true;
    var queue = [core];
    while (queue.length) {
      var cur = queue.shift();
      for (var i = 0; i < mods.length; i++) {
        var o = mods[i];
        if (seen[o.id] || !adjacent(cur, o)) continue;
        seen[o.id] = true;
        queue.push(o);
      }
    }
    return seen;
  }

  function meetsReq(s, m) {
    var e = fx(m.name, 'mod');
    if (m.id === s.coreId || e.core) return true;
    /* the base rule first: no path back to the Core and nothing else matters */
    if (!connectedToCore(s)[m.id]) return false;
    var others = Object.keys(s.modules).map(function (id) { return s.modules[id]; })
      .filter(function (o) { return o !== m; });
    var cores = others.filter(function (o) { return isCoreLike(s, o); });
    if (e.placement === 'adjacentToCore')
      return cores.some(function (c) { return adjacent(m, c); });
    if (e.placement === 'adjacentToAnyAndAwayFromCore')
      return others.some(function (o) { return adjacent(m, o); }) &&
             cores.every(function (c) { return dist(m, c) >= (e.minCoreDistance || 2); });
    if (e.placement === 'adjacentToAny')
      return others.some(function (o) { return adjacent(m, o); });
    return true;
  }
  /* let a planner try a whole manoeuvre and roll it back if the end state is illegal */
  function snapshotModules(idx) {
    var s = G.players[idx];
    return Object.keys(s.modules).map(function (id) {
      var m = s.modules[id];
      return { id: id, x: m.x, y: m.y, moveLeft: m.moveLeft };
    });
  }
  function restoreModules(idx, snap) {
    var s = G.players[idx];
    Object.keys(s.modules).forEach(function (id) { vacate(s.modules[id].x, s.modules[id].y); });
    snap.forEach(function (r) {
      var m = s.modules[r.id];
      if (!m) return;                       /* destroyed since the snapshot; leave it gone */
      m.x = r.x; m.y = r.y; m.moveLeft = r.moveLeft;
    });
    Object.keys(s.modules).forEach(function (id) {
      var m = s.modules[id];
      occupy(m.x, m.y, { kind: 'module', owner: idx, id: id });
    });
    emit();
  }

  function failingModules(s) {
    return Object.keys(s.modules).map(function (id) { return s.modules[id]; })
      .filter(function (m) { return !meetsReq(s, m); });
  }

  /* Shove one object a square. Works for anything on the board — your drone under its own
     power, an enemy module on the end of a tractor beam, a rock — because the mover is not
     always the owner. */
  function stepObject(objId, dx, dy) {
    var t = objectById(objId);
    if (!t || !G.pending || G.pending.left <= 0) return false;
    var o = t.obj, nx = o.x + dx, ny = o.y + dy;
    if (!inBounds(nx, ny) || cellAt(nx, ny)) return false;
    vacate(o.x, o.y); o.x = nx; o.y = ny;
    occupy(nx, ny, t.kind === 'asteroid' ? { kind: 'asteroid', id: o.id }
                                         : { kind: t.kind, owner: t.owner.idx, id: o.id });
    G.pending.left--; emit();
    return true;
  }
  var stepDeployable = stepObject;

  return {
    RULES: RULES,
    newGame: newGame, get: function () { return G; }, onChange: onChange, emit: emit,
    playCard: playCard, activateCard: activateCard, activateModule: activateModule,
    moveModule: moveModule, meetsReq: meetsReq, failingModules: failingModules,
    snapshotModules: snapshotModules, restoreModules: restoreModules,
    activateDeployable: activateDeployable, stepDeployable: stepDeployable,
    endPlayPhase: endPlayPhase, hasLos: hasLos, lineBlocked: lineBlocked,
    endTurn: endTurn, resolve: resolve, cancel: cancel, attackRoll: attackRoll,
    dist: dist, stepDist: stepDist, cellAt: cellAt, sensorsOf: sensorsOf, speedOf: speedOf,
    enemiesOf: enemiesOf, alliesOf: alliesOf, alive: alive, foe: foe, teamsAlive: teamsAlive,
    undo: undo, canUndo: canUndo,
    onAnnounce: onAnnounce, announce: announce, telegraph: telegraph, setTelegraph: setTelegraph,
    hostileObjects: hostileObjects, objectById: objectById, stepObject: stepObject,
    connectedToCore: connectedToCore,
    isStarterCard: isStarterCard, cardIsStarter: cardIsStarter, hasStarterTrait: hasStarterTrait,
    costShortfall: costShortfall, affordable: affordable,
    addAsteroid: addAsteroid, damageAsteroid: damageAsteroid,
    drawCountOf: drawCountOf, playCountOf: playCountOf,
    storageCapOf: storageCapOf, capacityCapOf: capacityCapOf,
    findTech: findTech, findMod: findMod, fx: fx, checkWin: checkWin
  };
})();
