// Secure messaging between patients and doctors (replaces follow-up phone calls).
const express = require('express');
const db = require('../db');
const t = require('../utils/time');
const v = require('../utils/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { notifyUser } = require('../services/notify');
const { patientForUser } = require('../services/patients');

const router = express.Router();
router.use(requireAuth, requireRole('patient', 'doctor'));

/** Doctors a patient may message: those they have had an appointment with. */
async function doctorsForPatient(patientId) {
  return db.all(
    `SELECT DISTINCT u.id, u.full_name, u.specialty FROM appointments a JOIN users u ON u.id = a.doctor_id
      WHERE a.patient_id = ? AND u.is_active = 1 ORDER BY u.full_name`,
    patientId
  );
}

/** Check that the signed-in user belongs to the thread (patient, doctor). */
async function threadAccess(req, patientId, doctorId) {
  const doctor = await db.get("SELECT id, full_name, is_active FROM users WHERE id = ? AND role = 'doctor'", doctorId);
  const patient = await db.get('SELECT id, full_name, user_id, uhs_number FROM patients WHERE id = ?', patientId);
  if (!doctor || !patient) return null;
  if (req.user.role === 'doctor' && doctor.id !== req.user.id) return null;
  if (req.user.role === 'patient') {
    if (patient.user_id !== req.user.id) return null;
    // A patient can only open a thread with a doctor they have seen, or who has written to them.
    const known = (await doctorsForPatient(patient.id)).some((d) => d.id === doctor.id) ||
      await db.get('SELECT 1 FROM messages WHERE patient_id = ? AND doctor_id = ? LIMIT 1', patient.id, doctor.id);
    if (!known) return null;
  }
  return { doctor, patient };
}

router.get('/', async (req, res) => {
  let where, param;
  if (req.user.role === 'patient') {
    const p = await patientForUser(req.user.id);
    where = 'm.patient_id = ?';
    param = p ? p.id : -1;
  } else {
    where = 'm.doctor_id = ?';
    param = req.user.id;
  }
  const threads = await db.all(
    `SELECT m.patient_id, m.doctor_id, p.full_name AS patient_name, p.uhs_number, u.full_name AS doctor_name,
            MAX(m.created_at) AS last_at,
            SUM(CASE WHEN m.sender_id <> ? AND m.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
            (SELECT body FROM messages x WHERE x.patient_id = m.patient_id AND x.doctor_id = m.doctor_id
              ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS last_body
       FROM messages m JOIN patients p ON p.id = m.patient_id JOIN users u ON u.id = m.doctor_id
      WHERE ${where}
      GROUP BY m.patient_id, m.doctor_id ORDER BY last_at DESC`,
    req.user.id, param
  );
  const p = req.user.role === 'patient' ? await patientForUser(req.user.id) : null;
  res.render('messages/index', { title: 'Messages', threads, doctors: p ? await doctorsForPatient(p.id) : [], patient: p });
});

router.get('/:patientId/:doctorId', async (req, res) => {
  const access = await threadAccess(req, v.int(req.params.patientId), v.int(req.params.doctorId));
  if (!access) return res.status(404).render('error', { title: 'Not found', message: 'Conversation not found.' });
  const { patient, doctor } = access;
  await db.run(
    'UPDATE messages SET read_at = ? WHERE patient_id = ? AND doctor_id = ? AND sender_id <> ? AND read_at IS NULL',
    t.now(), patient.id, doctor.id, req.user.id
  );
  const messages = await db.all(
    'SELECT * FROM messages WHERE patient_id = ? AND doctor_id = ? ORDER BY created_at, id',
    patient.id, doctor.id
  );
  res.render('messages/thread', { title: 'Conversation', patient, doctor, messages });
});

router.post('/:patientId/:doctorId', async (req, res) => {
  const access = await threadAccess(req, v.int(req.params.patientId), v.int(req.params.doctorId));
  if (!access) return res.status(404).render('error', { title: 'Not found', message: 'Conversation not found.' });
  const { patient, doctor } = access;
  const body = v.str(req.body.body, 2000);
  const url = `/messages/${patient.id}/${doctor.id}`;
  if (!body) {
    req.flash('error', 'Type a message first.');
    return res.redirect(url);
  }
  if (req.user.role === 'doctor' && !patient.user_id) {
    req.flash('error', 'This patient has no online account. Please contact them by phone, or ask the records office to enable online access.');
    return res.redirect(url);
  }
  if (!doctor.is_active) {
    req.flash('error', 'This doctor is no longer available. Please message another doctor or call the clinic.');
    return res.redirect(url);
  }
  const id = await db.insert('messages', { patient_id: patient.id, doctor_id: doctor.id, sender_id: req.user.id, body });
  await audit(req, 'message_sent', 'message', id);
  const recipient = req.user.role === 'doctor' ? patient.user_id : doctor.id;
  // Email says only that a message exists; the content stays inside the secure system.
  await notifyUser(recipient, 'New secure message', `You have a new message from ${req.user.full_name}. Sign in to read it.`, url);
  res.redirect(`${url}#latest`);
});

module.exports = router;
