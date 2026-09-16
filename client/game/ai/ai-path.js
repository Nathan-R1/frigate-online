/* Formation pathfinding.

   The fleet is a rigid shape. A translation (dx,dy) is legal when every module's destination
   is empty, holds one of our own modules, or holds an enemy deployable we may overrun.
   BFS outward from (0,0) over that lattice gives every offset the fleet can actually reach
   this turn, routed around asteroids — replacing the greedy stepper that a single rock froze. */
var AIPath = (function () {
  'use strict';

  function budget(s) {
    var mods = AIKnowledge.modList(s);
    if (!mods.length) return 0;
    return Math.min.apply(null, mods.map(function (m) { return m.moveLeft; }));
  }

  function canTranslate(s, mods, dx, dy, overrunOwn) {
    var own = {};
    mods.forEach(function (m) { own[m.x + ',' + m.y] = true; });
    for (var i = 0; i < mods.length; i++) {
      var nx = mods[i].x + dx, ny = mods[i].y + dy;
      if (nx < 0 || ny < 0 || nx >= Engine.RULES.boardSize || ny >= Engine.RULES.boardSize) return false;
      if (own[nx + ',' + ny]) continue;                 /* a sibling is vacating it */
      var c = Engine.cellAt(nx, ny);
      if (!c) continue;
      /* modules overrun deployables; ours are only crushed when we have no other way out */
      if (c.kind === 'deployable' && (overrunOwn || c.owner !== s.idx)) continue;
      return false;
    }
    return true;
  }

  /* Offsets the formation can translate to, searched out to `horizon` steps — which is
     deliberately further than this turn's Move. A destination we cannot reach yet is still
     worth knowing about: we commit the first few steps now and continue next turn, which is
     how the fleet gets through a gap that takes longer to thread than one turn of Move. */
  function reachable(s, horizon, overrunOwn) {
    if (overrunOwn) return search(s, horizon, true);
    var out = search(s, horizon, false);
    /* Boxed in. A long game leaves a ring of our own idle drones around the hull, and a
       fleet that will not crush its own decoys simply stops moving for the rest of the
       game. Re-run the search allowing that, and pay the drones. */
    if (Object.keys(out).length <= 1) out = search(s, horizon, true);
    return out;
  }

  function search(s, horizon, overrunOwn) {
    var mods = AIKnowledge.modList(s);
    var max = horizon === undefined ? budget(s) : horizon;
    var seen = { '0,0': { dx: 0, dy: 0, cost: 0, from: null, step: null } };
    if (!mods.length || max <= 0) return seen;
    var q = [seen['0,0']], dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    while (q.length) {
      var cur = q.shift();
      if (cur.cost >= max) continue;
      for (var i = 0; i < dirs.length; i++) {
        var nx = cur.dx + dirs[i][0], ny = cur.dy + dirs[i][1], k = nx + ',' + ny;
        if (seen[k]) continue;
        /* legality is tested from the CURRENT board, translated by the offset so far */
        var probe = mods.map(function (m) { return { x: m.x + cur.dx, y: m.y + cur.dy }; });
        if (!canTranslate(s, probe, dirs[i][0], dirs[i][1], overrunOwn)) continue;
        seen[k] = { dx: nx, dy: ny, cost: cur.cost + 1, from: cur, step: dirs[i] };
        q.push(seen[k]);
      }
    }
    return seen;
  }

  /* walk the fleet to an offset, leading edge first so nobody steps onto a sibling */
  function applyStep(s, dx, dy) {
    var mods = AIKnowledge.modList(s).slice().sort(function (a, b) {
      return (b.x * dx + b.y * dy) - (a.x * dx + a.y * dy);
    });
    var snap = Engine.snapshotModules(s.idx);
    for (var i = 0; i < mods.length; i++) {
      if (!Engine.moveModule(mods[i].id, dx, dy)) { Engine.restoreModules(s.idx, snap); return false; }
    }
    return true;
  }

  function pathOf(node) {
    var steps = [];
    for (var n = node; n && n.step; n = n.from) steps.unshift(n.step);
    return steps;
  }

  /* Walk as far along a route as this turn's Move allows. Partial progress is kept — that is
     the point of planning past the budget — but the fleet is rolled back if a step would
     strand a module, so slow progress never costs us one. */
  function advance(s, node) {
    var steps = pathOf(node);
    if (!steps.length) return 0;
    var snap = Engine.snapshotModules(s.idx);
    var failBefore = Engine.failingModules(s).length;
    var taken = 0;
    for (var i = 0; i < steps.length; i++) {
      if (budget(s) <= 0) break;
      if (!applyStep(s, steps[i][0], steps[i][1])) break;   /* blocked: keep what we gained */
      taken++;
    }
    if (Engine.failingModules(s).length > failBefore) { Engine.restoreModules(s.idx, snap); return 0; }
    return taken;
  }

  function moveTo(s, node) { return advance(s, node) > 0; }

  return { reachable: reachable, moveTo: moveTo, advance: advance, pathOf: pathOf,
           budget: budget, canTranslate: canTranslate };
})();
