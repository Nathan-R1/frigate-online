/* Online play — the browser's half.
 *
 * Offline, the page owns the game: it calls Engine.playCard and the state changes under its
 * feet. Online, the server owns it. The page still loads the same engine, but as a replica: a
 * pushed snapshot is handed to Engine.setState and everything that reads the game — the
 * renderer, the popups, affordability, line of sight — keeps working unchanged, because it is
 * reading a real state object through the real engine.
 *
 * What changes is the other direction. The calls that would advance the game are replaced
 * with sends, so the page's existing click handlers need no rewriting: Engine.playCard(id)
 * still means "play this card", it just now means it to the server.
 *
 * Nothing is applied locally first. A turn-based game over a local network has nothing to
 * gain from prediction, and plenty to lose: a predicted state that the server then refuses
 * has to be rolled back, and the rollback is where the bugs live.
 */
var Net = (function () {
  'use strict';

  var ST = {
    room: null, token: null, seat: null,
    lobby: null, es: null, seq: 0, rev: -1,
    online: false, error: null
  };
  var lobbyFns = [], errFns = [];
  var LOCAL = {};                     /* the engine calls we took over, kept for offline play */

  /* ---- finding the server ----
     The page is not necessarily served by the game server: this project already runs a PHP
     server for the battle map, and opening game.html from that one leaves /api pointing at
     something that answers in HTML. So the server is looked for rather than assumed — the
     origin the page came from first, then the default port — and the answer is remembered. */
  var BASE = null;
  var DEFAULT_PORT = 8080;

  function candidates() {
    var out = [], seen = {};
    function add(b) { if (b !== null && b !== undefined && !seen[b]) { seen[b] = 1; out.push(b); } }
    var asked = (location.search.match(/[?&]server=([^&]+)/) || [])[1];
    if (asked) add(decodeURIComponent(asked).replace(/\/$/, ''));
    try { add(localStorage.getItem('frigateServer')); } catch (e) {}
    if (location.protocol === 'http:' || location.protocol === 'https:') add('');   /* same origin */
    if (location.hostname) add(location.protocol + '//' + location.hostname + ':' + DEFAULT_PORT);
    add('http://localhost:' + DEFAULT_PORT);
    return out;
  }

  /* A response is only usable if it is actually this server answering. Anything else — an
     HTML error page, a redirect to another app — is treated as "not here", not as a crash. */
  function readJson(r) {
    return r.text().then(function (txt) {
      var j = null;
      try { j = JSON.parse(txt); } catch (e) { j = null; }
      if (!j || typeof j !== 'object') {
        var e2 = new Error('that address is not the game server');
        e2.notServer = true;
        throw e2;
      }
      return j;
    });
  }

  function probe(base) {
    return fetch(base + '/api/list', { method: 'GET' })
      .then(readJson)
      .then(function (j) { if (!j.ok) throw new Error('not the game server'); return base; });
  }

  /* Resolved once, then reused. */
  function findServer() {
    if (BASE !== null) return Promise.resolve(BASE);
    var list = candidates(), i = 0;
    function next() {
      if (i >= list.length) {
        return Promise.reject(new Error(
          'No game server found. Start it with ./run-online.sh, then reload — or add ' +
          '?server=http://host:' + DEFAULT_PORT + ' to this address.'));
      }
      var base = list[i++];
      return probe(base).then(function (ok) {
        BASE = ok;
        try { localStorage.setItem('frigateServer', ok); } catch (e) {}
        return ok;
      }, next);
    }
    return next();
  }

  function api(route, body) {
    return findServer().then(function (base) {
      return fetch(base + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (r) {
        return readJson(r).then(function (j) {
          if (j.ok === false) throw new Error(j.error || ('http ' + r.status));
          return j;
        });
      });
    });
  }

  /* Where a room's seat token is kept. It is the only thing that says who you are, so it is
     per room and it survives a reload — that is what makes coming back silent. */
  function keyFor(room) { return 'frigateSeat:' + room; }
  function remember(room, token, seat) {
    try { localStorage.setItem(keyFor(room), JSON.stringify({ token: token, seat: seat })); } catch (e) {}
  }
  function recall(room) {
    try { return JSON.parse(localStorage.getItem(keyFor(room))) || null; } catch (e) { return null; }
  }
  function forget(room) { try { localStorage.removeItem(keyFor(room)); } catch (e) {} }
  /* The last room this browser was in, so that a reload lands back in the game rather than on
     the new-game screen. It is the other half of reclaiming a seat: the token says who you
     are, this says where you were. */
  function rememberRoom(room) { try { localStorage.setItem('frigateRoom', room); } catch (e) {} }
  function lastRoom() { try { return localStorage.getItem('frigateRoom') || null; } catch (e) { return null; } }
  function forgetRoom() { try { localStorage.removeItem('frigateRoom'); } catch (e) {} }

  function onLobby(fn) { lobbyFns.push(fn); }
  function onError(fn) { errFns.push(fn); }
  function fireLobby() { lobbyFns.forEach(function (f) { f(ST.lobby, ST); }); }
  function fireError(msg) { ST.error = msg; errFns.forEach(function (f) { f(msg); }); }

  /* ---- joining ---- */

  function create(seats) {
    return api('/api/create', { seats: seats }).then(function (j) {
      ST.room = j.room; ST.lobby = j.lobby;
      rememberRoom(j.room);
      fireLobby();
      return j.room;
    });
  }

  function look(room) {
    return findServer().then(function (base) {
      return fetch(base + '/api/room?room=' + encodeURIComponent(room));
    })
      .then(readJson)
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'no such room');
        ST.room = j.lobby.room; ST.lobby = j.lobby;
        rememberRoom(ST.room);
        fireLobby();
        return j.lobby;
      });
  }

  /* Claim a seat, or take back the one this browser already held. The remembered token is
     offered first: if the server still knows it, nothing visible happens at all. */
  function claim(seat) {
    var had = recall(ST.room);
    var body = { room: ST.room, seat: seat };
    if (had && had.token) body.token = had.token;
    return api('/api/claim', body).then(function (j) {
      ST.token = j.token; ST.seat = j.seat; ST.lobby = j.lobby;
      remember(ST.room, j.token, j.seat);
      connect();
      fireLobby();
      return j.seat;
    });
  }

  /* On arrival, take back a seat this browser already holds without asking for a new one. */
  function resume(room) {
    var had = recall(room);
    if (!had || !had.token) return Promise.resolve(null);
    return api('/api/claim', { room: room, token: had.token, seat: had.seat })
      .then(function (j) {
        ST.room = room; ST.token = j.token; ST.seat = j.seat; ST.lobby = j.lobby;
        remember(room, j.token, j.seat);
        connect();
        fireLobby();
        return j.seat;
      })
      .catch(function () { forget(room); return null; });
  }

  function release() {
    if (!ST.token) return Promise.resolve();
    var room = ST.room, token = ST.token;
    ST.token = null; ST.seat = null;
    forget(room);
    forgetRoom();
    return api('/api/release', { room: room, token: token }).then(function (j) {
      ST.lobby = j.lobby; fireLobby();
    });
  }

  function start() {
    return api('/api/start', { room: ST.room, token: ST.token }).then(function (j) {
      ST.lobby = j.lobby; fireLobby(); return j.lobby;
    });
  }

  /* ---- the stream ---- */

  function connect() {
    if (ST.es) { ST.es.close(); ST.es = null; }
    var url = (BASE || '') + '/api/stream?room=' + encodeURIComponent(ST.room) +
              (ST.token ? '&token=' + encodeURIComponent(ST.token) : '');
    ST.es = new EventSource(url);
    ST.es.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (typeof msg.rev === 'number' && msg.rev < ST.rev) return;   /* a push we have passed */
      ST.rev = msg.rev;
      ST.lobby = msg.lobby;
      if (msg.seat !== null && msg.seat !== undefined) ST.seat = msg.seat;
      if (msg.state) {
        if (!ST.online) install();
        Engine.setState(msg.state);
      }
      fireLobby();
    };
    ST.es.onerror = function () { fireError('lost the connection — trying again'); };
  }

  function disconnect() {
    if (ST.es) { ST.es.close(); ST.es = null; }
    uninstall();
  }

  /* ---- intents ---- */

  /* Every call that would advance the game. Each carries a sequence number so that a retry
     after a lost reply is recognised and dropped rather than played a second time. */
  var SENT = ['playCard', 'activateCard', 'activateModule', 'activateDeployable',
              'moveModule', 'stepDeployable', 'resolve', 'cancel', 'undo',
              'endPlayPhase', 'endTurn'];

  function send(cmd, args) {
    if (!ST.token) { fireError('you are watching, not playing'); return Promise.resolve(false); }
    ST.seq++;
    return api('/api/cmd', { room: ST.room, token: ST.token, seq: ST.seq,
                             cmd: cmd, args: args || [] })
      .then(function () { return true; })
      .catch(function (e) { fireError(e.message); return false; });
  }

  function install() {
    if (ST.online) return;
    ST.online = true;
    SENT.forEach(function (name) {
      LOCAL[name] = Engine[name];
      Engine[name] = function () { send(name, [].slice.call(arguments)); return true; };
    });
    /* A walk is one intent, not one per square: sending the whole route saves five round
       trips and lets the server stop at the first step the rules refuse. */
    Engine.sendRoute = function (objId, steps) { return send('moveRoute', [objId, steps]); };
  }

  function uninstall() {
    if (!ST.online) return;
    ST.online = false;
    SENT.forEach(function (name) { if (LOCAL[name]) Engine[name] = LOCAL[name]; });
    Engine.sendRoute = null;
  }

  return {
    state: function () { return ST; },
    online: function () { return ST.online; },
    room: function () { return ST.room; },
    seat: function () { return ST.token ? ST.seat : null; },
    lobby: function () { return ST.lobby; },
    create: create, look: look, claim: claim, resume: resume, release: release,
    lastRoom: lastRoom, forgetRoom: forgetRoom, hadSeatIn: function (room) {
      var had = recall(room); return !!(had && had.token);
    },
    find: findServer, base: function () { return BASE; },
    start: start, connect: connect, disconnect: disconnect, send: send,
    onLobby: onLobby, onError: onError, forget: forget
  };
})();
