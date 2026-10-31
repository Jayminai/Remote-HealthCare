// Resets the database and fills it with realistic demo data (see demo-data.js).
//
//   npm run seed
//
// WARNING: locally this deletes the existing database file. Against a hosted
// (Turso) database it only runs when the database is empty, unless --reset is given,
// which deletes all existing rows first.
const fs = require('node:fs');
const config = require('../config');

if (!config.dbUrl) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
}

const db = require('./index');
const { PASSWORDS, loadDemoData } = require('./demo-data');

// Child tables first, so foreign keys are never violated.
const TABLES = ['typing', 'prescriptions', 'consultations', 'vitals', 'record_entries', 'message_images', 'quick_calls', 'messages', 'notifications',
  'appointments', 'patients', 'reminders_sent', 'email_outbox', 'audit_log', 'sessions', 'users'];

(async () => {
  await db.ready();
  if (config.dbUrl) {
    const hasData = await db.get('SELECT 1 AS x FROM users LIMIT 1');
    if (hasData && !process.argv.includes('--reset')) {
      console.log('The hosted database already has data. Run `npm run seed -- --reset` to delete it and load the demo data.');
      return;
    }
    await db.batch(TABLES.map((tbl) => ({ sql: `DELETE FROM ${tbl}`, args: [] })));
  }
  await loadDemoData();

  const count = async (sql) => (await db.get(sql)).n;
  console.log('Demo database created at', config.dbUrl ? 'the hosted database' : config.dbPath);
  console.log(`  ${await count('SELECT COUNT(*) AS n FROM patients')} patients, ${await count('SELECT COUNT(*) AS n FROM appointments')} appointments, ${await count('SELECT COUNT(*) AS n FROM consultations')} consultations`);
  console.log('\nDemo sign-in accounts:');
  console.log(`  Admin   admin@uhs.ui.edu.ng            ${PASSWORDS.admin}`);
  console.log(`  Doctor  dr.adebayo@uhs.ui.edu.ng       ${PASSWORDS.doctor}   (also dr.okafor@, dr.bello@)`);
  console.log(`  Nurse   nurse.ojo@uhs.ui.edu.ng        ${PASSWORDS.nurse}`);
  console.log(`  Patient tolulope.adeyemi@stu.ui.edu.ng ${PASSWORDS.patient}   (also emeka.nwosu@stu.ui.edu.ng)`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
