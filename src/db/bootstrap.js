// Makes sure there is always at least one administrator, so a fresh
// installation can be signed into without running the demo seed.
const bcrypt = require('bcryptjs');
const db = require('./index');

function ensureAdmin() {
  const exists = db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (exists) return;
  const email = process.env.ADMIN_EMAIL || 'admin@uhs.ui.edu.ng';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123';
  db.insert('users', {
    role: 'admin',
    full_name: 'System Administrator',
    email,
    password_hash: bcrypt.hashSync(password, 10),
    must_change_password: 1,
  });
  console.log(`Created initial admin account: ${email} (you will be asked to change the password on first sign-in).`);
}

module.exports = { ensureAdmin };
