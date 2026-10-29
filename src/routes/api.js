// Small JSON endpoints used by the booking forms.
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const appts = require('../services/appointments');
const v = require('../utils/validate');

const router = express.Router();
router.use(requireAuth, requireRole('patient', 'nurse'));

// GET /api/slots?date=YYYY-MM-DD&doctor_id=3
router.get('/slots', async (req, res) => {
  const date = v.str(req.query.date, 10);
  const doctorId = v.int(req.query.doctor_id);
  const problem = appts.dateProblem(date);
  if (problem) return res.json({ slots: [], message: problem });
  const slots = (await appts.availableSlots(date, doctorId)).map((s) => ({ time: s.time, free: s.freeDoctors.length }));
  res.json({ slots, message: slots.length ? null : 'No free slots on this day. Please try another date.' });
});

module.exports = router;
