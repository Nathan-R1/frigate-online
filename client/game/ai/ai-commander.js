/* The commander: a phase machine that delegates *what to want* to a doctrine and
   *how to get there* to the pathfinder. This is the only entry point game.html uses.

     PREP    set up — tempo cards first, then engines, mobility, charge the banks
     ENGAGE  doctrine drives range, positioning and target choice
     RECOVER cautious/tactical only — break contact, recharge shields, come back
     FINISH  we can kill the core this turn; drop all caution */
var AICommander = (function () {
  'use strict';
  var K = AIKnowledge, D = AIDoctrine, P = AIPath;

  var brains = {};   /* sideIndex -> persistent state */

  function brain(idx) {
    if (!brains[idx]) brains[idx] = { phase: 'PREP', doctrine: null, keystoneId: null, turnSeen: -1 };
    return brains[idx];
  }
  function reset() { brains = {}; }

  function foeOf(s) { return Engine.get().players[1 - s.idx]; }

  /* ---------- phase transitions ---------- */
  function updatePhase(s, st) {
    var G = Engine.get(), foe = foeOf(s);
    if (!st.doctrine) st.doctrine = D.choose(s);
    var core = foe.modules[foe.coreId];

    if (core && K.expectedDamage(s) >= foe.shield + core.hull) { st.phase = 'FINISH'; return; }

    if (st.phase === 'RECOVER') {
      if (st.recoverUntil === undefined) st.recoverUntil = G.turn + 3;
      /* nothing in the game regenerates shields on its own, so a side with no way to repair
         would hide forever. Give up after a few turns and fight with what is left. */
      if (st.doctrine.doneWithdrawing(s) || G.turn >= st.recoverUntil) {
        st.phase = 'ENGAGE'; st.recoverUntil = undefined; st.noMoreRecover = true;
      }
      return;
    }
    if (st.phase !== 'PREP' && !st.noMoreRecover && st.doctrine.wantsWithdraw(s)) {
      st.phase = 'RECOVER'; st.recoverUntil = G.turn + 3; return;
    }

    if (st.phase === 'PREP') {
      var hand = K.handByRole(s);
      var setupLeft = (hand.engine || []).length + (hand.mobility || []).length + (hand.bank || []).length;
      var banksHungry = K.underCharged(s).length > 0;
      var a = D.anchor(s), t = a && D.nearestFoe(a, foe);
      var gap = (a && t) ? Engine.dist(a, t) : 99;
      var forced = gap <= K.maxRange(foe) + 1;        /* they are on us — stop setting up */
      if (forced || (!setupLeft && !banksHungry)) {
        st.phase = 'ENGAGE';
        if (st.doctrine === D.Tactical) st.keystoneId = D.Tactical.pickKeystone(s);
      }
    }
  }

  /* ---------- play phase ---------- */
  function choosePlay(s, st) {
    var hand = K.handByRole(s);
    /* tempo is strictly free value — never hold Boost or Dynamo */
    if ((hand.tempo || []).length) return hand.tempo[0];
    if (st.phase === 'PREP') {
      return (hand.mobility || [])[0] || (hand.engine || [])[0] || (hand.bank || [])[0] ||
             (hand.reactive || [])[0] || (hand.control || [])[0] || s.hand[0];
    }
    return (hand.burst || [])[0] || (hand.control || [])[0] || (hand.engine || [])[0] || s.hand[0];
  }

  /* ---------- positioning ---------- */
  function manoeuvre(s, st) {
    var foe = foeOf(s);
    var nodes = P.reachable(s);
    var best = null, bestScore = -1e9;
    Object.keys(nodes).forEach(function (k) {
      var n = nodes[k];
      var sc = st.phase === 'FINISH'
        ? D.firepowerAt(s, foe, n.dx, n.dy) * 5 - D.gapAt(s, foe, n.dx, n.dy)
        : st.doctrine.score(s, foe, n.dx, n.dy, st);
      sc -= n.cost * 0.1;                 /* prefer the cheaper of two equal positions */
      if (sc > bestScore) { bestScore = sc; best = n; }
    });
    if (best && (best.dx || best.dy)) P.moveTo(s, best);
    K.modList(s).forEach(function (m) { m.moveLeft = 0; });   /* commit the turn's movement */
  }

  /* ---------- target choice ---------- */
  function bestTarget(s, st, ids) {
    var foe = foeOf(s), best = ids[0], bs = -1e9;
    ids.forEach(function (id) {
      var isDep = !!foe.deployables[id];
      var t = foe.modules[id] || foe.deployables[id];
      if (!t) return;
      var sc = st.doctrine.targetBias(t, isDep, foe);
      if (t.id === foe.coreId) {
        var lethal = K.expectedDamage(s) >= foe.shield + t.hull;
        sc = lethal ? 500 : sc - 40;      /* shields soak it otherwise */
      }
      if (!isDep && K.preset(t).tt === 'offense' && K.modList(foe).filter(K.isGun).length <= 1) sc += 40;
      var d = Math.min.apply(null, K.modList(s).map(function (m) { return Engine.dist(m, t); }).concat([99]));
      sc -= d * 0.5;
      if (sc > bs) { bs = sc; best = id; }
    });
    return best;
  }

  /* ---------- prompt answers ---------- */
  function answer(s, st, p) {
    if (p.kind === 'choice') return chooseOption(s, st, p);
    if (p.kind === 'target') return bestTarget(s, st, p.targets);
    if (p.kind === 'move') { manoeuvre(s, st); return null; }
    if (p.kind === 'moveObject') return null;
    if (p.kind === 'space') {
      var core = s.modules[s.coreId], pick = null, pd = 1e9;
      for (var x = 0; x < Engine.RULES.boardSize; x++)
        for (var y = 0; y < Engine.RULES.boardSize; y++)
          if (p.filter(x, y)) {
            var d = core ? Engine.dist({ x: x, y: y }, core) : 0;
            if (d < pd) { pd = d; pick = { x: x, y: y }; }
          }
      return pick;
    }
    return null;
  }
  /* "add a charge" vs "spend it". Bank during prep; once engaged, spend. In RECOVER the whole
     point is to turn charges back into shields, so spend as soon as the bank can pay. */
  function chooseOption(s, st, p) {
    var charging = -1;
    for (var i = 0; i < p.options.length; i++) if (/charge/i.test(p.options[i])) { charging = i; break; }
    if (charging < 0) return 0;
    var spend = -1;
    for (var j = 0; j < p.options.length; j++) if (j !== charging) { spend = j; break; }
    if (spend < 0) return charging;
    var card = s.played.map(function (id) { return s.cards[id]; })
      .filter(function (c) { return c.name === p.label; })[0];
    var funded = card && card.charges >= K.chargeTarget(p.label);
    if (st.phase === 'RECOVER') return funded ? spend : charging;
    if (st.phase === 'PREP') return charging;
    return funded ? spend : charging;
  }

  /* ---------- one decision per tick ---------- */
  function tick(idx) {
    var G = Engine.get();
    if (!G || G.over || G.active !== idx) return;
    var s = G.players[idx], st = brain(idx);
    if (G.pending) { Engine.resolve(answer(s, st, G.pending)); return; }
    updatePhase(s, st);

    if (G.phase === 'play') {
      if (s.playsLeft > 0 && s.hand.length) Engine.playCard(choosePlay(s, st));
      else Engine.endPlayPhase();
      return;
    }

    /* 1. engines first — Move is the prerequisite for every plan */
    var mv = K.modList(s).filter(function (m) {
      return !m.exhausted && K.isEngine(m) && Engine.fx(m.name, 'mod').activate && Engine.meetsReq(s, m); })[0];
    if (mv) { Engine.activateModule(mv.id); return; }
    var mvCard = s.played.map(function (i) { return s.cards[i]; }).filter(function (c) {
      return !c.exhausted && Engine.fx(c.name, 'tech').activate && K.roleOf(c.name) === 'mobility'; })[0];
    if (mvCard) { Engine.activateCard(mvCard.id); return; }

    /* 2. spend the Move on a doctrine-chosen position */
    if (K.modList(s).some(function (m) { return m.moveLeft > 0; })) { manoeuvre(s, st); return; }

    /* 3. top up the banks while still setting up */
    if (st.phase === 'PREP' || st.phase === 'RECOVER') {
      var bank = K.underCharged(s).filter(function (c) { return !c.exhausted; })[0];
      if (bank) { Engine.activateCard(bank.id); return; }
    }

    /* 4. the keystone gets priority over ordinary guns, and is upgraded if a better one lands */
    if (st.doctrine === D.Tactical) {
      var cand = D.Tactical.pickKeystone(s);
      if (cand && (!st.keystoneId || s.played.indexOf(st.keystoneId) < 0 ||
                   D.Tactical.scoreKeystone(s, cand) > D.Tactical.scoreKeystone(s, st.keystoneId)))
        st.keystoneId = cand;
    }
    if (st.keystoneId) {
      var ks = s.cards[st.keystoneId];
      if (ks && !ks.exhausted && s.played.indexOf(st.keystoneId) >= 0) { Engine.activateCard(ks.id); return; }
    }

    /* 5. guns, then anything else with an ability */
    var gun = K.modList(s).filter(function (m) {
      return !m.exhausted && K.isGun(m) && Engine.meetsReq(s, m); })[0];
    if (gun) { Engine.activateModule(gun.id); return; }
    var dep = K.depList(s).filter(function (d) {
      return !d.exhausted && Engine.fx(d.name, 'mod').activate; })[0];
    if (dep) { Engine.activateDeployable(dep.id); return; }
    var other = K.modList(s).filter(function (m) {
      return !m.exhausted && Engine.fx(m.name, 'mod').activate && Engine.meetsReq(s, m); })[0];
    if (other) { Engine.activateModule(other.id); return; }
    var card = s.played.map(function (i) { return s.cards[i]; }).filter(function (c) {
      return !c.exhausted && Engine.fx(c.name, 'tech').activate; })[0];
    if (card) { Engine.activateCard(card.id); return; }

    Engine.endTurn();
  }

  function describe(idx) {
    var st = brains[idx];
    if (!st) return '';
    return st.phase + (st.doctrine ? ' · ' + st.doctrine.name : '') +
           (st.keystoneId && Engine.get().players[idx].cards[st.keystoneId]
              ? ' · ' + Engine.get().players[idx].cards[st.keystoneId].name : '');
  }

  return { tick: tick, reset: reset, describe: describe, brain: brain };
})();
