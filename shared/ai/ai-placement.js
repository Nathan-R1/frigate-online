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

  /* "Place Cannon" / "Deploy Ion Torpedo" -> the module name */
  function nameFromLabel(label) {
    return String(label || '').replace(/^(Place|Deploy)\s+/i, '').trim();
  }

  return { best: best, score: score, roleOfModule: roleOfModule, facing: facing,
           isCoreDiagonal: isCoreDiagonal, weaponRank: weaponRank, targetBearing: targetBearing,
           bearing: bearing, face: face, moduleRange: moduleRange, nameFromLabel: nameFromLabel };
})();
