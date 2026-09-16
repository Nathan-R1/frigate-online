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

  function canTranslate(s, mods, dx, dy) {
    var own = {};
    mods.forEach(function (m) { own[m.x + ',' + m.y] = true; });
    for (var i = 0; i < mods.length; i++) {
      var nx = mods[i].x + dx, ny = mods[i].y + dy;
      if (nx < 0 || ny < 0 || nx >= Engine.RULES.boardSize || ny >= Engine.RULES.boardSize) return false;
      if (own[nx + ',' + ny]) continue;                 /* a sibling is vacating it */
      var c = Engine.cellAt(nx, ny);
      if (!c) continue;
      if (c.kind === 'deployable' && c.owner !== s.idx) continue;   /* modules overrun deployables */
      return false;
    }
    return true;
  }

  /* every offset reachable within the Move budget, with the step path to each */
  function reachable(s) {
    var mods = AIKnowledge.modList(s);
    var max = budget(s);
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
        if (!canTranslate(s, probe, dirs[i][0], dirs[i][1])) continue;
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

  /* move to the offset with the best doctrine score; rolls back anything illegal */
  function moveTo(s, node) {
    if (!node || (!node.dx && !node.dy)) return false;
    var steps = [];
    for (var n = node; n && n.step; n = n.from) steps.unshift(n.step);
    var snap = Engine.snapshotModules(s.idx);
    var failBefore = Engine.failingModules(s).length;
    for (var i = 0; i < steps.length; i++) {
      if (!applyStep(s, steps[i][0], steps[i][1])) { Engine.restoreModules(s.idx, snap); return false; }
    }
    if (Engine.failingModules(s).length > failBefore) { Engine.restoreModules(s.idx, snap); return false; }
    return true;
  }

  return { reachable: reachable, moveTo: moveTo, budget: budget, canTranslate: canTranslate };
})();
