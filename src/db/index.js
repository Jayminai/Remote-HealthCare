// Database access using Node's built-in SQLite driver (node:sqlite).
// No database server or native build step is needed.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');
const { now } = require('../utils/time');

if (config.dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}

const conn = new DatabaseSync(config.dbPath);
conn.exec('PRAGMA foreign_keys = ON;');
conn.exec('PRAGMA journal_mode = WAL;');
conn.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// node:sqlite only binds null/number/string/bigint/Buffer, so normalise values.
function clean(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
const bind = (params) => params.map(clean);
let txDepth = 0;

const db = {
  conn,

  get(sql, ...params) {
    return conn.prepare(sql).get(...bind(params));
  },

  all(sql, ...params) {
    return conn.prepare(sql).all(...bind(params));
  },

  run(sql, ...params) {
    return conn.prepare(sql).run(...bind(params));
  },

  /** Insert a row (created_at is filled automatically) and return its id. */
  insert(table, data) {
    const row = { created_at: now(), ...data };
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    return Number(conn.prepare(sql).run(...bind(Object.values(row))).lastInsertRowid);
  },

  /** Update columns of one row by id. Returns number of rows changed. */
  update(table, id, data) {
    const cols = Object.keys(data);
    if (!cols.length) return 0;
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    return Number(conn.prepare(sql).run(...bind([...Object.values(data), id])).changes);
  },

  /** Run fn inside a transaction; rolls back if it throws. Nested calls join the outer transaction. */
  tx(fn) {
    if (txDepth > 0) return fn();
    conn.exec('BEGIN IMMEDIATE');
    txDepth++;
    try {
      const result = fn();
      conn.exec('COMMIT');
      return result;
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    } finally {
      txDepth--;
    }
  },
};

module.exports = db;
