/* Floating tutorial prompts — the tutorial's own voice on the board.
 *
 * Each "Tutorial Prompt" tech holds a passive that asks the engine to notify the view when
 * its moment comes (engine.js: OPS.popup). This module turns those notices into a bubble
 * that floats next to the thing the prompt is about, points at it with an arrow, and is
 * dismissed by touching anywhere on the screen — the next bubble in line then shows.
 *
 * The wording lives on the cards themselves, in the passive text: "... popup:" opens the
 * bubble, the next line is its title and whatever follows is the subtitle. This file knows
 * only where each bubble points. `hidden` keeps the prompt cards out of the hand bar; they
 * are real in-play techs, but their quiet job is done once they have spoken.
 *
 * Prompt cards are dealt one-shot — each trashes itself after popping — but the whole
 * sequence starts when the tutorial button is pressed, so the page can be restarted or
 * replayed on the same load without the prompts refusing to come back.
 */
var Notify = (function () {
  'use strict';

  /* each bubble hangs next to something on the board — no anchor means the centre of the screen.
     The turn-2 prompts live with the opponent: "Play a Card" points at the hand it is about to
     fill, "Enemy Moves" just voices the enemy's turn. */
  var ANCHOR = {
    'Tutorial Prompt — Click to Begin':       { side: 'centre' },
    'Tutorial Prompt — Cards':                { id: 'hand', side: 'above' },
    'Tutorial Prompt — Modules':              { id: 'hand', side: 'above' },
    'Tutorial Prompt — Moving':               { side: 'centre' },
    'Tutorial Prompt — End Turn':             { id: 'endBtn', side: 'below' },
    'Tutorial Prompt — Play a Card':          { id: 'hand', side: 'above' },
    /* the "Enemy Moves" bubble is held until the player hands the turn over — see notice() */
    'Tutorial Prompt — Enemy Moves':          { side: 'centre' },
    'Tutorial Prompt — Cannon Aim':           { side: 'centre' },
    'Tutorial Prompt — Cannon No Targets':    { side: 'centre' },
    'Tutorial Prompt — Cannon Fired':         { id: 'gTop', side: 'above' }
  };

  var guard = null, cur = null, queue = [], shown = {};
  var armed = false, held = null, lastActive = null, seenG = null;

  function make() {
    if (typeof Engine === 'undefined' || !Engine.onNotice || document.getElementById('tutGuard'))
      return;
    var style = document.createElement('style');
    style.textContent =
      '#tutGuard{position:fixed;inset:0;z-index:99999;}\n' +
      '#tutPop{position:absolute;transform:translate(-50%,0);max-width:min(300px,82vw);' +
        'padding:14px 18px;border-radius:12px;box-sizing:border-box;' +
        'background:var(--panel,#141a2b);color:var(--ink,#e6e6e6);' +
        'border:2px solid #e8c04a;box-shadow:0 0 0 1px rgba(232,192,74,.55),0 0 18px rgba(232,192,74,.35),0 10px 32px rgba(0,0,0,.5);' +
        'font:14px/1.45 var(--font,system-ui,sans-serif);' +
        'pointer-events:none;animation:tutIn .18s ease-out;}\n' +
      '#tutPop .tut-title{font-weight:800;font-size:17px;letter-spacing:.03em;' +
        'color:#ffd75e;text-shadow:0 0 10px rgba(255,215,94,.45);}\n' +
      '#tutPop .tut-sub{margin-top:4px;font-size:13px;color:var(--ink-dim,#9aa);}\n' +
      '#tutPop::before{content:"";position:absolute;width:12px;height:12px;' +
        'background:inherit;border:inherit;border-top:0;border-left:0;transform:rotate(45deg);}\n' +
      '#tutPop.above::before{bottom:-8px;left:50%;margin-left:-6px;border-bottom:0;}\n' +
      '#tutPop.below::before{top:-8px;left:50%;margin-left:-6px;border-top:0;}\n' +
      '#tutPop.centre::before{display:none;}' +
      '@keyframes tutIn{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;' +
        'transform:translate(-50%,0)}}' +
      '#tutPop.centre{transform:translate(-50%,-50%);}' +
      '#tutPop.centre{animation:centerIn .18s ease-out;}' +
      '@keyframes centerIn{from{opacity:0}to{opacity:1}}';
    document.head.appendChild(style);

    guard = document.createElement('div');
    guard.id = 'tutGuard';
    guard.style.display = 'none';
    guard.innerHTML =
      '<div id="tutPop"><div class="tut-title"></div><div class="tut-sub"></div></div>';
    document.body.appendChild(guard);
    /* "dismiss on any touch" — the guard covers the whole screen, so wherever the tap lands
       it lands here, and the bubble itself never touches the page below it. */
    guard.addEventListener('pointerdown', next);

    Engine.onNotice(notice);
    Engine.onChange(onView);
  }

  /* split the card's passive text: the line after "popup:" is the title, the rest the
     subtitle — the same words that make up the card's description */
  function parse(cardName) {
    var t = (Engine.findTech && Engine.findTech(cardName)) || {};
    var txt = t.passive || '';
    var title = cardName, subtitle = '';
    var i = txt.indexOf('popup:');
    if (i >= 0) {
      var lines = txt.slice(i + 6).replace(/^\s*\r?\n/, '').split('\n');
      title = (lines.shift() || '').trim() || title;
      subtitle = lines.join('\n').trim();
    }
    return { title: title, subtitle: subtitle };
  }

  function notice(n) {
    if (!n || !n.card) return;
    var a = ANCHOR[n.card];
    if (!a || shown[n.card]) return;
    shown[n.card] = true;
    if (n.card === 'Tutorial Prompt — End Turn') armed = true;
    var p = parse(n.card);
    p.anchor = a;
    /* "Enemy Moves" is a briefing for the handover, not for the turn that precedes it —
       it is born when the enemy ends their turn (which starts turn 2), but must not speak
       until the player hands the turn over. Hold it here; onView releases it the moment
       the active seat leaves the player, so it floats up as the computer begins to move. */
    if (n.card === 'Tutorial Prompt — Enemy Moves') { held = p; return; }
    queue.push(p);
    if (!cur) next();
  }

  function next() {
    if (guard) guard.style.display = 'none';
    cur = queue.shift() || null;
    if (!cur) return;
    show(cur);
  }

  function show(p) {
    guard.style.display = 'block';
    var pop = guard.firstChild;
    pop.className = 'tut-pos ' + p.anchor.side;
    pop.querySelector('.tut-title').textContent = p.title;
    var sub = pop.querySelector('.tut-sub');
    sub.textContent = p.subtitle;
    sub.style.display = p.subtitle ? '' : 'none';
    place(pop, p.anchor);
  }

  function place(pop, a) {
    var vw = window.innerWidth, vh = window.innerHeight;
    if (!a.id) {
      pop.style.left = '50%'; pop.style.top = '42%'; pop.style.bottom = 'auto';
      return;
    }
    var el = document.getElementById(a.id);
    var r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!r) {
      pop.style.left = '50%'; pop.style.top = '42%'; pop.style.bottom = 'auto';
      return;
    }
    var cx = Math.min(Math.max(r.left + r.width / 2, 80), vw - 80);
    pop.style.left = cx + 'px';
    if (a.side === 'above') {
      pop.style.bottom = (vh - r.top + 14) + 'px';
      pop.style.top = 'auto';
    } else {
      pop.style.top = (r.bottom + 14) + 'px';
      pop.style.bottom = 'auto';
    }
  }

  /* a fresh game on the same load starts the prompts over — the engine hands out a new state
     object for it */
  function onView(G) {
    if (!G) return;
    if (seenG !== G) {
      seenG = G;
      queue = []; cur = null; shown = {};
      armed = false; held = null; lastActive = null;
      if (guard) guard.style.display = 'none';
    }
    /* The active seat leaving the player — the handover — lets go of the held "Enemy Moves"
       bubble. Turn 1's handover passes it by: nothing is held until the enemy has ended its
       turn and turn 2 has begun, so the first seat that can release it is its own end. */
    if (held && lastActive !== null && lastActive !== G.active && G.active !== 0 && !G.over) {
      queue.push(held);
      held = null;
      if (!cur) next();
    }
    /* Once "End Turn" has spoken, the first handover to the opponent pans the camera across
       to their ship. `focus` is the page's own camera; it is handed over through FrigateView. */
    if (!armed) { lastActive = G.active; return; }
    if (lastActive !== null && lastActive !== G.active && G.active !== 0 && !G.over &&
        window.FrigateView) {
      window.FrigateView.focus(G.active, 2.5);
      armed = false;
    }
    lastActive = G.active;
  }

  make();

  return { notice: notice, next: next };
})();