// Shared patient record view for clinical staff.
//   Doctors: full record including consultation notes and prescriptions.
//   Nurses/records officers: demographics, vitals, history, appointments
//   (no consultation notes - "need to know" principle).
// Every view is written to the audit log.
const express = require('express');
const db = require('../db');
const v = require('../utils/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { getRecord } = require('../services/records');
const appts = require('../services/appointments');

const router = express.Router();
router.use(requireAuth, requireRole('doctor', 'nurse'));

router.get('/:id', (req, res) => {
  const record = getRecord(v.int(req.params.id));
  if (!record) return res.status(404).render('error', { title: 'Not found', message: 'Patient not found.' });
  audit(req, 'patient_record_viewed', 'patient', record.patient.id);

  const showClinical = req.user.role === 'doctor';
  if (!showClinical) record.consultations = [];
  const account = record.patient.user_id
    ? db.get('SELECT email, last_login_at FROM users WHERE id = ?', record.patient.user_id)
    : null;

  res.render('patients/show', {
    title: record.patient.full_name,
    record,
    account,
    showClinical,
    appointmentId: v.int(req.query.appointment),
    doctors: appts.activeDoctors(),
  });
});

module.exports = router;
