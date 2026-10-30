// Live updates polled by public/js/live.js: unread counters and notifications created since the page loaded.
const express = require('express');
const v = require('../utils/validate');
const { summary } = require('../services/live');

const router = express.Router();

router.get('/', async (req, res) => {
  // Answer in JSON rather than redirecting to the sign-in page; the browser reloads the page itself.
  if (!req.user) return res.status(401).json({ signedOut: true });
  res.json(await summary(req.user, v.int(req.query.since) ?? -1, res.locals.base, res.locals.liveCounts));
});

module.exports = router;
