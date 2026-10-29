// Doctor's workspace: daily queue, consultations, prescriptions and follow-ups.
const express = require('express');
const config = require('../config');
const db = require('../db');
const t = require('../utils/time');
const v = require('../utils/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { audit } = require('../services/audit');
const appts = require('../services/appointments');
const { getRecord, latestVitals } = require('../services/records');
const { notifyPatient } = require('../services/notify');
const { searchPatients } = require('../services/patients');

const router = express.Router();
router.use(requireAuth, requireRole('doctor'));

const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'Appointment not found.' });

/** The doctor may act on their own appointments, or pick up an unassigned walk-in. */
function loadAppt(req) {
  const appt = appts.getFull(v.int(req.params.id));
  if (!appt) return null;
  if (appt.doctor_id === req.user.id) return appt;
  if (appt.doctor_id == null && appt.booked_via === 'walk_in') return appt;
  return null;
}

router.get('/', (req, res) => {
  const date = t.isValidDate(req.query.date) ? req.query.date : t.toDate();
  const list = db.all(
    `SELECT a.*, p.full_name AS patient_name, p.uhs_number, p.allergies
       FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.scheduled_at LIKE ?
        AND (a.doctor_id = ? OR (a.doctor_id IS NULL AND a.status = 'checked_in'))
      ORDER BY CASE a.status WHEN 'in_progress' THEN 0 WHEN 'checked_in' THEN 1 WHEN 'booked' THEN 2 ELSE 3 END,
               a.scheduled_at`,
    `${date} %`, req.user.id
  );
  const nowStr = t.toDateTime();
  list.forEach((a) => {
    a.waitingMinutes = a.status === 'checked_in' ? t.minutesBetween(a.checked_in_at, t.now()) : null;
    a.isLate = a.status === 'booked' && a.scheduled_at < nowStr;
  });
  const counts = {
    total: list.filter((a) => a.doctor_id === req.user.id && a.status !== 'cancelled').length,
    waiting: list.filter((a) => a.status === 'checked_in').length,
    remote: list.filter((a) => a.mode !== 'in_person' && a.status !== 'cancelled').length,
    completed: list.filter((a) => a.status === 'completed').length,
  };
  res.render('doctor/dashboard', {
    title: 'My consultations',
    list, counts, date,
    isToday: date === t.toDate(),
    prevDate: t.toDate(t.addDays(t.parse(date), -1)),
    nextDate: t.toDate(t.addDays(t.parse(date), 1)),
  });
});

router.post('/appointments/:id/start', (req, res) => {
  const appt = loadAppt(req);
  if (!appt) return notFound(res);
  if (appt.status === 'in_progress') return res.redirect(`/doctor/appointments/${appt.id}/consult`);
  if (appt.scheduled_at.slice(0, 10) !== t.toDate()) {
    req.flash('error', 'You can only start consultations scheduled for today.');
    return res.redirect('/doctor');
  }
  if (!appts.start(appt, req.user.id)) {
    req.flash('error', 'This consultation cannot be started.');
    return res.redirect('/doctor');
  }
  audit(req, 'consultation_started', 'appointment', appt.id);
  if (appt.mode !== 'in_person') {
    notifyPatient(appt.patient_id, 'Your doctor is ready', `${appts.doctorTitle(req.user.full_name)} has started your ${appts.MODES[appt.mode].toLowerCase()}. Join now.`, `/consult/${appt.id}`);
  }
  res.redirect(`/doctor/appointments/${appt.id}/consult`);
});

function renderConsult(req, res, appt, form, errors = [], status = 200) {
  const record = getRecord(appt.patient_id);
  audit(req, 'patient_record_viewed', 'patient', appt.patient_id, { via: 'consultation', appointment: appt.id });
  res.status(status).render('doctor/consult', {
    title: `Consultation – ${appt.patient_name}`,
    appt,
    record,
    vitals: latestVitals(appt.patient_id),
    form,
    errors,
    jitsiDomain: config.jitsiDomain,
    callName: appts.doctorTitle(req.user.full_name),
    minFollowUp: t.toDate(t.addDays(new Date(), 1)),
  });
}

const emptyConsult = {
  presenting_complaint: '', history: '', examination: '', diagnosis: '', plan: '',
  follow_up_date: '', follow_up_note: '', rx: [],
};

router.get('/appointments/:id/consult', (req, res) => {
  const appt = loadAppt(req);
  if (!appt) return notFound(res);
  if (appt.status !== 'in_progress') {
    req.flash('error', 'Start the consultation from your queue first.');
    return res.redirect('/doctor');
  }
  renderConsult(req, res, appt, { ...emptyConsult, presenting_complaint: appt.reason });
});

router.post('/appointments/:id/complete', (req, res) => {
  const appt = loadAppt(req);
  if (!appt || appt.doctor_id !== req.user.id) return notFound(res);
  if (appt.status !== 'in_progress') {
    req.flash('error', 'This consultation is not in progress.');
    return res.redirect('/doctor');
  }

  const form = {
    presenting_complaint: v.str(req.body.presenting_complaint, 1000),
    history: v.str(req.body.history, 3000),
    examination: v.str(req.body.examination, 3000),
    diagnosis: v.str(req.body.diagnosis, 500),
    plan: v.str(req.body.plan, 3000),
    follow_up_date: v.str(req.body.follow_up_date, 10),
    follow_up_note: v.str(req.body.follow_up_note, 1000),
    rx: [],
  };
  const names = v.arr(req.body.drug_name);
  const dosage = v.arr(req.body.dosage);
  const freq = v.arr(req.body.frequency);
  const dur = v.arr(req.body.duration);
  const instr = v.arr(req.body.instructions);
  for (let i = 0; i < names.length; i++) {
    const row = {
      drug_name: v.str(names[i], 120), dosage: v.str(dosage[i], 60), frequency: v.str(freq[i], 60),
      duration: v.str(dur[i], 60), instructions: v.str(instr[i], 300),
    };
    if (row.drug_name || row.dosage || row.frequency || row.duration) form.rx.push(row);
  }

  const errors = [];
  if (!form.presenting_complaint) errors.push('Enter the presenting complaint.');
  if (!form.diagnosis) errors.push('Enter a diagnosis or impression.');
  form.rx.forEach((r, i) => {
    if (!r.drug_name || !r.dosage || !r.frequency || !r.duration) {
      errors.push(`Prescription line ${i + 1}: drug, dosage, frequency and duration are all required.`);
    }
  });
  if (form.follow_up_date && (!t.isValidDate(form.follow_up_date) || form.follow_up_date <= t.toDate())) {
    errors.push('The follow-up date must be a valid date after today.');
  }
  if (errors.length) return renderConsult(req, res, appt, form, errors, 400);

  const consultationId = db.tx(() => {
    const cid = db.insert('consultations', {
      appointment_id: appt.id,
      patient_id: appt.patient_id,
      doctor_id: req.user.id,
      presenting_complaint: form.presenting_complaint,
      history: form.history || null,
      examination: form.examination || null,
      diagnosis: form.diagnosis,
      plan: form.plan || null,
      follow_up_date: form.follow_up_date || null,
      follow_up_note: form.follow_up_note || null,
    });
    for (const r of form.rx) {
      db.insert('prescriptions', {
        consultation_id: cid, patient_id: appt.patient_id, doctor_id: req.user.id,
        drug_name: r.drug_name, dosage: r.dosage, frequency: r.frequency, duration: r.duration,
        instructions: r.instructions || null,
      });
    }
    db.update('appointments', appt.id, { status: 'completed', ended_at: t.now() });

    // A follow-up note becomes a secure message the patient can reply to.
    if (form.follow_up_note && appt.patient_user_id) {
      db.insert('messages', {
        patient_id: appt.patient_id, doctor_id: req.user.id, sender_id: req.user.id,
        body: `Follow-up after your consultation on ${t.fmtDate(appt.scheduled_at)}:\n${form.follow_up_note}` +
          (form.follow_up_date ? `\nPlease follow up on ${t.fmtDate(form.follow_up_date)}.` : ''),
      });
    }
    return cid;
  });

  audit(req, 'consultation_completed', 'consultation', consultationId, { appointment: appt.id, prescriptions: form.rx.length });
  notifyPatient(
    appt.patient_id,
    'Consultation summary available',
    `Your consultation with ${appts.doctorTitle(req.user.full_name)} is complete.` +
      (form.rx.length ? ` ${form.rx.length} prescription item(s) issued.` : '') +
      (form.follow_up_date ? ` Follow-up: ${t.fmtDate(form.follow_up_date)}.` : ''),
    '/patient/records'
  );
  req.flash('success', `Consultation with ${appt.patient_name} saved.`);
  res.redirect('/doctor');
});

router.post('/appointments/:id/no-show', (req, res) => {
  const appt = loadAppt(req);
  if (!appt) return notFound(res);
  if (appts.markNoShow(appt)) {
    audit(req, 'appointment_no_show', 'appointment', appt.id);
    notifyPatient(appt.patient_id, 'Missed appointment', `You missed your appointment on ${t.fmtDateTime(appt.scheduled_at)}. Please book again if you still need care.`, '/patient/book');
    req.flash('success', 'Marked as no-show.');
  } else {
    req.flash('error', 'Only booked appointments whose time has passed can be marked as no-show.');
  }
  res.redirect('/doctor');
});

router.get('/patients', (req, res) => {
  const q = v.str(req.query.q, 80);
  const results = q ? searchPatients(q) : [];
  res.render('shared/patient_search', { title: 'Find a patient', q, results });
});

module.exports = router;
