// Stores login sessions in SQLite so users stay signed in across server restarts
// (express-session's default memory store is not meant for production).
const session = require('express-session');
const db = require('./index'); // the sessions table is defined in schema.sql

class SqliteStore extends session.Store {
  constructor() {
    super();
    // Remove expired sessions every 15 minutes.
    setInterval(() => db.run('DELETE FROM sessions WHERE expires < ?', Date.now()), 15 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = db.get('SELECT data, expires FROM sessions WHERE sid = ?', sid);
      cb(null, row && row.expires > Date.now() ? JSON.parse(row.data) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      db.run(
        'INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data',
        sid, expires, JSON.stringify(sess)
      );
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      db.run('UPDATE sessions SET expires = ? WHERE sid = ?', expires, sid);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  destroy(sid, cb) {
    try {
      db.run('DELETE FROM sessions WHERE sid = ?', sid);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }
}

module.exports = { SqliteStore };
