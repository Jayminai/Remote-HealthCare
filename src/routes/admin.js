// Administrative dashboard, staff accounts, audit log and email outbox.
// Admins see aggregated statistics only - never clinical notes.
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const t = require('../utils/time');
const v = require('../utils/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { audit } = require('../services/audit');
const config = require('../config');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const STAFF_ROLES = { doctor: 'Doctor', nurse: 'Nurse / Records officer', admin: 'Administrator' };

router.get('/', (req, res) => {
  const days = [7, 30, 90].includes(v.int(req.query.days)) ? v.int(req.query.days) : 30;
  const from = `${t.toDate(t.addDays(new Date(), -(days - 1)))} 00:00`;
  const to = `${t.toDate()} 23:59:59`;
  const today = t.toDate();

  const patients = db.get(
    'SELECT COUNT(*) AS total, SUM(user_id IS NOT NULL) AS online, SUM(digitised_at IS NOT NULL) AS digitised FROM patients'
  );
  const staff = db.all("SELECT role, COUNT(*) AS n FROM users WHERE role <> 'patient' AND is_active = 1 GROUP BY role");

  const todayByStatus = db.all(
    'SELECT status, COUNT(*) AS n FROM appointments WHERE scheduled_at LIKE ? GROUP BY status', `${today} %`
  );

  const range = db.get(
    `SELECT COUNT(*) AS total,
            SUM(mode <> 'in_person') AS remote,
            SUM(status = 'completed') AS completed,
            SUM(status = 'no_show') AS no_show,
            SUM(status = 'cancelled') AS cancelled,
            SUM(booked_via = 'online') AS online,
            SUM(booked_via = 'phone') AS phone,
            SUM(booked_via = 'walk_in') AS walk_in
       FROM appointments WHERE scheduled_at BETWEEN ? AND ?`,
    from, to
  );

  // Waiting time = from check-in (arrival / joining the waiting room) to the doctor starting.
  const wait = db.all(
    `SELECT CASE WHEN mode = 'in_person' THEN 'in_person' ELSE 'remote' END AS kind,
            ROUND(AVG((julianday(started_at) - julianday(checked_in_at)) * 1440)) AS avg_min,
            COUNT(*) AS n
       FROM appointments
      WHERE started_at IS NOT NULL AND checked_in_at IS NOT NULL AND started_at >= checked_in_at
        AND scheduled_at BETWEEN ? AND ?
      GROUP BY kind`,
    from, to
  );

  // Peak hours: when appointments are scheduled (or walk-ins arrive).
  const byHourRows = db.all(
    `SELECT CAST(substr(scheduled_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS n
       FROM appointments WHERE scheduled_at BETWEEN ? AND ? AND status <> 'cancelled'
      GROUP BY hour ORDER BY hour`,
    from, to
  );
  const byHour = [];
  for (let h = 7; h <= 17; h++) byHour.push({ label: `${String(h).padStart(2, '0')}:00`, n: byHourRows.find((r) => r.hour === h)?.n || 0 });

  const byDayRows = db.all(
    `SELECT substr(scheduled_at, 1, 10) AS day, COUNT(*) AS n,
            SUM(mode <> 'in_person') AS remote
       FROM appointments WHERE scheduled_at BETWEEN ? AND ? AND status <> 'cancelled'
      GROUP BY day`,
    `${t.toDate(t.addDays(new Date(), -13))} 00:00`, to
  );
  const byDay = [];
  for (let i = 13; i >= 0; i--) {
    const day = t.toDate(t.addDays(new Date(), -i));
    const row = byDayRows.find((r) => r.day === day);
    byDay.push({ label: t.fmtDate(day).slice(0, 10), n: row?.n || 0, remote: row?.remote || 0 });
  }

  const topDiagnoses = db.all(
    `SELECT LOWER(TRIM(diagnosis)) AS diagnosis, COUNT(*) AS n FROM consultations
      WHERE created_at BETWEEN ? AND ? GROUP BY LOWER(TRIM(diagnosis)) ORDER BY n DESC LIMIT 6`,
    from, to
  );

  const doctorLoad = db.all(
    `SELECT u.full_name, COUNT(a.id) AS total, SUM(a.status = 'completed') AS completed,
            SUM(a.mode <> 'in_person' AND a.status = 'completed') AS remote
       FROM users u LEFT JOIN appointments a ON a.doctor_id = u.id AND a.scheduled_at BETWEEN ? AND ? AND a.status <> 'cancelled'
      WHERE u.role = 'doctor' AND u.is_active = 1
      GROUP BY u.id ORDER BY total DESC`,
    from, to
  );

  res.render('admin/dashboard', {
    title: 'Administration', days, patients, staff, todayByStatus, range, wait, byHour, byDay, topDiagnoses, doctorLoad,
  });
});

// ---- Staff accounts ---------------------------------------------------------

router.get('/users', (req, res) => {
  const role = Object.keys(STAFF_ROLES).concat('patient').includes(req.query.role) ? req.query.role : '';
  const users = db.all(
    `SELECT id, role, full_name, email, phone, specialty, is_active, last_login_at, created_at FROM users
      ${role ? 'WHERE role = ?' : ''} ORDER BY role, full_name`,
    ...(role ? [role] : [])
  );
  res.render('admin/users', { title: 'User accounts', users, role, STAFF_ROLES });
});

router.get('/users/new', (req, res) => {
  res.render('admin/user_form', { title: 'Add staff account', form: { role: 'doctor' }, errors: [], STAFF_ROLES });
});

function tempPassword() {
  return `Uhs${crypto.randomInt(100000, 999999)}${crypto.randomBytes(2).toString('hex')}`;
}

router.post('/users/new', (req, res) => {
  const form = {
    role: v.str(req.body.role),
    full_name: v.str(req.body.full_name, 120),
    email: v.str(req.body.email, 120).toLowerCase(),
    phone: v.opt(req.body.phone, 20),
    specialty: v.opt(req.body.specialty, 80),
  };
  const errors = [];
  if (!STAFF_ROLES[form.role]) errors.push('Choose a role.');
  if (form.full_name.length < 3) errors.push('Enter the full name.');
  if (!v.isEmail(form.email)) errors.push('Enter a valid email address.');
  if (form.phone && !v.isPhone(form.phone)) errors.push('Enter a valid phone number.');
  if (form.email && db.get('SELECT id FROM users WHERE email = ?', form.email)) errors.push('That email is already in use.');
  if (errors.length) return res.status(400).render('admin/user_form', { title: 'Add staff account', form, errors, STAFF_ROLES });

  const password = tempPassword();
  const id = db.insert('users', {
    ...form,
    specialty: form.role === 'doctor' ? form.specialty : null,
    password_hash: bcrypt.hashSync(password, 10),
    must_change_password: 1,
  });
  audit(req, 'staff_account_created', 'user', id, { role: form.role });
  res.render('admin/credentials', { title: 'Account created', name: form.full_name, email: form.email, password, appUrl: config.appUrl });
});

router.post('/users/:id/toggle', (req, res) => {
  const id = v.int(req.params.id);
  const user = db.get('SELECT id, is_active, full_name FROM users WHERE id = ?', id);
  if (!user) return res.redirect('/admin/users');
  if (user.id === req.user.id) {
    req.flash('error', 'You cannot deactivate your own account.');
    return res.redirect('/admin/users');
  }
  db.update('users', id, { is_active: user.is_active ? 0 : 1 });
  audit(req, user.is_active ? 'account_deactivated' : 'account_activated', 'user', id);
  req.flash('success', `${user.full_name} ${user.is_active ? 'deactivated' : 'activated'}.`);
  res.redirect('/admin/users');
});

router.post('/users/:id/reset-password', (req, res) => {
  const user = db.get('SELECT id, full_name, email FROM users WHERE id = ?', v.int(req.params.id));
  if (!user) return res.redirect('/admin/users');
  const password = tempPassword();
  db.update('users', user.id, { password_hash: bcrypt.hashSync(password, 10), must_change_password: 1 });
  audit(req, 'password_reset_by_admin', 'user', user.id);
  res.render('admin/credentials', { title: 'Password reset', name: user.full_name, email: user.email, password, appUrl: config.appUrl });
});

// ---- Audit log & outbox -------------------------------------------------------

router.get('/audit', (req, res) => {
  const action = v.str(req.query.action, 60);
  const entries = db.all(
    `SELECT l.*, u.full_name, u.role FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
      ${action ? 'WHERE l.action = ?' : ''} ORDER BY l.id DESC LIMIT 300`,
    ...(action ? [action] : [])
  );
  const actions = db.all('SELECT DISTINCT action FROM audit_log ORDER BY action').map((r) => r.action);
  res.render('admin/audit', { title: 'Audit log', entries, actions, action });
});

router.get('/outbox', (req, res) => {
  const emails = db.all('SELECT * FROM email_outbox ORDER BY id DESC LIMIT 200');
  res.render('admin/outbox', { title: 'Email outbox', emails, smtpConfigured: Boolean(config.smtp.host) });
});

module.exports = router;
