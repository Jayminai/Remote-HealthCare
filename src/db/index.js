// Database access through libSQL (SQLite-compatible).
// - Locally it uses a SQLite file (data/uhs.db), so no database server is needed.
// - In the cloud (e.g. Vercel) it uses a hosted Turso database when
//   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are set, because serverless
//   functions cannot keep a database file between requests.
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createClient } = require('@libsql/client');
const config = require('../config');
const { now } = require('../utils/time');

const remote = Boolean(config.dbUrl);
if (!remote) fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const client = createClient(
  remote
    ? { url: config.dbUrl, authToken: config.dbAuthToken }
    : { url: `file:${config.dbPath.replace(/\\/g, '/')}` }
);

// The transaction (if any) that the current request is running inside.
const txStore = new AsyncLocalStorage();

// libSQL binds null/number/string/bigint/Uint8Array, so normalise values.
function clean(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** Turn a libSQL result row into a plain object (BigInt counts become numbers). */
function toObject(columns, row) {
  const out = {};
  columns.forEach((c, i) => {
    const val = row[i];
    out[c] = typeof val === 'bigint' ? Number(val) : val;
  });
  return out;
}

// Create tables on first use (CREATE TABLE IF NOT EXISTS, so safe on every start).
let readyPromise = null;
function ready() {
  readyPromise ??= (async () => {
    if (!remote) await client.execute('PRAGMA journal_mode = WAL');
    await client.execute('PRAGMA foreign_keys = ON');
    await client.executeMultiple(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    // Columns added after the first release: CREATE TABLE IF NOT EXISTS leaves existing tables as
    // they are. Existing accounts get the default, so they count as verified.
    const userColumns = (await client.execute('PRAGMA table_info(users)')).rows.map((r) => r.name);
    if (!userColumns.includes('email_verified')) {
      try {
        await client.execute('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
      } catch (err) {
        if (!/duplicate column/i.test(err.message)) throw err; // another instance added it first
      }
    }
  })().catch((err) => {
    readyPromise = null; // allow a retry on the next request
    throw err;
  });
  return readyPromise;
}

async function exec(sql, params) {
  await ready();
  const target = txStore.getStore() || client;
  return target.execute({ sql, args: params.map(clean) });
}

const db = {
  client,
  remote,
  ready,

  async get(sql, ...params) {
    const rs = await exec(sql, params);
    return rs.rows.length ? toObject(rs.columns, rs.rows[0]) : undefined;
  },

  async all(sql, ...params) {
    const rs = await exec(sql, params);
    return rs.rows.map((r) => toObject(rs.columns, r));
  },

  async run(sql, ...params) {
    const rs = await exec(sql, params);
    return { changes: rs.rowsAffected, lastInsertRowid: Number(rs.lastInsertRowid ?? 0) };
  },

  /** Insert a row (created_at is filled automatically) and return its id. */
  async insert(table, data) {
    const row = { created_at: now(), ...data };
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    return (await db.run(sql, ...Object.values(row))).lastInsertRowid;
  },

  /** Update columns of one row by id. Returns number of rows changed. */
  async update(table, id, data) {
    const cols = Object.keys(data);
    if (!cols.length) return 0;
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    return (await db.run(sql, ...Object.values(data), id)).changes;
  },

  /** Run many statements ({ sql, args }) atomically in one round trip. */
  async batch(statements) {
    await ready();
    await client.batch(statements.map((s) => ({ sql: s.sql, args: s.args.map(clean) })), 'write');
  },

  /** Run fn inside a write transaction; rolls back if it throws. Nested calls join the outer transaction. */
  async tx(fn) {
    if (txStore.getStore()) return fn();
    await ready();
    const tx = await client.transaction('write');
    try {
      const result = await txStore.run(tx, fn);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    } finally {
      tx.close();
    }
  },
};

module.exports = db;
