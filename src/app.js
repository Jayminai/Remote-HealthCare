const config = require('./config'); // must be first: sets the timezone
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const db = require('./db');
const { SqliteStore } = require('./db/session-store');
const { startup } = require('./db/bootstrap');
const { runReminders } = require('./services/reminders');
const t = require('./utils/time');
const { MODES } = require('./services/appointments');
const { ENTRY_TYPES, SOURCES } = require('./services/records');
const { loadUser, homeFor, isBackground, isPageView, PORTAL_BASES, portalFor, portalOfPath } = require('./middleware/auth');
const { markLinkRead } = require('./services/notify');
const { unreadCounts } = require('./services/live');
const { securityHeaders, csrf } = require('./middleware/security');

const STATUS_LABELS = {
  booked: 'Booked',
  checked_in: 'Waiting',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

/** Opening hours for the page header and footer, e.g. "Mon–Fri: 08:00 – 16:00". */
const clinicHours = (() => {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = [...config.clinic.workDays].sort((a, b) => a - b);
  const consecutive = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText = consecutive && days.length > 2
    ? `${names[days[0]]}–${names[days[days.length - 1]]}`
    : days.map((d) => names[d]).join(', ');
  return `${dayText}: ${config.clinic.open} – ${config.clinic.close}`;
})();

/**
 * URL of a file in /public with a content hash appended (e.g. /static/css/style.css?v=3f9a1c2b), so browsers
 * fetch the new file as soon as it changes instead of using a cached copy. Hashes are kept in production only;
 * in development they are recomputed so edits show up on the next page load.
 */
const assetHashes = new Map();
function asset(file) {
  let hash = assetHashes.get(file);
  if (hash === undefined) {
    try {
      hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(config.root, 'public', file))).digest('hex').slice(0, 8);
    } catch {
      hash = '';
    }
    if (config.isProduction) assetHashes.set(file, hash);
  }
  return `/static/${file}${hash ? `?v=${hash}` : ''}`;
}

/**
 * Patients use the public site, doctors and nurses /staff, administrators /admin. A signed-in user who opens
 * a page in another portal is sent to the matching page in their own (or refused, for form posts).
 */
const SHARED_PATHS = /^\/(messages|notifications|account|live)(\/|$)/;
function portalGuard(req, res, next) {
  if (!req.user) return next();
  const own = portalFor(req.user.role);
  const here = res.locals.portal;
  if (own === here) return next();
  const denied = () => res.status(403).render('error', { title: 'Access denied', message: 'You do not have permission to view this page.' });

  if (here === 'public') {
    // Staff or administrators opening messages, notifications or their account on the public side.
    if (SHARED_PATHS.test(req.path)) {
      return req.method === 'GET' ? res.redirect(`${PORTAL_BASES[own]}${req.originalUrl}`) : denied();
    }
    // Other public pages (home, FAQs, sign-out); each route still checks roles.
    return next();
  }
  // Inside a portal that is not theirs: the same shared page in their own portal, otherwise their home page.
  if (req.method !== 'GET') return denied();
  const rest = req.originalUrl.slice(PORTAL_BASES[here].length);
  res.redirect(SHARED_PATHS.test(rest) ? `${PORTAL_BASES[own]}${rest}` : homeFor(req.user));
}

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY || config.serverless) app.set('trust proxy', 1);

  app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: '1h' }));
  app.use(securityHeaders);

  // Make sure the database is ready (tables, first admin, optional demo data).
  app.use(async (req, res, next) => {
    await startup();
    next();
  });

  // Called by Vercel Cron (see vercel.json). Vercel sends "Authorization: Bearer <CRON_SECRET>".
  app.get('/cron/reminders', async (req, res) => {
    if (!config.cronSecret || req.get('authorization') !== `Bearer ${config.cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const sent = await runReminders();
    await db.run('DELETE FROM sessions WHERE expires < ?', Date.now());
    res.json({ sent });
  });

  // Serverless has no always-running process, so reminders also run on normal
  // traffic (at most once a minute per instance) as well as from the daily cron.
  if (config.serverless) {
    let lastRun = 0;
    app.use(async (req, res, next) => {
      if (Date.now() - lastRun > config.reminderIntervalMs) {
        lastRun = Date.now();
        await runReminders().catch((err) => console.error('Reminder run failed:', err));
      }
      next();
    });
  }

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  const idleMs = config.sessionMinutes * 60 * 1000;
  const store = new SqliteStore();
  const sessionOptions = {
    name: 'uhs.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: idleMs },
  };
  // Idle timeout: the session expires after N minutes of inactivity, so every page renews it...
  const pageSession = session({ ...sessionOptions, store, rolling: true });
  // ...except the live-update requests a page makes in the background every few seconds, which would
  // otherwise keep an unattended screen signed in forever. They renew neither the cookie nor the stored expiry.
  const backgroundSession = session({
    ...sessionOptions,
    store: Object.create(store, { touch: { value: (sid, sess, cb) => cb?.() } }),
    rolling: false,
  });
  app.use((req, res, next) => (isBackground(req) ? backgroundSession : pageSession)(req, res, next));

  // Flash messages survive exactly one redirect. Background requests leave them for the page the user sees next.
  app.use((req, res, next) => {
    res.locals.flash = null;
    if (!isBackground(req)) {
      res.locals.flash = req.session.flash || null;
      delete req.session.flash;
    }
    req.flash = (type, message) => {
      req.session.flash = { type, message };
    };
    next();
  });

  // Values available in every template (set before anything can render a page).
  // portal: 'public' (patient-facing site), 'staff' (under /staff) or 'admin' (under /admin); base is its address.
  app.use((req, res, next) => {
    const portal = portalOfPath(req.path);
    Object.assign(res.locals, {
      portal,
      base: PORTAL_BASES[portal],
      t,
      MODES,
      STATUS_LABELS,
      ENTRY_TYPES,
      SOURCES,
      clinicName: config.clinic.name,
      clinicHours,
      asset,
      currentPath: req.path,
      currentUser: null,
      csrfToken: '',
      unreadNotifications: 0,
      unreadMessages: 0,
      lastNotificationId: 0,
    });
    next();
  });

  app.use(csrf);
  app.use(loadUser);

  // Unread counters for the navigation bar.
  app.use(async (req, res, next) => {
    if (req.user) {
      // Opening a page directly (not from the notification list) also reads the notifications that point to it.
      // Not when a list on an open page refreshes itself: the user may not be looking at it.
      if (isPageView(req)) await markLinkRead(req.user.id, req.originalUrl);
      const counts = await unreadCounts(req.user);
      res.locals.liveCounts = counts;
      res.locals.unreadNotifications = counts.notifications;
      res.locals.unreadMessages = counts.messages;
      res.locals.lastNotificationId = counts.lastNotificationId;
    }
    next();
  });

  // The admin pages used to live in the staff portal; keep old bookmarks and links working.
  app.get(/^\/staff\/admin(\/|$)/, (req, res) => res.redirect(req.originalUrl.slice('/staff'.length)));

  app.use(portalGuard);

  // Public site and patient area.
  app.use(require('./routes/pages'));
  app.use(require('./routes/auth'));
  app.use('/account', require('./routes/account'));
  app.use('/api', require('./routes/api'));
  app.use('/patient', require('./routes/patient'));
  app.use('/consult', require('./routes/consult'));
  app.use('/messages', require('./routes/messages'));
  app.use('/notifications', require('./routes/notifications'));
  app.use('/live', require('./routes/live'));

  // Staff portal (doctors, nurses / records office).
  app.use('/staff/doctor', require('./routes/doctor'));
  app.use('/staff/records', require('./routes/records'));
  app.use('/staff/patients', require('./routes/patients'));
  app.use('/staff/messages', require('./routes/messages'));
  app.use('/staff/notifications', require('./routes/notifications'));
  app.use('/staff/live', require('./routes/live'));
  app.use('/staff/account', require('./routes/account'));

  // Admin portal (administrators).
  app.use('/admin/notifications', require('./routes/notifications'));
  app.use('/admin/live', require('./routes/live'));
  app.use('/admin/account', require('./routes/account'));
  app.use('/admin', require('./routes/admin'));

  // Staff pages used to live at the top level; keep old bookmarks and notification links working.
  app.get(/^\/(doctor|records|patients)(\/|$)/, (req, res) => res.redirect(`/staff${req.originalUrl}`));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'The page you requested does not exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Request errors (e.g. a body that is too large) keep their status; anything else is a server error.
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    // The page's scripts ask for JSON and show the message themselves.
    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(status).json({
        error: status === 413 ? 'That photo is too large. Please choose a smaller one.' : 'Something went wrong. Please try again.',
      });
    }
    res.status(status).render('error', {
      title: 'Something went wrong',
      message: config.isProduction ? 'An unexpected error occurred. Please try again.' : err.message,
    });
  });

  return app;
}

module.exports = { createApp };
