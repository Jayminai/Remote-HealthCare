const config = require('./config'); // must be first: sets the timezone
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const db = require('./db');
const { SqliteStore } = require('./db/session-store');
const t = require('./utils/time');
const { MODES } = require('./services/appointments');
const { ENTRY_TYPES, SOURCES } = require('./services/records');
const { loadUser } = require('./middleware/auth');
const { securityHeaders, csrf } = require('./middleware/security');

const STATUS_LABELS = {
  booked: 'Booked',
  checked_in: 'Waiting',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: '1h' }));
  app.use(securityHeaders);
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(
    session({
      store: new SqliteStore(),
      name: 'uhs.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true, // idle timeout: the session expires after N minutes of inactivity
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        maxAge: config.sessionMinutes * 60 * 1000,
      },
    })
  );

  // Flash messages survive exactly one redirect.
  app.use((req, res, next) => {
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    req.flash = (type, message) => {
      req.session.flash = { type, message };
    };
    next();
  });

  // Values available in every template (set before anything can render a page).
  app.use((req, res, next) => {
    Object.assign(res.locals, {
      t,
      MODES,
      STATUS_LABELS,
      ENTRY_TYPES,
      SOURCES,
      clinicName: config.clinic.name,
      currentPath: req.path,
      currentUser: null,
      csrfToken: '',
      unreadNotifications: 0,
      unreadMessages: 0,
    });
    next();
  });

  app.use(csrf);
  app.use(loadUser);

  // Unread counters for the navigation bar.
  app.use((req, res, next) => {
    if (req.user) {
      res.locals.unreadNotifications = db.get(
        'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id
      ).n;
      if (req.user.role === 'patient' || req.user.role === 'doctor') {
        const where = req.user.role === 'patient'
          ? 'patient_id = (SELECT id FROM patients WHERE user_id = ?)'
          : 'doctor_id = ?';
        res.locals.unreadMessages = db.get(
          `SELECT COUNT(*) AS n FROM messages WHERE ${where} AND sender_id <> ? AND read_at IS NULL`,
          req.user.id, req.user.id
        ).n;
      }
    }
    next();
  });

  app.use(require('./routes/auth'));
  app.use('/account', require('./routes/account'));
  app.use('/api', require('./routes/api'));
  app.use('/patient', require('./routes/patient'));
  app.use('/doctor', require('./routes/doctor'));
  app.use('/records', require('./routes/records'));
  app.use('/patients', require('./routes/patients'));
  app.use('/consult', require('./routes/consult'));
  app.use('/messages', require('./routes/messages'));
  app.use('/notifications', require('./routes/notifications'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'The page you requested does not exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', {
      title: 'Something went wrong',
      message: config.isProduction ? 'An unexpected error occurred. Please try again.' : err.message,
    });
  });

  return app;
}

module.exports = { createApp };
