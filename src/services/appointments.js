// Scheduling rules and the appointment life cycle:
//
//   booked ──► checked_in ──► in_progress ──► completed
//     │            │
//     ├────────────┴──► cancelled
//     └──► no_show
//
// Slots are generated from the clinic hours in config. The database also has a
// unique index on (doctor_id, scheduled_at) so a doctor can never be double-booked,
// even if two people submit at the same moment.
const crypto = require('node:crypto');
const config = require('../config');
const db = require('../db');
const t = require('../utils/time');
const { notifyUser, notifyPatient } = require('./notify');

const MODES = { video: 'Video call', audio: 'Audio call', in_person: 'In person' };
const ACTIVE = ['booked', 'checked_in', 'in_progress'];
const JOIN_EARLY_MINUTES = 15;

class BookingError extends Error {}

/** "Dr Ada Obi", without doubling a title already in the name ("Dr. Ada Obi"). */
function doctorTitle(name) {
  return /^dr\.?\s/i.test(name) ? name : `Dr ${name}`;
}

function isClinicDay(dateStr) {
  return t.isValidDate(dateStr) && config.clinic.workDays.includes(t.parse(dateStr).getDay());
}

/** All slot start times for a clinic day, e.g. ['08:00', '08:20', ...]. */
function slotTimes() {
  const out = [];
  const step = config.clinic.slotMinutes;
  const end = t.timeToMinutes(config.clinic.close);
  for (let m = t.timeToMinutes(config.clinic.open); m + step <= end; m += step) out.push(t.minutesToTime(m));
  return out;
}

async function activeDoctors() {
  return db.all("SELECT id, full_name, specialty FROM users WHERE role = 'doctor' AND is_active = 1 ORDER BY full_name");
}

/** Validate a date is bookable: a clinic day, not in the past, within the booking window. */
function dateProblem(dateStr) {
  if (!t.isValidDate(dateStr)) return 'Choose a valid date.';
  const today = t.toDate();
  if (dateStr < today) return 'That date is in the past.';
  if (dateStr > t.toDate(t.addDays(new Date(), config.clinic.maxDaysAhead))) {
    return `Appointments can be booked up to ${config.clinic.maxDaysAhead} days ahead.`;
  }
  if (!isClinicDay(dateStr)) return 'The clinic does not hold consultations on that day.';
  return null;
}

/**
 * Free slots on a date. If doctorId is null, a slot is free when at least one
 * active doctor is free. Returns [{ time, freeDoctors: [ids] }].
 */
async function availableSlots(dateStr, doctorId = null) {
  if (dateProblem(dateStr)) return [];
  const all = await activeDoctors();
  const doctors = doctorId ? all.filter((d) => d.id === doctorId) : all;
  if (!doctors.length) return [];

  const taken = new Set(
    (await db.all(
      "SELECT doctor_id, substr(scheduled_at, 12, 5) AS time FROM appointments WHERE scheduled_at LIKE ? AND status <> 'cancelled' AND doctor_id IS NOT NULL",
      `${dateStr} %`
    )).map((r) => `${r.doctor_id}|${r.time}`)
  );
  const nowStr = t.toDateTime();

  return slotTimes()
    .filter((time) => `${dateStr} ${time}` > nowStr)
    .map((time) => ({ time, freeDoctors: doctors.filter((d) => !taken.has(`${d.id}|${time}`)).map((d) => d.id) }))
    .filter((s) => s.freeDoctors.length > 0);
}

/** Choose the least-busy free doctor for a slot (spreads the load at peak times). */
async function pickDoctor(dateStr, freeDoctorIds) {
  const load = new Map(
    (await db.all(
      "SELECT doctor_id, COUNT(*) AS n FROM appointments WHERE scheduled_at LIKE ? AND status <> 'cancelled' GROUP BY doctor_id",
      `${dateStr} %`
    )).map((r) => [r.doctor_id, r.n])
  );
  return [...freeDoctorIds].sort((a, b) => (load.get(a) || 0) - (load.get(b) || 0) || a - b)[0];
}

/** Book an appointment. Throws BookingError with a user-friendly message on failure. */
async function book({ patientId, doctorId = null, mode, date, time, reason, bookedVia, createdBy }) {
  if (!MODES[mode]) throw new BookingError('Choose a consultation type.');
  if (!reason || reason.length < 3) throw new BookingError('Briefly describe the reason for the visit.');
  const problem = dateProblem(date);
  if (problem) throw new BookingError(problem);

  const slot = (await availableSlots(date, doctorId)).find((s) => s.time === time);
  if (!slot) throw new BookingError('That time is no longer available. Please choose another slot.');

  const scheduledAt = `${date} ${time}`;
  const clash = await db.get(
    `SELECT id FROM appointments WHERE patient_id = ? AND scheduled_at = ? AND status IN ('booked','checked_in','in_progress')`,
    patientId, scheduledAt
  );
  if (clash) throw new BookingError('This patient already has an appointment at that time.');

  const assigned = doctorId || await pickDoctor(date, slot.freeDoctors);
  let id;
  try {
    id = await db.insert('appointments', {
      patient_id: patientId,
      doctor_id: assigned,
      mode,
      scheduled_at: scheduledAt,
      reason,
      status: 'booked',
      booked_via: bookedVia,
      room_id: mode === 'in_person' ? null : crypto.randomBytes(12).toString('hex'),
      created_by: createdBy,
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new BookingError('That slot was just taken. Please choose another.');
    throw err;
  }

  const when = t.fmtDateTime(scheduledAt);
  const patient = await db.get('SELECT full_name FROM patients WHERE id = ?', patientId);
  await notifyPatient(patientId, 'Appointment booked', `Your ${MODES[mode].toLowerCase()} appointment is on ${when}.`, '/patient/appointments');
  await notifyUser(assigned, 'New appointment', `${patient.full_name} – ${MODES[mode]} on ${when}. Reason: ${reason}`, `/doctor?date=${date}`, { email: false });
  return id;
}

/** Register a walk-in: checked in immediately, waiting in the queue. */
async function walkIn({ patientId, doctorId = null, reason, createdBy }) {
  const ts = t.now();
  return db.insert('appointments', {
    patient_id: patientId,
    doctor_id: doctorId,
    mode: 'in_person',
    scheduled_at: ts, // includes seconds, so it never collides with a booked slot
    reason,
    status: 'checked_in',
    booked_via: 'walk_in',
    checked_in_at: ts,
    created_by: createdBy,
  });
}

async function getFull(id) {
  return db.get(
    `SELECT a.*, p.full_name AS patient_name, p.uhs_number, p.user_id AS patient_user_id, p.phone AS patient_phone,
            p.allergies, p.chronic_conditions, p.date_of_birth, p.gender,
            d.full_name AS doctor_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       LEFT JOIN users d ON d.id = a.doctor_id
      WHERE a.id = ?`,
    id
  );
}

/** Remote patients may enter the waiting room from 15 minutes before their slot until the end of that day. */
function canJoin(appt) {
  if (appt.mode === 'in_person' || !['booked', 'checked_in', 'in_progress'].includes(appt.status)) return false;
  const opens = t.toDateTime(t.addMinutes(t.parse(appt.scheduled_at), -JOIN_EARLY_MINUTES));
  const nowStr = t.toDateTime();
  return nowStr >= opens && t.toDate() === appt.scheduled_at.slice(0, 10);
}

async function checkIn(appt) {
  if (appt.status !== 'booked') return false;
  await db.update('appointments', appt.id, { status: 'checked_in', checked_in_at: t.now() });
  if (appt.doctor_id) {
    await notifyUser(appt.doctor_id, 'Patient waiting', `${appt.patient_name} has checked in.`, `/doctor`, { email: false });
  }
  return true;
}

async function start(appt, doctorId) {
  if (!['booked', 'checked_in'].includes(appt.status)) return false;
  await db.update('appointments', appt.id, { status: 'in_progress', started_at: t.now(), doctor_id: appt.doctor_id || doctorId });
  return true;
}

async function cancel(appt, reason) {
  if (!['booked', 'checked_in'].includes(appt.status)) return false;
  await db.update('appointments', appt.id, { status: 'cancelled', cancel_reason: reason || null });
  return true;
}

async function markNoShow(appt) {
  if (appt.status !== 'booked' || t.toDateTime() < appt.scheduled_at) return false;
  await db.update('appointments', appt.id, { status: 'no_show' });
  return true;
}

module.exports = {
  MODES, ACTIVE, BookingError, JOIN_EARLY_MINUTES, doctorTitle,
  isClinicDay, slotTimes, activeDoctors, dateProblem, availableSlots, pickDoctor,
  book, walkIn, getFull, canJoin, checkIn, start, cancel, markNoShow,
};
