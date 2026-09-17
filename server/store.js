/*
 * Where games are kept.
 *
 * Two drivers behind one interface. Which one runs is decided by DATABASE_URL and nothing
 * else, so the same server code is what you develop against and what you deploy:
 *
 *   no DATABASE_URL   -> files under server/data/, one JSON per room, written atomically.
 *                        No install, no service, nothing to run. This is local play.
 *   DATABASE_URL set  -> PostgreSQL through node-postgres. This is Supabase.
 *
 * The interface is deliberately small — a game is one document, not twenty tables. Rows exist
 * only for what you would want to ask *across* games: which rooms are there, who is sitting in
 * them. Everything about the game itself lives in one JSON column, because it is 20 KB and
 * splitting it would buy nothing but the job of keeping the pieces agreeing.
 *
 * Every write to a game is a compare-and-set on `version`. One server does not need it — a
 * single node process serialises on its own event loop — but two would, and the day a second
 * one appears is not the day to start thinking about it.
 *
 * A seat's token is never stored. Its SHA-256 is, which is all the server needs to recognise
 * the holder, and means a copy of the database does not hand anybody a seat.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function hashToken(token) {
  return token ? crypto.createHash('sha256').update(String(token)).digest('hex') : null;
}

/* ================= files ================= */

function FileStore(dir) {
  this.dir = dir;
  this.kind = 'file';
}

FileStore.prototype.init = function () {
  fs.mkdirSync(this.dir, { recursive: true });
  return Promise.resolve();
};

FileStore.prototype._path = function (code) {
  /* a room code is six characters of our own alphabet; refuse anything that is not */
  if (!/^[A-Z0-9]{4,12}$/.test(code)) throw new Error('bad room code');
  return path.join(this.dir, code + '.json');
};

FileStore.prototype.loadRoom = function (code) {
  var file;
  try { file = this._path(code); } catch (e) { return Promise.resolve(null); }
  return new Promise(function (resolve) {
    fs.readFile(file, 'utf8', function (err, txt) {
      if (err) return resolve(null);
      try { resolve(JSON.parse(txt)); } catch (e) { resolve(null); }
    });
  });
};

/* temp file plus rename: a reader sees the old room or the new one, never half of either */
FileStore.prototype._write = function (code, rec) {
  var file = this._path(code), tmp = file + '.tmp';
  return new Promise(function (resolve, reject) {
    fs.writeFile(tmp, JSON.stringify(rec), function (err) {
      if (err) return reject(err);
      fs.rename(tmp, file, function (err2) { err2 ? reject(err2) : resolve(true); });
    });
  });
};

FileStore.prototype.createRoom = function (rec) {
  rec.version = 0;
  return this._write(rec.code, rec).then(function () { return rec; });
};

FileStore.prototype.saveRoom = function (code, next) {
  var self = this;
  return this.loadRoom(code).then(function (cur) {
    if (!cur) return false;
    if (next.version !== undefined && cur.version !== next.version) return false;   /* someone else got there first */
    var rec = {
      code: code,
      seed: next.seed !== undefined ? next.seed : cur.seed,
      status: next.status !== undefined ? next.status : cur.status,
      version: (cur.version || 0) + 1,
      state: next.state !== undefined ? next.state : cur.state,
      seats: next.seats !== undefined ? next.seats : cur.seats,
      created: cur.created,
      updated: Date.now()
    };
    return self._write(code, rec).then(function () { return rec; });
  });
};

FileStore.prototype.listRooms = function () {
  var self = this;
  return new Promise(function (resolve) {
    fs.readdir(self.dir, function (err, names) {
      if (err) return resolve([]);
      var codes = names.filter(function (n) { return /\.json$/.test(n); })
                       .map(function (n) { return n.replace(/\.json$/, ''); });
      Promise.all(codes.map(function (c) { return self.loadRoom(c); }))
        .then(function (recs) { resolve(recs.filter(Boolean)); });
    });
  });
};

FileStore.prototype.deleteRoom = function (code) {
  var file;
  try { file = this._path(code); } catch (e) { return Promise.resolve(); }
  return new Promise(function (resolve) { fs.unlink(file, function () { resolve(); }); });
};

FileStore.prototype.close = function () { return Promise.resolve(); };

/* ================= postgres ================= */

function PgStore(url) {
  var pg;
  try { pg = require('pg'); }
  catch (e) {
    throw new Error('DATABASE_URL is set but node-postgres is not installed. Run: npm install');
  }
  this.kind = 'postgres';
  /* Supabase's poolers terminate TLS with a certificate this client has no chain for, which is
     the documented way to reach them; the connection is still encrypted. Set PGSSL=off for a
     plain local server. */
  var ssl = process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false };
  if (/localhost|127\.0\.0\.1/.test(url) && process.env.PGSSL !== 'on') ssl = false;
  this.pool = new pg.Pool({ connectionString: url, ssl: ssl, max: 8,
                            idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
}

PgStore.prototype.init = function () {
  /* Created on boot rather than by a migration tool: there are two tables, they are additive,
     and a game server that cannot make its own bed is one more thing to get wrong on deploy. */
  return this.pool.query(
    'CREATE TABLE IF NOT EXISTS games (' +
    '  code       text PRIMARY KEY,' +
    '  seed       bigint NOT NULL,' +
    '  status     text NOT NULL,' +
    '  version    integer NOT NULL DEFAULT 0,' +
    '  state      jsonb,' +
    '  created    timestamptz NOT NULL DEFAULT now(),' +
    '  updated    timestamptz NOT NULL DEFAULT now()' +
    ');' +
    'CREATE TABLE IF NOT EXISTS game_seats (' +
    '  code       text NOT NULL REFERENCES games(code) ON DELETE CASCADE,' +
    '  idx        integer NOT NULL,' +
    '  name       text NOT NULL,' +
    '  team       integer NOT NULL,' +
    '  kind       text NOT NULL,' +
    '  token_hash text,' +
    '  last_seq   integer NOT NULL DEFAULT -1,' +
    '  joined_at  bigint,' +
    '  setup      jsonb,' +
    '  PRIMARY KEY (code, idx)' +
    ');' +
    'CREATE INDEX IF NOT EXISTS games_updated_idx ON games (updated DESC);' +
    /* for a database made by an earlier build: adding a column is additive and safe to repeat */
    'ALTER TABLE game_seats ADD COLUMN IF NOT EXISTS joined_at bigint;'
  );
};

function seatRows(code, seats) {
  return seats.map(function (s) {
    return [code, s.idx, s.name, s.team, s.kind, s.tokenHash || null,
            (s.lastSeq === undefined ? -1 : s.lastSeq),
            s.joinedAt || null,
            JSON.stringify(s.setup || null)];
  });
}

PgStore.prototype._writeSeats = function (client, code, seats) {
  if (!seats || !seats.length) return Promise.resolve();
  var rows = seatRows(code, seats), vals = [], params = [], n = 0;
  rows.forEach(function (r) {
    vals.push('($' + (n + 1) + ',$' + (n + 2) + ',$' + (n + 3) + ',$' + (n + 4) + ',$' +
              (n + 5) + ',$' + (n + 6) + ',$' + (n + 7) + ',$' + (n + 8) + ',$' + (n + 9) + '::jsonb)');
    params = params.concat(r);
    n += 9;
  });
  return client.query(
    'INSERT INTO game_seats (code, idx, name, team, kind, token_hash, last_seq, joined_at, setup)' +
    ' VALUES ' + vals.join(',') +
    ' ON CONFLICT (code, idx) DO UPDATE SET name = EXCLUDED.name, team = EXCLUDED.team,' +
    ' kind = EXCLUDED.kind, token_hash = EXCLUDED.token_hash, last_seq = EXCLUDED.last_seq,' +
    ' joined_at = EXCLUDED.joined_at, setup = EXCLUDED.setup', params);
};

PgStore.prototype.createRoom = function (rec) {
  var self = this;
  return this.pool.connect().then(function (client) {
    return client.query('BEGIN')
      .then(function () {
        return client.query(
          'INSERT INTO games (code, seed, status, version, state) VALUES ($1,$2,$3,0,$4::jsonb)',
          [rec.code, rec.seed, rec.status, rec.state ? JSON.stringify(rec.state) : null]);
      })
      .then(function () { return self._writeSeats(client, rec.code, rec.seats); })
      .then(function () { return client.query('COMMIT'); })
      .then(function () { rec.version = 0; return rec; })
      .catch(function (e) { return client.query('ROLLBACK').then(function () { throw e; }); })
      .then(function (v) { client.release(); return v; },
            function (e) { client.release(); throw e; });
  });
};

PgStore.prototype.loadRoom = function (code) {
  var self = this;
  return this.pool.query('SELECT code, seed, status, version, state, extract(epoch from created)*1000 AS created FROM games WHERE code = $1', [code])
    .then(function (r) {
      if (!r.rows.length) return null;
      var g = r.rows[0];
      return self.pool.query(
        'SELECT idx, name, team, kind, token_hash, last_seq, joined_at, setup' +
        ' FROM game_seats WHERE code = $1 ORDER BY idx', [code])
        .then(function (sr) {
          return {
            code: g.code, seed: Number(g.seed), status: g.status, version: g.version,
            state: g.state, created: Number(g.created),
            seats: sr.rows.map(function (s) {
              return { idx: s.idx, name: s.name, team: s.team, kind: s.kind,
                       tokenHash: s.token_hash, lastSeq: s.last_seq,
                       joinedAt: s.joined_at === null ? null : Number(s.joined_at),
                       setup: s.setup };
            })
          };
        });
    });
};

PgStore.prototype.saveRoom = function (code, next) {
  var self = this;
  return this.pool.connect().then(function (client) {
    var out = null;
    return client.query('BEGIN')
      .then(function () {
        /* Compare-and-set: the update only lands if nobody has written since we read. The
           statement is built from whichever fields were actually given, so the placeholders
           and the values are numbered together — build them apart and they drift. */
        var sets = ['version = version + 1', 'updated = now()'];
        var params = [code];
        if (next.status !== undefined) { params.push(next.status); sets.push('status = $' + params.length); }
        if (next.state !== undefined) {
          params.push(next.state ? JSON.stringify(next.state) : null);
          sets.push('state = $' + params.length + '::jsonb');
        }
        var where = 'code = $1';
        if (next.version !== undefined) { params.push(next.version); where += ' AND version = $' + params.length; }
        return client.query('UPDATE games SET ' + sets.join(', ') + ' WHERE ' + where +
                            ' RETURNING version', params);
      })
      .then(function (r) {
        if (!r.rows.length) return null;                 /* conflict, or no such room */
        out = { code: code, version: r.rows[0].version };
        if (next.seats === undefined) return null;
        return self._writeSeats(client, code, next.seats);
      })
      .then(function () { return client.query('COMMIT'); })
      .then(function () { return out ? Object.assign({}, next, out) : false; })
      .catch(function (e) { return client.query('ROLLBACK').then(function () { throw e; }); })
      .then(function (v) { client.release(); return v; },
            function (e) { client.release(); throw e; });
  });
};

PgStore.prototype.listRooms = function () {
  return this.pool.query(
    'SELECT code, status, version, extract(epoch from created)*1000 AS created,' +
    ' extract(epoch from updated)*1000 AS updated FROM games ORDER BY updated DESC LIMIT 500')
    .then(function (r) {
      return r.rows.map(function (g) {
        return { code: g.code, status: g.status, version: g.version,
                 created: Number(g.created), updated: Number(g.updated) };
      });
    });
};

PgStore.prototype.deleteRoom = function (code) {
  return this.pool.query('DELETE FROM games WHERE code = $1', [code]).then(function () {});
};

PgStore.prototype.close = function () { return this.pool.end(); };

/* ================= choosing one ================= */

function createStore(opts) {
  opts = opts || {};
  var url = opts.url !== undefined ? opts.url : process.env.DATABASE_URL;
  if (url) return new PgStore(url);
  return new FileStore(opts.dir || path.join(__dirname, 'data'));
}

module.exports = { createStore: createStore, hashToken: hashToken,
                   FileStore: FileStore, PgStore: PgStore };
