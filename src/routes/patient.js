// Pages for signed-in patients (students, staff, dependants).
const express = require('express');
const config = require('../config');
const db = require('../db');
const t = require('../utils/time');
const v = require('../utils/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { audit } = require('../services/audit');
const appts = require('../services/appointments');
const { patientForUser } = require('../services/patients');
const { getRecord } = require('../services/records');
const { notifyUser } = require('../services/notify');

const router = express.Router();
router.use(requireAuth, requireRole('patient'));

// Attach the patient's record to every request.
router.use(async (req, res, next) => {
  req.patient = await patientForUser(req.user.id);
  if (!req.patient) {
    return res.status(404).render('error', { title: 'No record', message: 'No patient record is linked to this account. Please contact the UHS records office.' });
  }
  res.locals.patient = req.patient;
  next();
});

const APPT_SQL = `SELECT a.*, u.full_name AS doctor_name, u.specialty
                    FROM appointments a LEFT JOIN users u ON u.id = a.doctor_id
                   WHERE a.patient_id = ?`;

router.get('/', async (req, res) => {
  const upcoming = await db.all(
    `${APPT_SQL} AND a.status IN ('booked','checked_in','in_progress') AND a.scheduled_at >= ? ORDER BY a.scheduled_at`,
    req.patient.id, t.toDate()
  );
  upcoming.forEach((a) => { a.canJoin = appts.canJoin(a); });
  const recent = await db.all(
    `SELECT c.id, c.created_at, c.diagnosis, c.follow_up_date, u.full_name AS doctor_name
       FROM consultations c JOIN users u ON u.id = c.doctor_id
      WHERE c.patient_id = ? ORDER BY c.created_at DESC LIMIT 3`,
    req.patient.id
  );
  res.render('patient/dashboard', { title: 'My health', upcoming, recent });
});

router.get('/book', async (req, res) => {
  res.render('patient/book', {
    title: 'Book a consultation',
    doctors: await appts.activeDoctors(),
    form: { mode: 'video', doctor_id: '', date: '', time: '', reason: '' },
    errors: [],
    minDate: t.toDate(),
    maxDate: t.toDate(t.addDays(new Date(), config.clinic.maxDaysAhead)),
  });
});

router.post('/book', async (req, res) => {
  const form = {
    mode: v.str(req.body.mode),
    doctor_id: v.int(req.body.doctor_id),
    date: v.str(req.body.date, 10),
    time: v.str(req.body.time, 5),
    reason: v.str(req.body.reason, 500),
  };
  try {
    const id = await appts.book({
      patientId: req.patient.id,
      doctorId: form.doctor_id,
      mode: form.mode,
      date: form.date,
      time: form.time,
      reason: form.reason,
      bookedVia: 'online',
      createdBy: req.user.id,
    });
    await audit(req, 'appointment_booked', 'appointment', id);
    req.flash('success', `Appointment booked for ${t.fmtDateTime(`${form.date} ${form.time}`)}. You will receive reminders before it starts.`);
    res.redirect('/patient/appointments');
  } catch (err) {
    if (!(err instanceof appts.BookingError)) throw err;
    res.status(400).render('patient/book', {
      title: 'Book a consultation',
      doctors: await appts.activeDoctors(),
      form,
      errors: [err.message],
      minDate: t.toDate(),
      maxDate: t.toDate(t.addDays(new Date(), config.clinic.maxDaysAhead)),
    });
  }
});

router.get('/appointments', async (req, res) => {
  const list = await db.all(`${APPT_SQL} ORDER BY a.scheduled_at DESC`, req.patient.id);
  list.forEach((a) => { a.canJoin = appts.canJoin(a); });
  res.render('patient/appointments', { title: 'My appointments', list });
});

router.post('/appointments/:id/cancel', async (req, res) => {
  const appt = await appts.getFull(v.int(req.params.id));
  if (!appt || appt.patient_id !== req.patient.id) return res.status(404).render('error', { title: 'Not found', message: 'Appointment not found.' });
  if (await appts.cancel(appt, v.str(req.body.reason, 200) || 'Cancelled by patient')) {
    await audit(req, 'appointment_cancelled', 'appointment', appt.id);
    if (appt.doctor_id) {
      await notifyUser(appt.doctor_id, 'Appointment cancelled', `${appt.patient_name} cancelled the appointment on ${t.fmtDateTime(appt.scheduled_at)}.`, appts.queueLink(appt), { email: false });
    }
    req.flash('success', 'Appointment cancelled. The slot is now free for someone else.');
  } else {
    req.flash('error', 'This appointment can no longer be cancelled.');
  }
  res.redirect('/patient/appointments');
});

router.get('/records', async (req, res) => {
  res.render('patient/records', { title: 'My medical record', record: await getRecord(req.patient.id) });
});

router.get('/prescriptions/:consultationId', async (req, res) => {
  const c = await db.get(
    `SELECT c.*, u.full_name AS doctor_name FROM consultations c JOIN users u ON u.id = c.doctor_id
      WHERE c.id = ? AND c.patient_id = ?`,
    v.int(req.params.consultationId), req.patient.id
  );
  if (!c) return res.status(404).render('error', { title: 'Not found', message: 'Prescription not found.' });
  const items = await db.all('SELECT * FROM prescriptions WHERE consultation_id = ? ORDER BY id', c.id);
  res.render('shared/prescription', { title: 'Prescription', c, items, patient: req.patient });
});

module.exports = router;
