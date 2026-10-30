// Records office / nursing station: patient registration, digitising paper
// files, walk-ins, phone bookings, check-in and vital signs.
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const t = require('../utils/time');
const v = require('../utils/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { audit } = require('../services/audit');
const appts = require('../services/appointments');
const patients = require('../services/patients');
const { notifyPatient } = require('../services/notify');
const { ENTRY_TYPES, SOURCES } = require('../services/records');

const router = express.Router();
router.use(requireAuth, requireRole('nurse'));

async function loadPatient(req, res) {
  const p = await db.get('SELECT * FROM patients WHERE id = ?', v.int(req.params.id));
  if (!p) res.status(404).render('error', { title: 'Not found', message: 'Patient not found.' });
  return p;
}

async function loadAppt(req, res) {
  const a = await appts.getFull(v.int(req.params.id));
  if (!a) res.status(404).render('error', { title: 'Not found', message: 'Appointment not found.' });
  return a;
}

// ---- Overview -------------------------------------------------------------

router.get('/', async (req, res) => {
  const today = t.toDate();
  const list = await db.all(
    `SELECT a.*, p.full_name AS patient_name, p.uhs_number, u.full_name AS doctor_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN users u ON u.id = a.doctor_id
      WHERE a.scheduled_at LIKE ? ORDER BY a.scheduled_at`,
    `${today} %`
  );
  const nowStr = t.toDateTime();
  list.forEach((a) => {
    a.waitingMinutes = a.status === 'checked_in' ? t.minutesBetween(a.checked_in_at, t.now()) : null;
    a.isLate = a.status === 'booked' && a.scheduled_at < nowStr;
  });
  const totals = await db.get(
    'SELECT COUNT(*) AS total, SUM(digitised_at IS NOT NULL) AS digitised, SUM(user_id IS NOT NULL) AS online FROM patients'
  );
  res.render('records/dashboard', { title: 'Records office', list, totals, doctors: await appts.activeDoctors() });
});

// ---- Patient search & registration ---------------------------------------

router.get('/patients', async (req, res) => {
  const q = v.str(req.query.q, 80);
  res.render('shared/patient_search', { title: 'Patients', q, results: q ? await patients.searchPatients(q) : [] });
});

const formOptions = () => ({
  CATEGORIES: patients.CATEGORIES, GENDERS: patients.GENDERS,
  BLOOD_GROUPS: patients.BLOOD_GROUPS, GENOTYPES: patients.GENOTYPES,
});

router.get('/patients/new', async (req, res) => {
  res.render('records/patient_form', {
    title: 'Register patient', mode: 'new', form: { category: 'student' }, errors: [], duplicates: [], ...formOptions(),
  });
});

router.post('/patients/new', async (req, res) => {
  const { data, errors } = patients.readPatientForm(req.body);
  let duplicates = [];
  if (!errors.length) {
    duplicates = await patients.findPossibleDuplicates(data);
    const sameId = duplicates.some((d) => d.reasons.includes('Same matric/staff number'));
    if (sameId) {
      errors.push('A patient with this matric/staff number already exists. Open the existing record instead of creating a new one.');
    } else if (duplicates.length && !req.body.confirm_not_duplicate) {
      errors.push('Possible duplicate records found (below). Check them first. If this really is a different person, tick the confirmation box and save again.');
    }
  }
  if (errors.length) {
    return res.status(400).render('records/patient_form', {
      title: 'Register patient', mode: 'new', form: data, errors, duplicates, ...formOptions(),
    });
  }
  const id = await patients.createPatient(data, req.user.id);
  await audit(req, 'patient_registered', 'patient', id, duplicates.length ? { overrodeDuplicateWarning: duplicates.map((d) => d.patient.id) } : null);
  req.flash('success', 'Patient registered.');
  res.redirect(`/staff/patients/${id}`);
});

router.get('/patients/:id/edit', async (req, res) => {
  const p = await loadPatient(req, res);
  if (!p) return;
  res.render('records/patient_form', { title: 'Edit patient', mode: 'edit', form: p, errors: [], duplicates: [], ...formOptions() });
});

router.post('/patients/:id/edit', async (req, res) => {
  const p = await loadPatient(req, res);
  if (!p) return;
  const { data, errors } = patients.readPatientForm(req.body);
  if (!errors.length && data.id_number) {
    const other = await db.get('SELECT id FROM patients WHERE id_number = ? AND id <> ?', data.id_number, p.id);
    if (other) errors.push('Another patient already has this matric/staff number.');
  }
  if (errors.length) {
    return res.status(400).render('records/patient_form', {
      title: 'Edit patient', mode: 'edit', form: { ...p, ...data }, errors, duplicates: [], ...formOptions(),
    });
  }
  await db.update('patients', p.id, { ...data, updated_at: t.now() });
  if (p.user_id) await db.update('users', p.user_id, { full_name: data.full_name });
  await audit(req, 'patient_updated', 'patient', p.id);
  req.flash('success', 'Patient details updated.');
  res.redirect(`/staff/patients/${p.id}`);
});

// ---- Digitising paper records ---------------------------------------------

router.post('/patients/:id/history', async (req, res) => {
  const p = await loadPatient(req, res);
  if (!p) return;
  const entry = {
    entry_date: v.str(req.body.entry_date, 10),
    entry_type: v.str(req.body.entry_type),
    summary: v.str(req.body.summary, 2000),
    source: v.str(req.body.source),
  };
  if (!t.isValidDate(entry.entry_date) || entry.entry_date > t.toDate() || !ENTRY_TYPES[entry.entry_type] || !SOURCES[entry.source] || entry.summary.length < 3) {
    req.flash('error', 'History entry not saved: enter a valid past date, type, source and summary.');
    return res.redirect(`/staff/patients/${p.id}#history`);
  }
  const id = await db.insert('record_entries', { ...entry, patient_id: p.id, recorded_by: req.user.id });
  await audit(req, 'history_entry_added', 'record_entry', id, { patient: p.id });
  req.flash('success', 'History entry added.');
  res.redirect(`/staff/patients/${p.id}#history`);
});

router.post('/patients/:id/digitised', async (req, res) => {
  const p = await loadPatient(req, res);
  if (!p) return;
  await db.update('patients', p.id, { digitised_at: req.body.undo ? null : t.now() });
  await audit(req, req.body.undo ? 'paper_file_digitised_undone' : 'paper_file_digitised', 'patient', p.id);
  req.flash('success', req.body.undo ? 'Marked as not fully digitised.' : 'Paper file marked as fully digitised.');
  res.redirect(`/staff/patients/${p.id}`);
});

// ---- Vital signs ------------------------------------------------------------

router.post('/patients/:id/vitals', async (req, res) => {
  const p = await loadPatient(req, res);
  if (!p) return;
  const vit = {
    systolic: v.int(req.body.systolic), diastolic: v.int(req.body.diastolic),
    temperature: v.num(req.body.temperature), pulse: v.int(req.body.pulse),
    respiratory_rate: v.int(req.body.respiratory_rate), weight_kg: v.num(req.body.weight_kg),
    height_cm: v.num(req.body.height_cm), notes: v.opt(req.body.notes, 500),
  };
  const ranges = {
    systolic: [50, 260], diastolic: [30, 160], temperature: [30, 45], pulse: [20, 250],
    respiratory_rate: [5, 80], weight_kg: [1, 350], height_cm: [30, 250],
  };
  const bad = Object.entries(ranges).filter(([k, [lo, hi]]) => vit[k] != null && (vit[k] < lo || vit[k] > hi)).map(([k]) => k);
  const anyValue = Object.keys(ranges).some((k) => vit[k] != null);
  const back = v.localPath(req.body.return_to, `/staff/patients/${p.id}`);
  if (!anyValue || bad.length) {
    req.flash('error', bad.length ? `Check these values: ${bad.join(', ').replace(/_/g, ' ')}.` : 'Enter at least one measurement.');
    return res.redirect(back);
  }
  const apptId = v.int(req.body.appointment_id);
  const validAppt = apptId && await db.get('SELECT id FROM appointments WHERE id = ? AND patient_id = ?', apptId, p.id);
  const id = await db.insert('vitals', { ...vit, patient_id: p.id, appointment_id: validAppt ? apptId : null, recorded_by: req.user.id });
  await audit(req, 'vitals_recorded', 'vitals', id, { patient: p.id });
  req.flash('success', `Vital signs recorded for ${p.full_name}.`);
  res.redirect(back);
});

// ---- Online access for existing records ------------------------------------

router.post('/patients/:id/online-access', async (req, res) => {
  const p = await loadPatient(req, res);
  if (!p) return;
  if (p.user_id) {
    req.flash('error', 'This patient already has online access.');
    return res.redirect(`/staff/patients/${p.id}`);
  }
  const email = v.str(req.body.email, 120).toLowerCase();
  if (!v.isEmail(email)) {
    req.flash('error', 'Enter a valid email address.');
    return res.redirect(`/staff/patients/${p.id}`);
  }
  if (await db.get('SELECT id FROM users WHERE email = ?', email)) {
    req.flash('error', 'That email is already used by another account.');
    return res.redirect(`/staff/patients/${p.id}`);
  }
  const tempPassword = `Uhs${crypto.randomInt(100000, 999999)}${crypto.randomBytes(2).toString('hex')}`;
  await db.tx(async () => {
    const userId = await db.insert('users', {
      role: 'patient', full_name: p.full_name, email, phone: p.phone,
      password_hash: bcrypt.hashSync(tempPassword, 10), must_change_password: 1,
    });
    await db.update('patients', p.id, { user_id: userId, email, updated_at: t.now() });
  });
  await audit(req, 'patient_online_access_enabled', 'patient', p.id);
  res.render('records/access_created', { title: 'Online access enabled', patient: p, email, tempPassword, signInUrl: `${config.appUrl}/login` });
});

// ---- Appointments: phone bookings, walk-ins, check-in -----------------------

const bookView = async (patient, form, errors = []) => ({
  title: 'Book on behalf of patient',
  patient,
  doctors: await appts.activeDoctors(),
  form,
  errors,
  minDate: t.toDate(),
  maxDate: t.toDate(t.addDays(new Date(), config.clinic.maxDaysAhead)),
});

router.get('/patients/:id/book', async (req, res) => {
  const p = await loadPatient(req, res);
  if (!p) return;
  res.render('records/book', await bookView(p, { mode: 'in_person', doctor_id: '', date: '', time: '', reason: '' }));
});

router.post('/patients/:id/book', async (req, res) => {
  const p = await loadPatient(req, res);
  if (!p) return;
  const form = {
    mode: v.str(req.body.mode), doctor_id: v.int(req.body.doctor_id), date: v.str(req.body.date, 10),
    time: v.str(req.body.time, 5), reason: v.str(req.body.reason, 500),
  };
  if (form.mode !== 'in_person' && !p.user_id) {
    return res.status(400).render('records/book', await bookView(p, form, [
      'Remote consultations need an online account. Enable online access for this patient first, or book in person.',
    ]));
  }
  try {
    const id = await appts.book({
      patientId: p.id, doctorId: form.doctor_id, mode: form.mode, date: form.date, time: form.time,
      reason: form.reason, bookedVia: 'phone', createdBy: req.user.id,
    });
    await audit(req, 'appointment_booked', 'appointment', id, { onBehalfOf: p.id });
    req.flash('success', `Appointment booked for ${p.full_name} on ${t.fmtDateTime(`${form.date} ${form.time}`)}.`);
    res.redirect(`/staff/patients/${p.id}`);
  } catch (err) {
    if (!(err instanceof appts.BookingError)) throw err;
    res.status(400).render('records/book', await bookView(p, form, [err.message]));
  }
});

router.post('/patients/:id/walk-in', async (req, res) => {
  const p = await loadPatient(req, res);
  if (!p) return;
  const reason = v.str(req.body.reason, 500);
  const doctorId = v.int(req.body.doctor_id);
  if (reason.length < 3) {
    req.flash('error', 'Enter the reason for the walk-in visit.');
    return res.redirect(`/staff/patients/${p.id}`);
  }
  if (doctorId && !(await appts.activeDoctors()).some((d) => d.id === doctorId)) {
    req.flash('error', 'Choose a valid doctor.');
    return res.redirect(`/staff/patients/${p.id}`);
  }
  const active = await db.get(
    "SELECT id FROM appointments WHERE patient_id = ? AND status IN ('checked_in','in_progress') AND scheduled_at LIKE ?",
    p.id, `${t.toDate()} %`
  );
  if (active) {
    req.flash('error', 'This patient is already waiting or being seen today.');
    return res.redirect('/staff/records');
  }
  const id = await appts.walkIn({ patientId: p.id, doctorId, reason, createdBy: req.user.id });
  await audit(req, 'walk_in_registered', 'appointment', id);
  req.flash('success', `${p.full_name} added to today's queue. Record their vital signs below.`);
  res.redirect('/staff/records');
});

router.post('/appointments/:id/check-in', async (req, res) => {
  const a = await loadAppt(req, res);
  if (!a) return;
  if (a.scheduled_at.slice(0, 10) !== t.toDate() || !await appts.checkIn(a)) {
    req.flash('error', 'Only booked appointments for today can be checked in.');
  } else {
    await audit(req, 'appointment_checked_in', 'appointment', a.id);
    req.flash('success', `${a.patient_name} checked in.`);
  }
  res.redirect('/staff/records');
});

router.post('/appointments/:id/no-show', async (req, res) => {
  const a = await loadAppt(req, res);
  if (!a) return;
  if (await appts.markNoShow(a)) {
    await audit(req, 'appointment_no_show', 'appointment', a.id);
    await notifyPatient(a.patient_id, 'Missed appointment', `You missed your appointment on ${t.fmtDateTime(a.scheduled_at)}. Please book again if you still need care.`, `/patient/appointments#appt-${a.id}`);
    req.flash('success', 'Marked as no-show.');
  } else {
    req.flash('error', 'Only booked appointments whose time has passed can be marked as no-show.');
  }
  res.redirect('/staff/records');
});

router.post('/appointments/:id/cancel', async (req, res) => {
  const a = await loadAppt(req, res);
  if (!a) return;
  if (await appts.cancel(a, v.str(req.body.reason, 200) || 'Cancelled by records office')) {
    await audit(req, 'appointment_cancelled', 'appointment', a.id);
    await notifyPatient(a.patient_id, 'Appointment cancelled', `Your appointment on ${t.fmtDateTime(a.scheduled_at)} was cancelled by the UHS records office. Please book a new time or call the clinic.`, `/patient/appointments#appt-${a.id}`);
    req.flash('success', 'Appointment cancelled.');
  } else {
    req.flash('error', 'This appointment can no longer be cancelled.');
  }
  res.redirect(v.localPath(req.body.return_to, '/staff/records'));
});

module.exports = router;
