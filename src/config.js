// Central configuration. Values come from environment variables (see .env.example).
// The timezone must be set before any Date is created so that all times are
// handled as Nigerian local time (WAT, UTC+1, no daylight saving).
process.env.TZ = process.env.TZ || 'Africa/Lagos';

const path = require('node:path');

const root = path.join(__dirname, '..');
const port = Number(process.env.PORT) || 3000;
const env = process.env.NODE_ENV || 'development';

const config = {
  root,
  port,
  env,
  isProduction: env === 'production',
  appUrl: process.env.APP_URL || `http://localhost:${port}`,
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  sessionMinutes: Number(process.env.SESSION_MINUTES) || 30,
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'uhs.db'),

  clinic: {
    name: 'University Health Service, University of Ibadan',
    open: process.env.CLINIC_OPEN || '08:00',
    close: process.env.CLINIC_CLOSE || '16:00',
    slotMinutes: Number(process.env.SLOT_MINUTES) || 20,
    // 0 = Sunday ... 6 = Saturday. Default: Monday to Friday.
    workDays: (process.env.CLINIC_DAYS || '1,2,3,4,5').split(',').map(Number),
    maxDaysAhead: Number(process.env.MAX_DAYS_AHEAD) || 30,
  },

  jitsiDomain: process.env.JITSI_DOMAIN || 'meet.jit.si',

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'UHS Telemedicine <no-reply@uhs.ui.edu.ng>',
  },

  reminderIntervalMs: Number(process.env.REMINDER_INTERVAL_MS) || 60 * 1000,
};

if (config.isProduction && config.sessionSecret === 'dev-only-secret-change-me') {
  throw new Error('SESSION_SECRET must be set in production.');
}

module.exports = config;
