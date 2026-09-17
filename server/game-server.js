/*
 * Frigate online play — authoritative game server.
 *
 * Node, no dependencies. Run it with:  node server/game-server.js [port]
 *
 * WHY IT IS BUILT THIS WAY
 *
 * The rules are client/game/engine.js. Rather than write them a second time in another
 * language and spend the rest of the project keeping the two honest, the server loads that
 * very file and runs it. Each room gets its own V8 context (node's vm), because the engine
 * keeps one game in a module-level variable — a fresh context per room is the cheapest way to
 * have several games at once without touching the engine's shape.
 *
 * The server is the only place a game ever advances. A client sends an intent — "play this
 * card", "answer this prompt", "end my turn" — and nothing else. It never sends state, and it
 * never says which seat it is: the seat is looked up from a secret token, so a client cannot
 * act as anybody but itself. The engine then does what it always does, refusing anything the
 * rules forbid, and the resulting state is pushed to every watcher.
 *
 * What each watcher is pushed is not the same thing. A snapshot is taken per viewer, and the
 * engine redacts it: the board is public, your own cards are yours, everyone else's hand and
 * deck arrive as the right number of blanks. Hidden information that never leaves the server
 * cannot be read out of the browser.
 *
 * Presence, not activity, is what the idle timer measures. A seat is held for as long as that
 * player has a live event stream open; sixty seconds after the last one closes the seat is
 * freed for anyone to take, and the computer plays it in the meantime so a game can never
 * deadlock behind someone who shut their laptop.
 *
 * ENDPOINTS
 *   POST /api/create   {seats:[{name,team,kind,deck,modules,skills}]}  -> {room}
 *   GET  /api/room     ?room=CODE                                     -> lobby, no secrets
 *   POST /api/claim    {room, seat, token?}                           -> {token, seat}
 *   POST /api/release  {room, token}                                  -> give the seat up
 *   POST /api/start    {room, token}                                  -> deal and begin
 *   POST /api/cmd      {room, token, seq, cmd, args}                  -> one intent
 *   GET  /api/stream   ?room=CODE&token=...                           -> SSE of your state
 *   everything else                                                    -> static files
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..');
var PORT = parseInt(process.argv[2], 10) || 8080;
var SNAPSHOT = path.join(__dirname, 'rooms.json');

/* How long a seat survives with nobody watching it, and how often we look. The timer counts
   absence, not idleness: a player staring at the board for two minutes is still here, and
   taking their seat away mid-turn would be the wrong reading of "inactive". */
var SEAT_TTL_MS = parseInt(process.env.FRIGATE_SEAT_TTL, 10) || 60000;
var SWEEP_MS = parseInt(process.env.FRIGATE_SWEEP, 10) || 5000;
/* The computer's pace when it is playing a seat, matching the browser's own tick — it is
   meant to be watched, not raced. */
var AI_TICK_MS = parseInt(process.env.FRIGATE_AI_TICK, 10) || 380;
/* Rooms are cheap but not free; an abandoned one is dropped after an hour. */
var ROOM_TTL_MS = 60 * 60 * 1000;

/* ---------- the rules, loaded once and instantiated per room ---------- */

var SOURCES = [
  'client/frigate-sheet/presets/tech-presets.js',
  'client/frigate-sheet/presets/mod-presets.js',
  'client/frigate-sheet/presets/card-effects.js',
  'client/game/engine.js',
  'client/game/ai/ai-knowledge.js',
  'client/game/ai/ai-path.js',
  'client/game/ai/ai-placement.js',
  'client/game/ai/ai-doctrine.js',
  'client/game/ai/ai-commander.js'
];
var RULES_SRC = SOURCES.map(function (f) {
  return '/* ' + f + ' */\n' + fs.readFileSync(path.join(ROOT, f), 'utf8');
}).join('\n;\n');
var RULES_SCRIPT = new vm.Script(RULES_SRC, { filename: 'frigate-rules.js' });

function newRules() {
  var sandbox = { console: console };
  vm.createContext(sandbox);
  RULES_SCRIPT.runInContext(sandbox);
  if (!sandbox.Engine) throw new Error('rules did not define Engine');
  return { E: sandbox.Engine, AI: sandbox.AICommander || null };
}

/* ---------- rooms ---------- */

var rooms = Object.create(null);

/* Ambiguous glyphs are left out: a room code gets read aloud and typed by hand. */
var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  var code;
  do {
    var bytes = crypto.randomBytes(6);
    code = '';
    for (var i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  } while (rooms[code]);
  return code;
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }

function makeRoom(seatDefs) {
  var r = newRules();
  var room = {
    code: newCode(),
    created: Date.now(),
    touched: Date.now(),
    E: r.E, AI: r.AI,
    started: false,
    rev: 0,
    subs: [],                 /* live event streams */
    seats: seatDefs.map(function (d, i) {
      return {
        idx: i,
        name: String(d.name || ('Player ' + (i + 1))).slice(0, 40),
        team: (d.team === undefined || d.team === null) ? i : (+d.team | 0),
        /* 'computer' is a seat nobody is meant to sit in; 'human' waits to be claimed */
        kind: d.kind === 'computer' ? 'computer' : 'human',
        deck: Array.isArray(d.deck) ? d.deck : null,
        modules: Array.isArray(d.modules) ? d.modules : null,
        skills: d.skills || null,
        token: null,
        live: 0,              /* open event streams for this seat */
        lastSeen: 0,
        lastSeq: -1,          /* the newest command applied, so a retry is not replayed */
        away: false           /* claimed once, then the watcher went and has not come back */
      };
    })
  };
  rooms[room.code] = room;
  return room;
}

/* The computer plays only the seats it was given at the table. A seat meant for a person stays
   theirs to play: if they go, it empties and waits, and the game waits with it rather than
   having someone's ship fought by a stand-in they did not ask for. */
function autoSeat(seat) { return seat.kind === 'computer'; }
/* A seat with a person's name on it and nobody in it. The game cannot go on through one. */
function emptySeat(seat) { return seat.kind === 'human' && !seat.token; }
function seatOf(room, token) {
  if (!token) return null;
  for (var i = 0; i < room.seats.length; i++) if (room.seats[i].token === token) return room.seats[i];
  return null;
}

/* The engine decides what a side is at the moment it is dealt, but who is playing a seat can
   change mid-game — someone leaves and the computer picks it up, someone arrives and takes it
   back. Keeping the side's own flag in step is what lets a returning player act again. */
function syncControl(room) {
  if (!room.started) return;
  var G = room.E.get();
  if (!G) return;
  room.seats.forEach(function (s) {
    if (G.players[s.idx]) G.players[s.idx].ai = autoSeat(s);
  });
}

/* What a lobby may know: who is sitting where, never anybody's token. */
function lobbyView(room) {
  var G = room.started ? room.E.get() : null;
  return {
    room: room.code,
    started: room.started,
    over: G && G.over ? G.over : null,
    active: G ? G.active : null,
    turn: G ? G.turn : null,
    /* set when the game cannot go on because the seat whose turn it is has nobody in it */
    waitingFor: (G && !G.over && room.started && emptySeat(room.seats[G.active]))
      ? G.active : null,
    seats: room.seats.map(function (s) {
      return { idx: s.idx, name: s.name, team: s.team, kind: s.kind,
               taken: !!s.token, away: s.away, watching: s.live > 0,
               auto: autoSeat(s), empty: emptySeat(s) };
    })
  };
}

/* ---------- pushing state ---------- */

function stateFor(room, seat) {
  var payload = { kind: 'state', rev: room.rev, lobby: lobbyView(room),
                  seat: seat ? seat.idx : null,
                  state: room.started ? room.E.snapshot(seat ? seat.idx : -1) : null };
  return JSON.stringify(payload);
}

function broadcast(room) {
  room.rev++;
  room.touched = Date.now();
  room.subs.forEach(function (sub) {
    try {
      sub.res.write('data: ' + stateFor(room, sub.seat) + '\n\n');
    } catch (e) { /* the sweep will drop it */ }
  });
}

/* ---------- commands ---------- */

/* Every intent a seat may send. Anything not on this list does not exist, and all of these
   belong to whoever's turn it is — there is no legal off-turn action in this game. */
var COMMANDS = {
  playCard: 1, activateCard: 1, activateModule: 1, activateDeployable: 1,
  moveModule: 3, stepDeployable: 3, resolve: 1, cancel: 0, undo: 0,
  endPlayPhase: 0, endTurn: 0,
  /* not an engine call: a whole walk in one intent, applied a square at a time */
  moveRoute: 2
};

/* A route is walked step by step so that each square is judged on its own — the walk simply
   stops at the first one the rules refuse, exactly as it does when a player clicks. */
function walkRoute(room, seat, objId, steps) {
  var G = room.E.get();
  if (!Array.isArray(steps) || !steps.length || steps.length > 64) return 'bad route';
  var mine = G.players[seat.idx];
  var isModule = !!(mine && mine.modules[objId]);
  for (var i = 0; i < steps.length; i++) {
    var st = steps[i];
    if (!Array.isArray(st) || st.length !== 2) return 'bad route';
    var ok = isModule ? room.E.moveModule(objId, st[0] | 0, st[1] | 0)
                      : room.E.stepDeployable(objId, st[0] | 0, st[1] | 0);
    if (!ok) break;
  }
  return null;
}

function applyCommand(room, seat, cmd, args) {
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) return 'unknown command';
  if (!room.started) return 'not started';
  var G = room.E.get();
  if (!G) return 'no game';
  if (G.over) return 'game over';
  if (G.active !== seat.idx) return 'not your turn';
  args = Array.isArray(args) ? args.slice(0, 3) : [];
  if (cmd === 'moveRoute') return walkRoute(room, seat, args[0], args[1]);
  /* The engine is the judge of legality. Everything above only decides who is allowed to ask.
     Where it answers at all it answers false, and that is a refusal worth passing back: a
     client asking to play a card it does not hold should hear no, not silence. */
  var ret;
  try {
    ret = room.E[cmd].apply(null, args);
  } catch (e) {
    return 'refused: ' + e.message;
  }
  if (ret === false) return 'the rules do not allow that';
  return null;
}

/* The computer plays any seat it has been handed, at a pace a watcher can follow. */
function tickRooms() {
  Object.keys(rooms).forEach(function (code) {
    var room = rooms[code];
    if (!room.started || !room.AI) return;
    var G = room.E.get();
    if (!G || G.over) return;
    var seat = room.seats[G.active];
    if (!seat || !autoSeat(seat)) return;
    var before = JSON.stringify([G.turn, G.active, G.phase, G.seq, !!G.pending]);
    try { room.AI.tick(G.active); } catch (e) { console.error('[ai]', code, e.message); }
    var after = JSON.stringify([G.turn, G.active, G.phase, G.seq, !!G.pending]);
    if (before !== after) broadcast(room);
  });
}

/* A seat is held while someone is watching it. Sixty seconds after the last stream for it
   closed, it is free for anyone — and the computer plays it until somebody takes it. */
function sweepSeats() {
  var now = Date.now();
  Object.keys(rooms).forEach(function (code) {
    var room = rooms[code], changed = false;
    room.seats.forEach(function (s) {
      if (!s.token || s.live > 0) return;
      if (now - s.lastSeen < SEAT_TTL_MS) return;
      s.token = null;
      s.away = true;
      s.lastSeq = -1;
      changed = true;
    });
    if (changed) { syncControl(room); broadcast(room); }
    if (now - room.touched > ROOM_TTL_MS && room.subs.length === 0) delete rooms[code];
  });
  saveSnapshot();
}

/* ---------- a crash should not cost a lobby ----------
   Only the shape of a room is kept, never a live game: replaying a half-finished match from
   disk would need the engine's own state serialised, and a room that outlives the process by
   more than its lobby is not worth that. */
var saveTimer = null;
function saveSnapshot() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    var out = Object.keys(rooms).map(function (c) {
      var r = rooms[c];
      return { code: c, created: r.created, started: r.started,
               seats: r.seats.map(function (s) {
                 return { name: s.name, team: s.team, kind: s.kind };
               }) };
    });
    fs.writeFile(SNAPSHOT + '.tmp', JSON.stringify(out), function (err) {
      if (err) return;
      fs.rename(SNAPSHOT + '.tmp', SNAPSHOT, function () {});
    });
  }, 1000);
}

/* ---------- http ---------- */

var MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
             '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
             '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
             '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/* The client is often served by something else — the PHP server this project already runs, or
   a file opened directly — so every API answer has to be readable from another origin. */
var CORS = { 'Access-Control-Allow-Origin': '*',
             'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
             'Access-Control-Allow-Headers': 'Content-Type' };
function withCors(h) {
  var out = {};
  Object.keys(h).forEach(function (k) { out[k] = h[k]; });
  Object.keys(CORS).forEach(function (k) { out[k] = CORS[k]; });
  return out;
}

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, withCors({ 'Content-Type': 'application/json; charset=utf-8',
                                 'Cache-Control': 'no-store',
                                 'Content-Length': Buffer.byteLength(body) }));
  res.end(body);
}

function readBody(req, done) {
  var chunks = [], size = 0;
  req.on('data', function (c) {
    size += c.length;
    if (size > 262144) { req.destroy(); return; }      /* a sheet is large, a payload is not */
    chunks.push(c);
  });
  req.on('end', function () {
    var txt = Buffer.concat(chunks).toString('utf8');
    var obj = null;
    try { obj = JSON.parse(txt); } catch (e) { obj = null; }
    done(obj);
  });
}

function serveStatic(req, res, urlPath) {
  var rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/client/game.html';
  var file = path.join(ROOT, rel);
  /* never serve outside the project, whatever the path claims */
  if (file.indexOf(ROOT + path.sep) !== 0 && file !== ROOT) { res.writeHead(403); res.end('no'); return; }
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                         'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

function roomFrom(q, res) {
  var room = rooms[String(q || '').toUpperCase()];
  if (!room) { sendJson(res, 404, { ok: false, error: 'no such room' }); return null; }
  return room;
}

var server = http.createServer(function (req, res) {
  var u = req.url || '/';
  var qs = {};
  var qi = u.indexOf('?');
  if (qi >= 0) {
    u.slice(qi + 1).split('&').forEach(function (kv) {
      var p = kv.split('=');
      qs[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' '));
    });
  }
  var route = qi >= 0 ? u.slice(0, qi) : u;

  /* a JSON POST from another origin is preflighted before it is sent */
  if (req.method === 'OPTIONS') { res.writeHead(204, withCors({})); res.end(); return; }

  if (route === '/api/stream') {
    var room = roomFrom(qs.room, res);
    if (!room) return;
    var seat = seatOf(room, qs.token);
    res.writeHead(200, withCors({ 'Content-Type': 'text/event-stream; charset=utf-8',
                                  'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
                                  'X-Accel-Buffering': 'no' }));
    var sub = { res: res, seat: seat };
    room.subs.push(sub);
    if (seat) { seat.live++; seat.lastSeen = Date.now(); seat.away = false; }
    res.write('data: ' + stateFor(room, seat) + '\n\n');
    /* someone arriving is news for everyone else: it is how a lobby shows who is here */
    if (seat) broadcast(room);
    var beat = setInterval(function () {
      try { res.write(': ping\n\n'); } catch (e) {}
      if (sub.seat) sub.seat.lastSeen = Date.now();
    }, 15000);
    req.on('close', function () {
      clearInterval(beat);
      var i = room.subs.indexOf(sub);
      if (i >= 0) room.subs.splice(i, 1);
      if (sub.seat) { sub.seat.live = Math.max(0, sub.seat.live - 1); sub.seat.lastSeen = Date.now(); }
      broadcast(room);
    });
    return;
  }

  if (route === '/api/room') {
    var r0 = roomFrom(qs.room, res);
    if (r0) sendJson(res, 200, { ok: true, lobby: lobbyView(r0) });
    return;
  }

  if (route === '/api/list') {
    sendJson(res, 200, { ok: true, rooms: Object.keys(rooms).map(function (c) {
      return { room: c, started: rooms[c].started, seats: rooms[c].seats.length }; }) });
    return;
  }

  if (req.method !== 'POST') { serveStatic(req, res, route); return; }

  readBody(req, function (body) {
    if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'bad payload' });

    if (route === '/api/create') {
      var defs = Array.isArray(body.seats) ? body.seats : [];
      if (defs.length < 2 || defs.length > 4)
        return sendJson(res, 400, { ok: false, error: 'a game seats two to four' });
      var room = makeRoom(defs);
      saveSnapshot();
      return sendJson(res, 200, { ok: true, room: room.code, lobby: lobbyView(room) });
    }

    var room2 = rooms[String(body.room || '').toUpperCase()];
    if (!room2) return sendJson(res, 404, { ok: false, error: 'no such room' });

    if (route === '/api/claim') {
      /* A token you already hold gets your own seat back, whatever else has happened — that
         is what makes a reload silent. Otherwise the seat has to actually be free. */
      var mine = seatOf(room2, body.token);
      if (mine) {
        mine.away = false;
        mine.lastSeen = Date.now();
        syncControl(room2);
        broadcast(room2);
        return sendJson(res, 200, { ok: true, token: mine.token, seat: mine.idx, lobby: lobbyView(room2) });
      }
      var want = room2.seats[body.seat | 0];
      if (!want) return sendJson(res, 400, { ok: false, error: 'no such seat' });
      if (want.kind === 'computer') return sendJson(res, 409, { ok: false, error: 'that seat is the computer' });
      if (want.token) return sendJson(res, 409, { ok: false, error: 'that seat is taken' });
      want.token = newToken();
      want.away = false;
      want.lastSeen = Date.now();
      want.lastSeq = -1;
      syncControl(room2);
      broadcast(room2);
      return sendJson(res, 200, { ok: true, token: want.token, seat: want.idx, lobby: lobbyView(room2) });
    }

    var seat2 = seatOf(room2, body.token);

    if (route === '/api/release') {
      if (!seat2) return sendJson(res, 403, { ok: false, error: 'not seated' });
      seat2.token = null;
      seat2.away = true;
      seat2.lastSeq = -1;
      syncControl(room2);
      broadcast(room2);
      return sendJson(res, 200, { ok: true, lobby: lobbyView(room2) });
    }

    if (route === '/api/start') {
      if (!seat2) return sendJson(res, 403, { ok: false, error: 'not seated' });
      if (room2.started) return sendJson(res, 409, { ok: false, error: 'already started' });
      /* A seat nobody took is played by the computer rather than left empty, so a table that
         is one player short still gets a game. */
      var configs = room2.seats.map(function (s) {
        return { name: s.name, team: s.team, ai: autoSeat(s),
                 deck: s.deck || undefined, modules: s.modules || undefined,
                 skills: s.skills || undefined };
      });
      try {
        room2.E.newGame(configs);
        if (room2.AI) room2.AI.reset();
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: 'could not deal: ' + e.message });
      }
      room2.started = true;
      broadcast(room2);
      return sendJson(res, 200, { ok: true, lobby: lobbyView(room2) });
    }

    if (route === '/api/cmd') {
      if (!seat2) return sendJson(res, 403, { ok: false, error: 'not seated' });
      seat2.lastSeen = Date.now();
      var seq = (typeof body.seq === 'number') ? body.seq : null;
      /* A command that has already been applied is acknowledged, not applied again: a retry
         after a lost response must not play the card twice. */
      if (seq !== null && seq <= seat2.lastSeq)
        return sendJson(res, 200, { ok: true, duplicate: true, rev: room2.rev });
      var err = applyCommand(room2, seat2, String(body.cmd || ''), body.args);
      if (err) return sendJson(res, 409, { ok: false, error: err, rev: room2.rev });
      if (seq !== null) seat2.lastSeq = seq;
      broadcast(room2);
      return sendJson(res, 200, { ok: true, rev: room2.rev });
    }

    return sendJson(res, 404, { ok: false, error: 'no such endpoint' });
  });
});

setInterval(tickRooms, AI_TICK_MS);
setInterval(sweepSeats, SWEEP_MS);

server.listen(PORT, function () {
  console.log('Frigate server on http://localhost:' + PORT + '/client/game.html');
  console.log('  rules: ' + SOURCES.length + ' files, ' + RULES_SRC.length + ' bytes');
});

module.exports = { server: server, rooms: rooms };
