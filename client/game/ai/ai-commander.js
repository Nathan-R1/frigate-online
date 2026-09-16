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

  function log2(s, msg) {
    var G = Engine.get();
    if (G && G.log) G.log.push({ turn: G.turn, side: s.idx, msg: msg });
  }
  function brain(idx) {
    if (!brains[idx]) brains[idx] = { phase: 'PREP', doctrine: null, keystoneId: null, turnSeen: -1 };
    return brains[idx];
  }
  function reset() { brains = {}; }

  /* the enemy this AI is currently orienting on — the nearest living one on another team */
  function foeOf(s) { return Engine.foe(s); }
  function foesOf(s) { return Engine.enemiesOf(s); }
  /* every enemy piece on the board, regardless of which opposing side owns it */
  function allFoeObjects(s) {
    var out = [];
    foesOf(s).forEach(function (f) { out = out.concat(K.modList(f)).concat(K.depList(f)); });
    return out;
  }

  /* Is anything of theirs actually in a gun's envelope right now? Exhausted guns count —
     this asks whether the fleets are in contact, not whether we can fire this instant. */
  function inContact(s) {
    var tgts = allFoeObjects(s);
    return K.weapons(s).some(function (w) {
      return tgts.some(function (t) {
        return Engine.dist(w.mod, t) <= w.range && Engine.hasLos(w.mod, t);
      });
    });
  }

  /* ---------- phase transitions ---------- */
  function updatePhase(s, st) {
    var G = Engine.get(), foe = foeOf(s);
    if (!st.doctrine) st.doctrine = D.choose(s);
    var core = foe.modules[foe.coreId];

    /* Standoff breaker. Two cautious fleets with the same envelope both sit contentedly at
       the edge of their band and never trade a shot — each one's ideal gap is the other's.
       Once nothing has been in our sights for several turns, press in until contact
       resumes; being shot at is better than a game that never ends. */
    if (inContact(s)) { st.lastContact = G.turn; st.pressing = false; }
    else if (st.lastContact === undefined) st.lastContact = G.turn;
    else if (G.turn - st.lastContact >= 4 && !st.pressing) {
      st.pressing = true;
      log2(s, s.name + ' has had no contact for several turns — closing in.');
    }

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
  /* Plan past this turn's Move. A destination twelve squares away through a gap is a
     legitimate answer when nothing closer improves anything — we take what Move we have
     toward it now and pick the route up again next turn. */
  var PLAN_HORIZON = 14;
  function manoeuvre(s, st) {
    var foe = foeOf(s);
    var reach = P.budget(s);
    var horizon = Math.min(30, reach + PLAN_HORIZON);

    function pick(nodes) {
      var best = null, bestScore = -1e9;
      Object.keys(nodes).forEach(function (k) {
        var n = nodes[k];
        var sc = st.phase === 'FINISH'
          ? D.firepowerAt(s, foe, n.dx, n.dy) * 5 - D.gapAt(s, foe, n.dx, n.dy)
          : st.doctrine.score(s, foe, n.dx, n.dy, st);
        /* out of contact for too long: keep the doctrine's shape but add a steady pull
           inward, so "stay at the edge of my band" can no longer beat closing the gap */
        if (st.pressing && st.phase !== 'FINISH') sc -= D.gapAt(s, foe, n.dx, n.dy) * 6;
        /* a good square we cannot reach yet is still worth starting toward, just discounted:
           steps we can take now are nearly free, steps beyond the budget are speculative */
        sc -= Math.min(n.cost, reach) * 0.1;
        if (n.cost > reach) sc -= (n.cost - reach) * 2.5;
        /* keep heading for last turn's goal unless something clearly better appeared, so the
           fleet does not dither at the mouth of a gap */
        if (st.goal && st.goal.x === n.dx && st.goal.y === n.dy) sc += 6;
        if (sc > bestScore) { bestScore = sc; best = n; }
      });
      return best;
    }

    var best = pick(P.reachable(s, horizon));
    /* Nothing on the strict lattice beat standing still. That is usually a hull fenced in by
       its own idle drones, leaving only routes that back away. Look again at the lattice that
       lets us drive over them: a crushed decoy is cheaper than a game that never ends. */
    if (!best || (!best.dx && !best.dy)) {
      var loose = pick(P.reachable(s, horizon, true));
      if (loose && (loose.dx || loose.dy)) best = loose;
    }
    if (best && (best.dx || best.dy)) {
      var taken = P.advance(s, best);
      /* remember what is left of the route, in offsets from where we now stand */
      var steps = P.pathOf(best);
      if (taken < steps.length) {
        var rx = 0, ry = 0;
        for (var i = taken; i < steps.length; i++) { rx += steps[i][0]; ry += steps[i][1]; }
        st.goal = { x: rx, y: ry };
      } else st.goal = null;
    } else st.goal = null;
    /* Whatever Move survives the approach is spent here, in priority order. Clearing a firing
       line comes before tidying berths: a gun that can shoot this turn is worth more than a
       gun in the right place next turn. Both must happen before the Move is committed away. */
    var tgts = allFoeObjects(s);
    for (var r = 0; r < 3; r++) {
      var rotated = AIPlacement.repositionForLos(s, tgts);
      if (!rotated) break;
      log2(s, rotated.name + ' shifts to clear its line of fire.');
    }
    AIPlacement.reconfigure(s, foe);
    K.modList(s).forEach(function (m) { m.moveLeft = 0; });   /* commit the turn's movement */
  }

  /* ---------- target choice ---------- */
  /* Is this rock the thing standing between a gun and something we want to shoot?
     Tested by lifting it off the board and asking whether a blocked shot opens up —
     collinearity cannot be inferred from Manhattan distances, because every square inside
     the bounding rectangle satisfies dist(a,r) + dist(r,b) === dist(a,b). */
  function blocksOurLine(s, foe, rock) {
    var G = Engine.get(), k = rock.x + ',' + rock.y, saved = G.cells[k];
    var guns = K.weapons(s), tgts = allFoeObjects(s);
    var opens = false;
    for (var i = 0; i < guns.length && !opens; i++) {
      for (var j = 0; j < tgts.length && !opens; j++) {
        var g = guns[i], t = tgts[j];
        if (Engine.dist(g.mod, t) > g.range) continue;      /* out of reach anyway */
        if (Engine.hasLos(g.mod, t)) continue;              /* already have the shot */
        delete G.cells[k];
        opens = Engine.hasLos(g.mod, t);
        G.cells[k] = saved;
      }
    }
    return opens;
  }

  /* The closest to the target the formation could translate to, ignoring this turn's Move —
     we care whether a rock matters for the route at all, not whether we can clear it today. */
  /* A rock touching the hull is sitting on a square we will want — orthogonal adjacency is
     exactly the set of squares a module can step into next. That is a cheaper and steadier
     signal than probing the pathfinder, which rated every segment of a distant wall equally
     because removing any one of them opened a hole. */
  function adjacentToHull(s, rock) {
    return K.modList(s).some(function (m) { return Engine.dist(m, rock) === 1; });
  }
  /* -1 astern .. +1 dead ahead: clear the road in front before tidying up behind */
  function rockBearing(s, foe, rock) {
    var core = s.modules[s.coreId];
    if (!core) return 0;
    return AIPlacement.bearing(core, AIPlacement.facing(s, foe), rock.x, rock.y);
  }

  /* Targets sort into three tiers:
       primary   — the module this doctrine most wants gone
       secondary — any other ship or deployable that is reachable
       tertiary  — terrain, and only when clearing it opens a blocked shot
     The tiers decide whether firing is worth it at all, not just what to aim at. */
  function classifyTargets(s, st, ids) {
    var foe = foeOf(s), G = Engine.get();
    var ships = [], rocks = [];
    ids.forEach(function (id) {
      var rock = (G.asteroids || {})[id];
      if (rock) { rocks.push(rock); return; }
      /* with three or four sides a target id may belong to any enemy, so ask the engine
         who owns it and judge the piece against that owner's ship */
      var found = Engine.objectById(id);
      if (!found || !found.owner || found.owner.team === s.team) return;
      var owner = found.owner, t = found.obj, isDep = found.kind === 'deployable';
      var sc = st.doctrine.targetBias(t, isDep, owner);
      if (t.id === owner.coreId) {
        var lethal = K.expectedDamage(s) >= owner.shield + t.hull;
        sc = lethal ? 500 : sc - 40;
      }
      if (!isDep && K.preset(t).tt === 'offense' && K.modList(owner).filter(K.isGun).length <= 1) sc += 40;
      if (owner.idx !== foe.idx) sc -= 15;        /* mild pull towards the side we are engaging */
      var d = Math.min.apply(null, K.modList(s).map(function (m) { return Engine.dist(m, t); }).concat([99]));
      ships.push({ id: id, score: sc - d * 0.5 });
    });
    ships.sort(function (a, b) { return b.score - a.score; });
    /* Terrain earns a shot if it denies us a firing line or a route to the target. Several
       rocks in a wall each "open a hole", so rank them: biggest gain first, then whichever is
       nearest the fleet — that is the one actually plugging the way ahead. */
    var scored = [];
    rocks.forEach(function (r) {
      var line = blocksOurLine(s, foe, r);
      var touching = adjacentToHull(s, r);
      if (!line && !touching) return;          /* neither in our sights nor under our feet */
      var d = Math.min.apply(null, K.modList(s).map(function (m) { return Engine.dist(m, r); }).concat([99]));
      scored.push({ id: r.id,
                    score: (line ? 50 : 0) + (touching ? 25 : 0) +
                           rockBearing(s, foe, r) * 15 - d });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    var tertiary = scored.map(function (x) { return x.id; });
    return { primary: ships.length ? ships[0].id : null,
             secondary: ships.slice(1).map(function (x) { return x.id; }),
             tertiary: tertiary };
  }

  function bestTarget(s, st, ids) {
    var t = classifyTargets(s, st, ids);
    return t.primary || t.secondary[0] || t.tertiary[0] || null;
  }

  /* Rocks the hull is actually resting against. The formation moves as a rigid shape, so one
     of these pins the entire fleet in that direction; with a big enough hull all four
     directions get pinned and the fleet never moves again. They are worth a shot even when
     no enemy is anywhere near. */
  function pinningRocks(s) {
    var G = Engine.get();
    return Object.keys(G.asteroids || {}).map(function (id) { return G.asteroids[id]; })
      .filter(function (r) { return adjacentToHull(s, r); });
  }

  /* a ready gun that already has something worth shooting in range with line of sight — the
     reason not to spend another engine and another turn of Move getting closer */
  function gunWithShot(s) {
    var tgts = allFoeObjects(s).concat(pinningRocks(s));
    var found = null;
    K.weapons(s).forEach(function (w) {
      if (found || w.mod.exhausted || !Engine.meetsReq(s, w.mod)) return;
      for (var i = 0; i < tgts.length; i++)
        if (Engine.dist(w.mod, tgts[i]) <= w.range && Engine.hasLos(w.mod, tgts[i])) { found = w.mod; return; }
    });
    return found;
  }

  /* Would this ability actually find something to shoot? `extraMove` is the distance the
     piece may close as part of the same activation (a torpedo's run), so a one-shot weapon
     is only spent when it can finish within reach of a real target. */
  function hasTargetFor(s, origin, name, extraMove) {
    var reach = K.attackReach(s, name);
    if (reach === null) return true;                  /* not a weapon — no range to satisfy */
    var tgts = allFoeObjects(s).concat(pinningRocks(s));
    for (var i = 0; i < tgts.length; i++) {
      var d = Engine.dist(origin, tgts[i]);
      if (d <= reach && Engine.hasLos(origin, tgts[i])) return true;   /* can hit from here */
      if (extraMove > 0 && d <= reach + extraMove) return true;        /* can hit after its run */
    }
    return false;
  }

  /* ---------- prompt answers ---------- */
  function answer(s, st, p) {
    if (p.kind === 'choice') return chooseOption(s, st, p);
    if (p.kind === 'target') return bestTarget(s, st, p.targets);
    if (p.kind === 'move') { manoeuvre(s, st); return null; }
    if (p.kind === 'moveObject') return null;
    if (p.kind === 'space') {
      var name = AIPlacement.nameFromLabel(p.label);
      return AIPlacement.best(s, foeOf(s), name, p.filter);
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

    /* 1. if a gun already bears on something, shoot — burning engines to close a gap we do
       not have is how a turn gets wasted. Only reach for mobility when there is no shot. */
    var readyGun = gunWithShot(s);
    if (readyGun) { Engine.activateModule(readyGun.id); return; }

    /* 2. no shot, but is a target merely screened? Stepping one gun clear of its own hull is
       far cheaper than hauling the whole formation into a new position. */
    if (K.modList(s).some(function (m) { return m.moveLeft > 0; })) {
      var rotated = AIPlacement.repositionForLos(s, allFoeObjects(s));
      if (rotated) { log2(s, rotated.name + ' shifts to clear its line of fire.'); return; }
    }

    /* 3. still nothing: spend Move we already hold before generating more */
    if (K.modList(s).some(function (m) { return m.moveLeft > 0; })) { manoeuvre(s, st); return; }

    /* 4. still no shot: bring ONE engine online, then loop back to step 1 — after moving we
       may already be in range, and the remaining engines stay ready for next turn */
    var mv = K.modList(s).filter(function (m) {
      return !m.exhausted && K.isEngine(m) && Engine.fx(m.name, 'mod').activate && Engine.meetsReq(s, m); })[0];
    if (mv) { Engine.activateModule(mv.id); return; }
    var mvCard = s.played.map(function (i) { return s.cards[i]; }).filter(function (c) {
      return !c.exhausted && Engine.fx(c.name, 'tech').activate && K.roleOf(c.name) === 'mobility'; })[0];
    if (mvCard) { Engine.activateCard(mvCard.id); return; }

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

    /* 5. deployables. A one-shot is only spent when its run ends within reach of a target;
       one that survives its activation may move up regardless, which is how TAT Guided closes. */
    var dep = K.depList(s).filter(function (d) {
      if (d.exhausted || !Engine.fx(d.name, 'mod').activate) return false;
      if (!K.isOneShot(d.name)) return true;
      return hasTargetFor(s, d, d.name, K.selfMove(d.name));
    })[0];
    if (dep) { Engine.activateDeployable(dep.id); return; }

    /* 6. anything else with an ability — but never a weapon with nothing in range */
    var other = K.modList(s).filter(function (m) {
      if (m.exhausted || !Engine.fx(m.name, 'mod').activate || !Engine.meetsReq(s, m)) return false;
      return hasTargetFor(s, m, m.name, 0);
    })[0];
    if (other) { Engine.activateModule(other.id); return; }
    var card = s.played.map(function (i) { return s.cards[i]; }).filter(function (c) {
      if (c.exhausted || !Engine.fx(c.name, 'tech').activate) return false;
      if (K.attackReach(s, c.name) === null) return true;
      /* a card fires from the hull, so any module may serve as its origin */
      return K.modList(s).some(function (m) { return hasTargetFor(s, m, c.name, 0); });
    })[0];
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
