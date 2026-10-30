const express = require('express');
const db = require('../db');
const t = require('../utils/time');
const v = require('../utils/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const list = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', req.user.id);
  res.render('notifications/index', { title: 'Notifications', list });
});

// Opening a notification marks it read and goes straight to what it is about. A plain link (GET), so it
// also works from the live pop-up and can be opened in a new tab; POST is kept for older pages.
async function open(req, res) {
  // A link on another website must not mark notifications read; just show the list.
  if (req.get('sec-fetch-site') === 'cross-site') return res.redirect(`${res.locals.base}/notifications`);
  const n = await db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', v.int(req.params.id), req.user.id);
  if (!n) return res.redirect(`${res.locals.base}/notifications`);
  if (!n.read_at) await db.update('notifications', n.id, { read_at: t.now() });
  res.redirect(v.localPath(n.link, `${res.locals.base}/notifications`));
}
router.get('/:id/open', open);
router.post('/:id/open', open);

router.post('/read-all', async (req, res) => {
  await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', t.now(), req.user.id);
  res.redirect(`${res.locals.base}/notifications`);
});

module.exports = router;
