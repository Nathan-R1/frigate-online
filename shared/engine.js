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

  /* ---- randomness ----
     Every die, every shuffle and the asteroid scatter come from here, and the generator's
     position is part of the game rather than of the process. That is what makes a saved game
     honest: restore it and the next roll is the roll that was always going to happen, so a
     server that dies mid-action and comes back cannot quietly deal anybody a better hand.
     mulberry32 — small, fast, and good enough for dice. */
  function rand() {
    if (!G) return Math.random();          /* before a game exists: setup chatter only */
    G.rng = (G.rng + 0x6D2B79F5) | 0;
    var t = G.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function newSeed() {
    return (Math.floor(Math.random() * 0xFFFFFFFF) ^ (Date.now() & 0xFFFFFFFF)) | 0;
  }
  function onChange(fn) { listeners.push(fn); }
  function emit() { for (var i = 0; i < listeners.length; i++) listeners[i](G); }

  /* A line is coloured by whoever it is about, which on someone else's turn is often not
     the player acting: their gun fires, but it is your shield that soaks it and your passive
     that answers. Pass the subject and the line reads in that seat's colour. */
  /* How much log a game carries. Clients are sent the last 200; the rest is only ever going to
     be written to disk, so the tail is kept and the head is let go. */
  var LOG_KEEP = 500;
  /* `kind` marks the lines that are the story of a turn rather than its arithmetic — a card
     played, an ability used. Everything else is detail: rolls, damage, draws. A reader who
     only wants to know what happened can then be given exactly those, instead of the log
     having to be guessed at by matching words in it. */
  function log(msg, who, kind) {
    var idx = who == null ? G.active
            : (typeof who === 'number' ? who : who.idx);
    var entry = { turn: G.turn, side: idx, msg: msg };
    if (kind) entry.kind = kind;
    G.log.push(entry);
    if (G.log.length > LOG_KEEP * 2) G.log.splice(0, G.log.length - LOG_KEEP);
  }
  function uid(p) { return p + '_' + (G.seq++); }
  function key(x, y) { return x + ',' + y; }
  function findTech(n) { for (var i = 0; i < TECH_PRESETS.length; i++) if (TECH_PRESETS[i].name === n) return TECH_PRESETS[i]; return null; }
  function findMod(n) { for (var i = 0; i < MOD_PRESETS.length; i++) if (MOD_PRESETS[i].name === n) return MOD_PRESETS[i]; return null; }
  function fx(name, kind) { return (CARD_EFFECTS[kind] || {})[name] || {}; }
  function num(v, d) { var n = parseInt(v, 10); return isNaN(n) ? (d || 0) : n; }

  /* ---- derived stats, mirroring the sheet builder ---- */
  function skill(s, n) { return Math.max(0, num(s.skills[n], 0)); }
  function speedOf(s) { return Math.max(1, skill(s, 'Navigation')); }
  function sensorsOf(s) { return 2 * skill(s, 'Sensors'); }
  function drawCountOf(s) { return num(s.stats.drawDrawBase, 4) + skill(s, 'Cyber'); }
  function playCountOf(s) { return num(s.stats.drawPlayBase, 1); }
  function storageCapOf(s) { return skill(s, 'Logistics'); }
  function capacityCapOf(s) { return skill(s, 'Leadership'); }

  /* ---- geometry: square grid, chebyshev distance (diagonals cost 1) ---- */
  /* Manhattan throughout, as the tabletop map measured it. A diagonal neighbour is
     2 away, so "adjacent" means orthogonal and "2 spaces from Core" clears the orthogonals. */
  function dist(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }
  var stepDist = dist;
  function adjacent(a, b) { return dist(a, b) === 1; }
  function cellAt(x, y) { return G.cells[key(x, y)] || null; }
  function occupy(x, y, ref) { G.cells[key(x, y)] = ref; }
  function vacate(x, y) { delete G.cells[key(x, y)]; }
  function inBounds(x, y) { return x >= 0 && y >= 0 && x < RULES.boardSize && y < RULES.boardSize; }

  /* ---- line of sight: centre to centre; any occupied square in between blocks.
     Every occupant counts as a blocker, your own hull included. ---- */
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
  /* The same thirteen points as the sheet builder's defaults, and they have to stay the same:
     a seat with no sheet plays with these, and one carrying the default sheet plays with those,
     and a player should not find the two ships differ. */
  function defaultSkills() {
    return { Cyber: 1, Diplomacy: 0, Engineering: 3, Leadership: 0,
             Logistics: 4, Navigation: 1, Piloting: 2, Sensors: 2, Science: 0 };
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
    shapeFallback(s.idx, modName);
    var id = uid('m');
    var rec = { id: id, name: modName, x: x, y: y,
                exhausted: false, tokens: {}, charges: num(m.charges, 0),
                moveLeft: 0, owner: s.idx, stealth: pregame() };
    /* A module that shares the Core's hull carries no hull fields at all. Leaving it a pool
       nothing reads is how the Citadel came to own a second, private 5 HP. */
    if (!sharesHullWithCore(s, rec)) {
      rec.hull = num(m.hull, 1);
      rec.hullMax = rec.hull;
    }
    s.modules[id] = rec;
    occupy(x, y, { kind: 'module', owner: s.idx, id: id });
    return id;
  }

  function placeDeployable(s, depName, x, y) {
    var m = findMod(depName); if (!m) return null;
    if (!inBounds(x, y) || cellAt(x, y)) return null;
    shapeFallback(s.idx, depName);
    var id = uid('d');
    s.deployables[id] = { id: id, name: depName, x: x, y: y, hull: num(m.hull, 1),
                          speed: num(m.speed, 0), charges: num(m.charges, 0), owner: s.idx,
                          stealth: pregame() };
    occupy(x, y, { kind: 'deployable', owner: s.idx, id: id });
    return id;
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  var MOD_SHAPES = ['hex', 'triangle', 'square', 'diamond', 'circle', 'frigate'];

  function creationNames(v, out) {
    if (Array.isArray(v)) { v.forEach(function (x) { creationNames(x, out); }); return out; }
    if (v && typeof v === 'object') {
      if (v.op === 'createModule' && v.module) out[v.module] = true;
      if (v.op === 'createDeployable' && v.deployable) out[v.deployable] = true;
      Object.keys(v).forEach(function (k) { creationNames(v[k], out); });
    }
    return out;
  }

  function dealShapes(idx, cfg) {
    var names = { Core: true };
    (cfg.modules || []).forEach(function (mn) { names[mn] = true; });
    (cfg.deck || []).forEach(function (d) {
      var t = (d && d.name) || d;
      creationNames(CARD_EFFECTS.tech[t], names);
    });
    var items = Object.keys(names);
    shuffle(items);
    var pool = MOD_SHAPES.slice();
    shuffle(pool);
    G.shapes[idx] = {};
    items.forEach(function (name, k) { G.shapes[idx][name] = pool[k % pool.length]; });
  }

  function shapeFallback(idx, name) {
    if (idx === undefined || idx === null) return;
    if (!G.shapes) G.shapes = G.players.map(function () { return {}; });
    var map = G.shapes[idx] || (G.shapes[idx] = {});
    if (map[name]) return;
    var used = {};
    Object.keys(map).forEach(function (k) { used[map[k]] = true; });
    var free = MOD_SHAPES.filter(function (s) { return !used[s]; });
    map[name] = free.length ? free[Math.floor(rand() * free.length)]
                            : MOD_SHAPES[Math.floor(rand() * MOD_SHAPES.length)];
  }

  /* two sides face off across the middle; three or four take corners */
  function spawnPoints(n) {
    var m = RULES.boardSize, lo = 5, hi = m - 6, mid = Math.floor(m / 2);
    if (n <= 2) return [{ x: lo, y: mid }, { x: hi, y: mid }];
    return [{ x: lo, y: lo }, { x: hi, y: hi }, { x: hi, y: lo }, { x: lo, y: hi }];
  }

  /* newGame(configArray) — 2 to 4 sides. Each config may carry { name, team, ai, deck, modules }.
     A side with no team is its own team, so the default is a free-for-all. */
  /* A seed may be given so that the same table can be dealt twice — a server restoring a game
     it saved, or a test that wants the same dice every run. Left out, one is made. */
  function newGame(configs, seed, opts) {
    if (!Array.isArray(configs)) configs = Array.prototype.slice.call(arguments);
    configs = configs.slice(0, 4);
    var s0 = (seed === undefined || seed === null) ? newSeed() : (seed | 0);
    G = { turn: 1, active: 0, phase: 'upkeep', cells: {}, players: [], pending: null,
          log: [], seq: 1, over: null, queue: [], asteroids: {}, shapes: [],
          seed: s0, rng: s0 };
    /* Settled before a single piece is put down, because the Core is placed below and it has
       to be hidden with the rest of the hull it is about to grow. */
    if (!(opts && opts.autoSetup)) G.turn = 0;
    var pts = spawnPoints(configs.length);
    configs.forEach(function (cfg, i) {
      var s = makeSide(cfg.name, cfg);
      s.idx = i;
      s.team = (cfg.team === undefined || cfg.team === null) ? i : cfg.team;
      s.ai = !!cfg.ai;
      s.dead = false;
      G.players.push(s);
      dealShapes(i, cfg);
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
    /* Turn 0 is the pregame: every seat takes a play phase with its Starter Cards in hand and
       builds its ship in the order it likes. It is an ordinary turn, so the whole of the turn
       machinery — playCard, endPlayPhase, the placement prompts, the AI — works unchanged, and
       the turn counter itself records that the pregame is over when it rolls to 1.

       The exception is a board nobody is going to play: the menu screens want scenery behind
       them, not four bare Cores waiting on a player who will never arrive. `autoSetup` deploys
       everything at once for those, which is what every game used to do. */
    if (opts && opts.autoSetup) {
      autoBerth = true;
      try { G.players.forEach(autoDeployStarters); } finally { autoBerth = false; }
      log(G.players.length + '-player game start.');
    }
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

  /* Every Starter Card at once, with no one asked anything — the scenery boards behind the
     menus, and nothing else. A card that wants an answer is given the empty one, so a prompt
     can never be left parked for a player who is not there; the guard is only there so a card
     that re-prompts forever cannot hang the page. */
  function autoDeployStarters(s) {
    starterIds(s, s.deck).forEach(function (id) {
      var card = s.cards[id];
      var i = s.deck.indexOf(id);
      if (i >= 0) s.deck.splice(i, 1);
      s.played.push(id);
      log(s.name + ' deploys ' + card.name + ' before combat.', s);
      run(fx(card.name, 'tech').onPlay || [], { side: s, card: card });
      var guard = 0;
      while (G.pending && guard++ < 50) resolve(null);
    });
  }

  /* ---- stealth ----
     A stealthed piece is on the board in every way that matters — it fills its square, it
     blocks line of sight, it can be shot at — but the other side cannot see it. Ships are
     built under it during the pregame, so nobody reads their opponent's hull off the board
     before the first turn and berths against it. */
  function pregame() { return !!G && G.turn === 0; }
  /* Whether `o` is hidden from the seat `viewer`. A watcher is nobody, and is shown neither
     side's hull rather than one of them. Your own team always sees its own. */
  function hiddenFrom(o, viewer) {
    if (!o || !o.stealth) return false;
    if (viewer === null || viewer === undefined) return true;
    var owner = G && G.players[o.owner], seat = G && G.players[viewer];
    if (!owner || !seat) return true;
    return owner.team !== seat.team;
  }
  /* Everything on the board comes out of stealth at once. The pregame calls this as it ends;
     it is also the thing a reveal effect should reach for rather than walking the board
     itself. */
  function reveal(s) {
    var sides = s ? [s] : G.players;
    sides.forEach(function (p) {
      Object.keys(p.modules).forEach(function (id) { p.modules[id].stealth = false; });
      Object.keys(p.deployables).forEach(function (id) { p.deployables[id].stealth = false; });
    });
  }

  /* the Starter Cards among a pile, in the pile's own order */
  function starterIds(s, pile) {
    return pile.filter(function (id) { return cardIsStarter(s.cards[id]); });
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
      var c = cand.splice(Math.floor(rand() * cand.length), 1)[0];
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
    dealtDamage(a);
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
    G.phase = 'draw';
    if (G.turn === 0) {
      /* the pregame hand is the Starter Cards, and the plays are exactly enough to spend it.
         Spending the last one drops playsLeft to 0, which is the same signal that ends any
         other play phase — so the seat hands over by itself with nothing extra to press. */
      var starters = starterIds(s, s.deck);
      starters.forEach(function (id) {
        s.deck.splice(s.deck.indexOf(id), 1);
        s.hand.push(id);
      });
      s.playsLeft = starters.length;
      log(s.name + ' prepares for combat.', s);
      G.phase = 'play';
      /* nothing to deploy is nothing to decide: hand straight on, rather than sitting on a
         board with no legal action. startTurn does not run the queue, so this cannot wait
         for step() to notice. */
      if (!s.playsLeft) { endPlayPhase(); return; }
      emit();
      return;
    }
    s.playsLeft = playCountOf(s);
    log(s.name + ' begins turn ' + G.turn + '.', s);
    drawCards(s, drawCountOf(s) - s.hand.length > 0 ? drawCountOf(s) - s.hand.length : 0);
    G.phase = 'play';
    emit();
  }

  /* leaving the play phase discards whatever is still in hand */
  function endPlayPhase() {
    if (G.phase !== 'play') return false;
    var s = side();
    if (s.hand.length) {
      log(G.turn === 0
            ? s.name + ' leaves ' + s.hand.length + ' Starter Card(s) in the box.'
            : s.name + ' discards ' + s.hand.length + ' card(s) from hand.', s);
      s.discard = s.discard.concat(s.hand);
      s.hand = [];
    }
    s.playsLeft = 0;
    /* The pregame turn has no action phase — there is nothing built yet to fire or fly — so
       ending it hands straight to the next seat. */
    if (G.turn === 0) { advancePregame(); return true; }
    G.phase = 'action';
    emit();
    return true;
  }

  /* Pass the pregame on. The turn counter does the bookkeeping: rolling past the last seat
     makes it turn 1, and the next startTurn is an ordinary one. */
  function advancePregame() {
    var nxt = nextLiving(G.active);
    if (nxt <= G.active) {
      G.turn++;                           /* wrapped past the end of the order: 0 becomes 1 */
      /* everyone's hull comes into view together, so no seat sees another's a moment early */
      reveal();
      log('The fleets come into view.');
    }
    G.active = nxt;
    startTurn();
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
    /* The pregame turn ends through its play phase, so that unplayed Starter Cards are put
       away rather than carried into turn 1. This is reachable from the server command as well
       as the page, so it is refused here rather than only in the UI. */
    if (G.turn === 0) { endPlayPhase(); return; }
    clearUndo();
    G.pending = null; G.queue = [];
    var s = side();
    failingModules(s).forEach(function (m) {
      log(m.name + ' does not meet its requirement and breaks apart.', s);
      destroyModule(s, m);
    });
    if (G.over) { emit(); return; }
    Object.keys(s.modules).forEach(function (id) { s.modules[id].moveLeft = 0; });
    s.moveLeft = 0;
    refresh(s);
    log(s.name + ' ends turn.', s);
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
        log(s.name + ' reshuffles the discard pile.', s);
      }
      var id = s.deck.shift();
      if (id) s.hand.push(id);
    }
  }

  /* ================= dice ================= */
  function die(n) { return 1 + Math.floor(rand() * n); }
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
    /* A Citadel is the Core wearing another silhouette: the damage lands in the Core's pool,
       and it is the Core that dies when that pool runs out — the Citadel goes with the wreck. */
    var hit = hullHolder(targetSide, mod);
    hit.hull -= rest;
    if (absorbed) {
      log(targetSide.name + "'s shields absorb " + absorbed + '.', targetSide);
      fire(targetSide, 'onShieldDamaged', { amount: absorbed });
    }
    if (rest) log(targetSide.name + "'s " + mod.name + ' takes ' + rest + ' hull damage' +
                  (hit === mod ? '' : ' — off the Core') + '.', targetSide);
    if (hit.hull <= 0) destroyModule(targetSide, hit);
    dealtDamage(mod);
    checkWin();
    return rest;
  }

  /* Whoever is acting has just landed damage on something; cards that count hits care. */
  function dealtDamage(target) {
    fire(side(), 'onDealDamage', { victim: target && target.id });
  }

  /* deployables sit outside the shield envelope, so damage lands straight on their hull */
  function damageDeployable(s, dep, amount) {
    if (!dep || amount <= 0) return 0;
    dep.hull -= amount;
    log(s.name + "'s " + dep.name + ' takes ' + amount + ' damage.', s);
    dealtDamage(dep);
    if (dep.hull <= 0) {
      log(s.name + "'s " + dep.name + ' is destroyed.', s);
      /* Fired while it is still listed, because the passive is found by walking its owner's
         deployables — a mine asked to detonate after it has been taken off the board is not
         found at all. The queued effect keeps a direct reference, so the blast still knows
         where the mine was standing. */
      fire(s, 'onDestroyedOrEnemyEnters', { self: dep, source: dep });
      vacate(dep.x, dep.y);
      delete s.deployables[dep.id];
    }
    return amount;
  }

  function destroyModule(s, mod) {
    log(s.name + "'s " + mod.name + ' is destroyed.', s);
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
        log(s.name + ' is eliminated — their Core is destroyed.', s);
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
    if (G && G.replica) return !!G.canUndo;
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
    log(s.name + ' cancels ' + u.label + '.', s);
    emit();
    return true;
  }

  /* ================= passive triggers =================
     Cards, modules and deployables may declare passives that fire on an event. This walks
     everything a side has in play, matches the trigger, and runs the effect with that card
     as the context — so a passive spends its own heat and banks its own charges, not the
     ones belonging to whatever caused the event.

     Only non-interrupting events are dispatched here. Triggers that have to stop an action
     mid-resolution — onDamaged negating a hit, onTargeted dodging a shot — need the resolver
     to offer them a window, and are not wired yet. */
  function passiveHolders(s) {
    var out = [];
    s.played.forEach(function (id) {
      var c = s.cards[id], e = c && fx(c.name, 'tech');
      if (e && e.passive) out.push({ obj: c, passives: e.passive, ctx: { side: s, card: c } });
    });
    ['modules', 'deployables'].forEach(function (bag) {
      Object.keys(s[bag]).forEach(function (id) {
        var m = s[bag][id], e = fx(m.name, 'mod');
        if (e && e.passive) out.push({ obj: m, passives: e.passive,
          ctx: bag === 'modules' ? { side: s, module: m } : { side: s, module: m, deployable: m } });
      });
    });
    return out;
  }

  /* Passives go on the queue rather than running inline. An optional one has to ask before
     it acts, and asking parks the queue — so whatever triggered it must be able to wait for
     the answer, which only queued work can do. */
  function fire(s, trigger, payload) {
    if (!s || G.over) return;
    var items = [];
    passiveHolders(s).forEach(function (h) {
      h.passives.forEach(function (pas) {
        if (pas.trigger !== trigger) return;
        /* Most events are announcements: everything a side holds gets to answer them. Some are
           about one particular piece — a mine is destroyed, and it is that mine that goes off,
           not every mine on the board. Such an event names the piece it happened to, and only
           that piece's own passive is offered the chance to answer. */
        if (payload && payload.self && h.obj !== payload.self) return;
        var ctx = {};
        for (var k in h.ctx) ctx[k] = h.ctx[k];
        for (var k2 in (payload || {})) ctx[k2] = payload[k2];
        items.push({ op: { op: '__passive', pas: pas, name: h.obj.name }, ctx: ctx });
      });
    });
    if (items.length) G.queue = items.concat(G.queue);
  }

  /* ---- op implementations ---- */
  var OPS = {};

  /* One passive, resolved. Optional ones ask first; either way the effects are queued rather
     than run, so anything they prompt for happens in order. */
  OPS.__passive = function (o, ctx) {
    var pas = o.pas, s = ctx.side;
    if (costShortfall(pas.effect, ctx)) return;     /* cannot pay its own cost: stays quiet */
    function go() {
      log(s.name + ' passive — ' + o.name + '.', s);
      enqueue(pas.effect || [], ctx);
    }
    if (!pas.optional) { go(); return; }
    prompt({ kind: 'choice', label: 'Activate passive — ' + o.name + '?',
      options: ['Yes', 'No'],
      onResolve: function (i) { if (i === 0) go(); } });
  };

  /* Set only while a board is being built with no player to ask — see autoDeployStarters.
     It is a module variable rather than game state so that nothing can persist it or read it
     back: a real game never berths a module for you. */
  var autoBerth = false;
  OPS.createModule = function (o, ctx) {
    var s = ctx.side;
    if (autoBerth) {
      /* nobody is here to be asked: berth it ourselves, nearest the Core */
      var cell = firstLegalCell(s, o.module);
      if (cell) { placeModule(s, o.module, cell.x, cell.y); log(s.name + ' deploys ' + o.module + '.', s); }
      else log(s.name + ' has nowhere to berth ' + o.module + '.', s);
      return;
    }
    prompt({ kind: 'space', label: 'Place ' + o.module, filter: placementFilter(s, o.module),
      onResolve: function (cell) {
        if (cell) { placeModule(s, o.module, cell.x, cell.y); log(s.name + ' builds ' + o.module + '.', s); }
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
        if (cell) { placeDeployable(s, o.deployable, cell.x, cell.y); log(s.name + ' deploys ' + o.deployable + '.', s); }
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
    /* 'ships' means crewed things only. A torpedo is spent whether it hits or not, and cracking
       an asteroid with one is a waste nobody would choose — so it is not offered the choice. */
    if (o.targets === 'ships') pool = pool.filter(function (m) { return !G.asteroids[m.id]; });
    var targets = pool.filter(function (m) {
      /* a beam cannot grab the very module it is firing from */
      if (ctx.module && m.id === ctx.module.id) return false;
      return origins.some(function (or) {
        return dist(or, m) <= reach + powerOf(or) && hasLos(or, m);
      });
    });
    if (!targets.length) {
      /* Nothing in reach. Saying so and walking away spends the weapon on empty space, and the
         cost was already paid on the way in — so the shot is offered as a prompt like any
         other, with nothing to click. Taking it back refunds the activation; skipping leaves
         it spent, which is what used to happen without being asked. */
      log(s.name + ' has no target in range with line of sight.', s);
      /* Nothing paid, nobody to ask: a mine that finds nothing simply finds nothing, and the
         player whose turn it happens to be is not the one being offered the choice. */
      if (unattended(o, ctx)) return;
      prompt({ kind: 'target', label: 'Nothing in range', targets: [],
               envelope: firingEnvelope(origins, reach),
               onResolve: function () {} });
      return;
    }
    var ids = targets.map(function (m) { return m.id; });
    /* An area weapon does not pick: everything it can see is already a target, so the only
       question left is whether to pull the trigger. Each one is then resolved in turn, in
       full — its own rolls, its own riders — before the next is touched. */
    if (o.aoe) {
      /* Some blasts are a decision and some are physics. A mine going off is not a shot its
         owner chooses to take — and the prompt would be put to whoever is standing on it,
         which is the wrong person entirely. */
      if (unattended(o, ctx)) {
        enqueue(ids.map(function (id) { return { op: '__shot', shot: o, targetId: id }; }), ctx);
        return;
      }
      prompt({ kind: 'confirm', label: 'Confirm targets', targets: ids,
        envelope: firingEnvelope(origins, reach),
        onResolve: function () {
          enqueue(ids.map(function (id) { return { op: '__shot', shot: o, targetId: id }; }), ctx);
        } });
      return;
    }
    prompt({ kind: 'target', label: 'Choose a target', targets: ids,
      envelope: firingEnvelope(origins, reach),
      onResolve: function (targetId) { shoot(o, ctx, targetId); } });
  };

  OPS.__shot = function (o, ctx) { shoot(o.shot, ctx, o.targetId); };

  /* One target, start to finish. */
  /* ---- Power tokens ----
     Divert Power puts a token on a module and the card says what that is worth: +1 Hull, Move,
     Range and Damage. Rather than a general buff engine, the token is simply read at each of
     the four places a module's number is asked for, which is what the card describes and all
     it describes. Hull is handled where the token is placed, because hull is a pool rather
     than a reading. */
  function powerOf(m) { return (m && m.tokens && m.tokens.Power) || 0; }

  /* ---- Decomp Strikes ----
     "When you make an attack roll with a module adjacent to an Asteroid or other terrain you
     may reroll each missed attack once." Decided here for the same reason point defence is:
     it has to answer in the middle of a roll, and the passive queue only runs between actions,
     which is why this card has never done anything. The "may" is taken generously — a free
     reroll nobody would decline is not worth a prompt per missed shot. */
  function hasInPlay(s, name) {
    return s.played.some(function (id) { return s.cards[id] && s.cards[id].name === name; });
  }
  function besideTerrain(m) {
    if (!m) return false;
    var ids = Object.keys(G.asteroids || {});
    for (var i = 0; i < ids.length; i++) if (dist(m, G.asteroids[ids[i]]) === 1) return true;
    return false;
  }

  /* ---- point defence ----
     Is this module standing under one of its owner's P.D. modules? Range 1, as the card says,
     measured from the P.D. to the piece being shot at — so a P.D. covers itself and everything
     immediately around it.

     This is answered here rather than through the passive queue above, and deliberately. A
     passive that has to stop an attack has to be consulted in the middle of resolving one, and
     the queue only runs between actions — which is why the P.D.'s passive has never once
     fired. Deciding it at the moment the dice would be rolled is the whole of the rule. */
  function pointDefenceCovers(t) {
    if (!t || t.kind !== 'module' || !t.owner) return false;
    var mods = t.owner.modules, ids = Object.keys(mods);
    for (var i = 0; i < ids.length; i++) {
      var m = mods[ids[i]];
      if (m.name === 'P.D.' && dist(m, t.obj) <= 1) return true;
    }
    return false;
  }

  /* Is there somebody at the controls to put this question to?
     Two ways there is not. A blast that is happening rather than being chosen — a mine going
     off because somebody drove over it — has nothing to decide. And a side that is not the one
     whose turn it is has nobody present to decide it: the prompt would be shown to whoever is
     sitting there, which for a mine is precisely the player it is going off underneath. */
  function unattended(o, ctx) {
    return !!(o.auto || ctx.auto || !ctx.side || ctx.side.idx !== G.active);
  }

  function shoot(o, ctx, targetId) {
    var s = ctx.side;
    var t = objectById(targetId);
    if (!t) return;
    var origins = attackOrigins(s, o, ctx);
    var reach = resolveRange(s, o.range);
    /* name the piece that actually fires: the origin nearest the target that can see it */
    var from = null, fd = 1e9;
    origins.forEach(function (or) {
      var d = dist(or, t.obj);
      if (d <= reach + powerOf(or) && hasLos(or, t.obj) && d < fd) { fd = d; from = or; }
    });
    var n = resolveCount(s, o.attacks, ctx);
    var base = resolveCount(s, o.dmg, ctx);
    /* a powered gun hits harder; a zero-damage beam is not a gun, and stays zero */
    var dmg = base > 0 ? base + powerOf(from) : 0;
    var hit = false;
    /* A check is a piloting problem, not a duel: aiming at your own hull or an ally's,
       nobody is trying to slip the beam, so it simply lands. */
    var friendly = !!t.owner && t.owner.team === s.team;
    /* A deployable closing on somebody's hull is the exact thing point defence exists for, so
       a module under that umbrella cannot be hit by one. Only deployables: a P.D. is close-in
       defence, not a shield against the enemy fleet's guns. */
    var swatted = !!ctx.deployable && !friendly && pointDefenceCovers(t);
    var decomp = hasInPlay(s, 'Decomp Strikes') && besideTerrain(from);
    /* The dice are about to be cast, so the activation can no longer be taken back. A
       rider's prompt may still be cancelled, but that cancels only the rider — the cost
       stays paid and the card stays exhausted. */
    clearUndo();
    /* a zero-damage beam is not an attack, and reads oddly as one when it grabs your own hull */
    log(s.name + (dmg > 0 ? ' attacks with ' : ' locks on with ') +
        (from ? from.name + ' ' + at(from) : 'its hull') +
        ' targeting ' + labelOf(t) + ' ' + at(t.obj) +
        (dmg > 0 ? ' — ' + n + (n === 1 ? ' attack, ' : ' attacks, ') + dmg + ' damage each.'
                 : '.'), s);
    for (var i = 0; i < n; i++) {
      /* a card naming a Check rolls d12 + that skill; everything else is a flat d6 */
      var c = (o.check && friendly) ? { hit: true, text: o.check + ' — no resistance' }
            : swatted ? { hit: false, text: 'P.D. covers the target — the shot is swatted down' }
            : o.check ? check(s, o.check, RULES.dc) : attackRoll();
      /* one second swing per missed shot, when the gun is working beside terrain */
      if (!c.hit && !swatted && decomp) {
        var again = o.check ? check(s, o.check, RULES.dc) : attackRoll();
        log('  ' + c.text + ' — miss; Decomp Strikes rerolls.');
        c = again;
      }
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
  }

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
    /* A passive answering onMove adds to the grant rather than starting its own — otherwise
       an After Burner would open a second move prompt inside the first. */
    if (ctx.moveBonus) { s.moveBonus = (s.moveBonus || 0) + resolveCount(s, o.n, ctx); return; }
    /* Move N is N for EACH module. "gain N Move for each module" is therefore just N —
       multiplying by the module count here would apply the same factor twice. */
    var n = (o.from === 'stat' && o.stat === 'speed') ? speedOf(s) : resolveCount(s, o.n, ctx);
    /* Power on the module making the grant raises the grant itself, for every piece it reaches
       — a powered Graviton Engine gives Move 4 per module rather than Move 3 and a limp. It
       belongs here rather than where the Move is handed out, because it is a property of the
       engine being run, not of whoever receives its output. */
    n += powerOf(ctx.module);
    s.moveBonus = 0;
    /* queue the grant, then the passives in front of it: an optional one may stop to ask,
       and its answer has to be in before the Move is handed out */
    enqueue([{ op: '__grantMove', n: n }], ctx);
    fire(s, 'onMove', { moveBonus: true });
  };

  OPS.__grantMove = function (o, ctx) {
    var s = ctx.side, n = o.n;
    if (s.moveBonus) { n += s.moveBonus; log(s.name + ' gains +' + s.moveBonus + ' Move from a passive.', s); }
    s.moveBonus = 0;
    Object.keys(s.modules).forEach(function (id) { s.modules[id].moveLeft += n; });
    s.moveLeft = n;
    log(s.name + ' gains Move ' + n + ' per module.', s);
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
      log(p.name + ' gains ' + n + ' shield.', p);
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
    if (!picks.length) { log(s.name + ' has no ship in Sensor range to shield.', s); return; }
    if (picks.length === 1) { give(picks[0]); return; }
    prompt({ kind: 'choice', label: 'Shield which ship?',
      options: picks.map(function (p) { return p.name + ' — ' + p.shield + '/' + p.shieldMax; }),
      onResolve: function (i) { if (picks[i]) give(picks[i]); } });
  };

  OPS.gainHull = function (o, ctx) {
    var s = ctx.side, n = resolveCount(s, o.n, ctx);
    /* Reinforcement past the rated maximum raises the maximum with it, so the extra hull is
       permanent rather than something a later repair would clamp away. */
    function give(m, owner) {
      if (!m) return;
      /* reinforcing a Citadel is reinforcing the Core; there is only the one pool */
      m = hullHolder(owner || s, m);
      m.hull += n;
      if (o.mayExceed) m.hullMax = Math.max(m.hullMax || 0, m.hull);
      else m.hull = Math.min(m.hull, m.hullMax || m.hull);
      log((owner || s).name + "'s " + m.name + ' gains ' + n + ' Hull (' +
          m.hull + '/' + m.hullMax + ').', owner || s);
    }
    if (o.target !== 'choose') { give(s.modules[s.coreId]); return; }

    /* "any Module within Sensor range" — yours and your allies', measured from your own hull */
    var reach = sensorsOf(s);
    var mine = Object.keys(s.modules).map(function (id) { return s.modules[id]; });
    var pool = [];
    [s].concat(alliesOf(s)).forEach(function (p) {
      Object.keys(p.modules).forEach(function (id) {
        var m = p.modules[id];
        if (mine.some(function (o2) { return dist(o2, m) <= reach; })) pool.push({ m: m, p: p });
      });
    });
    if (!pool.length) { log(s.name + ' has no module in Sensor range to reinforce.', s); return; }
    if (pool.length === 1) { give(pool[0].m, pool[0].p); return; }
    prompt({ kind: 'target', label: 'Reinforce which module?',
      targets: pool.map(function (x) { return x.m.id; }),
      onResolve: function (id) {
        pool.forEach(function (x) { if (x.m.id === id) give(x.m, x.p); });
      } });
  };

  OPS.draw = function (o, ctx) { drawCards(ctx.side, resolveCount(ctx.side, o.n, ctx)); log(ctx.side.name + ' draws ' + o.n + '.', ctx.side); };
  OPS.grantPlays = function (o, ctx) { ctx.side.playsLeft += resolveCount(ctx.side, o.n, ctx); log('+' + o.n + ' play.'); };

  OPS.addCharge = function (o, ctx) {
    var c = holderOf(ctx);
    if (!c) return;
    /* "reset if you dmg a new Object": the count is a lock on one target, not a tally */
    if (o.resetOnNewTarget && ctx.victim !== undefined) {
      if (c.lockedOn !== ctx.victim) { c.charges = 0; c.lockedOn = ctx.victim; }
    }
    c.charges = (c.charges || 0) + resolveCount(ctx.side, o.n, ctx);
  };
  /* charges, heat and tokens sit on whatever is being activated — a card, a module like the
     Repulsor Unit, or a deployable */
  function holderOf(ctx) { return ctx.card || ctx.module || ctx.deployable || null; }

  OPS.spendCharge = function (o, ctx) {
    var c = holderOf(ctx);
    if (c) c.charges = Math.max(0, (c.charges || 0) - resolveCount(ctx.side, o.n, ctx));
  };
  /* A card can bank heat when its preset declares a heat capacity, the way charges:'0' marks
     a card that takes charges. No field, or an empty one, means it cannot hold heat at all. */
  function takesHeat(name) {
    var t = findTech(name) || findMod(name);
    if (!t) return false;
    var h = t.heat;
    if (h === undefined || h === null || h === '') return false;
    return !isNaN(parseInt(h, 10));
  }

  OPS.addHeat = function (o, ctx) {
    var s = ctx.side, n = resolveCount(s, o.n, ctx);
    function give(c) {
      c.heat = (c.heat || 0) + n;
      log(s.name + ' adds ' + n + ' Heat to ' + c.name + ' (' + c.heat + ').', s);
    }
    if (o.target !== 'choose' && o.target !== 'allOwnCards') {
      var self = holderOf(ctx);
      if (self) give(self);
      return;
    }
    /* everything of yours that can hold heat: cards in play, and modules and drones too */
    var pool = s.played.map(function (id) { return s.cards[id]; });
    ['modules', 'deployables'].forEach(function (bag) {
      Object.keys(s[bag]).forEach(function (id) { pool.push(s[bag][id]); });
    });
    pool = pool.filter(function (c) { return c && takesHeat(c.name); });
    if (!pool.length) { log(s.name + ' has nothing in play that takes Heat.', s); return; }
    if (o.target === 'allOwnCards') { pool.forEach(give); return; }
    if (pool.length === 1) { give(pool[0]); return; }
    prompt({ kind: 'card', label: 'Add Heat to…',
      cards: pool.map(function (c) { return c.id; }),
      onResolve: function (id) {
        pool.forEach(function (c) { if (c.id === id) give(c); });
      } });
  };
  OPS.spendHeat = function (o, ctx) { var c = holderOf(ctx); if (c) { ctx.heatSpent = Math.min(c.heat || 0, resolveCount(ctx.side, o.n, ctx)); c.heat -= ctx.heatSpent; } };
  OPS.spendAllHeat = function (o, ctx) { var c = holderOf(ctx); if (c) { ctx.heatSpent = c.heat || 0; c.heat = 0; } };

  /* Exhausting a Movement Module is an event some cards bank heat off, so it goes through
     one place rather than being set in three. */
  function exhaustPiece(s, m) {
    if (!m || m.exhausted) return;
    m.exhausted = true;
    if (isMovementModule(m)) fire(s, 'onExhaustMovementModule', { source: m });
  }

  OPS.exhaustSelf = function (o, ctx) {
    if (ctx.card) ctx.card.exhausted = true;
    if (ctx.module) exhaustPiece(ctx.side, ctx.module);
  };
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
  /* take one token off this holder, charges first unless the op names heat */
  function takeToken(o, c) {
    if ((c.charges || 0) > 0 && o.token !== 'heat') { c.charges--; return 'charge'; }
    if ((c.heat || 0) > 0 && o.token !== 'charge') { c.heat--; return 'heat'; }
    return null;
  }

  OPS.spendToken = function (o, ctx) {
    var s = ctx.side, n = resolveCount(s, o.n, ctx);
    if (n <= 0) return;

    /* Whose token comes off is the player's call when there is more than one candidate —
       spending the last charge on a weapon to move a module is a real decision. */
    function step(left) {
      if (left <= 0) return;
      var src = tokenSources(s, o);
      if (!src.length) return;
      if (src.length === 1) {
        var kind = takeToken(o, src[0]);
        if (kind) log(s.name + ' removes a ' + kind + ' from ' + src[0].name + '.', s);
        step(left - 1);
        return;
      }
      prompt({ kind: 'card', label: 'Take a token from…',
        cards: src.map(function (c) { return c.id; }),
        onResolve: function (id) {
          var pick = null;
          src.forEach(function (c) { if (c.id === id) pick = c; });
          if (!pick) return;
          var k = takeToken(o, pick);
          if (k) log(s.name + ' removes a ' + k + ' from ' + pick.name + '.', s);
          step(left - 1);
        } });
    }
    step(n);
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
    log(s.name + ' consumes an asteroid at (' + best.x + ',' + best.y + ').', s);
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
    pool.slice(0, want).forEach(function (m) { exhaustPiece(s, m); done++; });
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
      return (a.options || []).some(function (opt) { return !activationShortfall(opt, ctx); });
    return !activationShortfall(a, ctx);
  }

  /* Why this cannot be activated, in words, or null when it can. affordable() answers the same
     question with a boolean; a greyed-out button that will not say what is wrong with it is the
     thing players actually complain about. */
  function shortfall(s, obj, kind) {
    var e = fx(obj.name, kind === 'tech' ? 'tech' : 'mod');
    var a = e.activate;
    if (!a) return 'has nothing to activate';
    var ctx = kind === 'tech' ? { side: s, card: obj }
            : kind === 'dep' ? { side: s, module: obj, deployable: obj }
            : { side: s, module: obj };
    if (a.mode === 'choice') {
      var reasons = (a.options || []).map(function (opt) { return activationShortfall(opt, ctx); });
      return reasons.every(Boolean) ? reasons[0] : null;
    }
    return activationShortfall(a, ctx) || null;
  }

  /* Run an activation, but only if its cost can be met in full. */
  function activate(cost, effect, ctx, label, option) {
    var why = costShortfall(cost, ctx) || effectShortfall(effect, ctx);
    if (why) {
      log(ctx.side.name + ' cannot activate ' + label + ' — it ' + why + '.', ctx.side);
      emit();
      return false;
    }
    /* Announced before the ops run, so the log reads as cause then consequence: the
       activation, then what it cost and what it did. */
    log(ctx.side.name + ' activates ' + label + (option ? ' — ' + option : '') + '.', ctx.side, 'act');
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
            ' around (' + cell.x + ',' + cell.y + ').', s);
      } });
  };

  OPS.removeSelf = function (o, ctx) {
    var d = ctx.deployable; if (!d) return;
    vacate(d.x, d.y); delete ctx.side.deployables[d.id];
    log(d.name + ' is removed.');
  };
  /* Push whatever the shot caught. The prompt is the same one a deployable's own move uses,
     so the board already knows how to draw the route and walk it. */
  /* Walk a piece under its own power, `n` squares at a time. Moving a piece of your own is a
     Move like any other, so the passives that answer onMove get their say first and their
     bonus is added to the allowance — the prompt is queued behind them. */
  function promptStepMove(obj, n, ctx) {
    if (n <= 0) return;
    var s = ctx && ctx.side;
    var ours = s && (s.modules[obj.id] || s.deployables[obj.id]);
    if (!ours) { openStepMove(obj, n); return; }
    s.moveBonus = 0;
    enqueue([{ op: '__stepMove', objId: obj.id, n: n }], ctx);
    fire(s, 'onMove', { moveBonus: true });
  }
  function openStepMove(obj, n) {
    prompt({ kind: 'moveObject', label: 'Move ' + obj.name + ' up to ' + n,
             objId: obj.id, left: n, onResolve: function () {} });
  }
  OPS.__stepMove = function (o, ctx) {
    var s = ctx.side, t = objectById(o.objId);
    if (!t) return;
    var n = o.n;
    if (s.moveBonus) { n += s.moveBonus; log(s.name + ' gains +' + s.moveBonus + ' Move from a passive.', s); }
    s.moveBonus = 0;
    openStepMove(t.obj, n);
  };

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
        log(s.name + ' repositions ' + mod.name + ' to (' + cell.x + ',' + cell.y + ').', s);
      } });
  }

  /* Ask which of your modules this is about, then hand it to `then`. One candidate needs no
     asking; none means the ability simply has nothing to work with. */
  function withOwnModule(s, label, then) {
    var mods = Object.keys(s.modules).map(function (id) { return s.modules[id]; });
    if (!mods.length) { log(s.name + ' has no module to move.', s); return; }
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
        else promptStepMove(m, n, ctx);
      });
      return;
    }
    var t = (o.what === 'target') ? ctx.target : (ctx.deployable ? objectById(ctx.deployable.id) : null);
    if (!t) return;
    promptStepMove(t.obj, resolveCount(s, o.n, ctx), ctx);
  };

  OPS.moveSelf = function (o, ctx) {
    var d = ctx.deployable; if (!d) return;
    var n = resolveCount(ctx.side, o.n, ctx);
    promptStepMove(d, n, ctx);
  };
  /* "Activate" as a passive says: run this piece's own ability, here and now. Not its owner
     taking a turn — no cost, no readiness, no whose-turn-is-it — because a mine going off is
     something that happens to whoever set it off, not something its owner chooses. The effect
     is queued rather than run, since this is already inside the resolver. */
  OPS.activateSelf = function (o, ctx) {
    var holder = ctx.deployable || ctx.module || ctx.card;
    if (!holder) return;
    var e = fx(holder.name, (ctx.card && !ctx.module) ? 'tech' : 'mod');
    var a = e && e.activate;
    if (!a || !a.effect) return;
    /* This is the piece acting of its own accord, so nothing it does stops to ask — including
       on its owner's own turn, where there would otherwise be somebody to ask. */
    var sub = {};
    for (var k in ctx) sub[k] = ctx[k];
    sub.auto = true;
    enqueue(a.effect, sub);
  };

  /* Put a token on one of your modules. Only Power exists so far, and it is the one case where
     placing the token does something at once rather than being read later: Hull is a pool, not
     a reading, so the point is added here and the module is that much harder to kill from now
     on. */
  OPS.addToken = function (o, ctx) {
    var s = ctx.side, token = o.token || 'Power';
    function give(m) {
      m.tokens = m.tokens || {};
      m.tokens[token] = (m.tokens[token] || 0) + 1;
      if (token === 'Power') {
        var h = hullHolder(s, m);
        h.hull += 1; h.hullMax += 1;
      }
      log(s.name + ' diverts power to ' + m.name + '.', s);
      emit();
    }
    if (o.target === 'choose') { withOwnModule(s, 'Give a Power token to…', give); return; }
    if (ctx.module) give(ctx.module);
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
    /* A card that names where its shot comes from means it. Falling back to the Core when the
       ship has none of that kind let a Tract Beam reach out of a hull with no Offense Module
       at all — the card says "from any Offense Module" and there were none. Where no kind is
       named, the hull itself is the origin and the Core stands in for a ship stripped to it. */
    if (o.from === 'offenseModule') return list.filter(isOffenseModule);
    return list.length ? list : [s.modules[s.coreId]].filter(Boolean);
  }

  /* What an ability needs on the board before it can be used at all, as distinct from what it
     costs. Read off the effect rather than declared per card: an attack that names the kind of
     module it fires from cannot be used by a ship that has none. */
  var ORIGIN_NAMES = { offenseModule: 'Offense Module', movementModule: 'Movement Module',
                       gravitonModule: 'Graviton module' };
  function effectShortfall(effect, ctx) {
    for (var i = 0; i < (effect || []).length; i++) {
      var o = effect[i];
      if (o.op !== 'attack' || !o.from || o.from === 'self' || o.from === 'any') continue;
      if (!attackOrigins(ctx.side, o, ctx).length)
        return 'has no ' + (ORIGIN_NAMES[o.from] || o.from) + ' to fire from';
    }
    return null;
  }

  /* cost and requirement together, which is what both the button and the engine want */
  function activationShortfall(a, ctx) {
    if (!a) return 'has nothing to activate';
    return costShortfall(a.cost, ctx) || effectShortfall(a.effect, ctx);
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
    log(s.name + ' plays ' + card.name + '.', s, 'act');
    var e = fx(card.name, 'tech');
    run(e.onPlay || [], { side: s, card: card });
    return true;
  }

  function activateCard(cardId) {
    var s = side();
    if (G.pending || G.over) return false;
    if (G.phase === 'play') { log('Finish the play phase first.'); emit(); return false; }
    var card = s.cards[cardId];
    if (!card) return false;
    if (card.exhausted) { log(card.name + ' is already spent this turn.', s); emit(); return false; }
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
    if (!m) return false;
    if (m.exhausted) { log(m.name + ' is already spent this turn.', s); emit(); return false; }
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
    if (!d) return false;
    if (d.exhausted) { log(d.name + ' is already spent this turn.', s); emit(); return false; }
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
      if (od) {
        log(m.name + ' overruns ' + od.name + '.');
        /* "an enemy enters this space" — driving over a mine is the case it exists for */
        fire(G.players[c.owner], 'onDestroyedOrEnemyEnters', { self: od, source: od });
        vacate(od.x, od.y);
        delete G.players[c.owner].deployables[c.id];
      }
    }
    vacate(m.x, m.y);
    m.x = nx; m.y = ny; m.moveLeft--;
    occupy(nx, ny, { kind: 'module', owner: s.idx, id: m.id });
    /* Anything the move set off is queued, not run — and unlike an op, a move is entered from
       outside the resolver, so nothing else will come along to drain it. A mine driven over
       would have been queued to detonate and then simply sat there. */
    step();
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
  /* A module with no hull of its own: it is a piece of the Core, so damage to it comes off
     the ship's hull and it reports that number. The Citadel says so in its own static passive
     — read here the way isCoreLike reads countsAsCore, rather than hardcoded against a name. */
  function sharesHullWithCore(s, m) {
    if (!m || !s || m.id === s.coreId) return false;
    var e = fx(m.name, 'mod');
    if (e.shareHullWithCore) return true;
    return (e.passive || []).some(function (pas) {
      return (pas.effect || []).some(function (o) { return o.op === 'shareHullWithCore'; });
    });
  }
  /* Where a module's hull actually lives. Every read and every write goes through this, so a
     shared pool is one number in one place and nothing can drift out of step with it. */
  function hullHolder(s, m) {
    if (!sharesHullWithCore(s, m)) return m;
    return s.modules[s.coreId] || m;
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

  /* ================= serialising for a replica =================
     A networked game runs these rules on the server and mirrors the result into every
     browser. The browser still loads this same file, but as a replica: it renders and answers
     questions about the state, and never advances it. Two things stop a state from surviving
     the trip, and both are handled here.

     Closures. A prompt carries onResolve and sometimes a filter predicate, neither of which
     survives JSON. The filter is the only one the far side needs, so it is flattened into the
     list of squares it accepts and rebuilt on arrival.

     Hidden information. A viewer is told everything about the board, because the board is in
     front of everyone, and everything about their own cards. Of anybody else's cards they are
     told only what is already face up: what is in play, discarded or trashed. A hand and a
     deck arrive as the right number of blanks, so counts read correctly and nothing else
     leaks. Redacting here rather than at the transport keeps the rule with the rules. */
  function promptData() {
    var p = G.pending;
    if (!p) return null;
    var out = { kind: p.kind, label: p.label };
    ['options', 'targets', 'envelope', 'pattern', 'left', 'objId', 'cards'].forEach(function (k) {
      if (p[k] !== undefined) out[k] = p[k];
    });
    if (typeof p.filter === 'function') {
      out.cells = [];
      for (var y = 0; y < RULES.boardSize; y++)
        for (var x = 0; x < RULES.boardSize; x++)
          if (p.filter(x, y)) out.cells.push([x, y]);
    }
    return out;
  }

  var PUBLIC_PILES = ['played', 'discard', 'trash'];
  function snapshot(viewer) {
    if (!G) return null;
    var out = { replica: true, turn: G.turn, active: G.active, phase: G.phase, seq: G.seq,
                over: G.over, cells: copy(G.cells), asteroids: copy(G.asteroids),
                shapes: copy(G.shapes),
                log: G.log.slice(-200), pending: promptData(), canUndo: canUndo(),
                players: [] };
    G.players.forEach(function (s, i) {
      var p = copy({ idx: s.idx, name: s.name, team: s.team, ai: s.ai, dead: s.dead,
                     shield: s.shield, shieldMax: s.shieldMax, skills: s.skills, stats: s.stats,
                     coreId: s.coreId, modules: s.modules, deployables: s.deployables,
                     playsLeft: s.playsLeft, moveBonus: s.moveBonus });
      if (i === viewer) {
        p.cards = copy(s.cards);
        ['hand', 'deck'].concat(PUBLIC_PILES).forEach(function (k) { p[k] = s[k].slice(); });
      } else {
        p.cards = {};
        PUBLIC_PILES.forEach(function (k) {
          p[k] = s[k].slice();
          s[k].forEach(function (id) { if (s.cards[id]) p.cards[id] = copy(s.cards[id]); });
        });
        /* the right number of blanks: a count is public, a name is not */
        p.hand = s.hand.map(function (_, n) { return 'hidden:' + i + ':h' + n; });
        p.deck = s.deck.map(function (_, n) { return 'hidden:' + i + ':d' + n; });
      }
      out.players.push(p);
    });
    return out;
  }

  /* The whole game, for writing down. Not the same thing as a snapshot: a snapshot is what one
     player may see, this is everything, and it is only offered when the game is *settled* —
     no prompt waiting, no queued effects. That is the one moment the state is plain data, with
     no closure parked in a prompt and no live object held by a queued op. Anything else would
     save a game that cannot be read back. */
  function settled() { return !!G && !G.pending && G.queue.length === 0; }
  function save() {
    if (!settled()) return null;
    /* trimmed: the log is most of the bytes and only the recent lines are ever read */
    var out = copy({ turn: G.turn, active: G.active, phase: G.phase, seq: G.seq, over: G.over,
                     cells: G.cells, asteroids: G.asteroids, players: G.players,
                     shapes: G.shapes,
                     seed: G.seed, rng: G.rng });
    out.log = G.log.slice(-LOG_KEEP);
    return out;
  }
  /* Take a saved game back up. The engine has no other state of its own: an undo point belongs
     to an activation that is over, and the queue was empty or this would not have been saved. */
  function restore(state) {
    G = state;
    G.queue = G.queue || [];
    G.pending = null;
    undoPoint = null;
    emit();
    return G;
  }

  /* Adopt a snapshot as the live state. Everything that reads the game keeps working; only
     the calls that change it are meaningless here, and the client routes those to the server. */
  function setState(s) {
    G = s;
    if (G && G.pending && G.pending.cells) {
      var ok = {};
      G.pending.cells.forEach(function (c) { ok[c[0] + ',' + c[1]] = true; });
      G.pending.filter = function (x, y) { return ok[x + ',' + y] === true; };
    }
    emit();
  }

  /* ================= debug tools =================
     A hand reached into the board for testing. These answer to no rule — no cost, no range,
     no turn order — so nothing here is reachable unless the page has debug switched on. Each
     one still does the bookkeeping properly: a piece that moves vacates the square it left,
     and a card that is trashed leaves whatever pile it was in. */
  var DEBUG = {
    /* put any piece on any empty square */
    place: function (objId, x, y) {
      var t = objectById(objId);
      if (!t || !inBounds(x, y)) return false;
      var there = cellAt(x, y);
      if (there && there.id !== objId) return false;
      vacate(t.obj.x, t.obj.y);
      t.obj.x = x; t.obj.y = y;
      occupy(x, y, { kind: t.kind === 'asteroid' ? 'asteroid' : t.kind,
                     owner: t.owner ? t.owner.idx : undefined, id: objId });
      log('debug: ' + labelOf(t) + ' moved to (' + x + ',' + y + ').', t.owner || undefined);
      emit();
      return true;
    },
    /* take any piece off the board */
    remove: function (objId) {
      var t = objectById(objId);
      if (!t) return false;
      vacate(t.obj.x, t.obj.y);
      if (t.kind === 'asteroid') delete G.asteroids[objId];
      else if (t.kind === 'deployable') delete t.owner.deployables[objId];
      else delete t.owner.modules[objId];
      log('debug: ' + labelOf(t) + ' removed.', t.owner || undefined);
      checkWin();
      emit();
      return true;
    },
    /* conjure a card into a pile — the hand by default, so it can be used at once */
    addCard: function (sideIdx, name, pile) {
      var s = G.players[sideIdx];
      if (!s || !findTech(name)) return null;
      var id = addCardToDeck(s, name);
      if (!id) return null;
      if (pile !== 'deck') {
        s.deck.splice(s.deck.indexOf(id), 1);
        (s[pile] || s.hand).push(id);
      }
      log('debug: ' + s.name + ' is given ' + name + '.', s);
      emit();
      return id;
    },
    /* flip anything that can be spent: a card, a module or a deployable */
    exhaust: function (sideIdx, id, on) {
      var s = G.players[sideIdx];
      var o = s && (s.cards[id] || s.modules[id] || s.deployables[id]);
      if (!o) return false;
      o.exhausted = on === undefined ? !o.exhausted : !!on;
      log('debug: ' + o.name + (o.exhausted ? ' exhausted.' : ' refreshed.'), s);
      emit();
      return true;
    },
    /* move a card to another pile, wherever it is now */
    toPile: function (sideIdx, id, pile) {
      var s = G.players[sideIdx];
      if (!s || !s.cards[id] || !s[pile]) return false;
      ['hand', 'deck', 'discard', 'trash', 'played'].forEach(function (k) {
        var i = s[k].indexOf(id); if (i >= 0) s[k].splice(i, 1);
      });
      s[pile].push(id);
      log('debug: ' + s.cards[id].name + ' sent to ' + pile + '.', s);
      emit();
      return true;
    },
    /* every card that could be conjured */
    cardNames: function () {
      return TECH_PRESETS.map(function (t) { return t.name; }).sort();
    }
  };

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
    costShortfall: costShortfall, affordable: affordable, shortfall: shortfall,
    isCoreLike: function (s2, m) { return isCoreLike(s2, m); },
    hiddenFrom: function (o, viewer) { return hiddenFrom(o, viewer); },
    reveal: reveal,
    sharesHullWithCore: function (s2, m) { return sharesHullWithCore(s2, m); },
    hullHolder: function (s2, m) { return hullHolder(s2, m); },
    addAsteroid: addAsteroid, damageAsteroid: damageAsteroid,
    drawCountOf: drawCountOf, playCountOf: playCountOf,
    storageCapOf: storageCapOf, capacityCapOf: capacityCapOf,
    findTech: findTech, findMod: findMod, fx: fx, checkWin: checkWin,
    snapshot: snapshot, setState: setState, save: save, restore: restore, settled: settled,
    debug: DEBUG
  };
})();
