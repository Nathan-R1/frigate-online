/* Ship pathfinding.

   The ship is a rigid shape that moves as one (engine.js: moveShip). The engine already knows
   every offset it can reach and whether it may stop there (shipReach), so planning is a matter
   of picking from that map. The search reaches further than this turn's Move on purpose: a
   destination we cannot reach yet is still worth starting toward, and we commit the first few
   steps now and continue next turn — which is how the ship gets through a gap that takes
   longer to thread than one turn of Move. */
var AIPath = (function () {
  'use strict';

  function budget(s) { return s.moveLeft || 0; }

  /* Offsets the ship can come to rest on, out to `horizon` steps. Squares it could only pass
     through are left out as destinations, though routes still run through them — and so are
     squares inside an asteroid: AI Piloting may fly through a rock field, but a turn that ends
     in one wrecks whatever is on the rock. */
  function reachable(s, horizon) {
    var all = Engine.shipReach(s, horizon === undefined ? budget(s) : horizon), out = {};
    Object.keys(all).forEach(function (k) { if (all[k].stand && !all[k].rock) out[k] = all[k]; });
    return out;
  }

  function pathOf(node) {
    var steps = [];
    for (var n = node; n && n.step; n = n.from) steps.unshift(n.step);
    return steps;
  }

  /* Walk as far along a route as this turn's Move allows, stopping on the last square of it
     the ship may rest on — never part-way through one of our own pieces, where the move phase
     would refuse to end. Returns how many steps were taken. */
  function advance(s, node) {
    var chain = [];
    for (var n = node; n && n.step; n = n.from) chain.unshift(n);
    var stop = 0;
    for (var i = 0; i < chain.length && i < budget(s); i++)
      if (chain[i].stand && !chain[i].rock) stop = i + 1;
    for (var j = 0; j < stop; j++)
      if (!Engine.moveShip(chain[j].step[0], chain[j].step[1])) return j;
    return stop;
  }

  return { reachable: reachable, advance: advance, pathOf: pathOf, budget: budget };
})();
