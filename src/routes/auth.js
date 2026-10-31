// Signing in and out, patient registration and patient password resets.
// Patients sign in on the public site (/login), doctors and nurses in the staff portal (/staff/login) and
// administrators in the admin portal (/admin/login).
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const v = require('../utils/validate');
const t = require('../utils/time');
const { homeFor, loginPathFor, portalFor, portalOfPath } = require('../middleware/auth');
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
  admin: { view: 'staff/login', title: 'Administrator sign in' },
};
const renderLogin = (portal) => (req, res, error) =>
  res.render(LOGIN_PAGES[portal].view, { title: LOGIN_PAGES[portal].title, email: req.body?.email || '', error });
const limiters = {
  public: loginLimiter({ onLimit: renderLogin('public') }),
  staff: loginLimiter({ onLimit: renderLogin('staff') }),
  admin: loginLimiter({ onLimit: renderLogin('admin') }),
};

// Shown when someone signs in on another group's page.
const WRONG_PORTAL = {
  public: 'This is the patient sign-in. UHS staff sign in through the staff portal, and administrators through the admin portal.',
  staff: { patient: 'This is the staff portal. Patients sign in on the main UHS Telemedicine website.', admin: 'This is the staff portal. Administrators sign in through the admin portal at /admin/login.' },
  admin: 'This is the admin portal, for UHS administrators only. Doctors and nurses sign in through the staff portal; patients on the main website.',
};

/** Start a fresh session for the user (prevents session fixation). Resolves to the page to go to next. */
async function signIn(req, user) {
  // Only return to a page on the user's own side of the site.
  const returnTo = req.session.returnTo;
  const sameSide = typeof returnTo === 'string' && portalOfPath(returnTo) === portalFor(user.role);
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  req.user = user;
  await db.update('users', user.id, { last_login_at: t.now() });
  return sameSide ? v.localPath(returnTo, homeFor(user)) : homeFor(user);
}

/** Shared sign-in handler. portal: 'public' (patients), 'staff' or 'admin'. */
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
    // Patients, staff and administrators each have their own sign-in page.
    if (portalFor(user.role) !== portal) {
      await audit(req, 'login_wrong_portal', 'user', user.id, { portal });
      const message = WRONG_PORTAL[portal];
      const error = typeof message === 'string' ? message : message[user.role] || message.patient;
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

router.get('/admin/login', async (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('staff/login', { title: 'Administrator sign in', email: '', error: null });
});
router.post('/admin/login', ...handleLogin('admin'));

router.post('/logout', async (req, res) => {
  const portal = req.user ? portalFor(req.user.role) : 'public';
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
    // Opening the emailed link also proves the address belongs to the patient.
    await db.update('users', reset.user_id, { password_hash: bcrypt.hashSync(password, 10), must_change_password: 0, email_verified: 1 });
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

// ---- Email verification (patients who register themselves) ----
// The patient is signed in after registering, but every patient page redirects to /verify-email
// (see requireAuth) until they open the link we email them.

const VERIFY_HOURS = 24;
const VERIFY_PER_HOUR = 5;

/** Email the user a new confirmation link; earlier links stop working. */
async function sendVerification(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.insert('email_verifications', {
    user_id: user.id,
    token_hash: hashToken(token),
    expires_at: t.toDateTime(t.addMinutes(new Date(), VERIFY_HOURS * 60), true),
  });
  const body = (url) => `Hello ${user.full_name},

Welcome to UHS Telemedicine. Please confirm that this is your email address by opening this link
within ${VERIFY_HOURS} hours:
${url}

You can book consultations once your email address is confirmed.

If you did not create an account, ignore this email.

${config.clinic.name}`;
  await sendEmail(user.email, 'Confirm your email for UHS Telemedicine', body(`${config.appUrl}/verify-email/${token}`),
    { outboxBody: body('[confirmation link hidden]') });
}

/** Links sent to this user in the last hour, to stop the resend button being used to flood an inbox. */
async function recentVerifications(userId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ? AND created_at > ?',
    userId, t.toDateTime(t.addMinutes(new Date(), -60), true));
  return row.n;
}

/** Only signed-in patients who still have to confirm their email use the pages below. */
function pendingPatient(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'patient' || req.user.email_verified) return res.redirect(homeFor(req.user));
  next();
}

const renderVerify = (req, res, extra = {}) =>
  res.render('auth/verify', { title: 'Confirm your email', state: 'pending', email: req.user?.email, newEmail: '', error: null, hours: VERIFY_HOURS, ...extra });

router.get('/verify-email', pendingPatient, (req, res) => renderVerify(req, res));

router.post('/verify-email/resend', pendingPatient, async (req, res) => {
  if (await recentVerifications(req.user.id) >= VERIFY_PER_HOUR) {
    return renderVerify(req, res.status(429), { error: 'We have sent several links already. Check your spam folder, or try again in an hour.' });
  }
  await sendVerification(req.user);
  await audit(req, 'email_verification_resent', 'user', req.user.id);
  req.flash('success', `We have sent a new link to ${req.user.email}.`);
  res.redirect('/verify-email');
});

// A patient who mistyped their address can correct it here (until it is confirmed).
router.post('/verify-email/change', pendingPatient, async (req, res) => {
  const email = v.str(req.body.email, 120).toLowerCase();
  let error = null;
  if (!v.isEmail(email)) error = 'Enter a valid email address.';
  else if (email === req.user.email) error = 'That is the address we already have. Use "Send a new link" instead.';
  else if (await db.get('SELECT id FROM users WHERE email = ? AND id <> ?', email, req.user.id)) error = 'An account with this email already exists.';
  else if (await recentVerifications(req.user.id) >= VERIFY_PER_HOUR) error = 'We have sent several links already. Try again in an hour.';
  if (error) return renderVerify(req, res.status(400), { error, newEmail: email, showChange: true });

  await db.tx(async () => {
    await db.update('users', req.user.id, { email });
    await db.run('UPDATE patients SET email = ?, updated_at = ? WHERE user_id = ?', email, t.now(), req.user.id);
  });
  await audit(req, 'email_changed_before_verification', 'user', req.user.id);
  await sendVerification({ ...req.user, email });
  req.flash('success', `Email address changed. We have sent a link to ${email}.`);
  res.redirect('/verify-email');
});

// The link from the email. It works whether or not the patient is signed in on this device.
router.get('/verify-email/:token', async (req, res) => {
  const token = req.params.token;
  const row = /^[A-Za-z0-9_-]{43}$/.test(token) && await db.get(
    `SELECT e.user_id FROM email_verifications e JOIN users u ON u.id = e.user_id
      WHERE e.token_hash = ? AND e.expires_at > ? AND u.is_active = 1
        AND e.id = (SELECT MAX(id) FROM email_verifications WHERE user_id = e.user_id)`,
    hashToken(token), t.now()
  );
  if (!row) {
    if (req.user?.role === 'patient' && req.user.email_verified) return res.redirect(homeFor(req.user));
    return res.status(410).render('auth/verify', { title: 'Link not valid', state: 'invalid', signedIn: Boolean(req.user), hours: VERIFY_HOURS });
  }
  await db.tx(async () => {
    await db.update('users', row.user_id, { email_verified: 1 });
    await db.run('DELETE FROM email_verifications WHERE user_id = ?', row.user_id);
  });
  await audit(req, 'email_verified', 'user', row.user_id);
  if (req.user?.id === row.user_id) {
    req.flash('success', 'Thank you, your email address is confirmed. You can now book a consultation.');
    return res.redirect('/patient');
  }
  req.flash('success', 'Thank you, your email address is confirmed. Sign in to continue.');
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
      email_verified: 0,
    });
    const pid = await patients.createPatient({ ...data, user_id: userId }, userId);
    return { user: await db.get('SELECT * FROM users WHERE id = ?', userId), patientId: pid };
  });

  await signIn(req, user);
  await audit(req, 'patient_self_registered', 'patient', patientId);
  await sendVerification(user);
  res.redirect('/verify-email');
});

module.exports = router;
