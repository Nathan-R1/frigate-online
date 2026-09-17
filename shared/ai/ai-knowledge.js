/* What the commander knows. Pure reads over Engine state — no mutation, no DOM.
   Card roles are derived from card-effects.js ops, so a new card classifies itself. */
var AIKnowledge = (function () {
  'use strict';

  function modList(s) { return Object.keys(s.modules).map(function (i) { return s.modules[i]; }); }
  function depList(s) { return Object.keys(s.deployables).map(function (i) { return s.deployables[i]; }); }
  function preset(m) { return Engine.findMod(m.name) || {}; }
  function isGun(m) { return preset(m).tt === 'offense' && !!Engine.fx(m.name, 'mod').activate; }
  /* the Core's preset type is 'movement' too, so exclude it — it is not a propulsion module
     and counting it skews both engine tallies and the per-face spread in placement */
  function isEngine(m) {
    return preset(m).tt === 'movement' && !Engine.fx(m.name, 'mod').core;
  }

  /* ---- card roles ---- */
  function opsOf(e) {
    var out = [];
    (function walk(v) {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') { if (v.op) out.push(v); Object.keys(v).forEach(function (k) { walk(v[k]); }); }
    })(e);
    return out;
  }
  function roleOf(cardName) {
    var e = Engine.fx(cardName, 'tech');
    var ops = opsOf(e), has = function (op) { return ops.some(function (o) { return o.op === op; }); };
    if (has('grantPlays') || has('draw')) return 'tempo';
    if (has('createModule')) return 'engine';
    /* an attack that deals no damage but displaces or locks down is control, even though it
       carries a moveObject — check it before mobility or Tract Beam reads as an engine card */
    var atk = ops.filter(function (o) { return o.op === 'attack'; })[0];
    if (atk && (atk.dmg === 0 || atk.onSuccess || atk.check)) return 'control';
    if (has('gainMove')) return 'mobility';
    if (has('addCharge') && e.activate) return 'bank';
    if ((e.passive || []).some(function (p) {
      return /onDamaged|onTargeted|onWouldTrash|onFailCheck/.test(p.trigger); })) return 'reactive';
    if (has('moveObject')) return 'mobility';
    if (atk) return 'burst';
    return 'other';
  }

  /* ---- ranges and firepower ---- */
  function weapons(s) {
    var out = [];
    modList(s).filter(isGun).forEach(function (m) {
      var a = Engine.fx(m.name, 'mod').activate;
      (a && a.effect || []).forEach(function (op) {
        if (op.op !== 'attack') return;
        out.push({ mod: m, range: rangeVal(s, op.range),
                   dmg: typeof op.dmg === 'number' ? op.dmg : 0,
                   attacks: typeof op.attacks === 'number' ? op.attacks : 1 });
      });
    });
    return out;
  }
  function rangeVal(s, r) {
    if (r === 'sensors') return Engine.sensorsOf(s);
    if (r === 'any') return 99;
    return typeof r === 'number' ? r : 1;
  }
  function maxRange(s) { var w = weapons(s); return w.length ? Math.max.apply(null, w.map(function (x) { return x.range; })) : 1; }
  function minRange(s) { var w = weapons(s); return w.length ? Math.min.apply(null, w.map(function (x) { return x.range; })) : 1; }
  /* d6 hitting on 5+ is a 1/3 rate */
  function expectedDamage(s) {
    return weapons(s).reduce(function (a, w) { return a + w.attacks * w.dmg / 3; }, 0);
  }
  /* how many enemy weapons could bear on a point */
  function exposureAt(foe, pt) {
    return weapons(foe).filter(function (w) { return Engine.dist(w.mod, pt) <= w.range; }).length;
  }
  function shieldFrac(s) { return s.shieldMax ? s.shield / s.shieldMax : 0; }

  /* ---- deck reading ---- */
  function handByRole(s) {
    var out = {};
    s.hand.forEach(function (id) {
      var r = roleOf(s.cards[id].name);
      (out[r] = out[r] || []).push(id);
    });
    return out;
  }
  /* cards in play that still want charging before a fight */
  function underCharged(s) {
    return s.played.map(function (id) { return s.cards[id]; }).filter(function (c) {
      if (roleOf(c.name) !== 'bank') return false;
      return c.charges < chargeTarget(c.name);
    });
  }
  function chargeTarget(name) {
    var e = Engine.fx(name, 'tech');
    var a = e.activate;
    if (!a) return 0;
    var opts = a.options || [{ cost: a.cost }];
    var need = 0;
    opts.forEach(function (o) {
      (o.cost || []).forEach(function (c) {
        if (c.op === 'spendCharge' && typeof c.n === 'number' && c.n > need) need = c.n;
      });
    });
    return need || 2;
  }

  /* ---- reading an activated ability ---- */
  function activateOf(name) {
    return Engine.fx(name, 'mod').activate || Engine.fx(name, 'tech').activate || null;
  }
  function activateEffect(name) {
    var a = activateOf(name);
    if (!a) return [];
    var list = (a.effect || []).slice();
    (a.options || []).forEach(function (o) { list = list.concat(o.effect || []); });
    return list;
  }
  /* A top-level removeSelf means activating consumes the piece — Ion Torpedo and Fusion Mine.
     TAT Guided's removeSelf is nested in attack.onHit, so it survives a miss and may be
     activated purely to close distance. */
  function isOneShot(name) {
    var a = activateOf(name);
    return !!a && (a.effect || []).some(function (o) { return o.op === 'removeSelf'; });
  }
  /* longest attack range this ability can produce, or null if it is not an attack at all */
  function attackReach(s, name) {
    var best = null;
    activateEffect(name).forEach(function (o) {
      if (o.op !== 'attack') return;
      var r = o.range === 'sensors' ? Engine.sensorsOf(s) : (o.range === 'any' ? 99 : o.range);
      if (typeof r === 'number' && (best === null || r > best)) best = r;
    });
    return best;
  }
  /* how far the piece may reposition itself as part of the same activation */
  function selfMove(name) {
    var n = 0;
    activateEffect(name).forEach(function (o) {
      if (o.op === 'moveSelf') n = Math.max(n, parseInt(o.n, 10) || 0);
    });
    return n;
  }

  return { modList: modList, depList: depList, preset: preset, isGun: isGun, isEngine: isEngine,
           activateOf: activateOf, activateEffect: activateEffect, isOneShot: isOneShot,
           attackReach: attackReach, selfMove: selfMove,
           roleOf: roleOf, weapons: weapons, maxRange: maxRange, minRange: minRange,
           expectedDamage: expectedDamage, exposureAt: exposureAt, shieldFrac: shieldFrac,
           handByRole: handByRole, underCharged: underCharged, chargeTarget: chargeTarget };
})();
