// Assembles a patient's complete electronic medical record in one place, so
// information is "easy to retrieve" (a key request from UHS).
const db = require('../db');

/** Kinds of history captured when digitising paper files. */
const ENTRY_TYPES = {
  past_visit: 'Past clinic visit', diagnosis: 'Diagnosis', medication: 'Medication',
  lab_result: 'Lab result', immunisation: 'Immunisation', surgery: 'Surgery / procedure', note: 'Note',
};
const SOURCES = { paper_file: 'Old paper file', patient_report: 'Reported by patient', external: 'External hospital' };

function getRecord(patientId) {
  const patient = db.get('SELECT * FROM patients WHERE id = ?', patientId);
  if (!patient) return null;

  const consultations = db.all(
    `SELECT c.*, u.full_name AS doctor_name, a.mode, a.scheduled_at
       FROM consultations c
       JOIN users u ON u.id = c.doctor_id
       LEFT JOIN appointments a ON a.id = c.appointment_id
      WHERE c.patient_id = ? ORDER BY c.created_at DESC`,
    patientId
  );
  const rx = db.all('SELECT * FROM prescriptions WHERE patient_id = ? ORDER BY id', patientId);
  for (const c of consultations) c.prescriptions = rx.filter((p) => p.consultation_id === c.id);

  return {
    patient,
    consultations,
    vitals: db.all(
      `SELECT v.*, u.full_name AS recorded_by_name FROM vitals v LEFT JOIN users u ON u.id = v.recorded_by
        WHERE v.patient_id = ? ORDER BY v.created_at DESC`,
      patientId
    ),
    history: db.all(
      `SELECT r.*, u.full_name AS recorded_by_name FROM record_entries r LEFT JOIN users u ON u.id = r.recorded_by
        WHERE r.patient_id = ? ORDER BY r.entry_date DESC, r.id DESC`,
      patientId
    ),
    appointments: db.all(
      `SELECT a.*, u.full_name AS doctor_name FROM appointments a LEFT JOIN users u ON u.id = a.doctor_id
        WHERE a.patient_id = ? ORDER BY a.scheduled_at DESC`,
      patientId
    ),
  };
}

function latestVitals(patientId) {
  return db.get('SELECT * FROM vitals WHERE patient_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', patientId);
}

module.exports = { ENTRY_TYPES, SOURCES, getRecord, latestVitals };
