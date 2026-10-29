// Stores login sessions in SQLite so users stay signed in across server restarts
// (express-session's default memory store is not meant for production).
const session = require('express-session');
const db = require('./index'); // the sessions table is defined in schema.sql

const expiry = (sess) => (sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000);

class SqliteStore extends session.Store {
  constructor() {
    super();
    // Remove expired sessions every 15 minutes.
    setInterval(() => db.run('DELETE FROM sessions WHERE expires < ?', Date.now()).catch(() => {}), 15 * 60 * 1000).unref();
  }

  get(sid, cb) {
    db.get('SELECT data, expires FROM sessions WHERE sid = ?', sid)
      .then((row) => cb(null, row && row.expires > Date.now() ? JSON.parse(row.data) : null), cb);
  }

  set(sid, sess, cb) {
    db.run(
      'INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data',
      sid, expiry(sess), JSON.stringify(sess)
    ).then(() => cb?.(null), (err) => cb?.(err));
  }

  touch(sid, sess, cb) {
    db.run('UPDATE sessions SET expires = ? WHERE sid = ?', expiry(sess), sid).then(() => cb?.(null), (err) => cb?.(err));
  }

  destroy(sid, cb) {
    db.run('DELETE FROM sessions WHERE sid = ?', sid).then(() => cb?.(null), (err) => cb?.(err));
  }
}

module.exports = { SqliteStore };
