const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const v = require('../utils/validate');
const { now } = require('../utils/time');
const { homeFor } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/security');
const { audit } = require('../services/audit');
const patients = require('../services/patients');

const router = express.Router();
const limiter = loginLimiter();
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/** Start a fresh session for the user (prevents session fixation). */
function signIn(req, user, cb) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return cb(err);
    req.session.userId = user.id;
    db.update('users', user.id, { last_login_at: now() });
    cb(null, v.localPath(returnTo, homeFor(user)));
  });
}

router.get('/', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('home', { title: 'Welcome' });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/login', { title: 'Sign in', email: '', error: null });
});

router.post('/login', limiter, (req, res, next) => {
  const email = v.str(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  const user = db.get('SELECT * FROM users WHERE email = ?', email);

  // Always run bcrypt so response time does not reveal whether the email exists.
  const ok = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || !user.is_active) {
    limiter.fail(req);
    audit(req, 'login_failed', 'user', user?.id ?? null, { email });
    const error = user && ok && !user.is_active
      ? 'This account has been deactivated. Contact the UHS administrator.'
      : 'Incorrect email or password.';
    return res.status(401).render('auth/login', { title: 'Sign in', email, error });
  }
  limiter.reset(req);
  signIn(req, user, (err, dest) => {
    if (err) return next(err);
    req.user = user;
    audit(req, 'login', 'user', user.id);
    res.redirect(dest);
  });
});

router.post('/logout', (req, res) => {
  if (req.user) audit(req, 'logout', 'user', req.user.id);
  req.session.destroy(() => {
    res.clearCookie('uhs.sid');
    res.redirect('/login');
  });
});

const emptyRegistration = { full_name: '', id_number: '', category: 'student', date_of_birth: '', gender: '', phone: '', email: '' };

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/register', { title: 'Create patient account', form: emptyRegistration, errors: [] });
});

router.post('/register', (req, res, next) => {
  const { data, errors } = patients.readPatientForm(req.body);
  const password = String(req.body.password || '');

  if (!['student', 'staff', 'dependant'].includes(data.category)) errors.push('Choose student, staff or dependant.');
  if (!data.email) errors.push('An email address is required for an online account.');
  if (!data.phone) errors.push('A phone number is required.');
  const pwProblem = v.passwordProblem(password);
  if (pwProblem) errors.push(pwProblem);
  if (password !== String(req.body.confirm_password || '')) errors.push('The two passwords do not match.');
  if (!req.body.consent) errors.push('You must agree to the data-protection notice to register.');
  if (data.email && db.get('SELECT id FROM users WHERE email = ?', data.email)) {
    errors.push('An account with this email already exists. Try signing in instead.');
  }

  // If the person may already have a UHS folder, do not create a second one.
  // To protect medical records, linking an existing folder to an online
  // account is done in person at the records office after identity checks.
  if (!errors.length && patients.findPossibleDuplicates(data).length) {
    errors.push(
      'You may already have a UHS record. To protect your medical information, please visit the UHS records office with your ID card so they can enable online access for your existing record.'
    );
  }

  if (errors.length) {
    return res.status(400).render('auth/register', { title: 'Create patient account', form: { ...data }, errors });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const { user, patientId } = db.tx(() => {
    const userId = db.insert('users', {
      role: 'patient',
      full_name: data.full_name,
      email: data.email,
      phone: data.phone,
      password_hash: passwordHash,
    });
    const pid = patients.createPatient({ ...data, user_id: userId }, userId);
    return { user: db.get('SELECT * FROM users WHERE id = ?', userId), patientId: pid };
  });

  signIn(req, user, (err) => {
    if (err) return next(err);
    req.user = user;
    audit(req, 'patient_self_registered', 'patient', patientId);
    req.flash('success', 'Welcome! Your account has been created. You can now book a consultation.');
    res.redirect('/patient');
  });
});

module.exports = router;
