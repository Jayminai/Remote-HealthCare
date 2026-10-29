// Prepares the database once per server instance:
// - creates the tables,
// - loads demo data into an empty database when SEED_DEMO=true,
// - makes sure there is always at least one administrator, so a fresh
//   installation can be signed into without running the demo seed.
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('./index');

async function ensureAdmin() {
  const exists = await db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (exists) return;
  const email = process.env.ADMIN_EMAIL || 'admin@uhs.ui.edu.ng';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123';
  await db.insert('users', {
    role: 'admin',
    full_name: 'System Administrator',
    email,
    password_hash: bcrypt.hashSync(password, 10),
    must_change_password: 1,
  });
  console.log(`Created initial admin account: ${email} (you will be asked to change the password on first sign-in).`);
}

async function seedIfEmpty() {
  if (await db.get('SELECT 1 AS x FROM users LIMIT 1')) return;
  try {
    await require('./demo-data').loadDemoData();
    console.log('Loaded demo data into the empty database.');
  } catch (err) {
    // Another instance seeding at the same moment wins; its batch is atomic.
    if (!String(err.message).includes('UNIQUE')) throw err;
  }
}

let started = null;
/** Resolves when the database is ready. Safe to call on every request. */
function startup() {
  started ??= (async () => {
    await db.ready();
    if (config.seedDemo) await seedIfEmpty();
    await ensureAdmin();
  })().catch((err) => {
    started = null; // retry on the next request
    throw err;
  });
  return started;
}

module.exports = { ensureAdmin, startup };
