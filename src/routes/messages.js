// Secure messaging between patients and doctors (replaces follow-up phone calls).
const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');
const t = require('../utils/time');
const v = require('../utils/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { notifyUser, markLinkRead } = require('../services/notify');
const { summary, unreadCounts } = require('../services/live');
const { patientForUser } = require('../services/patients');
const { doctorTitle } = require('../services/appointments');

// "Typing…" shows while the other person typed within this many milliseconds.
const TYPING_MS = 6000;

// Photos in messages. The browser shrinks them before sending (public/js/live.js), so this limit is generous;
// requests to Vercel functions cannot be larger than 4.5 MB in any case.
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
const IMAGE_TYPES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  'image/gif': (b) => b.toString('latin1', 0, 4) === 'GIF8',
};

/**
 * A photo sent as a data URL ("data:image/jpeg;base64,..."). Returns { type, data }, null when there is none,
 * or { error } when it is not an accepted picture. The bytes must match the stated type, so nothing else
 * can be stored and later served as an image.
 */
function parseImage(value) {
  if (value == null || value === '') return null;
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(value));
  if (!m || !IMAGE_TYPES[m[1]]) return { error: 'Send a photo in JPEG, PNG, WebP or GIF format.' };
  const data = Buffer.from(m[2], 'base64');
  if (data.length > MAX_IMAGE_BYTES) return { error: 'That photo is too large. Please choose a smaller one.' };
  if (!IMAGE_TYPES[m[1]](data)) return { error: 'That file is not a valid picture.' };
  return { type: m[1], data };
}

/** Messages of a thread with the id of their photo, if any (the photo itself is fetched separately). */
const MESSAGES_SQL = `SELECT m.*, i.id AS image_id FROM messages m LEFT JOIN message_images i ON i.message_id = m.id
  WHERE m.patient_id = ? AND m.doctor_id = ?`;

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
  res.render('messages/index', { title: 'Messages', bodyClass: 'chat-screen', threads, doctors: p ? await doctorsForPatient(p.id) : [], patient: p });
});

/** Mark the other person's messages in the thread, and the notifications about them, as read. */
async function markThreadRead(req, res, patient, doctor) {
  await db.run(
    'UPDATE messages SET read_at = ? WHERE patient_id = ? AND doctor_id = ? AND sender_id <> ? AND read_at IS NULL',
    t.now(), patient.id, doctor.id, req.user.id
  );
  await markLinkRead(req.user.id, `${res.locals.base}/messages/${patient.id}/${doctor.id}`);
}

/** A message as the browser shows it (see public/js/live.js). threadUrl: the conversation's address. */
function present(m, user, threadUrl) {
  return {
    id: m.id,
    mine: m.sender_id === user.id,
    body: m.body,
    image: m.image_id ? `${threadUrl}/images/${m.image_id}` : null,
    when: t.fmtDateTime(m.created_at),
    read: Boolean(m.read_at),
  };
}

const threadUrl = (res, patient, doctor) => `${res.locals.base}/messages/${patient.id}/${doctor.id}`;

/** Scripts sending the form ask for JSON so the page can update without reloading. */
const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';

router.get('/:patientId/:doctorId', async (req, res) => {
  const access = await threadAccess(req, v.int(req.params.patientId), v.int(req.params.doctorId));
  if (!access) return res.status(404).render('error', { title: 'Not found', message: 'Conversation not found.' });
  const { patient, doctor } = access;
  await markThreadRead(req, res, patient, doctor);
  // The menu counters were counted before this conversation was read.
  const counts = await unreadCounts(req.user);
  res.locals.unreadMessages = counts.messages;
  res.locals.unreadNotifications = counts.notifications;
  const messages = await db.all(`${MESSAGES_SQL} ORDER BY m.created_at, m.id`, patient.id, doctor.id);
  const call = presentCall(req, res, patient, doctor, await activeCall(patient, doctor));
  res.render('messages/thread', { title: 'Conversation', bodyClass: 'chat-screen', patient, doctor, messages, call });
});

// Polled by the open conversation: new messages, read receipts and whether the other person is typing,
// plus the counters and notifications every page receives.
router.get('/:patientId/:doctorId/updates', async (req, res) => {
  const access = await threadAccess(req, v.int(req.params.patientId), v.int(req.params.doctorId));
  if (!access) return res.status(404).json({ error: 'Conversation not found.' });
  const { patient, doctor } = access;
  // Only while the page is on screen, so a conversation left open in a background tab stays unread.
  if (req.query.active === '1') await markThreadRead(req, res, patient, doctor);
  const messages = await db.all(
    `${MESSAGES_SQL} AND m.id > ? ORDER BY m.created_at, m.id`,
    patient.id, doctor.id, v.int(req.query.after) || 0
  );
  const lastRead = await db.get(
    'SELECT MAX(id) AS id FROM messages WHERE patient_id = ? AND doctor_id = ? AND sender_id = ? AND read_at IS NOT NULL',
    patient.id, doctor.id, req.user.id
  );
  const typing = await db.get(
    'SELECT 1 AS x FROM typing WHERE patient_id = ? AND doctor_id = ? AND user_id <> ? AND at > ?',
    patient.id, doctor.id, req.user.id, Date.now() - TYPING_MS
  );
  res.json({
    ...await summary(req.user, v.int(req.query.since) ?? -1, res.locals.base),
    thread: {
      messages: messages.map((m) => present(m, req.user, threadUrl(res, patient, doctor))),
      lastReadId: lastRead.id || 0,
      typing: Boolean(typing),
      call: presentCall(req, res, patient, doctor, await activeCall(patient, doctor)),
    },
  });
});

// A photo in the conversation, only for its two members.
router.get('/:patientId/:doctorId/images/:imageId', async (req, res) => {
  const access = await threadAccess(req, v.int(req.params.patientId), v.int(req.params.doctorId));
  const image = access && await db.get(
    `SELECT i.content_type, i.data FROM message_images i JOIN messages m ON m.id = i.message_id
      WHERE i.id = ? AND m.patient_id = ? AND m.doctor_id = ?`,
    v.int(req.params.imageId), access.patient.id, access.doctor.id
  );
  if (!image) return res.status(404).end();
  res.type(image.content_type).set('Content-Disposition', 'inline').send(Buffer.from(image.data));
});

// Sent by the page every few seconds while the user types ("typing=1"), and once they stop ("typing=0").
router.post('/:patientId/:doctorId/typing', async (req, res) => {
  const access = await threadAccess(req, v.int(req.params.patientId), v.int(req.params.doctorId));
  if (!access) return res.status(404).json({ error: 'Conversation not found.' });
  const key = [access.patient.id, access.doctor.id, req.user.id];
  if (req.body.typing === '1') {
    await db.run(
      `INSERT INTO typing (patient_id, doctor_id, user_id, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (patient_id, doctor_id, user_id) DO UPDATE SET at = excluded.at`,
      ...key, Date.now()
    );
  } else {
    await db.run('DELETE FROM typing WHERE patient_id = ? AND doctor_id = ? AND user_id = ?', ...key);
  }
  res.status(204).end();
});

// Text from the form, or JSON from the page's script, which can also carry a photo.
router.post('/:patientId/:doctorId', express.json({ limit: '4mb' }), async (req, res) => {
  const json = wantsJson(req);
  const access = await threadAccess(req, v.int(req.params.patientId), v.int(req.params.doctorId));
  if (!access) {
    if (json) return res.status(404).json({ error: 'Conversation not found.' });
    return res.status(404).render('error', { title: 'Not found', message: 'Conversation not found.' });
  }
  const { patient, doctor } = access;
  const body = v.str(req.body.body, 2000);
  const path = `/messages/${patient.id}/${doctor.id}`;
  const url = `${res.locals.base}${path}`;
  const fail = (message) => {
    if (json) return res.status(400).json({ error: message });
    req.flash('error', message);
    res.redirect(url);
  };
  const image = parseImage(req.body.image);
  if (image?.error) return fail(image.error);
  if (!body && !image) return fail('Type a message first.');
  if (req.user.role === 'doctor' && !patient.user_id) {
    return fail('This patient has no online account. Please contact them by phone, or ask the records office to enable online access.');
  }
  if (!doctor.is_active) return fail('This doctor is no longer available. Please message another doctor or call the clinic.');
  const id = await db.tx(async () => {
    const messageId = await db.insert('messages', { patient_id: patient.id, doctor_id: doctor.id, sender_id: req.user.id, body });
    if (image) await db.insert('message_images', { message_id: messageId, content_type: image.type, data: image.data });
    return messageId;
  });
  await db.run('DELETE FROM typing WHERE patient_id = ? AND doctor_id = ? AND user_id = ?', patient.id, doctor.id, req.user.id);
  await audit(req, 'message_sent', 'message', id, image ? { photo: true } : undefined);
  // The doctor reads messages in the staff portal, the patient on the public site.
  const [recipient, link] = req.user.role === 'doctor' ? [patient.user_id, path] : [doctor.id, `/staff${path}`];
  // Email says only that a message exists; the content stays inside the secure system.
  await notifyUser(recipient, 'New secure message', `You have a new message from ${req.user.full_name}. Sign in to read it.`, link);
  if (json) return res.status(201).json({ message: present(await db.get(`${MESSAGES_SQL} AND m.id = ?`, patient.id, doctor.id, id), req.user, url) });
  res.redirect(`${url}#latest`);
});

// ---- Quick calls ----
// Once a conversation has started, the doctor can call the patient straight away (video or audio) in a private
// room. Patients cannot start a call; they are notified and join the doctor's.

const CALL_MINUTES = 60; // a call left open counts as over after this long

/** The call in progress in this conversation, if any. */
function activeCall(patient, doctor) {
  return db.get(
    `SELECT * FROM quick_calls WHERE patient_id = ? AND doctor_id = ? AND ended_at IS NULL AND started_at > ?
      ORDER BY id DESC LIMIT 1`,
    patient.id, doctor.id, t.toDateTime(t.addMinutes(new Date(), -CALL_MINUTES), true)
  );
}

const callUrl = (base, patient, doctor, call) => `${base}/messages/${patient.id}/${doctor.id}/call/${call.id}`;

/** A call as the conversation page shows it, worded for whoever is looking. */
function presentCall(req, res, patient, doctor, call) {
  if (!call) return null;
  const url = callUrl(res.locals.base, patient, doctor, call);
  const kind = call.mode === 'audio' ? 'audio' : 'video';
  return {
    id: call.id,
    mode: call.mode,
    url,
    endUrl: `${url}/end`,
    label: req.user.role === 'doctor'
      ? `Your ${kind} call with ${patient.full_name} is open`
      : `${doctorTitle(doctor.full_name)} is calling you (${kind} call)`,
  };
}

/** The call with this id in this conversation, if it is still going. */
async function findCall(req, patient, doctor) {
  const call = await db.get(
    'SELECT * FROM quick_calls WHERE id = ? AND patient_id = ? AND doctor_id = ?', v.int(req.params.callId), patient.id, doctor.id
  );
  const active = await activeCall(patient, doctor);
  return call && active && active.id === call.id ? call : null;
}

router.post('/:patientId/:doctorId/call', requireRole('doctor'), async (req, res) => {
  const access = await threadAccess(req, v.int(req.params.patientId), v.int(req.params.doctorId));
  if (!access) return res.status(404).render('error', { title: 'Not found', message: 'Conversation not found.' });
  const { patient, doctor } = access;
  const url = threadUrl(res, patient, doctor);
  if (!patient.user_id) {
    req.flash('error', 'This patient has no online account, so they cannot join a call. Please phone them instead.');
    return res.redirect(url);
  }
  if (!await db.get('SELECT 1 AS x FROM messages WHERE patient_id = ? AND doctor_id = ? LIMIT 1', patient.id, doctor.id)) {
    req.flash('error', 'Send the patient a message first: a call can be started once the conversation has begun.');
    return res.redirect(url);
  }
  // One call at a time: starting again rejoins the call already open.
  let call = await activeCall(patient, doctor);
  if (!call) {
    const id = await db.insert('quick_calls', {
      patient_id: patient.id,
      doctor_id: doctor.id,
      mode: req.body.mode === 'audio' ? 'audio' : 'video',
      room_id: crypto.randomBytes(12).toString('hex'),
      started_at: t.now(),
    });
    call = await db.get('SELECT * FROM quick_calls WHERE id = ?', id);
    await audit(req, 'quick_call_started', 'quick_call', id, { patient: patient.id, mode: call.mode });
    // In-app only: an email would arrive too late to answer a call.
    await notifyUser(
      patient.user_id,
      `${doctorTitle(doctor.full_name)} is calling you`,
      `A ${call.mode} call is waiting for you. Open it to join.`,
      callUrl('', patient, doctor, call),
      { email: false }
    );
  }
  res.redirect(callUrl(res.locals.base, patient, doctor, call));
});

router.get('/:patientId/:doctorId/call/:callId', async (req, res) => {
  const access = await threadAccess(req, v.int(req.params.patientId), v.int(req.params.doctorId));
  if (!access) return res.status(404).render('error', { title: 'Not found', message: 'Conversation not found.' });
  const { patient, doctor } = access;
  const call = await findCall(req, patient, doctor);
  if (!call) {
    req.flash('info', 'This call has ended.');
    return res.redirect(threadUrl(res, patient, doctor));
  }
  const isDoctor = req.user.role === 'doctor';
  if (!isDoctor) await audit(req, 'quick_call_joined', 'quick_call', call.id);
  res.render('messages/call', {
    title: call.mode === 'audio' ? 'Audio call' : 'Video call',
    patient, doctor, call,
    threadPath: threadUrl(res, patient, doctor),
    jitsiDomain: config.jitsiDomain,
    callName: isDoctor ? doctorTitle(req.user.full_name) : req.user.full_name,
  });
});

router.post('/:patientId/:doctorId/call/:callId/end', requireRole('doctor'), async (req, res) => {
  const access = await threadAccess(req, v.int(req.params.patientId), v.int(req.params.doctorId));
  if (!access) return res.status(404).render('error', { title: 'Not found', message: 'Conversation not found.' });
  const call = await findCall(req, access.patient, access.doctor);
  if (call) {
    await db.update('quick_calls', call.id, { ended_at: t.now() });
    await audit(req, 'quick_call_ended', 'quick_call', call.id);
    req.flash('success', 'Call ended.');
  }
  res.redirect(threadUrl(res, access.patient, access.doctor));
});

module.exports = router;
