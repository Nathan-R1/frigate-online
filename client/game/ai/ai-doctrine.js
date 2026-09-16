/* Doctrines. Each answers three questions: where do I want to be, what do I shoot,
   and how do I score a candidate position. The commander does the rest. */
var AIDoctrine = (function () {
  'use strict';
  var K = AIKnowledge;

  function foeOf(s) { var G = Engine.get(); return G.players[1 - s.idx]; }
  function anchor(s) { return K.modList(s).filter(K.isGun)[0] || s.modules[s.coreId]; }
  function nearestFoe(from, foe) {
    var all = K.modList(foe).concat(K.depList(foe));
    var best = null, bd = 1e9;
    all.forEach(function (t) { var d = Engine.dist(from, t); if (d < bd) { bd = d; best = t; } });
    return best;
  }
  /* can any of our guns see and reach a target from this offset */
  function firepowerAt(s, foe, dx, dy) {
    var n = 0;
    K.weapons(s).forEach(function (w) {
      var p = { x: w.mod.x + dx, y: w.mod.y + dy };
      K.modList(foe).concat(K.depList(foe)).forEach(function (t) {
        if (Engine.dist(p, t) <= w.range && Engine.hasLos(p, t)) n += w.attacks * w.dmg;
      });
    });
    return n;
  }
  function exposureAt(s, foe, dx, dy) {
    var core = s.modules[s.coreId];
    if (!core) return 0;
    return K.exposureAt(foe, { x: core.x + dx, y: core.y + dy });
  }
  function gapAt(s, foe, dx, dy) {
    var a = anchor(s); if (!a) return 99;
    var p = { x: a.x + dx, y: a.y + dy }, t = nearestFoe(p, foe);
    return t ? Engine.dist(p, t) : 99;
  }

  /* ---------- CAUTIOUS: sit at the outer edge of our envelope, outside theirs ---------- */
  var Cautious = {
    name: 'cautious',
    idealBand: function (s) {
      var mine = K.maxRange(s), theirs = K.maxRange(foeOf(s));
      return mine > theirs ? { lo: theirs + 1, hi: mine } : { lo: Math.max(1, mine - 1), hi: mine };
    },
    wantsWithdraw: function (s) { return K.shieldFrac(s) < 0.40; },
    doneWithdrawing: function (s) { return K.shieldFrac(s) > 0.70; },
    score: function (s, foe, dx, dy, st) {
      var band = this.idealBand(s), g = gapAt(s, foe, dx, dy);
      if (st.phase === 'RECOVER') return (g > K.maxRange(foe) ? 200 : 0) + g;
      var fit = (g >= band.lo && g <= band.hi) ? 100 : -Math.min(Math.abs(g - band.lo), Math.abs(g - band.hi)) * 8;
      return fit + firepowerAt(s, foe, dx, dy) * 2 - exposureAt(s, foe, dx, dy) * 25;
    },
    /* shoot what reduces incoming damage first */
    targetBias: function (t, isDep, foe) {
      if (isDep) return 60;
      var p = K.preset(t);
      if (p.tt === 'offense') return 100;
      if (p.tt === 'movement') return 70;
      return 30;
    }
  };

  /* ---------- AGGRESSIVE: get adjacent, maximise damage, ignore risk ---------- */
  var Aggressive = {
    name: 'aggressive',
    idealBand: function () { return { lo: 1, hi: 1 }; },
    wantsWithdraw: function () { return false; },
    doneWithdrawing: function () { return true; },
    score: function (s, foe, dx, dy) {
      var g = gapAt(s, foe, dx, dy);
      return firepowerAt(s, foe, dx, dy) * 4 - g * 12;
    },
    targetBias: function (t, isDep, foe) {
      if (isDep) return 20;                    /* only worth it when it screens */
      return t.id === foe.coreId ? 60 : 80;
    }
  };

  /* ---------- TACTICAL: build the whole position around one keystone ---------- */
  var Tactical = {
    name: 'tactical',
    /* leverage = does something guns cannot, is repeatable, and reaches far.
       Below MIN_LEVERAGE there is no keystone worth shaping the whole game around — a
       movement card is not a tactical lever, so we would rather have none and position
       on firepower instead. */
    MIN_LEVERAGE: 60,
    scoreKeystone: function (s, id) {
      var c = s.cards[id]; if (!c) return -1;
      var e = Engine.fx(c.name, 'tech');
      if (!e.activate) return -1;
      var role = K.roleOf(c.name);
      var lev = role === 'control' ? 100 : role === 'bank' ? 55 : 15;
      var atk = ((e.activate.effect || []).filter(function (o) { return o.op === 'attack'; })[0]) || {};
      lev += Math.min(20, (atk.range === 'sensors' ? Engine.sensorsOf(s) : (atk.range || 0)));
      return lev;
    },
    pickKeystone: function (s) {
      var self = this, best = null, bs = this.MIN_LEVERAGE - 1;
      s.played.forEach(function (id) {
        var lev = self.scoreKeystone(s, id);
        if (lev > bs) { bs = lev; best = id; }
      });
      return best;
    },
    keystoneRange: function (s, id) {
      var c = s.cards[id]; if (!c) return K.maxRange(s);
      var e = Engine.fx(c.name, 'tech');
      var atk = ((e.activate && e.activate.effect || []).filter(function (o) { return o.op === 'attack'; })[0]);
      if (!atk) return K.maxRange(s);
      return atk.range === 'sensors' ? Engine.sensorsOf(s) : (typeof atk.range === 'number' ? atk.range : K.maxRange(s));
    },
    idealBand: function (s, st) {
      var r = st.keystoneId ? this.keystoneRange(s, st.keystoneId) : K.maxRange(s);
      return { lo: Math.max(1, Math.floor(r * 0.5)), hi: r };
    },
    wantsWithdraw: function (s) { return K.shieldFrac(s) < 0.25; },
    doneWithdrawing: function (s) { return K.shieldFrac(s) > 0.60; },
    score: function (s, foe, dx, dy, st) {
      var band = this.idealBand(s, st), g = gapAt(s, foe, dx, dy);
      /* staying inside the keystone's envelope dominates everything else */
      var fit = (g >= band.lo && g <= band.hi) ? 150 : -Math.abs(g - band.hi) * 10;
      return fit + firepowerAt(s, foe, dx, dy) - exposureAt(s, foe, dx, dy) * 10;
    },
    targetBias: function (t, isDep, foe) {
      if (isDep) return 50;
      var p = K.preset(t);
      if (p.tt === 'movement') return 100;     /* pin them where the keystone wants them */
      if (p.tt === 'offense') return 70;
      return 40;
    }
  };

  function choose(s) {
    var w = K.weapons(s);
    var hasControl = s.deck.concat(s.hand, s.played)
      .some(function (id) { return s.cards[id] && K.roleOf(s.cards[id].name) === 'control'; });
    if (hasControl) return Tactical;
    var shortRanged = w.length && w.every(function (x) { return x.range <= 2; });
    if (shortRanged) return Aggressive;
    return Cautious;
  }

  return { Cautious: Cautious, Aggressive: Aggressive, Tactical: Tactical,
           choose: choose, firepowerAt: firepowerAt, gapAt: gapAt, anchor: anchor,
           nearestFoe: nearestFoe };
})();
