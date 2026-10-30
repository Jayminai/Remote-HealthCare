// Signing in and out, patient registration and patient password resets.
// Patients sign in on the public site (/login); staff sign in to the staff portal (/staff/login).
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const v = require('../utils/validate');
const t = require('../utils/time');
const { homeFor, loginPathFor } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/security');
const { audit } = require('../services/audit');
const { sendEmail } = require('../services/notify');
const patients = require('../services/patients');

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const RESET_MINUTES = 60;

const LOGIN_PAGES = {
  public: { view: 'auth/login', title: 'Sign in' },
  staff: { view: 'staff/login', title: 'Staff sign in' },
};
const renderLogin = (portal) => (req, res, error) =>
  res.render(LOGIN_PAGES[portal].view, { title: LOGIN_PAGES[portal].title, email: req.body?.email || '', error });
const limiters = {
  public: loginLimiter({ onLimit: renderLogin('public') }),
  staff: loginLimiter({ onLimit: renderLogin('staff') }),
};

/** Start a fresh session for the user (prevents session fixation). Resolves to the page to go to next. */
async function signIn(req, user) {
  // Only return to a page on the user's own side of the site.
  const returnTo = req.session.returnTo;
  const sameSide = typeof returnTo === 'string' && returnTo.startsWith('/staff') === (user.role !== 'patient');
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  req.user = user;
  await db.update('users', user.id, { last_login_at: t.now() });
  return sameSide ? v.localPath(returnTo, homeFor(user)) : homeFor(user);
}

/** Shared sign-in handler. portal: 'public' (patients) or 'staff'. */
function handleLogin(portal) {
  const limiter = limiters[portal];
  const page = LOGIN_PAGES[portal];
  return [limiter, async (req, res) => {
    const email = v.str(req.body.email, 120).toLowerCase();
    const password = String(req.body.password || '');
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);

    // Always run bcrypt so response time does not reveal whether the email exists.
    const ok = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok || !user.is_active) {
      limiter.fail(req);
      await audit(req, 'login_failed', 'user', user?.id ?? null, { email, portal });
      const error = user && ok && !user.is_active
        ? 'This account has been deactivated. Contact the UHS administrator.'
        : 'Incorrect email or password.';
      return res.status(401).render(page.view, { title: page.title, email, error });
    }
    // Patients and staff each have their own sign-in page.
    if ((user.role === 'patient') !== (portal === 'public')) {
      await audit(req, 'login_wrong_portal', 'user', user.id, { portal });
      const error = portal === 'public'
        ? 'This is the patient sign-in. UHS staff sign in through the staff portal.'
        : 'This is the staff portal. Patients sign in on the main UHS Telemedicine website.';
      return res.status(403).render(page.view, { title: page.title, email, error });
    }
    limiter.reset(req);
    const dest = await signIn(req, user);
    await audit(req, 'login', 'user', user.id, { portal });
    res.redirect(dest);
  }];
}

router.get('/login', async (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/login', { title: 'Sign in', email: '', error: null });
});
router.post('/login', ...handleLogin('public'));

router.get('/staff', (req, res) => res.redirect(req.user ? homeFor(req.user) : '/staff/login'));
router.get('/staff/login', async (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('staff/login', { title: 'Staff sign in', email: '', error: null });
});
router.post('/staff/login', ...handleLogin('staff'));

router.post('/logout', async (req, res) => {
  const portal = req.user && req.user.role !== 'patient' ? 'staff' : 'public';
  if (req.user) await audit(req, 'logout', 'user', req.user.id);
  req.session.destroy(() => {
    res.clearCookie('uhs.sid');
    res.redirect(loginPathFor(portal));
  });
});

// ---- Forgotten password (patients only; staff passwords are reset by an administrator) ----

const resetLimiter = loginLimiter({
  max: 5,
  windowMs: 60 * 60 * 1000,
  onLimit: (req, res, error) => res.render('auth/forgot', { title: 'Forgot password', email: req.body?.email || '', sent: false, error }),
});
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** The reset request for a link token, if it is unused, unexpired and belongs to an active patient. */
async function findReset(token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.get(
    `SELECT r.id, r.user_id, u.full_name, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND u.role = 'patient' AND u.is_active = 1`,
    hashToken(token), t.now()
  );
}

router.get('/forgot-password', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/forgot', { title: 'Forgot password', email: '', sent: false, error: null });
});

router.post('/forgot-password', resetLimiter, async (req, res) => {
  const email = v.str(req.body.email, 120).toLowerCase();
  if (!v.isEmail(email)) {
    return res.status(400).render('auth/forgot', { title: 'Forgot password', email, sent: false, error: 'Enter the email address you registered with.' });
  }
  resetLimiter.fail(req); // every request counts, successful or not
  const user = await db.get('SELECT id, role, full_name, email, is_active FROM users WHERE email = ?', email);

  if (user && user.is_active && user.role === 'patient') {
    const token = crypto.randomBytes(32).toString('base64url');
    // Only the newest link works.
    await db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', user.id);
    await db.insert('password_resets', {
      user_id: user.id,
      token_hash: hashToken(token),
      expires_at: t.toDateTime(t.addMinutes(new Date(), RESET_MINUTES), true),
    });
    const link = `${config.appUrl}/reset-password/${token}`;
    const body = (url) => `Hello ${user.full_name},

We received a request to reset the password for your UHS Telemedicine account.

Open this link to choose a new password. It works once and expires in ${RESET_MINUTES} minutes:
${url}

If you did not ask for this, ignore this email. Your password will not change.

${config.clinic.name}`;
    await sendEmail(user.email, 'Reset your UHS Telemedicine password', body(link), { outboxBody: body('[reset link hidden]') });
    await audit(req, 'password_reset_requested', 'user', user.id);
  } else if (user && user.is_active) {
    await sendEmail(user.email, 'UHS Telemedicine password reset',
      `Hello ${user.full_name},\n\nSomeone asked to reset the password for this email address on the patient website.\n` +
      'Staff account passwords are reset by the UHS administrator. Please contact them if you cannot sign in to the staff portal.\n\n' +
      config.clinic.name);
    await audit(req, 'password_reset_refused_staff', 'user', user.id);
  }
  // Same answer either way, so the form cannot be used to find out who has an account.
  res.render('auth/forgot', { title: 'Forgot password', email, sent: true, error: null });
});

router.get('/reset-password/:token', async (req, res) => {
  const reset = await findReset(req.params.token);
  res.status(reset ? 200 : 410).render('auth/reset', { title: 'Choose a new password', token: req.params.token, valid: Boolean(reset), errors: [] });
});

router.post('/reset-password/:token', async (req, res) => {
  const reset = await findReset(req.params.token);
  if (!reset) {
    return res.status(410).render('auth/reset', { title: 'Choose a new password', token: req.params.token, valid: false, errors: [] });
  }
  const password = String(req.body.password || '');
  const errors = [];
  const problem = v.passwordProblem(password);
  if (problem) errors.push(problem);
  if (password !== String(req.body.confirm_password || '')) errors.push('The two passwords do not match.');
  if (errors.length) {
    return res.status(400).render('auth/reset', { title: 'Choose a new password', token: req.params.token, valid: true, errors });
  }

  await db.tx(async () => {
    await db.update('users', reset.user_id, { password_hash: bcrypt.hashSync(password, 10), must_change_password: 0 });
    await db.update('password_resets', reset.id, { used_at: t.now() });
    await db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', reset.user_id);
    // Sign the account out everywhere, in case someone else was using it.
    await db.run("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?", reset.user_id);
  });
  await audit(req, 'password_reset_completed', 'user', reset.user_id);
  await sendEmail(reset.email, 'Your UHS Telemedicine password was changed',
    `Hello ${reset.full_name},\n\nThe password for your UHS Telemedicine account was just changed.\n` +
    'If this was not you, contact the UHS records office straight away.\n\n' + config.clinic.name);
  req.flash('success', 'Your password has been changed. You can now sign in.');
  res.redirect('/login');
});

// ---- Patient registration ----

const emptyRegistration = { full_name: '', id_number: '', category: 'student', date_of_birth: '', gender: '', phone: '', email: '' };

router.get('/register', async (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/register', { title: 'Create patient account', form: emptyRegistration, errors: [] });
});

router.post('/register', async (req, res) => {
  const { data, errors } = patients.readPatientForm(req.body);
  const password = String(req.body.password || '');

  if (!['student', 'staff', 'dependant'].includes(data.category)) errors.push('Choose student, staff or dependant.');
  if (!data.email) errors.push('An email address is required for an online account.');
  if (!data.phone) errors.push('A phone number is required.');
  const pwProblem = v.passwordProblem(password);
  if (pwProblem) errors.push(pwProblem);
  if (password !== String(req.body.confirm_password || '')) errors.push('The two passwords do not match.');
  if (!req.body.consent) errors.push('You must agree to the data-protection notice to register.');
  if (data.email && await db.get('SELECT id FROM users WHERE email = ?', data.email)) {
    errors.push('An account with this email already exists. Try signing in instead.');
  }

  // If the person may already have a UHS folder, do not create a second one.
  // To protect medical records, linking an existing folder to an online
  // account is done in person at the records office after identity checks.
  if (!errors.length && (await patients.findPossibleDuplicates(data)).length) {
    errors.push(
      'You may already have a UHS record. To protect your medical information, please visit the UHS records office with your ID card so they can enable online access for your existing record.'
    );
  }

  if (errors.length) {
    return res.status(400).render('auth/register', { title: 'Create patient account', form: { ...data }, errors });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const { user, patientId } = await db.tx(async () => {
    const userId = await db.insert('users', {
      role: 'patient',
      full_name: data.full_name,
      email: data.email,
      phone: data.phone,
      password_hash: passwordHash,
    });
    const pid = await patients.createPatient({ ...data, user_id: userId }, userId);
    return { user: await db.get('SELECT * FROM users WHERE id = ?', userId), patientId: pid };
  });

  await signIn(req, user);
  await audit(req, 'patient_self_registered', 'patient', patientId);
  req.flash('success', 'Welcome! Your account has been created. You can now book a consultation.');
  res.redirect('/patient');
});

module.exports = router;
