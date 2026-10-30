// Background job that sends appointment reminders and follow-up reminders.
// It runs every minute (on Vercel: on incoming requests and a daily cron);
// the reminders_sent table makes it safe to run
// repeatedly (each reminder is sent at most once).
const config = require('../config');
const db = require('../db');
const t = require('../utils/time');
const { notifyPatient } = require('./notify');
const { MODES } = require('./appointments');

/** Returns true the first time it is called for a given reminder. */
async function claim(refType, refId, kind) {
  const r = await db.run(
    'INSERT OR IGNORE INTO reminders_sent (ref_type, ref_id, kind, created_at) VALUES (?, ?, ?, ?)',
    refType, refId, kind, t.now()
  );
  return Number(r.changes) === 1;
}

async function runReminders(at = new Date()) {
  const nowStr = t.toDateTime(at);
  const in1h = t.toDateTime(t.addMinutes(at, 60));
  const in24h = t.toDateTime(t.addMinutes(at, 24 * 60));
  let sent = 0;

  const upcoming = await db.all(
    `SELECT a.id, a.patient_id, a.mode, a.scheduled_at, u.full_name AS doctor_name
       FROM appointments a LEFT JOIN users u ON u.id = a.doctor_id
      WHERE a.status = 'booked' AND a.scheduled_at > ? AND a.scheduled_at <= ?`,
    nowStr, in24h
  );
  for (const a of upcoming) {
    const kind = a.scheduled_at <= in1h ? '1h' : '24h';
    if (!(await claim('appointment', a.id, kind))) continue;
    const how = a.mode === 'in_person'
      ? 'Please come to the UHS clinic.'
      : 'Sign in a few minutes early and click "Join consultation".';
    await notifyPatient(
      a.patient_id,
      kind === '1h' ? 'Appointment within the hour' : 'Upcoming appointment',
      `Reminder: ${MODES[a.mode]} with ${a.doctor_name || 'a UHS doctor'} on ${t.fmtDateTime(a.scheduled_at)}. ${how}`,
      `/patient/appointments#appt-${a.id}`
    );
    sent++;
  }

  // Follow-up reminders go out on the morning of the follow-up date.
  if (at.getHours() >= 7) {
    const due = await db.all(
      `SELECT c.id, c.patient_id, c.follow_up_note, u.full_name AS doctor_name
         FROM consultations c JOIN users u ON u.id = c.doctor_id
        WHERE c.follow_up_date = ?`,
      t.toDate(at)
    );
    for (const c of due) {
      if (!(await claim('consultation', c.id, 'follow_up'))) continue;
      await notifyPatient(
        c.patient_id,
        'Follow-up due today',
        `${c.doctor_name} asked you to follow up today.${c.follow_up_note ? ` Note: ${c.follow_up_note}` : ''} Book a follow-up appointment or send a message.`,
        `/patient/records#consultation-${c.id}`
      );
      sent++;
    }
  }
  return sent;
}

function startReminderJob() {
  const tick = () => runReminders().catch((err) => console.error('Reminder job failed:', err));
  tick();
  return setInterval(tick, config.reminderIntervalMs).unref();
}

module.exports = { runReminders, startReminderJob };
