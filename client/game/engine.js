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

  function log(msg) { G.log.push({ turn: G.turn, side: G.active, msg: msg }); }
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

  function addCardToDeck(s, techName) {
    var t = findTech(techName); if (!t) return null;
    var id = uid('c');
    s.cards[id] = { id: id, name: techName, charges: 0, heat: 0, exhausted: false, durations: [], owner: s.idx };
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
    log(G.players.length + '-player game start.');
    startTurn();
    return G;
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

  function startTurn() {
    var s = side();
    G.phase = 'upkeep';
    Object.keys(s.cards).forEach(function (id) { s.cards[id].exhausted = false; });
    Object.keys(s.modules).forEach(function (id) { s.modules[id].exhausted = false; });
    Object.keys(s.deployables).forEach(function (id) { s.deployables[id].exhausted = false; });
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
    G.pending = null; G.queue = [];
    var s = side();
    failingModules(s).forEach(function (m) {
      log(m.name + ' does not meet its requirement and breaks apart.');
      destroyModule(s, m);
    });
    if (G.over) { emit(); return; }
    Object.keys(s.modules).forEach(function (id) { s.modules[id].moveLeft = 0; });
    s.moveLeft = 0;
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
  function run(ops, ctx) {
    G.queue = (ops || []).map(function (o) { return { op: o, ctx: ctx }; }).concat(G.queue);
    step();
  }

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
  }

  function cancel() { G.pending = null; G.queue = []; emit(); }

  /* ---- op implementations ---- */
  var OPS = {};

  OPS.createModule = function (o, ctx) {
    var s = ctx.side;
    prompt({ kind: 'space', label: 'Place ' + o.module, filter: placementFilter(s, o.module),
      onResolve: function (cell) {
        if (cell) { placeModule(s, o.module, cell.x, cell.y); log(s.name + ' builds ' + o.module + '.'); }
      } });
  };

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

  OPS.attack = function (o, ctx) {
    var s = ctx.side;
    var origins = attackOrigins(s, o, ctx);
    var reach = resolveRange(s, o.range);
    var targets = hostileObjects(s).filter(function (m) {
      return origins.some(function (or) { return dist(or, m) <= reach && hasLos(or, m); });
    });
    if (!targets.length) { log(s.name + ' has no target in range with line of sight.'); return; }
    prompt({ kind: 'target', label: 'Choose a target', targets: targets.map(function (m) { return m.id; }),
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
        log(s.name + ' attacks with ' + (from ? from.name : 'its hull') + ' ' + at(from) +
            ' targeting ' + labelOf(t) + ' ' + at(t.obj) +
            ' — ' + n + (n === 1 ? ' attack, ' : ' attacks, ') + dmg + ' damage each.');
        for (var i = 0; i < n; i++) {
          /* a card naming a Check rolls d12 + that skill; everything else is a flat d6 */
          var c = o.check ? check(s, o.check, RULES.dc) : attackRoll();
          if (c.hit) {
            log('  ' + c.text + ' — hit.');
            if (t.kind === 'asteroid') damageAsteroid(t.obj, dmg);
            else if (t.kind === 'deployable') damageDeployable(t.owner, t.obj, dmg);
            else damageModule(t.owner, t.obj, dmg);
          } else log('  ' + c.text + ' — miss.');
          if (!objectById(targetId)) break;
        }
      } });
  };

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
    prompt({ kind: 'move', label: 'Move your modules — ' + n + ' each', onResolve: function () {} });
  };

  OPS.gainShield = function (o, ctx) {
    var s = ctx.side, n = resolveCount(s, o.n, ctx);
    s.shield = Math.min(s.shieldMax, s.shield + n);
    log(s.name + ' gains ' + n + ' shield.');
  };

  OPS.gainHull = function (o, ctx) {
    var s = ctx.side, n = resolveCount(s, o.n, ctx);
    var m = o.target === 'core' ? s.modules[s.coreId] : null;
    if (m) { m.hull += n; if (o.mayExceed) m.hullMax = Math.max(m.hullMax, m.hull); log(s.name + ' gains ' + n + ' Hull.'); }
  };

  OPS.draw = function (o, ctx) { drawCards(ctx.side, resolveCount(ctx.side, o.n, ctx)); log(ctx.side.name + ' draws ' + o.n + '.'); };
  OPS.grantPlays = function (o, ctx) { ctx.side.playsLeft += resolveCount(ctx.side, o.n, ctx); log('+' + o.n + ' play.'); };

  OPS.addCharge = function (o, ctx) { var c = ctx.card; if (c) { c.charges += resolveCount(ctx.side, o.n, ctx); } };
  OPS.spendCharge = function (o, ctx) { var c = ctx.card; if (c) c.charges = Math.max(0, c.charges - resolveCount(ctx.side, o.n, ctx)); };
  OPS.addHeat = function (o, ctx) { var c = ctx.card; if (c) c.heat += resolveCount(ctx.side, o.n, ctx); };
  OPS.spendHeat = function (o, ctx) { var c = ctx.card; if (c) { ctx.heatSpent = Math.min(c.heat, resolveCount(ctx.side, o.n, ctx)); c.heat -= ctx.heatSpent; } };
  OPS.spendAllHeat = function (o, ctx) { var c = ctx.card; if (c) { ctx.heatSpent = c.heat; c.heat = 0; } };

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

  OPS.exhaustOther = function (o, ctx) {
    var s = ctx.side, want = o.n === 'all' ? 99 : num(o.n, 1), done = 0;
    var self = ctx.module || null;
    var pool = Object.keys(s.modules).map(function (id) { return s.modules[id]; })
      .filter(function (m) {
        if (m.exhausted) return false;
        if (m === self && !o.includeSelf) return false;
        return matchModule(m, o.filter, self);
      });
    if (pool.length < want && o.n !== 'all') { log('Not enough modules to pay that cost.'); ctx.failed = true; return; }
    pool.slice(0, want).forEach(function (m) { m.exhausted = true; done++; });
    ctx.exhaustedCount = done;
  };
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

  OPS.createAsteroid = function (o, ctx) {
    prompt({ kind: 'space', label: 'Place an Asteroid', filter: function (x, y) { return !cellAt(x, y); },
      onResolve: function (cell) {
        if (!cell) return;
        var spots = [[0,0]];
        if (o.pattern === 'selfAndAllAdjacent')
          spots = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
        spots.forEach(function (d) { addAsteroid(cell.x + d[0], cell.y + d[1]); });
        log('Asteroids placed.');
      } });
  };

  OPS.removeSelf = function (o, ctx) {
    var d = ctx.deployable; if (!d) return;
    vacate(d.x, d.y); delete ctx.side.deployables[d.id];
    log(d.name + ' is removed.');
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
    if (v === 'charges') return ctx.card ? ctx.card.charges : 0;
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
  function placementFilter(s, modName) {
    var e = fx(modName, 'mod');
    return function (x, y) {
      if (!inBounds(x, y) || cellAt(x, y)) return false;
      var mods = Object.keys(s.modules).map(function (id) { return s.modules[id]; });
      var core = s.modules[s.coreId];
      var p = { x: x, y: y };
      if (e.placement === 'adjacentToCore') return core && adjacent(p, core);
      if (e.placement === 'adjacentToAnyAndAwayFromCore')
        return mods.some(function (m) { return adjacent(p, m); }) &&
               core && stepDist(p, core) >= (e.minCoreDistance || 2);
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
    if (a.mode === 'choice') {
      prompt({ kind: 'choice', label: card.name, options: a.options.map(function (x) { return x.label; }),
        onResolve: function (idx) {
          var opt = a.options[idx]; if (!opt) return;
          run((opt.cost || []).concat(opt.effect || []), { side: s, card: card });
        } });
      return true;
    }
    run((a.cost || []).concat(a.effect || []), { side: s, card: card });
    return true;
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
    if (a.mode === 'choice') {
      prompt({ kind: 'choice', label: m.name, options: a.options.map(function (x) { return x.label; }),
        onResolve: function (idx) {
          var opt = a.options[idx]; if (!opt) return;
          run((opt.cost || []).concat(opt.effect || []), { side: s, module: m });
        } });
      return true;
    }
    run((a.cost || []).concat(a.effect || []), { side: s, module: m });
    return true;
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
    var ctx = { side: s, module: d, deployable: d };
    if (a.mode === 'choice') {
      prompt({ kind: 'choice', label: d.name, options: a.options.map(function (x) { return x.label; }),
        onResolve: function (idx) {
          var opt = a.options[idx]; if (!opt) return;
          run((opt.cost || []).concat(opt.effect || []), ctx);
        } });
      return true;
    }
    run((a.cost || []).concat(a.effect || []), ctx);
    return true;
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
  function isCoreLike(s, m) {
    if (!m) return false;
    if (m.id === s.coreId) return true;
    return !!fx(m.name, 'mod').countsAsCore || m.name === 'Citadel';
  }
  function meetsReq(s, m) {
    var e = fx(m.name, 'mod');
    if (m.id === s.coreId || e.core) return true;
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

  function stepDeployable(depId, dx, dy) {
    var s = side(), d = s.deployables[depId];
    if (!d || !G.pending || G.pending.left <= 0) return false;
    var nx = d.x + dx, ny = d.y + dy;
    if (!inBounds(nx, ny) || cellAt(nx, ny)) return false;
    vacate(d.x, d.y); d.x = nx; d.y = ny;
    occupy(nx, ny, { kind: 'deployable', owner: s.idx, id: d.id });
    G.pending.left--; emit();
    return true;
  }

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
    hostileObjects: hostileObjects, objectById: objectById,
    addAsteroid: addAsteroid, damageAsteroid: damageAsteroid,
    drawCountOf: drawCountOf, playCountOf: playCountOf,
    storageCapOf: storageCapOf, capacityCapOf: capacityCapOf,
    findTech: findTech, findMod: findMod, fx: fx, checkWin: checkWin
  };
})();
