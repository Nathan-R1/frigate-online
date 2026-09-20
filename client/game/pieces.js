/* Board piece graphics.

   The silhouettes, the slow rotations and the blinking lights are lifted from the tabletop
   battle map this game grew out of, so a piece carries no text: its shape says what class of
   module it is, and everything else — selection, exhaustion, a broken connection, movement
   left — is a class or a floating badge.

   Shapes are dealt per seat when a game starts, so the class clues above are only the fallback
   for a shape the deal has not assigned. Everything unrecognised falls back to the hex. */
var GamePieces = (function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var s = document.createElementNS(NS, tag);
    for (var k in attrs) s.setAttribute(k, attrs[k]);
    return s;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  /* multiply a colour: below 1 darkens it for the body fill, above 1 lifts the detail lines */
  function shade(hex, f) {
    var c = hexToRgb(hex);
    return 'rgb(' + Math.round(clamp(c.r * f, 0, 255)) + ',' +
                    Math.round(clamp(c.g * f, 0, 255)) + ',' +
                    Math.round(clamp(c.b * f, 0, 255)) + ')';
  }
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967296;
  }
  /* The rotates and pulses are CSS animations, not SMIL, so a detached piece node is dropped
     with nothing left behind — SMIL keeps a gone piece's animation state alive and the board
     leaks memory every time a piece is removed. The CSS side kills the keyframes via
     html.gfx-low. The groups these attach to are centred on their own origin, so a CSS rotate
     about (0 0) spins them in place exactly like the SMIL rotate did. */
  var lowGfx = false;
  function setLowGfx(on) { lowGfx = !!on; }

  function addRotate(node, dur, reverse) {
    if (lowGfx) return;
    node.style.animation = 'piece-rot ' + dur + 's linear infinite';
    node.style.animationDirection = reverse ? 'reverse' : 'normal';
  }
  function addPing(node) {
    if (lowGfx) return;
    node.style.animation = 'ping-scale 2.8s cubic-bezier(.2,0,.6,1) infinite,' +
                           ' ping-fade 2.8s linear infinite';
  }

  /* ---------- shapes ---------- */
  function buildHex(svg, c) {
    var g = svgEl('g', { transform: 'translate(36 36)' });
    g.appendChild(svgEl('polygon', { points: '0,-26 22.5,-13 22.5,13 0,26 -22.5,13 -22.5,-13',
      fill: shade(c, 0.16), stroke: c, 'stroke-width': 3, 'stroke-linejoin': 'round' }));
    var ping = svgEl('polygon', { points: '0,-15 13,-7.5 13,7.5 0,15 -13,7.5 -13,-7.5',
      fill: 'none', stroke: shade(c, 1.35), 'stroke-width': 2.2, 'stroke-linejoin': 'round' });
    addPing(ping);
    g.appendChild(ping);
    var core = svgEl('circle', { r: 5, fill: shade(c, 1.5) });
    core.setAttribute('class', 'core-pulse');
    g.appendChild(core);
    svg.appendChild(g);
  }

  function buildTriangle(svg, c) {
    var g = svgEl('g', { transform: 'translate(36 36)' });
    g.appendChild(svgEl('path', { d: 'M0 -25 L25 17 L-25 17 Z', fill: shade(c, 0.16),
      stroke: c, 'stroke-width': 3, 'stroke-linejoin': 'round' }));
    var frame = svgEl('g');
    frame.appendChild(svgEl('path', { d: 'M0 -12 L10 9 L-10 9 Z', fill: 'none',
      stroke: shade(c, 1.5), 'stroke-width': 2.4, 'stroke-linejoin': 'round' }));
    addRotate(frame, '14s', false);
    g.appendChild(frame);
    var orb = svgEl('g');
    orb.appendChild(svgEl('circle', { cx: 0, cy: -18, r: 2.8, fill: shade(c, 1.5) }));
    orb.appendChild(svgEl('circle', { cx: 0, cy: 18, r: 2.1, fill: shade(c, 1.2), opacity: 0.7 }));
    addRotate(orb, '6s', true);
    g.appendChild(orb);
    svg.appendChild(g);
  }

  function buildSquare(svg, c) {
    var g = svgEl('g', { transform: 'translate(6 6)' });
    g.appendChild(svgEl('rect', { x: 8, y: 8, width: 44, height: 44, rx: 6,
      fill: shade(c, 0.16), stroke: c, 'stroke-width': 3 }));
    var corners = [[14, 14], [46, 14], [14, 46], [46, 46]];
    for (var i = 0; i < corners.length; i++) {
      var lg = svgEl('circle', { cx: corners[i][0], cy: corners[i][1], r: 3.4, fill: shade(c, 1.5) });
      lg.setAttribute('class', 'blink');
      lg.setAttribute('style', 'animation-delay:' + (i * 0.22) + 's');
      g.appendChild(lg);
    }
    var scan = svgEl('g', { 'class': 'scan scan-in' });
    scan.appendChild(svgEl('rect', { x: 16, y: 27, width: 16, height: 3.5, rx: 1.75,
      fill: shade(c, 1.6), opacity: 0.9 }));
    scan.appendChild(svgEl('circle', { cx: 32, cy: 28.75, r: 2.2, fill: shade(c, 1.8), opacity: 0.95 }));
    g.appendChild(scan);
    svg.appendChild(g);
  }

  function buildDiamond(svg, c) {
    var g = svgEl('g', { transform: 'translate(36 36)' });
    g.appendChild(svgEl('polygon', { points: '0,-27 26,0 0,27 -26,0', fill: shade(c, 0.16),
      stroke: c, 'stroke-width': 3, 'stroke-linejoin': 'round' }));
    var spin = svgEl('g');
    spin.appendChild(svgEl('polygon', { points: '0,-14 14,0 0,14 -14,0', fill: 'none',
      stroke: shade(c, 1.4), 'stroke-width': 2.2, 'stroke-linejoin': 'round' }));
    addRotate(spin, '12s', false);
    g.appendChild(spin);
    var cross = svgEl('g', { 'class': 'mod-shimmer' });
    cross.appendChild(svgEl('line', { x1: 0, y1: -22, x2: 0, y2: 22, stroke: shade(c, 1.5),
      'stroke-width': 2, 'stroke-linecap': 'round' }));
    cross.appendChild(svgEl('line', { x1: -22, y1: 0, x2: 22, y2: 0, stroke: shade(c, 1.5),
      'stroke-width': 2, 'stroke-linecap': 'round' }));
    g.appendChild(cross);
    svg.appendChild(g);
  }

  function buildCircle(svg, c) {
    var g = svgEl('g', { transform: 'translate(36 36)' });
    g.appendChild(svgEl('circle', { r: 25, fill: shade(c, 0.16), stroke: c, 'stroke-width': 3 }));
    var spin = svgEl('g');
    spin.appendChild(svgEl('circle', { r: 18, fill: 'none', stroke: c, 'stroke-width': 5,
      opacity: 0.9, 'stroke-dasharray': '22 16 9 30' }));
    addRotate(spin, '9s', false);
    g.appendChild(spin);
    var spinR = svgEl('g');
    spinR.appendChild(svgEl('circle', { r: 12, fill: 'none', stroke: shade(c, 1.4),
      'stroke-width': 3.4, opacity: 0.85, 'stroke-dasharray': '15 15' }));
    addRotate(spinR, '6.5s', true);
    g.appendChild(spinR);
    var core = svgEl('circle', { r: 6.5, fill: shade(c, 1.5) });
    core.setAttribute('class', 'core-pulse');
    g.appendChild(core);
    svg.appendChild(g);
  }

  /* a lumpy rock, seeded off the asteroid's id so each one keeps its own silhouette */
  function buildAsteroid(svg, seed) {
    var g = svgEl('g', { transform: 'translate(36 36)' });
    var n = 9 + Math.floor(seed * 4), pts = '';
    for (var i = 0; i < n; i++) {
      var ang = (i / n) * Math.PI * 2, r = 20 + hashStr('r' + i + seed) * 11;
      pts += (Math.cos(ang) * r).toFixed(1) + ',' + (Math.sin(ang) * r).toFixed(1) + (i < n - 1 ? ' ' : '');
    }
    g.appendChild(svgEl('polygon', { points: pts, fill: '#6a7077', stroke: '#4b5158',
      'stroke-width': 2, 'stroke-linejoin': 'round' }));
    for (i = 0; i < 3; i++) {
      g.appendChild(svgEl('ellipse', {
        cx: ((hashStr('d' + i + seed) - 0.5) * 20).toFixed(1),
        cy: ((hashStr('c' + i + seed) - 0.5) * 16).toFixed(1),
        rx: (3 + hashStr('e' + i + seed) * 3).toFixed(1),
        ry: (2 + hashStr('f' + i + seed) * 2).toFixed(1), fill: 'rgba(0,0,0,.3)' }));
    }
    /* A minority of rocks carry a pair of small companions on opposite sides, in the same
       spun group as the body so they orbit with it. The rock's own outline reaches 31, so
       they are placed clear of it rather than at the old map's 17-25, which here would bury
       them in the silhouette. The svg overflows its cell, which is what lets them float. */
    if (hashStr('oaf' + seed) < 0.3) {
      var a1 = hashStr('oa' + seed) * Math.PI * 2;
      var a2 = a1 + Math.PI + (hashStr('ob' + seed) - 0.5) * 1.6;
      var r1 = 36 + hashStr('oc' + seed) * 8;
      var r2 = 36 + hashStr('od' + seed) * 8;
      g.appendChild(svgEl('circle', {
        cx: (Math.cos(a1) * r1).toFixed(1), cy: (Math.sin(a1) * r1).toFixed(1),
        r: (3.5 + hashStr('oe' + seed) * 2).toFixed(1),
        fill: '#565c63', stroke: '#3f444a', 'stroke-width': 1.5 }));
      g.appendChild(svgEl('circle', {
        cx: (Math.cos(a2) * r2).toFixed(1), cy: (Math.sin(a2) * r2).toFixed(1),
        r: (2.5 + hashStr('of' + seed) * 2).toFixed(1),
        fill: '#5b6168', stroke: '#3f444a', 'stroke-width': 1.4 }));
    }
    svg.appendChild(g);
  }

  /* the same rock once it is nearly broken up: the lump replaced by a scatter of chunks */
  function buildDebris(svg, seed) {
    var g = svgEl('g', { transform: 'translate(36 36)' });
    var count = 6 + Math.floor(hashStr('n' + seed) * 4);
    for (var i = 0; i < count; i++) {
      var k = 'd' + i + seed;
      var ang = (i / count) * Math.PI * 2 + hashStr('a' + k) * 0.9;
      var rad = 7 + hashStr('r' + k) * 17;
      var cx = Math.cos(ang) * rad, cy = Math.sin(ang) * rad;
      var size = 3.5 + hashStr('s' + k) * 4.5;
      var pts = '', sides = 3 + Math.floor(hashStr('p' + k) * 3);
      for (var j = 0; j < sides; j++) {
        var a2 = (j / sides) * Math.PI * 2 + hashStr('j' + j + k) * 0.8;
        var r2 = size * (0.6 + hashStr('q' + j + k) * 0.6);
        pts += (cx + Math.cos(a2) * r2).toFixed(1) + ',' + (cy + Math.sin(a2) * r2).toFixed(1) +
               (j < sides - 1 ? ' ' : '');
      }
      g.appendChild(svgEl('polygon', { points: pts, fill: '#6a7077', stroke: '#4b5158',
        'stroke-width': 1.4, 'stroke-linejoin': 'round', opacity: (0.7 + hashStr('o' + k) * 0.3).toFixed(2) }));
    }
    svg.appendChild(g);
  }

  var BUILDERS = { hex: buildHex, triangle: buildTriangle, square: buildSquare,
                   diamond: buildDiamond, circle: buildCircle };

  /* Does this module stand in for the Core? The Citadel says so in its own rules text — it
     shares the Core's hull and counts as a Core Module — so it wears the Core's silhouette
     rather than the square its 'defense' type would otherwise give it. */
  function countsAsCore(name) {
    if (typeof Engine === 'undefined' || !Engine.fx) return false;
    var e = Engine.fx(name, 'mod');
    if (e.core) return true;
    return (e.passive || []).some(function (p) {
      return (p.effect || []).some(function (o) { return o.op === 'countsAsCore'; });
    });
  }

  /* the shape a piece wears. Dealt per seat when the game is dealt (Engine.get().shapes),
     so a Cannon is not recognisably a triangle from across the board; the Core shuffles like
     any other name. Only when the game has no deal — an old save, the setup screens — does the
     shape fall back to the module's class: hex for Core, offense triangle, defence square,
     movement diamond, science circle. */
  function shapeOf(owner, name, isCore) {
    var g = (typeof Engine !== 'undefined' && Engine.get) ? Engine.get() : null;
    var map = g && g.shapes && g.shapes[owner];
    if (map && map[name]) return map[name];
    if (isCore || countsAsCore(name)) return 'hex';
    var m = (typeof Engine !== 'undefined' && Engine.findMod) ? Engine.findMod(name) : null;
    var tt = m && m.tt;
    if (tt === 'offense') return 'triangle';
    if (tt === 'defense') return 'square';
    if (tt === 'movement') return 'diamond';
    if (tt === 'science') return 'circle';
    return 'hex';
  }

  function build(shape, color, seed) {
    var svg = svgEl('svg', { viewBox: '0 0 72 72', 'class': 'module-svg' });
    if (shape === 'asteroid') { buildAsteroid(svg, seed === undefined ? 0.5 : seed); return svg; }
    if (shape === 'debris') { buildDebris(svg, seed === undefined ? 0.5 : seed); return svg; }
    (BUILDERS[shape] || buildHex)(svg, color || '#7fa0b0');
    return svg;
  }

  /* the same silhouette as HTML, for the module's card in the hand */
  function markup(shape, color) {
    var svg = build(shape, color);
    svg.setAttribute('class', 'module-svg');
    return svg.outerHTML;
  }

  return { build: build, markup: markup, shapeOf: shapeOf, hash: hashStr, shade: shade,
           setLowGfx: setLowGfx };
})();
