/* Floating tutorial prompts — the tutorial's own voice on the board.
 *
 * Each "Tutorial Prompt" tech holds a passive whose `popup` op hands the engine a notice: the
 * words to show, the element the bubble points at and which side of it, and optionally a seat
 * for the camera to swing to (engine.js: OPS.popup; the wording lives in card-effects.js).
 * This module turns each notice into a bubble that floats beside that element with an arrow,
 * dismissed by touching anywhere on the screen — the next bubble in line then shows.
 *
 * The cards see to it that each prompt speaks once; this file only queues and draws. `hidden`
 * keeps the prompt cards out of the hand bar.
 */
var Notify = (function () {
  'use strict';

  var guard = null, cur = null, queue = [], seenG = null;

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

  function notice(n) {
    if (!n || !n.title) return;
    queue.push(n);
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
    /* a notice that points at nothing (the forfeit) sits in the middle with no arrow */
    pop.className = 'tut-pos ' + (p.side || 'centre');
    pop.querySelector('.tut-title').textContent = p.title;
    var sub = pop.querySelector('.tut-sub');
    sub.textContent = p.text;
    sub.style.display = p.text ? '' : 'none';
    place(pop, p);
    /* `focus` is the page's own camera, handed over through FrigateView */
    if (p.focus !== null && p.focus !== undefined && window.FrigateView)
      window.FrigateView.focus(p.focus, 2.5);
  }

  function place(pop, a) {
    var vw = window.innerWidth, vh = window.innerHeight;
    if (!a.at) {
      pop.style.left = '50%'; pop.style.top = '42%'; pop.style.bottom = 'auto';
      return;
    }
    var el = document.getElementById(a.at);
    var r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    /* an anchor the layout has hidden — the player bars give way on a narrow screen — has no
       box to point at, so the bubble takes the centre instead */
    if (!r || !r.width) {
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

  /* a fresh game on the same load drops whatever the last one left unread — the engine hands
     out a new state object for it */
  function onView(G) {
    if (!G || seenG === G) return;
    seenG = G;
    queue = []; cur = null;
    if (guard) guard.style.display = 'none';
  }

  make();

  return { notice: notice, next: next };
})();