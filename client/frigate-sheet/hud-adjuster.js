(function () {
  'use strict';

  var pending = {};

  /* ---- local overlay, used only when this page is the top window ---- */
  var localWrap = null, localTitle = null, localVal = null, localDelta = null;
  var localPlus = null, localMinus = null, localOk = null, localCur = null;

  function buildLocal() {
    localWrap = document.createElement('div');
    localWrap.className = 'hud-adj-wrap hidden';
    localWrap.innerHTML =
      '<div class="hud-adj-card">' +
        '<div class="hud-adj-title"></div>' +
        '<div class="hud-adj-val"></div>' +
        '<div class="hud-adj-delta"></div>' +
        '<div class="hud-adj-row">' +
          '<button type="button" class="hud-adj-btn hud-adj-minus" title="Decrease">−</button>' +
          '<button type="button" class="hud-adj-btn hud-adj-plus" title="Increase">+</button>' +
        '</div>' +
        '<button type="button" class="hud-adj-ok">OK</button>' +
      '</div>';
    document.body.appendChild(localWrap);
    localTitle = localWrap.querySelector('.hud-adj-title');
    localVal = localWrap.querySelector('.hud-adj-val');
    localDelta = localWrap.querySelector('.hud-adj-delta');
    localPlus = localWrap.querySelector('.hud-adj-plus');
    localMinus = localWrap.querySelector('.hud-adj-minus');
    localOk = localWrap.querySelector('.hud-adj-ok');
    localPlus.addEventListener('click', function () { localNudge(1); });
    localMinus.addEventListener('click', function () { localNudge(-1); });
    localOk.addEventListener('click', localCommit);
    localWrap.addEventListener('click', function (e) { if (e.target === localWrap) localClose(); });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && localCur) localClose();
    });
  }
  function localRender() {
    if (!localCur) return;
    localTitle.textContent = localCur.title;
    localVal.textContent = String(localCur.val);
    localDelta.textContent = localCur.val === localCur.start
      ? ''
      : (localCur.val > localCur.start ? '+' : '') + (localCur.val - localCur.start);
  }
  function localNudge(d) {
    if (!localCur) return;
    localCur.val = Math.max(0, localCur.val + d);
    localRender();
  }
  function localCommit() {
    if (!localCur) return;
    var target = localCur;
    var delta = target.val - target.start;
    localClose();
    if (delta !== 0 && typeof target.commit === 'function') target.commit(delta);
  }
  function localClose() {
    if (localWrap) localWrap.classList.add('hidden');
    localCur = null;
  }
  function localOpen(opts) {
    if (!localWrap) buildLocal();
    localCur = {
      title: (opts && opts.title) || '',
      start: Math.max(0, Math.floor(Number(opts && opts.start) || 0)),
      val: Math.max(0, Math.floor(Number(opts && opts.start) || 0)),
      commit: opts && typeof opts.commit === 'function' ? opts.commit : null
    };
    localRender();
    localWrap.classList.remove('hidden');
  }

  /* ---- framed mode: ask the parent window to host the popup ---- */
  function isFramed() {
    try { return !!window.parent && window.parent !== window; } catch (e) { return false; }
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || typeof m !== 'object' || m.t !== 'hud') return;
    if (m.a === 'commit' && pending[m.id]) {
      var opts = pending[m.id];
      delete pending[m.id];
      if (typeof m.delta === 'number' && m.delta !== 0 && typeof opts.commit === 'function') {
        opts.commit(m.delta);
      }
    } else if (m.a === 'cancel' && pending[m.id]) {
      delete pending[m.id];
    }
  });

  function framedOpen(opts) {
    var id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    for (var k in pending) delete pending[k];   // an abandoned open never resolves; drop it
    pending[id] = opts || {};
    try {
      window.parent.postMessage({
        t: 'hud',
        a: 'open',
        id: id,
        title: (opts && opts.title) || '',
        start: Math.max(0, Math.floor(Number(opts && opts.start) || 0))
      }, '*');
    } catch (e) {}
  }

  window.HudAdjuster = {
    open: function (opts) {
      if (isFramed()) framedOpen(opts);
      else localOpen(opts);
    },
    close: function () {
      if (isFramed()) {
        try { window.parent.postMessage({ t: 'hud', a: 'cancel-any' }, '*'); } catch (e) {}
      } else {
        localClose();
      }
    },
    isVisible: function () {
      return !!(localWrap && !localWrap.classList.contains('hidden'));
    }
  };
})();