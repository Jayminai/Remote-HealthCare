const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const v = require('../utils/validate');
const { now } = require('../utils/time');
const { requireAuth, requireRole, homeFor } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { patientForUser } = require('../services/patients');

const router = express.Router();
router.use(requireAuth);

router.get('/password', (req, res) => {
  res.render('account/password', { title: 'Change password', errors: [] });
});

router.post('/password', (req, res) => {
  const user = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  const errors = [];
  if (!bcrypt.compareSync(current, user.password_hash)) errors.push('Your current password is incorrect.');
  const problem = v.passwordProblem(next);
  if (problem) errors.push(problem);
  if (next !== String(req.body.confirm_password || '')) errors.push('The new passwords do not match.');
  if (next && next === current) errors.push('The new password must be different from the current one.');
  if (errors.length) return res.status(400).render('account/password', { title: 'Change password', errors });

  db.update('users', user.id, { password_hash: bcrypt.hashSync(next, 10), must_change_password: 0 });
  audit(req, 'password_changed', 'user', user.id);
  req.flash('success', 'Your password has been changed.');
  res.redirect(homeFor(user));
});

// Patients can keep their own contact details up to date.
router.get('/profile', requireRole('patient'), (req, res) => {
  const patient = patientForUser(req.user.id);
  res.render('account/profile', { title: 'My profile', patient, errors: [] });
});

router.post('/profile', requireRole('patient'), (req, res) => {
  const patient = patientForUser(req.user.id);
  const data = {
    phone: v.str(req.body.phone, 20),
    address: v.opt(req.body.address, 300),
    emergency_contact_name: v.opt(req.body.emergency_contact_name, 120),
    emergency_contact_phone: v.opt(req.body.emergency_contact_phone, 20),
  };
  const errors = [];
  if (!v.isPhone(data.phone)) errors.push('Enter a valid phone number.');
  if (data.emergency_contact_phone && !v.isPhone(data.emergency_contact_phone)) errors.push('Enter a valid emergency contact phone.');
  if (errors.length) {
    return res.status(400).render('account/profile', { title: 'My profile', patient: { ...patient, ...data }, errors });
  }
  db.update('patients', patient.id, { ...data, updated_at: now() });
  db.update('users', req.user.id, { phone: data.phone });
  audit(req, 'patient_profile_updated', 'patient', patient.id);
  req.flash('success', 'Profile updated.');
  res.redirect('/account/profile');
});

module.exports = router;
