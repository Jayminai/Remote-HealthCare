// Data behind the live updates in the browser (public/js/live.js): unread counters and new
// notifications. Pages poll for it every few seconds instead of keeping a connection open,
// because serverless hosting (Vercel) cannot hold WebSocket connections.
const db = require('../db');
const t = require('../utils/time');

/** Unread notifications and messages for the navigation bar, and the newest notification id. */
async function unreadCounts(user) {
  const n = await db.get(
    `SELECT SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread, MAX(id) AS last_id
       FROM notifications WHERE user_id = ?`,
    user.id
  );
  let messages = 0;
  if (user.role === 'patient' || user.role === 'doctor') {
    const where = user.role === 'patient' ? 'patient_id = (SELECT id FROM patients WHERE user_id = ?)' : 'doctor_id = ?';
    messages = (await db.get(
      `SELECT COUNT(*) AS n FROM messages WHERE ${where} AND sender_id <> ? AND read_at IS NULL`,
      user.id, user.id
    )).n;
  }
  return { notifications: n.unread || 0, messages, lastNotificationId: n.last_id || 0 };
}

/**
 * Counters plus the notifications created after `since` (newest first), shaped for the browser.
 * base is '' on the patient site, '/staff' in the staff portal and '/admin' in the admin portal. counts: from unreadCounts(), if already known.
 */
async function summary(user, since, base, counts = null) {
  counts ??= await unreadCounts(user);
  const fresh = since >= 0 && counts.lastNotificationId > since
    ? await db.all(
      'SELECT id, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? AND id > ? ORDER BY id DESC LIMIT 5',
      user.id, since
    )
    : [];
  return {
    unreadNotifications: counts.notifications,
    unreadMessages: counts.messages,
    lastNotificationId: counts.lastNotificationId,
    notifications: fresh.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      when: t.fmtDateTime(n.created_at),
      read: Boolean(n.read_at),
      url: n.link ? `${base}/notifications/${n.id}/open` : `${base}/notifications`,
    })),
  };
}

module.exports = { unreadCounts, summary };
