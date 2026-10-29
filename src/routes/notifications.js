const express = require('express');
const db = require('../db');
const t = require('../utils/time');
const v = require('../utils/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const list = db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', req.user.id);
  res.render('notifications/index', { title: 'Notifications', list });
});

// Opening a notification marks it read and follows its link.
router.post('/:id/open', (req, res) => {
  const n = db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', v.int(req.params.id), req.user.id);
  if (!n) return res.redirect('/notifications');
  if (!n.read_at) db.update('notifications', n.id, { read_at: t.now() });
  res.redirect(v.localPath(n.link, '/notifications'));
});

router.post('/read-all', (req, res) => {
  db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', t.now(), req.user.id);
  res.redirect('/notifications');
});

module.exports = router;
