/* Attack animations — a shot drawn on the board after the dice have spoken.
 *
 * The engine writes every shot into the state (engine.js: recordShot): the square it came
 * from, the square it went to, and whether each roll hit. Online that arrives in a snapshot
 * like everything else, so this file never asks how a shot came about — it watches G.shots
 * for numbers it has not drawn yet and plays them, one after another.
 *
 * Every shot marks both ends: the firing square is ringed in the shooter's seat colour and the
 * target square wears a red reticle, joined by a faint guide line while the shot plays. Each
 * roll then sends its own round across. A hit ends in the style's impact; a miss ends in
 * nothing — the round simply fades where it was going.
 *
 * How a shot looks is a style: ballistic, energy, bio, tractor or torpedo. An attack may name
 * one with `anim` (card-effects.js); left out, the damage type picks it, and anything else
 * falls back to the default ballistic round. A new look is one entry in STYLES — and, for a
 * damage type, one line in BY_TYPE.
 */
var AttackFx = (function () {
  'use strict';

  var STAGGER = 170;          /* ms between the rolls of one shot */
  var BACKLOG = 3500;         /* never let a run of computer shots fall further behind than this */

  var BY_TYPE = { kinetic: 'ballistic', energy: 'energy', bio: 'bio', ion: 'energy' };

  var env = null, lastN = null, freeAt = 0;

  /* ---- drawing kit: absolutely placed divs on the board's fx layer, in board pixels ---- */
  function centre(p) { return { x: p.x * env.cell + env.cell / 2, y: p.y * env.cell + env.cell / 2 }; }

  function blob(x, y, size, css) {
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;pointer-events:none;left:' + (x - size / 2) + 'px;top:' +
      (y - size / 2) + 'px;width:' + size + 'px;height:' + size + 'px;' + (css || '');
    env.layer.appendChild(d);
    return d;
  }
  /* a bar from a to b, for beams and guide lines; it grows from a */
  function bar(a, b, thick, css) {
    var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy);
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;pointer-events:none;left:' + a.x + 'px;top:' +
      (a.y - thick / 2) + 'px;width:' + len + 'px;height:' + thick + 'px;transform-origin:0 50%;' +
      'transform:rotate(' + Math.atan2(dy, dx) + 'rad);' + (css || '');
    env.layer.appendChild(d);
    return d;
  }
  /* run keyframes after `delay` ms, then take the element away */
  function play(d, frames, ms, delay, easing) {
    d.style.opacity = '0';
    var a = d.animate(frames, { duration: ms, delay: delay || 0, easing: easing || 'ease-out',
                                fill: 'forwards' });
    a.onfinish = function () { if (d.parentNode) d.parentNode.removeChild(d); };
    return a;
  }
  function travelMs(a, b) {
    var cells = Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2)) / env.cell;
    return Math.min(460, 140 + cells * 22);
  }
  /* where a miss ends up: a little past the target and off to one side, alternating */
  function wide(a, b, i) {
    var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var side = (i % 2 ? 1 : -1) * env.cell * 0.55, over = env.cell * 0.6;
    return { x: b.x + dx / len * over - dy / len * side, y: b.y + dy / len * over + dx / len * side };
  }

  /* ---- the two ends, shared by every style ---- */
  function markOrigin(p, colour, ms) {
    var s = env.cell + 6;
    play(blob(p.x, p.y, s, 'border:2px solid ' + colour + ';border-radius:6px;box-sizing:border-box;' +
                       'box-shadow:0 0 10px ' + colour + ',inset 0 0 8px ' + colour + ';'),
         [{ opacity: 0, transform: 'scale(1.5)' }, { opacity: 1, transform: 'scale(1)', offset: .15 },
          { opacity: 1, transform: 'scale(1)', offset: .8 }, { opacity: 0, transform: 'scale(1)' }], ms);
  }
  function markTarget(p, ms) {
    var c = '#ff5a4a', s = env.cell + 10, k = 9, w = 2, g = [];
    ['0 0', '100% 0', '0 100%', '100% 100%'].forEach(function (at) {
      g.push('linear-gradient(' + c + ',' + c + ') ' + at + '/' + k + 'px ' + w + 'px no-repeat');
      g.push('linear-gradient(' + c + ',' + c + ') ' + at + '/' + w + 'px ' + k + 'px no-repeat');
    });
    play(blob(p.x, p.y, s, 'background:' + g.join(',') + ';filter:drop-shadow(0 0 4px ' + c + ');'),
         [{ opacity: 0, transform: 'scale(1.7) rotate(45deg)' },
          { opacity: 1, transform: 'scale(1) rotate(0deg)', offset: .18 },
          { opacity: 1, transform: 'scale(1)', offset: .8 }, { opacity: 0, transform: 'scale(.9)' }], ms);
  }
  function guide(a, b, ms) {
    play(bar(a, b, 1, 'border-top:1px dashed rgba(255,255,255,.55);'),
         [{ opacity: 0 }, { opacity: .8, offset: .15 }, { opacity: .8, offset: .8 }, { opacity: 0 }], ms);
  }
  function flash(p, size, colour, delay) {
    play(blob(p.x, p.y, size, 'border-radius:50%;background:radial-gradient(circle,#fff 0,' + colour +
                              ' 45%,transparent 70%);'),
         [{ opacity: 1, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(1.2)' }], 180, delay);
  }
  function rings(p, colour, n, delay, ms) {
    for (var i = 0; i < n; i++)
      play(blob(p.x, p.y, env.cell, 'border-radius:50%;background:radial-gradient(circle,' +
                                    'transparent 52%,' + colour + ' 60%,' + colour + ' 64%,transparent 71%);'),
           [{ opacity: .95, transform: 'scale(.25)' }, { opacity: 0, transform: 'scale(2.6)' }],
           ms || 620, delay + i * 140);
  }

  /* ---- styles ----
     Each draws one roll: `a` is the firing square's centre (null when the shooter is hidden
     from you), `b` the target's, `hit` how the roll came out, `t0` when it starts. It returns
     [when the impact lands, how long it runs], both from t0; a miss has no impact. */
  var STYLES = {
    /* the default: a tracer round, and a fireball when it connects */
    ballistic: function (a, b, hit, t0, i) {
      var from = a || b, end = hit ? b : wide(from, b, i), ms = a ? travelMs(a, end) : 0;
      if (a) {
        flash(a, env.cell * .8, '#ffb347', t0);
        play(blob(a.x, a.y, 7, 'border-radius:50%;background:#fff6c8;' +
                               'box-shadow:0 0 6px 2px #ffcf4a,0 0 14px #ff8a1f;'),
             [{ opacity: 1, transform: 'translate(0,0)' },
              { opacity: hit ? 1 : 0, transform: 'translate(' + (end.x - a.x) + 'px,' + (end.y - a.y) + 'px)' }],
             ms, t0, 'linear');
      }
      if (hit) explode(b, t0 + ms);
      return [hit ? ms : null, ms + (hit ? 560 : 0)];
    },
    /* a beam that is there at once; a hit flares white-hot where it lands */
    energy: function (a, b, hit, t0, i) {
      var end = hit ? b : wide(a || b, b, i);
      if (a) {
        play(bar(a, end, 4, 'border-radius:2px;background:linear-gradient(90deg,#9ff3ff,#fff);' +
                            'box-shadow:0 0 6px #4fd8ff,0 0 14px #2a9dff;'),
             [{ opacity: 0, transform: bar.r(a, end) + ' scaleX(0)' },
              { opacity: 1, transform: bar.r(a, end) + ' scaleX(1)', offset: .25 },
              { opacity: .9, transform: bar.r(a, end) + ' scaleX(1) scaleY(.6)', offset: .7 },
              { opacity: 0, transform: bar.r(a, end) + ' scaleX(1) scaleY(.2)' }], 320, t0);
      }
      if (hit) {
        flash(b, env.cell * 1.5, '#5fe3ff', t0 + 70);
        rings(b, '#8beaff', 1, t0 + 90, 420);
        scorch(b, t0 + 90);
      }
      return [hit ? 70 : null, hit ? 640 : 320];
    },
    /* a lobbed glob of something alive; a hit bursts into a spreading cloud */
    bio: function (a, b, hit, t0, i) {
      var from = a || b, end = hit ? b : wide(from, b, i), ms = a ? travelMs(a, end) + 120 : 0;
      if (a) {
        var dx = end.x - a.x, dy = end.y - a.y, lift = Math.min(env.cell, 8 + Math.sqrt(dx * dx + dy * dy) * .12);
        var frames = [];
        for (var k = 0; k <= 6; k++) {
          var f = k / 6, arc = -4 * lift * f * (1 - f);
          frames.push({ opacity: (!hit && k === 6) ? 0 : 1,
                        transform: 'translate(' + dx * f + 'px,' + (dy * f + arc) + 'px) scale(' + (1 - .25 * f) + ')' });
        }
        play(blob(a.x, a.y, 10, 'border-radius:50%;background:radial-gradient(circle at 35% 35%,#d8ff9a,#5fd23c 60%,#2e7d1c);' +
                                'box-shadow:0 0 8px #7dff5a;'), frames, ms, t0, 'linear');
      }
      if (hit) {
        for (var n = 0; n < 5; n++) {
          var ang = n * 1.2566 + i, r = env.cell * .45;
          play(blob(b.x + Math.cos(ang) * 4, b.y + Math.sin(ang) * 4, 12,
                    'border-radius:50%;background:rgba(125,255,90,.75);filter:blur(1px);'),
               [{ opacity: .9, transform: 'translate(0,0) scale(.5)' },
                { opacity: 0, transform: 'translate(' + Math.cos(ang) * r + 'px,' + Math.sin(ang) * r + 'px) scale(1.8)' }],
               700, t0 + ms);
        }
      }
      return [hit ? ms : null, ms + (hit ? 700 : 0)];
    },
    /* a beam that takes hold rather than burns: it shimmers across and, on a hit, sends a
       shockwave through whatever it caught */
    tractor: function (a, b, hit, t0) {
      if (a) {
        var d = bar(a, b, 8, 'border-radius:4px;background:repeating-linear-gradient(90deg,' +
                             'rgba(190,140,255,.95) 0 6px,rgba(120,80,255,.15) 6px 12px);' +
                             'box-shadow:0 0 10px #9a7cff;');
        play(d, [{ opacity: 0, backgroundPosition: '0 0' }, { opacity: 1, offset: .2 },
                 { opacity: hit ? 1 : .6, offset: .75 },
                 { opacity: 0, backgroundPosition: '-48px 0' }], 900, t0, 'linear');
      }
      if (hit) rings(b, '#c39bff', 3, t0 + 300, 700);
      return [hit ? 300 : null, hit ? 1300 : 900];
    }
  };
  /* the torpedo is its own round: the piece throws itself at the target, picking up speed and
     trailing exhaust, and a hit is a warhead going off — the ballistic fireball, bigger, with a
     shockwave behind it. A miss runs on past and burns out. `launches` tells draw() the piece
     has left its square, so the one left standing there (see keep) goes as it sets off. */
  STYLES.torpedo = function (a, b, hit, t0, i) {
    var from = a || b, end = hit ? b : wide(from, b, i);
    var ms = a ? Math.min(560, 260 + Math.sqrt(Math.pow(end.x - a.x, 2) + Math.pow(end.y - a.y, 2)) / env.cell * 55) : 0;
    if (a) {
      var dx = end.x - a.x, dy = end.y - a.y, rot = 'rotate(' + Math.atan2(dy, dx) + 'rad)';
      var len = env.cell * .7, thick = Math.max(5, env.cell * .2);
      var body = blob(a.x, a.y, len, 'height:' + thick + 'px;margin-top:' + (len - thick) / 2 + 'px;' +
        'border-radius:' + thick + 'px ' + thick * 1.6 + 'px ' + thick * 1.6 + 'px ' + thick + 'px;' +
        'background:linear-gradient(90deg,#ff9a3c 0,#ffe08a 12%,#cfd6de 22%,#8c97a3 70%,#e2483d 72%,#ff6a5c 100%);' +
        'box-shadow:-6px 0 10px 2px rgba(255,150,60,.7);');
      play(body, [{ opacity: 1, transform: 'translate(0,0) ' + rot },
                  { opacity: 1, transform: 'translate(' + dx * .15 + 'px,' + dy * .15 + 'px) ' + rot, offset: .35 },
                  { opacity: hit ? 1 : 0, transform: 'translate(' + dx + 'px,' + dy + 'px) ' + rot }],
           ms, t0, 'cubic-bezier(.55,0,.85,.5)');
      /* exhaust left hanging along the run */
      for (var k = 1; k <= 5; k++) {
        var f = k / 6, at = Math.pow(f, 1.8);
        play(blob(a.x + dx * at, a.y + dy * at, env.cell * .35,
                  'border-radius:50%;background:radial-gradient(circle,rgba(200,200,210,.6),transparent 70%);'),
             [{ opacity: .8, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.6)' }],
             520, t0 + ms * f);
      }
    }
    if (hit) {
      explode(b, t0 + ms);
      play(blob(b.x, b.y, env.cell * 2.3, 'border-radius:50%;background:radial-gradient(circle,' +
                                          'rgba(255,240,200,.95) 0,rgba(255,150,40,.8) 35%,rgba(180,40,0,.4) 55%,transparent 70%);'),
           [{ opacity: 1, transform: 'scale(.15)' }, { opacity: .9, transform: 'scale(.9)', offset: .3 },
            { opacity: 0, transform: 'scale(1.15)' }], 620, t0 + ms);
      rings(b, '#ffb347', 1, t0 + ms + 40, 560);
    }
    return [hit ? ms : null, ms + (hit ? 760 : 0)];
  };
  STYLES.torpedo.launches = true;

  bar.r = function (a, b) { return 'rotate(' + Math.atan2(b.y - a.y, b.x - a.x) + 'rad)'; };
  STYLES['default'] = STYLES.ballistic;

  /* the ballistic hit: a white core blooming to fire, sparks thrown off and a puff of smoke */
  function explode(p, t0) {
    play(blob(p.x, p.y, env.cell * 1.4, 'border-radius:50%;background:radial-gradient(circle,' +
                                        '#fff 0,#ffe27a 25%,#ff8a1f 50%,rgba(200,40,0,.6) 65%,transparent 72%);'),
         [{ opacity: 1, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1)', offset: .35 },
          { opacity: 0, transform: 'scale(1.25)' }], 460, t0);
    play(blob(p.x, p.y, env.cell * 1.2, 'border-radius:50%;background:radial-gradient(circle,' +
                                        'rgba(90,90,90,.55) 0,rgba(60,60,60,.3) 45%,transparent 70%);'),
         [{ opacity: 0, transform: 'scale(.5)' }, { opacity: .9, transform: 'scale(1)', offset: .3 },
          { opacity: 0, transform: 'scale(1.6)' }], 760, t0 + 120);
    for (var k = 0; k < 7; k++) {
      var ang = k * .8976 + .3, r = env.cell * (.75 + (k % 3) * .2);
      play(blob(p.x, p.y, 3, 'border-radius:50%;background:#ffd36a;box-shadow:0 0 4px #ff8a1f;'),
           [{ opacity: 1, transform: 'translate(0,0)' },
            { opacity: 0, transform: 'translate(' + Math.cos(ang) * r + 'px,' + Math.sin(ang) * r + 'px)' }],
           420, t0 + 40);
    }
  }
  function scorch(p, t0) {
    play(blob(p.x, p.y, env.cell * .7, 'border-radius:50%;background:radial-gradient(circle,' +
                                       'rgba(255,255,255,.9) 0,rgba(95,227,255,.5) 40%,transparent 70%);'),
         [{ opacity: 1 }, { opacity: 0 }], 520, t0);
  }

  function styleOf(shot) {
    if (shot.anim && STYLES[shot.anim]) return STYLES[shot.anim];
    return STYLES[BY_TYPE[shot.dmgType]] || STYLES['default'];
  }

  /* One shot: both ends marked for as long as it runs, each roll a beat behind the last. The
     piece it destroyed is still standing on the board as a ghost (see keep) and goes under the
     last impact; once no shot is left to play, so does anything else the volley took with it —
     a Core's wreck, a mine's neighbours. */
  function draw(shot) {
    var b = centre(shot.to);
    var a = shot.from && !Engine.hiddenFrom(shot.from, env.viewer) ? centre(shot.from) : null;
    if (a && a.x === b.x && a.y === b.y) a = null;      /* a blast going off where it stands */
    var style = styleOf(shot), end = 0, impact = 0;
    (shot.rolls || []).forEach(function (hit, i) {
      var t0 = 260 + i * STAGGER, r = style(a, b, hit, t0, i);
      if (r[0] !== null) impact = Math.max(impact, t0 + r[0]);
      end = Math.max(end, i * STAGGER + r[1]);
    });
    var total = 260 + end + 260;
    if (a) { markOrigin(a, env.colour(shot.side), total); guide(a, b, total); }
    markTarget(b, total);
    /* a round that is the piece itself: the copy left on its square goes as it sets off */
    if (style.launches && a && shot.from && shot.from.id) {
      setTimeout(function () {
        ghosts = ghosts.filter(function (g) {
          if (g.id !== shot.from.id) return true;
          vanish(g.node);
          return false;
        });
      }, 260);
    }
    var last = --playing === 0;
    setTimeout(function () {
      ghosts = ghosts.filter(function (g) {
        if (!last && g.id !== (shot.to && shot.to.id)) return true;
        vanish(g.node);
        return false;
      });
    }, (impact || 260) + 120);
    return total;
  }

  /* ---- ghosts ----
     The state already knows a piece is gone by the time its shot is drawn, so the board would
     take it away before the round had even left the gun. While shots are waiting to play, a
     piece the board drops is handed here instead: it stays where it stood, on the fx layer
     under the effects, until the impact that destroyed it. */
  var ghosts = [], playing = 0;
  function keep(node, id) {
    if (!playing || !env || !env.layer) return false;
    env.layer.insertBefore(node, env.layer.firstChild);
    var g = { id: id, node: node };
    ghosts.push(g);
    /* whatever happens to the shots, a ghost never outstays its welcome */
    setTimeout(function () {
      if (ghosts.indexOf(g) >= 0) { ghosts.splice(ghosts.indexOf(g), 1); vanish(node); }
    }, BACKLOG + 4000);
    return true;
  }
  function vanish(node) {
    if (!node.parentNode) return;
    var a = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    a.onfinish = function () { if (node.parentNode) node.parentNode.removeChild(node); };
  }

  /* Anything in G.shots numbered past the last one drawn is new. The first look at a game —
     a page opened mid-match, a snapshot on joining — draws nothing: those shots are history.
     A count that has gone backwards is a new game, every shot in it new. */
  function sync(G, e) {
    env = e;
    var shots = (G && G.shots) || [];
    var top = shots.length ? shots[shots.length - 1].n : 0;
    if (lastN === null) { lastN = top; return; }
    if (top < lastN) lastN = 0;
    var fresh = shots.filter(function (s) { return s.n > lastN; });
    lastN = top;
    if (!env.layer || env.still) return;
    fresh.forEach(function (shot) {
      if (Engine.hiddenFrom(shot.to, env.viewer)) return;
      var now = Date.now();
      if (freeAt - now > BACKLOG) freeAt = now + BACKLOG;
      var wait = Math.max(0, freeAt - now);
      /* the next shot starts once this one has had its moment, not after every spark has gone */
      freeAt = now + wait + 260 + (shot.rolls || []).length * STAGGER + 450;
      playing++;
      setTimeout(function () {
        if (env.layer && env.layer.isConnected) draw(shot);
        else playing--;
      }, wait);
    });
  }

  return { sync: sync, keep: keep, styles: STYLES, byType: BY_TYPE };
})();
