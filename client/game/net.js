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
    online: false, error: null,
    /* Which room the board currently on screen actually came from. Not a boolean: switching
       rooms without disconnecting leaves `online` true from the previous one, and "we are
       online" is then mistaken for "we are showing this game". */
    stateRoom: null
  };
  var lobbyFns = [], errFns = [];
  var LOCAL = {};                     /* the engine calls we took over, kept for offline play */

  /* ---- finding the server ----
     The page is not necessarily served by the game server: this project already runs a PHP
     server for the battle map, and opening game.html from that one leaves /api pointing at
     something that answers in HTML. So the server is looked for rather than assumed — the
     origin the page came from first, then the default port — and the answer is remembered.

     An address that arrives in the URL is a different thing from one the page worked out for
     itself. ?server= is what makes a laptop and a phone on the same wifi find each other, and
     it is also a link somebody can be sent: follow one and the page keeps its real address in
     the bar while everything it says — including the token that holds your seat — goes
     wherever the link pointed. So an address from outside is taken quietly only where a link
     could not have moved you anywhere you were not already: this origin, the host you came
     from on another port, or a machine on this network. Anything further afield is asked
     about once, in words naming the host. And none of it is ever written down — only what the
     page found for itself is remembered, because a remembered address is one click that
     lasts. */
  var BASE = null;
  var DEFAULT_PORT = 8080;

  /* The origin a base would actually reach; '' is this very page. */
  function originOf(base) {
    if (!base) return location.origin;
    try { return new URL(base, location.href).origin; } catch (e) { return null; }
  }

  /* This machine, or one on this network — the same judgement the server makes about an
     incoming Origin, made here about a destination. */
  function isLocalHost(host) {
    return host === 'localhost' || host === '::1' || host === '[::1]' ||
           /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
           /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  }

  function isTrustedBase(base) {
    var o = originOf(base);
    if (!o) return false;
    if (o === location.origin) return true;
    var u;
    try { u = new URL(o); } catch (e) { return false; }
    if (u.hostname === location.hostname) return true;   /* the same host on another port */
    return isLocalHost(u.hostname);
  }

  /* Asked once per address, and only for one that is neither ours nor local. Saying no is not
     an error: the page carries on looking where it would have looked anyway. */
  var askedAbout = {};
  function allowForeign(base) {
    var o = originOf(base);
    if (!o) return false;
    if (askedAbout[o] !== undefined) return askedAbout[o];
    var ok = false;
    try {
      ok = window.confirm(
        'This link wants the game to talk to ' + o + ' instead of ' + location.origin + '.\n\n' +
        'That server would receive everything this page sends, including the token that holds ' +
        'your seat. Allow it only if you know whose server it is.\n\nUse ' + o + '?');
    } catch (e) { ok = false; }
    askedAbout[o] = ok;
    return ok;
  }

  function candidates() {
    var out = [], seen = {};
    function add(b, fromUrl) {
      if (b === null || b === undefined || seen[b]) return;
      seen[b] = 1;
      out.push({ base: b, fromUrl: !!fromUrl });
    }
    var asked = (location.search.match(/[?&]server=([^&]+)/) || [])[1];
    if (asked) {
      var want = decodeURIComponent(asked).replace(/\/$/, '');
      if (isTrustedBase(want) || allowForeign(want)) add(want, true);
    }
    /* Only an address the page found itself is ever remembered — but a browser that met an
       earlier build may still be holding one it was handed, so it is judged on the way out
       too, and forgotten if it does not pass. */
    try {
      var kept = localStorage.getItem('frigateServer');
      if (kept && isTrustedBase(kept)) add(kept);
      else if (kept) localStorage.removeItem('frigateServer');
    } catch (e) {}
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
      var cand = list[i++];
      return probe(cand.base).then(function (ok) {
        BASE = ok;
        /* An address the page worked out for itself is worth remembering. One that arrived in
           the URL is not: remembering it would turn one followed link into every later visit. */
        if (!cand.fromUrl) { try { localStorage.setItem('frigateServer', ok); } catch (e) {} }
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

  /* Games with a chair free. A plain GET: there is nothing to say and nothing to prove, and
     the server decides what is fit to tell. */
  function openGames() {
    return findServer()
      .then(function (base) { return fetch(base + '/api/open'); })
      .then(readJson)
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'could not look for games');
        return j.games || [];
      });
  }

  function look(room) {
    return findServer().then(function (base) {
      return fetch(base + '/api/room?room=' + encodeURIComponent(room));
    })
      .then(readJson)
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'no such room');
        /* a different room means the board on screen is somebody else's game, whatever it is */
        if (j.lobby.room !== ST.room) ST.stateRoom = null;
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

  /* The leader empties somebody else's chair. The server is the one that decides whether you
     are the leader; this only asks. */
  function kick(seatIdx) {
    return api('/api/kick', { room: ST.room, token: ST.token, seat: seatIdx })
      .then(function (j) { ST.lobby = j.lobby; fireLobby(); return true; });
  }

  /* The leader hands a seat to the computer, or takes it back for a person. */
  function setSeatKind(seatIdx, kind) {
    return api('/api/seatkind', { room: ST.room, token: ST.token, seat: seatIdx, kind: kind })
      .then(function (j) { ST.lobby = j.lobby; fireLobby(); return true; });
  }

  function start() {
    return api('/api/start', { room: ST.room, token: ST.token }).then(function (j) {
      ST.lobby = j.lobby; fireLobby(); return j.lobby;
    });
  }

  /* ---- the stream ---- */

  /* Opening the stream takes a step more than it looks like it should.
     EventSource cannot carry a header, so whatever says who we are has to go in the URL — and
     a URL is written into every log between here and the server. The seat token is the one
     thing that must not be, so it stays in POST bodies and buys a ticket instead: a separate
     secret, good for reading this seat's stream and nothing else. A watcher needs none and
     opens straight away. */
  var gen = 0;
  function connect() {
    if (ST.es) { ST.es.close(); ST.es = null; }
    var mine = ++gen, room = ST.room;
    function open(ticket) {
      /* a later connect() started while we were asking: that one owns the stream now */
      if (mine !== gen || ST.room !== room) return;
      var url = (BASE || '') + '/api/stream?room=' + encodeURIComponent(room) +
                (ticket ? '&ticket=' + encodeURIComponent(ticket) : '');
      ST.es = new EventSource(url);
      wire(ST.es);
    }
    if (!ST.token) return open(null);
    api('/api/ticket', { room: room, token: ST.token })
      .then(function (j) { open(j.ticket); },
            function () { open(null); });   /* no ticket: watch rather than show nothing */
  }

  function wire(es) {
    es.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (typeof msg.rev === 'number' && msg.rev < ST.rev) return;   /* a push we have passed */
      ST.rev = msg.rev;
      ST.lobby = msg.lobby;
      if (msg.seat !== null && msg.seat !== undefined) ST.seat = msg.seat;
      else if (ST.token) {
        /* We believed we held a seat and the server says otherwise — it was given up here or
           freed by the leader. Become a watcher rather than pretending. */
        ST.token = null; ST.seat = null;
        forget(ST.room);
        fireError('your seat was freed — you are watching now');
      }
      if (msg.state) {
        if (!ST.online) install();
        Engine.setState(msg.state);
        ST.stateRoom = ST.room;
      }
      fireLobby();
    };
    es.onerror = function () { fireError('lost the connection — trying again'); };
  }

  function disconnect() {
    gen++;                 /* a ticket still on its way back no longer has a stream to open */
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
    /* true only when the board on screen is this room's game, as the server sent it */
    hasState: function () { return ST.stateRoom !== null && ST.stateRoom === ST.room; },
    create: create, look: look, claim: claim, resume: resume, release: release, kick: kick,
    openGames: openGames, setSeatKind: setSeatKind,
    /* are you the one who sat down first, and so the one who can free a seat? */
    isLeader: function () {
      return !!(ST.lobby && ST.seat !== null && ST.token && ST.lobby.leader === ST.seat);
    },
    lastRoom: lastRoom, forgetRoom: forgetRoom, hadSeatIn: function (room) {
      var had = recall(room); return !!(had && had.token);
    },
    find: findServer, base: function () { return BASE; },
    start: start, connect: connect, disconnect: disconnect, send: send,
    onLobby: onLobby, onError: onError, forget: forget
  };
})();
