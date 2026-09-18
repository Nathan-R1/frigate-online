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

/* A CA as either a path to a certificate or the certificate itself, so a container that has
   an env var but nowhere to put a file is no worse off than one with a disk. */
function readCa(v) {
  if (!v) return null;
  if (/-----BEGIN CERTIFICATE-----/.test(v)) return v;
  try { return fs.readFileSync(v, 'utf8'); }
  catch (e) {
    throw new Error('PGSSL_CA is set but cannot be read: ' + e.message);
  }
}

/* One room record reduced to what a stranger may know about it: that it exists, whether it has
   started, and how many chairs are empty. Everything else — the state, the names, and above
   all the token hashes — stays here. Null when there is nothing free to advertise. */
function summariseOpen(rec) {
  if (!rec || rec.status === 'over') return null;
  var seats = rec.seats || [];
  var free = seats.filter(function (s) { return s.kind === 'human' && !s.tokenHash; }).length;
  if (!free) return null;
  /* how many chairs actually have somebody in them — a room with none is a room nobody has
     come back to, and the Join screen would rather not lead with those */
  var taken = seats.filter(function (s) { return s.kind === 'human' && s.tokenHash; }).length;
  return { code: rec.code, status: rec.status, total: seats.length, free: free, taken: taken,
           updated: rec.updated || rec.created || 0 };
}

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

/* Temp file plus rename: a reader sees the old room or the new one, never half of either.
   The directory is made once at boot and assumed ever after, which held right up until
   something removed it underneath a running server. After that every write failed the same
   way forever, the games in memory had nowhere to go, and the only symptom at the front door
   was that hosting a game stopped working. A directory that is merely absent is not a reason
   to lose a game, so it is made again and the write is tried once more. Once more, not until
   it works: a full disk, or a directory we are not allowed to write to, is a real answer and
   deserves to be given as one rather than retried in a circle. */
FileStore.prototype._write = function (code, rec) {
  var self = this;
  var file = this._path(code), tmp = file + '.tmp';
  var body = JSON.stringify(rec);

  function attempt(mayRetry) {
    return new Promise(function (resolve, reject) {
      fs.writeFile(tmp, body, function (err) {
        if (err) {
          if (err.code !== 'ENOENT' || !mayRetry) return reject(err);
          console.warn('[store] ' + self.dir + ' had gone — making it again');
          return fs.mkdir(self.dir, { recursive: true }, function (mkErr) {
            if (mkErr) return reject(mkErr);
            attempt(false).then(resolve, reject);
          });
        }
        fs.rename(tmp, file, function (err2) { err2 ? reject(err2) : resolve(true); });
      });
    });
  }

  return attempt(true);
};

FileStore.prototype.createRoom = function (rec) {
  rec.version = 0;
  return this._write(rec.code, rec).then(function () { return rec; });
};

FileStore.prototype.saveRoom = function (code, next) {
  var self = this;
  return this.loadRoom(code).then(function (cur) {
    /* No record at all is not the same as a record that has moved on.
       Reporting it as a conflict is what the caller does understand — and the caller answers a
       conflict by dropping the room from memory, which is right when two servers are arguing
       over a room and catastrophically wrong when the store simply went missing underneath a
       game in progress: the game gets thrown away to protect a file that is not there. A live
       room is never swept away either, since sweepOldRooms skips anything still in memory, so
       nothing but loss puts us here. Write back what we are holding and keep the game. */
    if (!cur) {
      console.warn('[store] ' + code + ' had no record on disk — writing back what we hold');
      /* nothing but the version chain: every other field is left absent on purpose, so the
         record we were handed supplies it and a rebuilt room keeps the birthday it had */
      cur = { version: (next.version === undefined ? 0 : next.version) };
    } else if (next.version !== undefined && cur.version !== next.version) {
      return false;                                   /* someone else got there first */
    }
    var rec = {
      code: code,
      seed: next.seed !== undefined ? next.seed : cur.seed,
      status: next.status !== undefined ? next.status : cur.status,
      version: (cur.version || 0) + 1,
      state: next.state !== undefined ? next.state : cur.state,
      seats: next.seats !== undefined ? next.seats : cur.seats,
      created: cur.created || next.created || Date.now(),
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

/* ---------- games somebody could still join ----------
   Deliberately not "every room". A room code is the key to that room, so a listing that hands
   out all of them hands out the keys; this one answers a narrower question — which games have
   a chair nobody is sitting in — and returns nothing else. A finished game is not one, a full
   game is not one, and a seat the computer is playing is not one either. */
FileStore.prototype.listOpenRooms = function (limit) {
  return this.listRooms().then(function (recs) {
    return recs.map(summariseOpen).filter(Boolean)
               .sort(function (a, b) { return b.updated - a.updated; })
               .slice(0, limit || 40);
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
  /* TLS to the database.
     Encryption without verification is what you get by default: Supabase's poolers present a
     certificate this client has no chain for, so the traffic is private but the other end is
     unproven, and an attacker positioned between Render and Supabase could sit in the middle
     of it. That is worth fixing and worth being told about, so point PGSSL_CA at Supabase's
     CA — the file itself, or its PEM text — and the certificate is actually checked. Without
     it the old behaviour stands and says so once at boot rather than passing for safe.
     PGSSL=off for a plain local server; PGSSL=on to force TLS to one. */
  var ca = readCa(process.env.PGSSL_CA);
  var ssl = process.env.PGSSL === 'off' ? false
          : ca ? { ca: ca, rejectUnauthorized: true }
               : { rejectUnauthorized: false };
  if (/localhost|127\.0\.0\.1/.test(url) && process.env.PGSSL !== 'on') ssl = false;
  if (ssl && !ca) {
    console.warn('[store] database TLS is encrypted but UNVERIFIED — set PGSSL_CA to the ' +
                 "database's CA certificate to authenticate the other end");
  }
  this.verified = !!(ssl && ca);
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

/* The same question asked of Postgres, which can count for us. The filter is in the HAVING so
   that rooms with nothing free never travel; the token hash is never selected at all. */
PgStore.prototype.listOpenRooms = function (limit) {
  return this.pool.query(
    "SELECT g.code," +
    "       g.status," +
    '       extract(epoch from g.updated)*1000 AS updated,' +
    '       count(s.idx) AS total,' +
    "       count(*) FILTER (WHERE s.kind = 'human' AND s.token_hash IS NULL) AS free," +
    "       count(*) FILTER (WHERE s.kind = 'human' AND s.token_hash IS NOT NULL) AS taken" +
    '  FROM games g LEFT JOIN game_seats s ON s.code = g.code' +
    " WHERE g.status <> 'over'" +
    ' GROUP BY g.code, g.status, g.updated' +
    " HAVING count(*) FILTER (WHERE s.kind = 'human' AND s.token_hash IS NULL) > 0" +
    ' ORDER BY g.updated DESC LIMIT $1', [limit || 40])
    .then(function (r) {
      return r.rows.map(function (g) {
        return { code: g.code, status: g.status, updated: Number(g.updated),
                 total: Number(g.total), free: Number(g.free), taken: Number(g.taken) };
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

module.exports = { createStore: createStore, hashToken: hashToken, summariseOpen: summariseOpen,
                   FileStore: FileStore, PgStore: PgStore };
