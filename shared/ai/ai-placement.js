/* Where to bolt a new module on.

   A hull has a facing: the direction toward the enemy Core. Everything is scored against
   how well a candidate square's bearing matches where that module wants to be —

     short-range weapons  the face pointing at the enemy, so they can reach
     mid-range weapons    the flanks, where they still bear without crowding the front
     long-range weapons   the rear, since range is not the constraint
     engines              never the front face, and spread across the remaining sides
     everything else      the rear, out of the way

   Facing is recomputed each placement, so as the fleet turns the preferred faces rotate
   with it rather than being fixed to a compass direction. */
var AIPlacement = (function () {
  'use strict';
  var K = AIKnowledge;

  /* longest attack range this module can produce, or null if it is not a weapon */
  function moduleRange(s, name) {
    var a = Engine.fx(name, 'mod').activate;
    if (!a) return null;
    var best = null;
    var list = (a.effect || []).slice();
    (a.options || []).forEach(function (o) { list = list.concat(o.effect || []); });
    list.forEach(function (op) {
      if (op.op !== 'attack') return;
      var r = op.range === 'sensors' ? Engine.sensorsOf(s) : (op.range === 'any' ? 99 : op.range);
      if (best === null || r > best) best = r;
    });
    return best;
  }

  function facing(s, foe) {
    var a = s.modules[s.coreId], b = foe.modules[foe.coreId];
    if (!a || !b) return { x: 1, y: 0 };
    var dx = b.x - a.x, dy = b.y - a.y, m = Math.abs(dx) + Math.abs(dy);
    return m ? { x: dx / m, y: dy / m } : { x: 1, y: 0 };
  }

  /* -1 (directly astern) .. +1 (directly at the enemy) */
  function bearing(core, f, x, y) {
    var dx = x - core.x, dy = y - core.y, m = Math.abs(dx) + Math.abs(dy);
    if (!m) return 0;
    return (dx * f.x + dy * f.y) / m;
  }
  /* which cardinal face of the hull a square sits on */
  function face(core, x, y) {
    var dx = x - core.x, dy = y - core.y;
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');
  }

  /* the four squares touching a Core corner-on: reachable from two faces at once, so a hit
     there costs the hull less structure than one on a face */
  function isCoreDiagonal(core, x, y) {
    return Math.abs(x - core.x) === 1 && Math.abs(y - core.y) === 1;
  }

  function roleOfModule(s, name) {
    var p = Engine.findMod(name) || {};
    if (name === 'Armor') return 'armor';
    if (p.tt === 'movement') return 'engine';
    if (moduleRange(s, name) === null) return 'other';
    return 'weapon';
  }

  /* Where a weapon belongs is relative to the guns we actually own, not to absolute range
     bands. The shortest-ranged weapon in the fleet takes the bow — reserving that face for a
     short-range class we do not have would leave the enemy-facing slot empty. 0 = our
     shortest, 1 = our longest. */
  function weaponRank(s, name) {
    var mine = moduleRange(s, name);
    if (mine === null) return 0;
    var all = [];
    AIKnowledge.modList(s).forEach(function (m) {
      var r = moduleRange(s, m.name);
      if (r !== null && all.indexOf(r) < 0) all.push(r);
    });
    if (all.indexOf(mine) < 0) all.push(mine);
    all.sort(function (a, b) { return a - b; });
    if (all.length < 2) return 0;
    return all.indexOf(mine) / (all.length - 1);
  }
  /* bow for our shortest gun, sweeping back toward the stern for longer ones */
  function targetBearing(s, name) {
    return Math.max(-0.8, 1 - 1.6 * weaponRank(s, name));
  }

  /* how crowded a face already is, per role — used to rotate engines around the hull */
  function facesUsed(s, role) {
    var core = s.modules[s.coreId], out = {};
    if (!core) return out;
    K.modList(s).forEach(function (m) {
      if (m.id === s.coreId) return;
      if (roleOfModule(s, m.name) !== role) return;
      var f = face(core, m.x, m.y);
      out[f] = (out[f] || 0) + 1;
    });
    return out;
  }

  function score(s, foe, name, x, y) {
    var core = s.modules[s.coreId];
    if (!core) return 0;
    var f = facing(s, foe), b = bearing(core, f, x, y);
    var role = roleOfModule(s, name);
    var sc = 0;
    if (role === 'armor') {
      /* armour belongs on the Core's diagonals whenever one is free — it screens two faces
         from a single square, and those squares are legal for it while the faces are not */
      return isCoreDiagonal(core, x, y) ? 500 - 40 * b
                                        : -100 - Engine.dist({ x: x, y: y }, core) * 6;
    }
    if (role === 'weapon')     sc = 130 - 100 * Math.abs(b - targetBearing(s, name));
    else if (role === 'engine') {
      /* bearing only breaks ties here — what actually drives an engine's berth is spreading
         them across faces, so a lucky shot down one bearing cannot strip all our mobility */
      sc = -60 * b;
      if (b > 0.4) sc -= 200;                                      /* never the bow */
      var used = facesUsed(s, 'engine');
      sc -= (used[face(core, x, y)] || 0) * 70;
    } else sc = -70 * b;
    /* keep the hull compact: distant bolt-ons are fragile and hard to keep legal */
    sc -= Engine.dist({ x: x, y: y }, core) * 6;
    return sc;
  }

  /* best legal square for this module, given the prompt's own filter */
  function best(s, foe, name, filter) {
    var pick = null, ps = -1e9;
    for (var x = 0; x < Engine.RULES.boardSize; x++)
      for (var y = 0; y < Engine.RULES.boardSize; y++) {
        if (!filter(x, y)) continue;
        var sc = score(s, foe, name, x, y);
        if (sc > ps) { ps = sc; pick = { x: x, y: y }; }
      }
    return pick;
  }

  /* ---------- rearranging a hull that is already built ----------
     Placement only ever applied to new modules, so a fleet that turned to face a new threat
     kept its old arrangement — guns astern, engines at the bow. This walks individual modules
     into better berths using their own Move. Requirements are checked only at end of turn, so
     the hull may pass through illegal shapes mid-shuffle; it just has to finish legal. */

  /* free squares this module can walk to on its own Move, with the path to each */
  function reachableFree(s, mod) {
    var start = { x: mod.x, y: mod.y, cost: 0, from: null };
    var seen = {}; seen[mod.x + ',' + mod.y] = start;
    var q = [start], dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    while (q.length) {
      var cur = q.shift();
      if (cur.cost >= mod.moveLeft) continue;
      for (var i = 0; i < dirs.length; i++) {
        var nx = cur.x + dirs[i][0], ny = cur.y + dirs[i][1], k = nx + ',' + ny;
        if (seen[k]) continue;
        if (nx < 0 || ny < 0 || nx >= Engine.RULES.boardSize || ny >= Engine.RULES.boardSize) continue;
        if (Engine.cellAt(nx, ny)) continue;          /* cannot walk through anything */
        seen[k] = { x: nx, y: ny, cost: cur.cost + 1, from: cur };
        q.push(seen[k]);
      }
    }
    delete seen[mod.x + ',' + mod.y];
    return seen;
  }

  function walk(s, mod, node) {
    var steps = [];
    for (var n = node; n && n.from; n = n.from)
      steps.unshift([n.x - n.from.x, n.y - n.from.y]);
    for (var i = 0; i < steps.length; i++)
      if (!Engine.moveModule(mod.id, steps[i][0], steps[i][1])) return false;
    return true;
  }

  /* would this module still satisfy its own placement rule if it stood here */
  function legalFor(s, mod, x, y) {
    var ox = mod.x, oy = mod.y;
    mod.x = x; mod.y = y;
    var ok = Engine.meetsReq(s, mod);
    mod.x = ox; mod.y = oy;
    return ok;
  }

  /* Pull any stranded module back to a square where it meets its requirement again.
     Rearranging necessarily strands things — moving the rear engine out orphans whatever was
     sitting behind it — and that is fine mid-turn, but the hull has to finish legal. */
  function repair(s) {
    var fails = Engine.failingModules(s), fixed = 0;
    for (var i = 0; i < fails.length; i++) {
      var m = fails[i];
      if (m.moveLeft <= 0) continue;
      var dests = reachableFree(s, m), best = null, bc = 1e9;
      Object.keys(dests).forEach(function (k) {
        var d = dests[k];
        if (legalFor(s, m, d.x, d.y) && d.cost < bc) { bc = d.cost; best = d; }
      });
      if (best && walk(s, m, best)) fixed++;
    }
    return fixed;
  }

  /* Like reachableFree, but our own modules are not walls — they are things that could be
     asked to move. Enemy pieces and terrain still block. */
  function reachableThrough(s, mod) {
    var start = { x: mod.x, y: mod.y, cost: 0, from: null };
    var seen = {}; seen[mod.x + ',' + mod.y] = start;
    var q = [start], dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    while (q.length) {
      var cur = q.shift();
      if (cur.cost >= mod.moveLeft) continue;
      for (var i = 0; i < dirs.length; i++) {
        var nx = cur.x + dirs[i][0], ny = cur.y + dirs[i][1], k = nx + ',' + ny;
        if (seen[k]) continue;
        if (nx < 0 || ny < 0 || nx >= Engine.RULES.boardSize || ny >= Engine.RULES.boardSize) continue;
        var c = Engine.cellAt(nx, ny);
        if (c && !(c.kind === 'module' && c.owner === s.idx)) continue;   /* only our own may yield */
        seen[k] = { x: nx, y: ny, cost: cur.cost + 1, from: cur };
        q.push(seen[k]);
      }
    }
    delete seen[mod.x + ',' + mod.y];
    return seen;
  }

  /* The berth a module wants may be held by a sibling that is perfectly happy there. Price the
     pair together: shift the occupant to its own best free square, move in behind it, and do it
     only if the two moves are worth more than leaving both where they are. */
  function bestDisplacement(s, foe, m) {
    var through = reachableThrough(s, m), best = null;
    var curM = score(s, foe, m.name, m.x, m.y);
    Object.keys(through).forEach(function (k) {
      var d = through[k];
      var occ = Engine.cellAt(d.x, d.y);
      if (!occ || occ.kind !== 'module' || occ.owner !== s.idx) return;
      var B = s.modules[occ.id];
      if (!B || B.id === s.coreId || B.moveLeft <= 0) return;
      if (!legalFor(s, m, d.x, d.y)) return;
      var gainM = score(s, foe, m.name, d.x, d.y) - curM - d.cost * 4;
      var curB = score(s, foe, B.name, B.x, B.y);
      var bDests = reachableFree(s, B), bBest = null, bg = -1e9;
      Object.keys(bDests).forEach(function (k2) {
        var e = bDests[k2];
        if (!legalFor(s, B, e.x, e.y)) return;
        var g = score(s, foe, B.name, e.x, e.y) - curB - e.cost * 4;
        if (g > bg) { bg = g; bBest = e; }
      });
      if (!bBest) return;
      var total = gainM + bg;
      if (total > 20 && (!best || total > best.total))
        best = { mover: m, dest: d, blocker: B, blockerDest: bBest, total: total };
    });
    return best;
  }

  /* shift the occupant first, then walk in behind it */
  function executeDisplacement(s, plan) {
    if (!walk(s, plan.blocker, plan.blockerDest)) return false;
    var now = reachableFree(s, plan.mover);
    var node = now[plan.dest.x + ',' + plan.dest.y];
    if (!node) return false;                      /* the square did not actually open up */
    return walk(s, plan.mover, node);
  }

  /* Repeatedly take the single largest improvement available. One at a time is what lets a
     blocked slot resolve itself: the engine in the bow gains by leaving, which frees the
     square, and the cannon then gains by moving in. */
  function reconfigure(s, foe) {
    var snap = Engine.snapshotModules(s.idx);
    var failBefore = Engine.failingModules(s).length;
    var guard = 0, moved = 0;
    while (guard++ < 24) {
      var best = null;
      AIKnowledge.modList(s).forEach(function (m) {
        if (m.id === s.coreId || m.moveLeft <= 0) return;
        var cur = score(s, foe, m.name, m.x, m.y);
        var dests = reachableFree(s, m);
        Object.keys(dests).forEach(function (k) {
          var d = dests[k];
          if (!legalFor(s, m, d.x, d.y)) return;   /* never walk a module out of its own berth */
          var gain = score(s, foe, m.name, d.x, d.y) - cur - d.cost * 4;
          if (gain > 15 && (!best || gain > best.gain)) best = { mod: m, node: d, gain: gain };
        });
      });
      if (!best) {
        /* nothing can improve on its own — look for a berth worth clearing a sibling out of */
        var plan = null;
        AIKnowledge.modList(s).forEach(function (m) {
          if (m.id === s.coreId || m.moveLeft <= 0) return;
          var p = bestDisplacement(s, foe, m);
          if (p && (!plan || p.total > plan.total)) plan = p;
        });
        if (!plan) break;
        if (!executeDisplacement(s, plan)) break;
        moved += 2;
        repair(s);
        continue;
      }
      if (!walk(s, best.mod, best.node)) break;
      moved++;
      repair(s);            /* re-anchor anything the move just stranded, then keep going */
    }
    repair(s);
    /* only abandon the whole shuffle if we genuinely could not put the hull back together */
    if (Engine.failingModules(s).length > failBefore) {
      Engine.restoreModules(s.idx, snap);
      return 0;
    }
    return moved;
  }

  /* A weapon with a target in range but no line to it is dead weight. Rather than drag the
     whole formation about, walk that one module to the nearest square it can actually shoot
     from — usually a step off its own hull's shadow. Returns the module it moved, or null. */
  function repositionForLos(s, targets) {
    var weapons = AIKnowledge.weapons(s);
    for (var i = 0; i < weapons.length; i++) {
      var w = weapons[i], m = w.mod;
      if (m.exhausted || m.moveLeft <= 0) continue;
      var blocked = null;
      for (var t = 0; t < targets.length; t++) {
        var d = Engine.dist(m, targets[t]);
        if (d <= w.range && Engine.hasLos(m, targets[t])) { blocked = null; break; }
        if (d <= w.range) blocked = targets[t];        /* in range, but we cannot see it */
      }
      if (!blocked) continue;
      var dests = reachableFree(s, m), best = null, bc = 1e9;
      Object.keys(dests).forEach(function (k) {
        var d2 = dests[k];
        if (d2.cost >= bc) return;
        if (!legalFor(s, m, d2.x, d2.y)) return;
        var p = { x: d2.x, y: d2.y };
        var sees = targets.some(function (t2) {
          return Engine.dist(p, t2) <= w.range && Engine.hasLos(p, t2);
        });
        if (sees) { bc = d2.cost; best = d2; }
      });
      if (!best) continue;
      var snap = Engine.snapshotModules(s.idx);
      var failBefore = Engine.failingModules(s).length;
      if (walk(s, m, best)) {
        repair(s);
        if (Engine.failingModules(s).length <= failBefore) return m;
      }
      Engine.restoreModules(s.idx, snap);
    }
    return null;
  }

  /* "Place Cannon" / "Deploy Ion Torpedo" -> the module name */
  function nameFromLabel(label) {
    return String(label || '').replace(/^(Place|Deploy)\s+/i, '').trim();
  }

  return { best: best, score: score, roleOfModule: roleOfModule, facing: facing,
           isCoreDiagonal: isCoreDiagonal, reconfigure: reconfigure, reachableFree: reachableFree,
           repair: repair, weaponRank: weaponRank, targetBearing: targetBearing,
           reachableThrough: reachableThrough, bestDisplacement: bestDisplacement,
           repositionForLos: repositionForLos, legalFor: legalFor,
           bearing: bearing, face: face, moduleRange: moduleRange, nameFromLabel: nameFromLabel };
})();
