// Public information pages: home, about, services, how it works and FAQ.
const express = require('express');
const db = require('../db');
const { homeFor } = require('../middleware/auth');
const { FAQ_GROUPS, HOME_FAQS } = require('../content/faq');

const router = express.Router();

/** Aggregate counts only, shown in the "service in numbers" band. */
function serviceNumbers() {
  return db.get(`
    SELECT
      (SELECT COUNT(*) FROM patients) AS patients,
      (SELECT COUNT(*) FROM appointments WHERE status = 'completed') AS completed,
      (SELECT COUNT(*) FROM appointments WHERE status = 'completed' AND mode <> 'in_person') AS remote,
      (SELECT COUNT(*) FROM users WHERE role = 'doctor' AND is_active = 1) AS doctors`);
}

router.get('/', async (req, res) => {
  // Signed-in patients start on their dashboard. Staff see the public home page: the staff portal's
  // "Patient website" link brings them here.
  if (req.user?.role === 'patient') return res.redirect(homeFor(req.user));
  res.render('home', { title: 'Welcome', numbers: await serviceNumbers(), faqs: HOME_FAQS });
});

router.get('/about', async (req, res) => {
  res.render('pages/about', { title: 'About Us', numbers: await serviceNumbers() });
});

router.get('/services', (req, res) => {
  res.render('pages/services', { title: 'Our Services' });
});

router.get('/how-it-works', (req, res) => {
  res.render('pages/how-it-works', { title: 'How It Works' });
});

router.get('/faq', (req, res) => {
  res.render('pages/faq', { title: 'FAQs', faqGroups: FAQ_GROUPS });
});

module.exports = router;
