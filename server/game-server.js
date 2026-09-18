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
 *   POST /api/ticket   {room, token}                                  -> a ticket for the stream
 *   GET  /api/stream   ?room=CODE&ticket=...                          -> SSE of your state
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

/* ---------- ceilings ----------
   A game needs none of these. They exist because this process answers the open internet, where
   a request costs the sender nothing and can be sent a million times, and every one of them
   spends something of ours: memory for a room, event-loop time to serialise a state, a row in
   somebody else's database. Each number below is the point past which a stranger would be
   spending it rather than a player. They are generous — a real game never approaches one — and
   every one can be moved without touching the code. */
var MAX_ROOMS_LIVE  = num(process.env.FRIGATE_MAX_ROOMS, 300);   /* rooms held in memory */
var MAX_SUBS_ROOM   = num(process.env.FRIGATE_MAX_SUBS_ROOM, 16);
var MAX_SUBS_TOTAL  = num(process.env.FRIGATE_MAX_SUBS, 400);
var MAX_DECK        = num(process.env.FRIGATE_MAX_DECK, 120);
var MAX_MODULES     = num(process.env.FRIGATE_MAX_MODULES, 40);
var MAX_SKILLS      = 40;
var MAX_TRAITS      = 200;
var MAX_BODY        = 262144;
/* A room code is six characters; anything longer is not a mistyped code, it is a probe. */
var MAX_CODE        = 12;

function num(v, dflt) { var n = parseInt(v, 10); return (isNaN(n) || n < 0) ? dflt : n; }

/* Whether /api/list says what rooms exist. Off unless asked for: see the endpoint. */
var LIST_ROOMS = process.env.FRIGATE_LIST === '1';

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

function subsTotal() {
  return Object.keys(rooms).reduce(function (a, c) { return a + rooms[c].subs.length; }, 0);
}

/* ---------- what a table may be set with ----------
   A seat arrives describing the ship it wants to fly, and the engine is careful about the
   names: one it does not know it ignores. It is not careful about how MANY, because nothing in
   the game ever asked it to be. A deck is a dozen cards; the body that carries it holds a
   quarter of a megabyte, which is twenty thousand — and twenty thousand cards is a state of a
   couple of megabytes that this server then serialises for every watcher, several times a
   second, and writes to the database on every settled turn. One request, paid for by everyone
   afterwards. So the count is checked here, where the number arrives, rather than trusted to
   stay sensible because it always has. */
function cleanSetup(d) {
  var deck = Array.isArray(d.deck) ? d.deck.slice(0, MAX_DECK).map(cleanEntry) : null;
  var mods = Array.isArray(d.modules) ? d.modules.slice(0, MAX_MODULES).map(cleanEntry) : null;
  return { deck: deck, modules: mods, skills: cleanSkills(d.skills) };
}

/* A deck entry is a name, or a name with traits of its own. Either way it is text, and text
   that is going to be held in a saved game has a length. */
function cleanEntry(e) {
  if (typeof e === 'string') return e.slice(0, 80);
  if (!e || typeof e !== 'object') return '';
  var out = { name: String(e.name || '').slice(0, 80) };
  if (e.traits !== undefined && e.traits !== null) out.traits = String(e.traits).slice(0, MAX_TRAITS);
  return out;
}

/* Skills are numbers under names the engine knows. Anything else is somebody else's idea: the
   keys are counted and kept plain, and __proto__ is not a skill. */
function cleanSkills(sk) {
  if (!sk || typeof sk !== 'object' || Array.isArray(sk)) return null;
  var out = Object.create(null), n = 0;
  Object.keys(sk).forEach(function (k) {
    if (n >= MAX_SKILLS) return;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
    var v = sk[k];
    if (typeof v !== 'number' && typeof v !== 'string') return;
    out[String(k).slice(0, 40)] = typeof v === 'number' ? v : String(v).slice(0, 40);
    n++;
  });
  return n ? Object.assign({}, out) : null;
}

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
    /* seed and created travel with every save, not because a save normally needs them — the
       store has them already — but so that a store which has lost the record can be handed a
       complete one back rather than a partial rebuild. */
    return store.saveRoom(room.code, {
      version: room.version, status: room.status, state: state, seats: seatRecords(room),
      seed: room.seed, created: room.created
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

/* Everybody looking through the same seat is owed the same bytes, and a snapshot is the most
   expensive thing this server does — so it is built once per distinct seat and handed round,
   rather than once per watcher. With one player that changes nothing; with a crowd on one room
   it is the difference between a broadcast costing what the game costs and costing what the
   audience costs. */
function broadcast(room) {
  room.rev++;
  room.touched = Date.now();
  var bySeat = Object.create(null);
  room.subs.forEach(function (sub) {
    var key = sub.seat ? sub.seat.idx : 'watch';
    if (bySeat[key] === undefined) bySeat[key] = 'data: ' + stateFor(room, sub.seat) + '\n\n';
    try { sub.res.write(bySeat[key]); } catch (e) {}
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
    console.error('[engine] ' + cmd + ': ' + (e && e.stack ? e.stack : e));
    return 'the rules could not apply that';
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
/* Over the ceiling, the quietest rooms go — watched or not.
   Eviction on idleness alone is a promise an outsider can stop us keeping simply by holding a
   stream open, and a room that cannot be let go of is memory that cannot be got back. Nothing
   is lost by going: the game is in the store and the next request loads it straight back, so
   the cost to a real player who happens to be the quietest is one reconnection. */
function evictOverflow() {
  var codes = Object.keys(rooms);
  if (codes.length <= MAX_ROOMS_LIVE) return;
  codes.sort(function (a, b) { return rooms[a].touched - rooms[b].touched; })
       .slice(0, codes.length - MAX_ROOMS_LIVE)
       .forEach(function (code) {
    var room = rooms[code];
    if (!room) return;
    flush(room, true).then(function () {
      if (rooms[code] !== room) return;
      room.subs.forEach(function (sub) { try { sub.res.end(); } catch (e) {} });
      room.subs.length = 0;
      delete rooms[code];
      console.warn('[rooms] over ' + MAX_ROOMS_LIVE + ' in memory — dropped ' + code);
    });
  });
}

function housekeeping() {
  var now = Date.now();
  sweepOldRooms();
  sweepBuckets(now);
  sweepTickets(now);
  Object.keys(rooms).forEach(function (code) {
    var room = rooms[code];
    if (room.dirty) flush(room);
    if (room.subs.length === 0 && !room.dirty && now - room.touched > EVICT_MS) {
      flush(room, true).then(function () {
        if (rooms[code] === room && room.subs.length === 0 && !room.dirty) delete rooms[code];
      });
    }
  });
  evictOverflow();
}

/* ---------- stream tickets ----------
   A seat token is the one thing that says who you are, and EventSource cannot carry a header,
   so before this the token was spelled out in the stream's URL — where it is written into
   every access log the request passes through and kept for as long as logs are kept. A ticket
   is what goes in the URL instead: a separate secret, minted over POST where the body is not
   logged, that buys one thing only. It opens a stream as its seat. It cannot play a card.
   Somebody who reads it out of a log can watch that seat's game, which is worth closing and is
   not worth the seat itself, and it dies with the seat it was cut for. */
var tickets = Object.create(null);
var TICKET_IDLE_MS = 30 * 60 * 1000;

function newTicket(room, seat) {
  var id = crypto.randomBytes(18).toString('hex');
  tickets[id] = { room: room.code, seat: seat.idx, hash: seat.tokenHash, used: Date.now() };
  return id;
}

/* A ticket is only worth anything while the seat it names is still held by the same person —
   the token hash is checked, so a seat given up and taken by somebody else leaves the old
   ticket pointing at nothing. */
function ticketSeat(room, id) {
  var t = id && tickets[id];
  if (!t || t.room !== room.code) return null;
  var seat = room.seats[t.seat];
  if (!seat || !seat.tokenHash || seat.tokenHash !== t.hash) { delete tickets[id]; return null; }
  t.used = Date.now();
  return seat;
}

function dropTickets(code, seatIdx) {
  Object.keys(tickets).forEach(function (id) {
    var t = tickets[id];
    if (t.room === code && (seatIdx === undefined || t.seat === seatIdx)) delete tickets[id];
  });
}

function sweepTickets(now) {
  Object.keys(tickets).forEach(function (id) {
    if (now - tickets[id].used > TICKET_IDLE_MS) delete tickets[id];
  });
}

/* ---------- what one caller may spend ----------
   A token bucket per client address. The costs say what each thing is worth to us rather than
   to them: a room is a database row and a V8 context, a stream is a socket held open, and
   everything else is arithmetic. The buckets are swept, because a map keyed on something the
   caller chooses is itself a way to spend our memory. */
var buckets = Object.create(null);
/* Credits held at most. The burst matters more than the rate: several players behind one
   household address all joining at once, or all reconnecting after a deploy, should not be
   mistaken for an attack. The sustained allowance below is what actually bounds abuse. */
var RATE_CAP = num(process.env.FRIGATE_RATE_CAP, 240);
var RATE_FILL = num(process.env.FRIGATE_RATE_FILL, 2);      /* credits back per second */
var COST = { '/api/create': 30, '/api/stream': 5, '/api/ticket': 2, other: 1 };

/* Behind Render the socket belongs to the proxy, so every player would share one bucket and
   rate limiting would mean nothing. The forwarded address is only believed where something in
   front is known to be setting it — never on a bare port, where the caller writes it. */
var TRUST_PROXY = process.env.FRIGATE_TRUST_PROXY
  ? process.env.FRIGATE_TRUST_PROXY !== 'off'
  : !!process.env.RENDER;

function clientAddr(req) {
  if (TRUST_PROXY) {
    var f = req.headers['x-forwarded-for'];
    if (f) return String(f).split(',')[0].trim().slice(0, 64);
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateOk(req, route) {
  var addr = clientAddr(req), now = Date.now();
  var b = buckets[addr];
  if (!b) b = buckets[addr] = { credits: RATE_CAP, seen: now };
  b.credits = Math.min(RATE_CAP, b.credits + (now - b.seen) / 1000 * RATE_FILL);
  b.seen = now;
  var cost = COST[route] || COST.other;
  if (b.credits < cost) return false;
  b.credits -= cost;
  return true;
}

function sweepBuckets(now) {
  Object.keys(buckets).forEach(function (a) {
    if (now - buckets[a].seen > 600000) delete buckets[a];
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

/* ---------- what every answer carries ----------
   A page is not only what it contains; it is also what a browser will let it do. These say
   that the game may talk to the server it came from and nowhere else, may not be framed, may
   not have its base rewritten, and may not load a plugin — so that a hole opened somewhere in
   the client has far less to reach for. connect-src is the load-bearing one: it is what stops
   a page of ours from being talked into sending a seat token somewhere it was not served
   from. FRIGATE_ORIGIN, where it is set, is added to it, because that is the same permission
   said once. FRIGATE_CSP=off is the way out for anyone who needs one. */
var CSP_ON = process.env.FRIGATE_CSP !== 'off';

function csp(nonce) {
  return [
    "default-src 'self'",
    "script-src 'self'" + (nonce ? " 'nonce-" + nonce + "'" : ''),
    /* inline style attributes are how the board is coloured, so this one cannot be a nonce:
       a nonce in style-src would switch 'unsafe-inline' off and take the board with it.
       Google Fonts needs naming twice and in two different directives, which is what makes it
       easy to half-fix: googleapis serves the stylesheet, gstatic serves the .woff2 files
       that stylesheet then asks for. Allow one without the other and the fonts still fail. */
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data:",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src " + ["'self'"].concat(ALLOWED).join(' '),
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}

function guarded(h, nonce) {
  h['X-Content-Type-Options'] = 'nosniff';
  h['Referrer-Policy'] = 'no-referrer';
  h['X-Frame-Options'] = 'DENY';
  if (CSP_ON) h['Content-Security-Policy'] = csp(nonce);
  return h;
}

/* An error a stranger reads should say what they can do about it and nothing else. What it was
   actually about goes to the log with a tag, so a report of "it said 500, tag a1b2c3d4" is
   enough to find the one line that matters. */
function fail(res, code, message, err) {
  var tag = crypto.randomBytes(4).toString('hex');
  if (err) console.error('[' + tag + '] ' + (err && err.stack ? err.stack : err));
  sendJson(res, code, { ok: false, error: message, tag: tag });
}

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, withCors(guarded({ 'Content-Type': 'application/json; charset=utf-8',
                                         'Cache-Control': 'no-store',
                                         'Content-Length': Buffer.byteLength(body) }), res.req));
  res.end(body);
}

/* JSON, said so in the request.
   The point is not politeness about types. A browser will send text/plain, a form encoding or
   a multipart body to another origin with no permission asked and no preflight, and before
   this that was enough to reach every POST here — so any page anywhere could have a visitor
   quietly create rooms. application/json is not on that list: asking for it means the browser
   has to ask us first, and the CORS rules above are then the ones that answer. */
function wantsJson(req) {
  var t = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return t === 'application/json';
}

function readBody(req, res, done) {
  var chunks = [], size = 0, over = false;
  req.on('data', function (c) {
    if (over) return;
    size += c.length;
    if (size > MAX_BODY) {                 /* a sheet is large, a payload is not */
      over = true;
      sendJson(res, 413, { ok: false, error: 'that payload is too large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', function () {
    if (over) return;
    var obj = null;
    try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { obj = null; }
    done(obj);
  });
  req.on('error', function () { over = true; });
}

/* ---------- static files ----------
   Only the two directories the browser actually asks for. Serving the project root was one
   line shorter and handed out everything that happened to sit next to the game: the working
   copy's .git, the notes, the package manifest — and, the day anybody puts one there, a .env
   holding the database URL. A traversal check alone does not help with that, because none of
   it is a traversal: it is all legitimately inside the root. So the root is not the thing
   being served. A dot-led segment is refused outright, and a file whose type we do not name is
   not ours to hand over. */
var SERVABLE = { client: 1, shared: 1 };

function serveStatic(req, res, urlPath) {
  var rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0]); } catch (e) { rel = null; }
  if (rel === null || rel.indexOf('\0') >= 0) { res.writeHead(400); res.end('no'); return; }
  if (rel === '/' || rel === '') rel = '/client/game.html';

  var parts = rel.split('/').filter(Boolean);
  var bad = !parts.length || !SERVABLE[parts[0]] ||
            parts.some(function (seg) { return seg.charAt(0) === '.'; });
  if (bad) { res.writeHead(404); res.end('not found'); return; }

  var file = path.join(ROOT, parts.join(path.sep));
  if (file.indexOf(ROOT + path.sep) !== 0) { res.writeHead(403); res.end('no'); return; }

  var type = MIME[path.extname(file).toLowerCase()];
  if (!type) { res.writeHead(404); res.end('not found'); return; }

  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    /* A page is rewritten on the way out so its own inline script carries this response's
       nonce. That is what lets script-src name the scripts we shipped and refuse every other
       one, which is the whole value of the header. */
    if (type.indexOf('text/html') === 0) {
      fs.readFile(file, 'utf8', function (e2, html) {
        if (e2) { res.writeHead(404); res.end('not found'); return; }
        var nonce = crypto.randomBytes(16).toString('base64');
        var body = html.replace(/<script(?=[\s>])(?![^>]*\bnonce=)/g, '<script nonce="' + nonce + '"');
        res.writeHead(200, guarded({ 'Content-Type': type, 'Cache-Control': 'no-cache',
                                     'Content-Length': Buffer.byteLength(body) }, nonce));
        res.end(body);
      });
      return;
    }
    res.writeHead(200, guarded({ 'Content-Type': type, 'Cache-Control': 'no-cache' }));
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

  if (req.method === 'OPTIONS') { res.writeHead(204, withCors(guarded({}), req)); res.end(); return; }

  /* Everything under /api costs credits. Static files do not: those are the game loading, and
     whatever sits in front of this process is better placed to say no to a flood of them. */
  if (route.indexOf('/api/') === 0 && !rateOk(req, route))
    return sendJson(res, 429, { ok: false, error: 'too many requests — slow down' });

  /* A room code is six characters. Anything longer is somebody trying the door, and it should
     cost us nothing, least of all a database round trip. */
  if (qs.room && qs.room.length > MAX_CODE)
    return sendJson(res, 400, { ok: false, error: 'no such room' });

  if (route === '/healthz') {
    /* Enough for a host to know we are alive, plus the two things worth knowing at a glance
       about a deploy: which store it came up on and which build is live. A stranger learns
       both, and that is the trade — a service that quietly fell back to the file store looks
       identical to a healthy one otherwise, and on an ephemeral disk that costs every game. */
    return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()),
                                store: store.kind, rules: RULES_VERSION });
  }

  if (route === '/api/stream') {
    if (subsTotal() >= MAX_SUBS_TOTAL)
      return sendJson(res, 503, { ok: false, error: 'the server is full — try again shortly' });
    return getRoom(qs.room).then(function (room) {
      if (!room) return sendJson(res, 404, { ok: false, error: 'no such room' });
      if (room.subs.length >= MAX_SUBS_ROOM)
        return sendJson(res, 503, { ok: false, error: 'too many people are watching that room' });
      /* A ticket, or nothing. The seat token used to be accepted here and it is not any more:
         it has no business in a URL. An old client sending one simply watches. */
      var seat = ticketSeat(room, qs.ticket);
      res.writeHead(200, withCors(guarded({ 'Content-Type': 'text/event-stream; charset=utf-8',
                                    'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
                                    'X-Accel-Buffering': 'no' }), req));
      var sub = { res: res, seat: seat };
      room.subs.push(sub);
      if (seat) seat.live++;
      res.write('data: ' + stateFor(room, seat) + '\n\n');
      if (seat) broadcast(room);         /* someone arriving is news for everyone else */
      /* The heartbeat keeps the ticket alive as well as the socket: a stream open for hours
         never re-opens, so without this its ticket would be swept as idle underneath it and
         the reconnection after a blip would come back as a watcher. */
      var beat = setInterval(function () {
        if (qs.ticket && tickets[qs.ticket]) tickets[qs.ticket].used = Date.now();
        try { res.write(': ping\n\n'); } catch (e) {}
      }, 15000);
      req.on('close', function () {
        clearInterval(beat);
        var i = room.subs.indexOf(sub);
        if (i >= 0) room.subs.splice(i, 1);
        if (sub.seat) sub.seat.live = Math.max(0, sub.seat.live - 1);
        broadcast(room);
      });
    }).catch(function (e) { fail(res, 500, 'could not open that stream', e); });
  }

  if (route === '/api/room') {
    return getRoom(qs.room)
      .then(function (room) {
        if (!room) return sendJson(res, 404, { ok: false, error: 'no such room' });
        sendJson(res, 200, { ok: true, lobby: lobbyView(room) });
      })
      .catch(function (e) { fail(res, 500, 'could not read that room', e); });
  }

  /* This answers two questions, and only one of them is anybody's business. "Are you the game
     server?" is what the page asks to find us, and what the start script asks to know we are
     up. "What games are running?" is a list of every room code on the server, which is the
     key to the front door of each one — a stranger could read it, walk in and sit down. So the
     list is only ever filled in for somebody who has been told to expect it. */
  if (route === '/api/list') {
    if (!LIST_ROOMS) return sendJson(res, 200, { ok: true, rooms: [] });
    return store.listRooms()
      .then(function (list) {
        sendJson(res, 200, { ok: true, rooms: list.map(function (r) {
          return { room: r.code, started: r.status !== 'lobby',
                   seats: (r.seats || []).length }; }) });
      })
      .catch(function (e) { fail(res, 500, 'could not list rooms', e); });
  }

  if (req.method !== 'POST') return serveStatic(req, res, route);

  if (!wantsJson(req))
    return sendJson(res, 415, { ok: false, error: 'send application/json' });

  readBody(req, res, function (body) {
    if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'bad payload' });

    if (route === '/api/create') {
      var defs = Array.isArray(body.seats) ? body.seats : [];
      if (defs.length < 2 || defs.length > 4)
        return sendJson(res, 400, { ok: false, error: 'a game seats two to four' });
      if (Object.keys(rooms).length >= MAX_ROOMS_LIVE)
        return sendJson(res, 503, { ok: false, error: 'the server is full — try again shortly' });
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
            setup: cleanSetup(d || {})
          };
        })
      };
      return store.createRoom(rec)
        .then(function (saved) {
          var room = hydrate(saved);
          sendJson(res, 200, { ok: true, room: room.code, lobby: lobbyView(room) });
        })
        .catch(function (e) { fail(res, 500, 'could not make that room', e); });
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

      /* The stream needs something to identify itself with and cannot send a header, so it is
         given a ticket instead of the token — cut here, over POST, where the body stays out of
         the logs the URL would have gone into. */
      if (route === '/api/ticket') {
        if (!seat) return sendJson(res, 403, { ok: false, error: 'not seated' });
        return sendJson(res, 200, { ok: true, ticket: newTicket(room, seat), seat: seat.idx });
      }

      if (route === '/api/release') {
        if (!seat) return sendJson(res, 403, { ok: false, error: 'not seated' });
        seat.tokenHash = null;
        seat.away = true;
        seat.lastSeq = -1;
        seat.joinedAt = null;
        seat.live = 0;
        detachSeat(room, seat.idx);
        dropTickets(room.code, seat.idx);
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
        dropTickets(room.code, target.idx);
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
          console.error('[deal] ' + room.code + ': ' + (e && e.stack ? e.stack : e));
          return sendJson(res, 500, { ok: false, error: 'the game could not be dealt' });
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
      fail(res, 500, 'something went wrong handling that', e);
    });
  });
});

/* ---------- lifecycle ---------- */

var timers = [];
function begin() {
  return store.init().then(function () {
    timers.push(setInterval(tickRooms, AI_TICK_MS));
    timers.push(setInterval(housekeeping, FLUSH_MS));
    return new Promise(function (resolve, reject) {
      /* a port already in use is an ordinary mistake, not a stack trace */
      server.on('error', function (e) {
        reject(e.code === 'EADDRINUSE'
          ? new Error('port ' + PORT + ' is already in use — is a server already running?')
          : e);
      });
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
