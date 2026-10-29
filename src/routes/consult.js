// The patient's side of a remote (video/audio) consultation.
// The doctor's side is /doctor/appointments/:id/consult, which embeds the same room.
const express = require('express');
const config = require('../config');
const t = require('../utils/time');
const v = require('../utils/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { audit } = require('../services/audit');
const appts = require('../services/appointments');
const { patientForUser } = require('../services/patients');

const router = express.Router();
router.use(requireAuth, requireRole('patient'));

router.get('/:id', (req, res) => {
  const patient = patientForUser(req.user.id);
  const appt = appts.getFull(v.int(req.params.id));
  if (!appt || !patient || appt.patient_id !== patient.id || appt.mode === 'in_person') {
    return res.status(404).render('error', { title: 'Not found', message: 'Consultation not found.' });
  }
  if (!appts.canJoin(appt)) {
    const opens = t.toDateTime(t.addMinutes(t.parse(appt.scheduled_at), -appts.JOIN_EARLY_MINUTES));
    req.flash('error', appt.status === 'completed' || appt.status === 'cancelled' || appt.status === 'no_show'
      ? 'This consultation has ended.'
      : `The consultation room opens at ${opens.slice(11)} on ${t.fmtDate(appt.scheduled_at)}.`);
    return res.redirect('/patient/appointments');
  }
  if (appts.checkIn(appt)) audit(req, 'patient_joined_waiting_room', 'appointment', appt.id);

  res.render('consult/room', {
    title: 'Consultation room',
    appt: appts.getFull(appt.id),
    jitsiDomain: config.jitsiDomain,
  });
});

module.exports = router;
