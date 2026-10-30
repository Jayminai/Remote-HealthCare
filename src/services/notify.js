// In-app notifications and email.
// Every email is written to the email_outbox table. If SMTP settings are
// provided in .env it is also really sent; otherwise it is only logged
// (useful for demonstrations without an email account).
const nodemailer = require('nodemailer');
const config = require('../config');
const db = require('../db');
const { now } = require('../utils/time');

let transporter = null;
if (config.smtp.host) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

/**
 * Send an email (or only record it when SMTP is not configured). Returns the outbox row.
 * outboxBody: what to store in the outbox instead of the real body, for emails that contain
 * a secret link (password reset), so administrators reading the outbox cannot use it.
 */
async function sendEmail(to, subject, body, { outboxBody } = {}) {
  if (!to) return null;
  const id = await db.insert('email_outbox', { to_email: to, subject, body: outboxBody ?? body, status: 'logged' });
  if (!transporter) {
    if (!config.isProduction && process.env.NODE_TEST_CONTEXT == null) {
      // Development without SMTP: print the email so links can still be followed.
      console.log(`[email logged] to=${to} subject="${subject}"
${body}
`);
    }
    return db.get('SELECT * FROM email_outbox WHERE id = ?', id);
  }
  try {
    await transporter.sendMail({ from: config.smtp.from, to, subject, text: body });
    await db.update('email_outbox', id, { status: 'sent' });
  } catch (err) {
    await db.update('email_outbox', id, { status: 'failed', error: String(err.message).slice(0, 500) });
  }
  return db.get('SELECT * FROM email_outbox WHERE id = ?', id);
}

/** Notify a user in-app, and optionally by email. */
async function notifyUser(userId, title, body, link = null, { email = true } = {}) {
  await db.insert('notifications', { user_id: userId, title, body, link });
  if (email) {
    const user = await db.get('SELECT email FROM users WHERE id = ? AND is_active = 1', userId);
    if (user) await sendEmail(user.email, `UHS Telemedicine: ${title}`, `${body}\n\n${link ? config.appUrl + link : config.appUrl}`);
  }
}

/**
 * Notify a patient. Patients registered at the clinic may have no online
 * account; they still receive email if an address is on file.
 */
async function notifyPatient(patientId, title, body, link = null) {
  const p = await db.get('SELECT user_id, email FROM patients WHERE id = ?', patientId);
  if (!p) return;
  if (p.user_id) await notifyUser(p.user_id, title, body, link);
  else if (p.email) await sendEmail(p.email, `UHS Telemedicine: ${title}`, body);
}

/**
 * Mark the user's notifications that point at `url` (path and query) as read. Used when the user
 * reaches that page some other way than through the notification list, so the counter does not
 * keep showing something they have already seen. Links may end in "#anchor", which is never sent
 * to the server, so a link matches with or without one.
 */
async function markLinkRead(userId, url) {
  return db.run(
    'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND (link = ? OR substr(link, 1, ?) = ?)',
    now(), userId, url, url.length + 1, `${url}#`
  );
}

module.exports = { sendEmail, notifyUser, notifyPatient, markLinkRead };
