/*
 * Frigate online play — authoritative game server.
 *
 * Node, one dependency (node-postgres, and only when you point it at a database).
 *   node server/game-server.js [port]
 *
 * WHY IT IS BUILT THIS WAY
 *
 * The rules are shared/engine.js — the same file the browser loads. Rather than write them a
 * second time in another language and spend the rest of the project keeping the two honest,
 * the server runs that very file. Each room gets its own V8 context (node's vm), because the
 * engine keeps one game in a module-level variable.
 *
 * The server is the only place a game advances. A client sends an intent — "play this card",
 * "answer this prompt", "end my turn" — and nothing else. It never sends state, and it never
 * says which seat it is: the seat is looked up from a secret token, so a client cannot act as
 * anybody but itself. The engine then does what it always does, refusing anything the rules
 * forbid, and the resulting state is pushed to every watcher.
 *
 * What each watcher is pushed is not the same thing. A snapshot is taken per viewer, and the
 * engine redacts it: the board is public, your own cards are yours, everyone else's hand and
 * deck arrive as the right number of blanks.
 *
 * WHERE THE GAME LIVES
 *
 * In store.js — files locally, PostgreSQL when DATABASE_URL is set. Memory is a cache of what
 * is written there, not the truth: a room is loaded on first use and can be dropped again, so
 * a restart, a deploy or a sleeping instance costs a game nothing.
 *
 * A game is only written down when it is *settled* — no prompt waiting, no queued effects.
 * That is the one moment the state is plain data rather than a half-resolved chain holding
 * closures. The cost of that choice is bounded and worth stating plainly: if the process dies
 * while somebody has a prompt open, the game comes back from just before the action that
 * opened it. Because the dice live in the state too — the generator's position is saved with
 * everything else — replaying that action rolls exactly what it rolled the first time.
 *
 * A seat is held until its player gives it up. Nothing expires on a timer, because a timer is
 * a promise a sleeping instance cannot keep.
 *
 * ENDPOINTS
 *   POST /api/create   {seats:[{name,team,kind,deck,modules,skills}]}  -> {room}
 *   GET  /api/room     ?room=CODE                                     -> lobby, no secrets
 *   POST /api/claim    {room, seat, token?}                           -> {token, seat}
 *   POST /api/release  {room, token}                                  -> give the seat up
 *   POST /api/kick     {room, token, seat}                             -> the leader frees a seat
 *   POST /api/start    {room, token}                                  -> deal and begin
 *   POST /api/cmd      {room, token, seq, cmd, args}                  -> one intent
 *   GET  /api/stream   ?room=CODE&token=...                           -> SSE of your state
 *   GET  /healthz                                                     -> for the host
 *   everything else                                                    -> static files
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');
var storeLib = require('./store');

var ROOT = path.resolve(__dirname, '..');
var PORT = parseInt(process.argv[2], 10) || parseInt(process.env.PORT, 10) || 8080;

/* The computer's pace when it is playing a seat — meant to be watched, not raced. */
var AI_TICK_MS = parseInt(process.env.FRIGATE_AI_TICK, 10) || 380;
/* How long after its last change a settled room is written down. Small enough that little is
   ever at risk, large enough that a computer turn is not a hundred writes. */
var FLUSH_MS = parseInt(process.env.FRIGATE_FLUSH, 10) || 500;
/* A room nobody is watching is dropped from memory this long after its last use. It is in the
   store; the next request loads it straight back. */
var EVICT_MS = parseInt(process.env.FRIGATE_EVICT, 10) || 10 * 60 * 1000;
/* How long a room is kept in the store. Zero means forever, which is the default: throwing
   away somebody's game because a number ran out should be something you asked for. */
var ROOM_TTL_DAYS = parseFloat(process.env.FRIGATE_ROOM_TTL_DAYS) || 0;

/* ---------- the rules, compiled once and instantiated per room ---------- */

var SOURCES = [
  'shared/presets/tech-presets.js',
  'shared/presets/mod-presets.js',
  'shared/presets/card-effects.js',
  'shared/engine.js',
  'shared/ai/ai-knowledge.js',
  'shared/ai/ai-path.js',
  'shared/ai/ai-placement.js',
  'shared/ai/ai-doctrine.js',
  'shared/ai/ai-commander.js'
];
var RULES_SRC = SOURCES.map(function (f) {
  return '/* ' + f + ' */\n' + fs.readFileSync(path.join(ROOT, f), 'utf8');
}).join('\n;\n');
var RULES_SCRIPT = new vm.Script(RULES_SRC, { filename: 'frigate-rules.js' });
/* Changing the rules invalidates a saved game's assumptions; the fingerprint is stored with
   the game so a mismatch can be seen rather than guessed at. */
var RULES_VERSION = crypto.createHash('sha256').update(RULES_SRC).digest('hex').slice(0, 12);

function newRules() {
  var sandbox = { console: console };
  vm.createContext(sandbox);
  RULES_SCRIPT.runInContext(sandbox);
  if (!sandbox.Engine) throw new Error('rules did not define Engine');
  return { E: sandbox.Engine, AI: sandbox.AICommander || null };
}

/* ---------- rooms ---------- */

var store = storeLib.createStore();
var rooms = Object.create(null);        /* a cache of what is in the store, not the truth */
var loading = Object.create(null);      /* in-flight loads, so two requests share one read */

/* Ambiguous glyphs are left out: a room code gets read aloud and typed by hand. */
var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  var bytes = crypto.randomBytes(6), code = '';
  for (var i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }

/* The computer plays only the seats it was given at the table. A seat meant for a person stays
   theirs: if they go, it empties and waits, and the game waits with it rather than having
   somebody's ship fought by a stand-in they did not ask for. */
function autoSeat(seat) { return seat.kind === 'computer'; }
function emptySeat(seat) { return seat.kind === 'human' && !seat.tokenHash; }
/* Somebody has to be able to clear a chair that its occupant has walked away from for good,
   and it should not be whoever shouts loudest. The leader is simply whoever sat down first,
   which needs no election and no owner account: if they leave, the next-earliest arrival is
   the leader, because the question is asked of the seats rather than remembered separately. */
function leaderOf(room) {
  var best = null;
  room.seats.forEach(function (s) {
    if (s.kind !== 'human' || !s.tokenHash || !s.joinedAt) return;
    if (!best || s.joinedAt < best.joinedAt || (s.joinedAt === best.joinedAt && s.idx < best.idx))
      best = s;
  });
  return best ? best.idx : null;
}

/* A stream is bound to the seat that was held when it opened. When that seat is given up or
   taken away, the binding has to go with it — otherwise the watcher keeps being sent that
   seat's hand, which is the one thing the redaction exists to prevent. */
function detachSeat(room, seatIdx) {
  room.subs.forEach(function (sub) {
    if (sub.seat && sub.seat.idx === seatIdx) sub.seat = null;
  });
}

function seatOf(room, token) {
  if (!token) return null;
  var h = storeLib.hashToken(token);
  for (var i = 0; i < room.seats.length; i++) if (room.seats[i].tokenHash === h) return room.seats[i];
  return null;
}

/* Build the live thing from what the store gave us. */
function hydrate(rec) {
  var r = newRules();
  var room = {
    code: rec.code,
    seed: rec.seed,
    status: rec.status,               /* 'lobby' | 'playing' | 'over' */
    version: rec.version,
    created: rec.created || Date.now(),
    E: r.E, AI: r.AI,
    seats: rec.seats.map(function (s) {
      return { idx: s.idx, name: s.name, team: s.team, kind: s.kind,
               tokenHash: s.tokenHash || null,
               lastSeq: (s.lastSeq === undefined ? -1 : s.lastSeq),
               joinedAt: s.joinedAt || null,
               setup: s.setup || null,
               live: 0, away: !!(s.kind === 'human' && !s.tokenHash) };
    }),
    rev: 0,
    subs: [],
    dirty: false,
    saving: Promise.resolve(),
    touched: Date.now()
  };
  if (rec.state) {
    /* A game saved by a different build of the rules may not mean the same thing any more —
       a card that has changed, an op that has gone. It is still loaded, because refusing would
       strand it, but the mismatch is said out loud rather than discovered later. */
    if (rec.state.rules && rec.state.rules !== RULES_VERSION) {
      console.warn('[rules] ' + rec.code + ' was saved by rules ' + rec.state.rules +
                   ', this server is ' + RULES_VERSION);
      room.staleRules = rec.state.rules;
    }
    room.E.restore(rec.state);
    syncControl(room);
  }
  rooms[rec.code] = room;
  return room;
}

function getRoom(code) {
  code = String(code || '').toUpperCase();
  if (rooms[code]) { rooms[code].touched = Date.now(); return Promise.resolve(rooms[code]); }
  if (loading[code]) return loading[code];
  loading[code] = store.loadRoom(code)
    .then(function (rec) {
      delete loading[code];
      if (!rec) return null;
      return rooms[code] || hydrate(rec);
    })
    .catch(function (e) { delete loading[code]; throw e; });
  return loading[code];
}

/* The engine decides what a side is when it is dealt, but who is playing a seat can change —
   somebody leaves, somebody arrives. Keeping the side's own flag in step is what lets a
   returning player act again. */
function syncControl(room) {
  var G = room.E.get();
  if (!G) return;
  room.seats.forEach(function (s) {
    if (G.players[s.idx]) G.players[s.idx].ai = autoSeat(s);
  });
}

/* ---------- writing it down ---------- */

function seatRecords(room) {
  return room.seats.map(function (s) {
    return { idx: s.idx, name: s.name, team: s.team, kind: s.kind,
             tokenHash: s.tokenHash, lastSeq: s.lastSeq, joinedAt: s.joinedAt,
             setup: s.setup };
  });
}

/* A save is only attempted when the game is settled, and saves for one room are chained so a
   slow write cannot be overtaken by the next one. */
function flush(room, force) {
  if (!room.dirty && !force) return room.saving;
  var G = room.E.get();
  var state = (room.status === 'lobby' || !G) ? undefined : room.E.save();
  if (state === null) return room.saving;              /* mid-action; the next tick will get it */
  room.dirty = false;
  room.saving = room.saving.then(function () {
    if (state) state.rules = RULES_VERSION;
    return store.saveRoom(room.code, {
      version: room.version, status: room.status, state: state, seats: seatRecords(room)
    });
  }).then(function (rec) {
    if (rec === false) {
      /* Somebody else wrote to this room. With one server that cannot happen; with two it is
         the moment to stop guessing, so the room is dropped and read afresh on next use. */
      console.error('[store] version conflict on ' + room.code + ', dropping it from memory');
      delete rooms[room.code];
      return;
    }
    if (rec && rec.version !== undefined) room.version = rec.version;
  }).catch(function (e) {
    room.dirty = true;                   /* try again on the next tick rather than lose it */
    console.error('[store] save failed for ' + room.code + ': ' + e.message);
  });
  return room.saving;
}

function touch(room) { room.dirty = true; room.touched = Date.now(); }

/* ---------- what a lobby may know: who is sitting where, never anybody's token ---------- */

function lobbyView(room) {
  var G = room.status === 'lobby' ? null : room.E.get();
  return {
    room: room.code,
    started: room.status !== 'lobby',
    over: G && G.over ? G.over : null,
    active: G ? G.active : null,
    turn: G ? G.turn : null,
    /* set when the game cannot go on because the seat whose turn it is has nobody in it */
    waitingFor: (G && !G.over && emptySeat(room.seats[G.active])) ? G.active : null,
    staleRules: room.staleRules || null,
    leader: leaderOf(room),
    seats: room.seats.map(function (s) {
      return { idx: s.idx, name: s.name, team: s.team, kind: s.kind,
               taken: !!s.tokenHash, away: s.away, watching: s.live > 0,
               auto: autoSeat(s), empty: emptySeat(s) };
    })
  };
}

function stateFor(room, seat) {
  return JSON.stringify({
    kind: 'state', rev: room.rev, lobby: lobbyView(room),
    seat: seat ? seat.idx : null,
    state: room.status === 'lobby' ? null : room.E.snapshot(seat ? seat.idx : -1)
  });
}

function broadcast(room) {
  room.rev++;
  room.touched = Date.now();
  room.subs.forEach(function (sub) {
    try { sub.res.write('data: ' + stateFor(room, sub.seat) + '\n\n'); } catch (e) {}
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
  if (room.status === 'lobby') return 'not started';
  var G = room.E.get();
  if (!G) return 'no game';
  if (G.over) return 'game over';
  if (G.active !== seat.idx) return 'not your turn';
  args = Array.isArray(args) ? args.slice(0, 3) : [];
  if (cmd === 'moveRoute') return walkRoute(room, seat, args[0], args[1]);
  /* The engine is the judge of legality. Everything above only decides who is allowed to ask.
     Where it answers at all it answers false, and that is a refusal worth passing back. */
  var ret;
  try {
    ret = room.E[cmd].apply(null, args);
  } catch (e) {
    return 'refused: ' + e.message;
  }
  if (ret === false) return 'the rules do not allow that';
  return null;
}

/* The computer plays any seat it was given, at a pace a watcher can follow. */
function tickRooms() {
  Object.keys(rooms).forEach(function (code) {
    var room = rooms[code];
    if (room.status !== 'playing' || !room.AI) return;
    var G = room.E.get();
    if (!G || G.over) return;
    var seat = room.seats[G.active];
    if (!seat || !autoSeat(seat)) return;
    var before = JSON.stringify([G.turn, G.active, G.phase, G.seq, !!G.pending]);
    try { room.AI.tick(G.active); } catch (e) { console.error('[ai]', code, e.message); }
    if (JSON.stringify([G.turn, G.active, G.phase, G.seq, !!G.pending]) === before) return;
    if (G.over) room.status = 'over';
    touch(room);
    broadcast(room);
  });
}

/* Old rooms, once you have said you want them swept. Finished games go first. */
var lastSweep = 0;
function sweepOldRooms() {
  if (!ROOM_TTL_DAYS) return;
  if (Date.now() - lastSweep < 3600000) return;
  lastSweep = Date.now();
  var cutoff = Date.now() - ROOM_TTL_DAYS * 86400000;
  store.listRooms().then(function (list) {
    list.forEach(function (r) {
      var age = r.updated || r.created || 0;
      if (age && age < cutoff && !rooms[r.code]) {
        store.deleteRoom(r.code);
        console.log('[store] swept ' + r.code + ' (older than ' + ROOM_TTL_DAYS + ' days)');
      }
    });
  }).catch(function () {});
}

/* Settled rooms are written down; rooms nobody is using are let go of. */
function housekeeping() {
  var now = Date.now();
  sweepOldRooms();
  Object.keys(rooms).forEach(function (code) {
    var room = rooms[code];
    if (room.dirty) flush(room);
    if (room.subs.length === 0 && !room.dirty && now - room.touched > EVICT_MS) {
      flush(room, true).then(function () {
        if (rooms[code] === room && room.subs.length === 0 && !room.dirty) delete rooms[code];
      });
    }
  });
}

/* ---------- http ---------- */

var MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
             '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
             '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
             '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/* ---------- who may call this from another origin ----------
   Normally nobody needs to: the page is served by this same server, and a same-origin request
   sends no Origin header and needs no permission. Cross-origin access exists for the case
   where the page is served from somewhere else — a second dev server, a static host — and that
   is worth allowing on purpose rather than to the whole internet.

   FRIGATE_ORIGIN lists the origins allowed, comma separated. With nothing set, only local and
   private-network addresses are allowed, so a laptop and a phone on the same wifi still work
   while a public deployment answers nobody it was not told about. */
var ALLOWED = (process.env.FRIGATE_ORIGIN || '').split(',')
  .map(function (o) { return o.trim().replace(/\/$/, ''); })
  .filter(Boolean);

function isPrivateOrigin(origin) {
  var m = /^https?:\/\/([^:/]+)/.exec(origin);
  if (!m) return false;
  var host = m[1];
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

function corsHeaders(req) {
  var origin = req && req.headers && req.headers.origin;
  /* no Origin means same-origin, or a tool like curl: nothing to grant */
  if (!origin) return {};
  var ok = ALLOWED.length ? ALLOWED.indexOf(origin) >= 0 : isPrivateOrigin(origin);
  if (!ok) return { 'Vary': 'Origin' };        /* no allow header: the browser blocks the read */
  return { 'Access-Control-Allow-Origin': origin,
           'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
           'Access-Control-Allow-Headers': 'Content-Type',
           'Vary': 'Origin' };
}

function withCors(h, req) {
  var out = {};
  Object.keys(h).forEach(function (k) { out[k] = h[k]; });
  var c = corsHeaders(req);
  Object.keys(c).forEach(function (k) { out[k] = c[k]; });
  return out;
}

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, withCors({ 'Content-Type': 'application/json; charset=utf-8',
                                 'Cache-Control': 'no-store',
                                 'Content-Length': Buffer.byteLength(body) }, res.req));
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
    var obj = null;
    try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { obj = null; }
    done(obj);
  });
}

function serveStatic(req, res, urlPath) {
  var rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/client/game.html';
  var file = path.join(ROOT, rel);
  if (file.indexOf(ROOT + path.sep) !== 0 && file !== ROOT) { res.writeHead(403); res.end('no'); return; }
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                         'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

var server = http.createServer(function (req, res) {
  var u = req.url || '/';
  var qs = {}, qi = u.indexOf('?');
  if (qi >= 0) {
    u.slice(qi + 1).split('&').forEach(function (kv) {
      var p = kv.split('=');
      qs[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' '));
    });
  }
  var route = qi >= 0 ? u.slice(0, qi) : u;

  if (req.method === 'OPTIONS') { res.writeHead(204, withCors({}, req)); res.end(); return; }

  if (route === '/healthz') {
    return sendJson(res, 200, { ok: true, store: store.kind, rules: RULES_VERSION,
                                rooms: Object.keys(rooms).length,
                                uptime: Math.round(process.uptime()) });
  }

  if (route === '/api/stream') {
    return getRoom(qs.room).then(function (room) {
      if (!room) return sendJson(res, 404, { ok: false, error: 'no such room' });
      var seat = seatOf(room, qs.token);
      res.writeHead(200, withCors({ 'Content-Type': 'text/event-stream; charset=utf-8',
                                    'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
                                    'X-Accel-Buffering': 'no' }, req));
      var sub = { res: res, seat: seat };
      room.subs.push(sub);
      if (seat) seat.live++;
      res.write('data: ' + stateFor(room, seat) + '\n\n');
      if (seat) broadcast(room);         /* someone arriving is news for everyone else */
      var beat = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
      req.on('close', function () {
        clearInterval(beat);
        var i = room.subs.indexOf(sub);
        if (i >= 0) room.subs.splice(i, 1);
        if (sub.seat) sub.seat.live = Math.max(0, sub.seat.live - 1);
        broadcast(room);
      });
    }).catch(function (e) { sendJson(res, 500, { ok: false, error: e.message }); });
  }

  if (route === '/api/room') {
    return getRoom(qs.room)
      .then(function (room) {
        if (!room) return sendJson(res, 404, { ok: false, error: 'no such room' });
        sendJson(res, 200, { ok: true, lobby: lobbyView(room) });
      })
      .catch(function (e) { sendJson(res, 500, { ok: false, error: e.message }); });
  }

  if (route === '/api/list') {
    return store.listRooms()
      .then(function (list) {
        sendJson(res, 200, { ok: true, rooms: list.map(function (r) {
          return { room: r.code, started: r.status !== 'lobby',
                   seats: (r.seats || []).length }; }) });
      })
      .catch(function (e) { sendJson(res, 500, { ok: false, error: e.message }); });
  }

  if (req.method !== 'POST') return serveStatic(req, res, route);

  readBody(req, function (body) {
    if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'bad payload' });

    if (route === '/api/create') {
      var defs = Array.isArray(body.seats) ? body.seats : [];
      if (defs.length < 2 || defs.length > 4)
        return sendJson(res, 400, { ok: false, error: 'a game seats two to four' });
      var rec = {
        code: newCode(),
        seed: crypto.randomBytes(4).readInt32LE(0),
        status: 'lobby',
        state: null,
        created: Date.now(),
        seats: defs.map(function (d, i) {
          return {
            idx: i,
            name: String(d.name || ('Player ' + (i + 1))).slice(0, 40),
            team: (d.team === undefined || d.team === null) ? i : (+d.team | 0),
            kind: d.kind === 'computer' ? 'computer' : 'human',
            tokenHash: null, lastSeq: -1,
            setup: { deck: Array.isArray(d.deck) ? d.deck : null,
                     modules: Array.isArray(d.modules) ? d.modules : null,
                     skills: d.skills || null }
          };
        })
      };
      return store.createRoom(rec)
        .then(function (saved) {
          var room = hydrate(saved);
          sendJson(res, 200, { ok: true, room: room.code, lobby: lobbyView(room) });
        })
        .catch(function (e) { sendJson(res, 500, { ok: false, error: e.message }); });
    }

    getRoom(body.room).then(function (room) {
      if (!room) return sendJson(res, 404, { ok: false, error: 'no such room' });

      if (route === '/api/claim') {
        /* A token you already hold gets your own seat back, whatever else has happened — that
           is what makes a reload silent. Otherwise the seat has to actually be free. */
        var mine = seatOf(room, body.token);
        if (mine) {
          mine.away = false;
          syncControl(room);
          broadcast(room);
          flush(room, true);
          return sendJson(res, 200, { ok: true, token: body.token, seat: mine.idx,
                                      lobby: lobbyView(room) });
        }
        var want = room.seats[body.seat | 0];
        if (!want) return sendJson(res, 400, { ok: false, error: 'no such seat' });
        if (want.kind === 'computer')
          return sendJson(res, 409, { ok: false, error: 'that seat is the computer' });
        if (want.tokenHash) return sendJson(res, 409, { ok: false, error: 'that seat is taken' });
        var token = newToken();
        want.tokenHash = storeLib.hashToken(token);
        want.away = false;
        want.lastSeq = -1;
        want.joinedAt = Date.now();      /* the order people sat down decides who leads */
        syncControl(room);
        broadcast(room);
        return flush(room, true).then(function () {
          sendJson(res, 200, { ok: true, token: token, seat: want.idx, lobby: lobbyView(room) });
        });
      }

      var seat = seatOf(room, body.token);

      if (route === '/api/release') {
        if (!seat) return sendJson(res, 403, { ok: false, error: 'not seated' });
        seat.tokenHash = null;
        seat.away = true;
        seat.lastSeq = -1;
        seat.joinedAt = null;
        seat.live = 0;
        detachSeat(room, seat.idx);
        syncControl(room);
        broadcast(room);
        return flush(room, true).then(function () {
          sendJson(res, 200, { ok: true, lobby: lobbyView(room) });
        });
      }

      if (route === '/api/kick') {
        if (!seat) return sendJson(res, 403, { ok: false, error: 'not seated' });
        if (leaderOf(room) !== seat.idx)
          return sendJson(res, 403, { ok: false, error: 'only the leader can free a seat' });
        var target = room.seats[body.seat | 0];
        if (!target) return sendJson(res, 400, { ok: false, error: 'no such seat' });
        if (target.idx === seat.idx)
          return sendJson(res, 400, { ok: false, error: 'use Leave to give up your own seat' });
        if (target.kind === 'computer')
          return sendJson(res, 400, { ok: false, error: 'that seat is the computer' });
        if (!target.tokenHash) return sendJson(res, 409, { ok: false, error: 'that seat is already free' });
        target.tokenHash = null;
        target.away = true;
        target.lastSeq = -1;
        target.joinedAt = null;
        target.live = 0;
        detachSeat(room, target.idx);
        /* their stream stays open — they simply become a watcher, and can take a free seat */
        syncControl(room);
        broadcast(room);
        return flush(room, true).then(function () {
          sendJson(res, 200, { ok: true, lobby: lobbyView(room) });
        });
      }

      if (route === '/api/start') {
        if (!seat) return sendJson(res, 403, { ok: false, error: 'not seated' });
        if (room.status !== 'lobby') return sendJson(res, 409, { ok: false, error: 'already started' });
        var configs = room.seats.map(function (s) {
          var set = s.setup || {};
          return { name: s.name, team: s.team, ai: autoSeat(s),
                   deck: set.deck || undefined, modules: set.modules || undefined,
                   skills: set.skills || undefined };
        });
        try {
          room.E.newGame(configs, room.seed);
          if (room.AI) room.AI.reset();
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: 'could not deal: ' + e.message });
        }
        room.status = 'playing';
        syncControl(room);
        broadcast(room);
        return flush(room, true).then(function () {
          sendJson(res, 200, { ok: true, lobby: lobbyView(room) });
        });
      }

      if (route === '/api/cmd') {
        if (!seat) return sendJson(res, 403, { ok: false, error: 'not seated' });
        var seq = (typeof body.seq === 'number') ? body.seq : null;
        /* A command already applied is acknowledged, not applied again: a retry after a lost
           reply must not play the card twice. */
        if (seq !== null && seq <= seat.lastSeq)
          return sendJson(res, 200, { ok: true, duplicate: true, rev: room.rev });
        var err = applyCommand(room, seat, String(body.cmd || ''), body.args);
        if (err) return sendJson(res, 409, { ok: false, error: err, rev: room.rev });
        if (seq !== null) seat.lastSeq = seq;
        var G2 = room.E.get();
        if (G2 && G2.over) room.status = 'over';
        touch(room);
        broadcast(room);
        /* A turn handed over, or a game finished, is worth writing down at once. */
        if (body.cmd === 'endTurn' || room.status === 'over') flush(room, true);
        return sendJson(res, 200, { ok: true, rev: room.rev });
      }

      return sendJson(res, 404, { ok: false, error: 'no such endpoint' });
    }).catch(function (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    });
  });
});

/* ---------- lifecycle ---------- */

var timers = [];
function begin() {
  return store.init().then(function () {
    timers.push(setInterval(tickRooms, AI_TICK_MS));
    timers.push(setInterval(housekeeping, FLUSH_MS));
    return new Promise(function (resolve) {
      server.listen(PORT, function () {
        console.log('Frigate server on http://localhost:' + PORT + '/client/game.html');
        console.log('  store: ' + store.kind + '   rules: ' + RULES_VERSION);
        resolve();
      });
    });
  });
}

/* A deploy sends SIGTERM. Anything settled and unwritten goes to the store before we go. */
var closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log('\n' + signal + ' — saving ' + Object.keys(rooms).length + ' room(s)');
  timers.forEach(clearInterval);
  server.close();
  Object.keys(rooms).forEach(function (c) {
    rooms[c].subs.forEach(function (s) { try { s.res.end(); } catch (e) {} });
  });
  Promise.all(Object.keys(rooms).map(function (c) { return flush(rooms[c], true); }))
    .then(function () { return store.close(); })
    .catch(function (e) { console.error('[shutdown] ' + e.message); })
    .then(function () { process.exit(0); });
  setTimeout(function () { process.exit(1); }, 8000).unref();
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });

if (require.main === module) {
  begin().catch(function (e) {
    console.error('could not start: ' + e.message);
    process.exit(1);
  });
}

module.exports = { server: server, rooms: rooms, begin: begin, store: store };
