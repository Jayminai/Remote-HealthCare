// End-to-end tests through HTTP, covering each role's main workflow.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db, t, makeUser, nextClinicDay, Client } = require('./helpers');
const { createApp } = require('../src/app');

let server;
let base;
let doctorId;

before(async () => {
  await makeUser('admin', 'admin@test.ng');
  await makeUser('nurse', 'nurse@test.ng');
  doctorId = await makeUser('doctor', 'doctor@test.ng', { full_name: 'Dr Test' });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const patientForm = {
  full_name: 'Ada Lovelace Okoro', category: 'student', id_number: '300100', date_of_birth: '2003-05-05',
  gender: 'female', phone: '08012345678', email: 'ada@stu.ui.edu.ng', password: 'Secret123', confirm_password: 'Secret123', consent: '1',
};

test('public pages and access control', async () => {
  const c = new Client(base);
  assert.equal((await c.get('/')).status, 200);
  const r = await c.get('/patient');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/login');
  assert.equal((await c.get('/does-not-exist')).status, 404);
});

test('POST without a CSRF token is rejected', async () => {
  const c = new Client(base);
  await c.get('/login');
  const r = await c.request('POST', '/login', { email: 'admin@test.ng', password: 'Passw0rd1' });
  assert.equal(r.status, 403);
});

test('wrong password is rejected and audited', async () => {
  const c = new Client(base);
  const r = await c.login('admin@test.ng', 'wrong-password1');
  assert.equal(r.status, 401);
  assert.ok(await db.get("SELECT id FROM audit_log WHERE action = 'login_failed'"));
});

/** A confirmation link with a known token (the real one only exists in the email). */
async function verifyLink(userId, minutes = 60) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.insert('email_verifications', {
    user_id: userId,
    token_hash: crypto.createHash('sha256').update(token).digest('hex'),
    expires_at: t.toDateTime(t.addMinutes(new Date(), minutes), true),
  });
  return `/verify-email/${token}`;
}

test('full journey: register, book, consult, prescribe, follow up', async () => {
  // 1. Patient self-registers.
  const patient = new Client(base);
  let r = await patient.post('/register', patientForm, '/register');
  assert.equal(r.status, 302, r.text.slice(0, 500));
  assert.equal(r.location, '/verify-email');
  // ...and confirms their email address with the emailed link.
  const adaId = (await db.get("SELECT id FROM users WHERE email = 'ada@stu.ui.edu.ng'")).id;
  assert.equal((await patient.get(await verifyLink(adaId))).location, '/patient');
  assert.equal((await patient.get('/patient')).status, 200);

  // Registering the same person again is blocked (duplicate prevention).
  const again = new Client(base);
  r = await again.post('/register', { ...patientForm, email: 'other@stu.ui.edu.ng' }, '/register');
  assert.equal(r.status, 400);
  assert.match(r.text, /records office/);

  // 2. Patient books a video consultation.
  const date = nextClinicDay();
  const slots = JSON.parse((await patient.get(`/api/slots?date=${date}`)).text);
  assert.ok(slots.slots.length > 0);
  r = await patient.post('/patient/book', { mode: 'video', date, time: slots.slots[0].time, reason: 'Fever for two days', doctor_id: '' }, '/patient/book');
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const booked = await db.get("SELECT * FROM appointments WHERE reason = 'Fever for two days'");
  assert.equal(booked.doctor_id, doctorId);
  assert.ok(booked.room_id);

  // The patient cannot open staff portal pages: they are sent back to their own dashboard.
  r = await patient.get('/staff/patients/1');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/patient');
  assert.equal((await patient.get('/staff/admin')).location, '/patient');

  // 3. Move the appointment to today so the doctor can start it now.
  await db.update('appointments', booked.id, { scheduled_at: `${t.toDate()} 00:00` });

  // 4. Doctor starts and completes the consultation with a prescription.
  const doctor = new Client(base);
  r = await doctor.staffLogin('doctor@test.ng');
  assert.equal(r.location, '/staff/doctor');
  assert.match((await doctor.get('/staff/doctor')).text, /Ada Lovelace Okoro/);
  r = await doctor.post(`/staff/doctor/appointments/${booked.id}/start`, {}, '/staff/doctor');
  assert.equal(r.location, `/staff/doctor/appointments/${booked.id}/consult`);
  const consultPage = await doctor.get(r.location);
  assert.equal(consultPage.status, 200);
  assert.match(consultPage.text, /data-room="UHS-/);

  // Validation: an incomplete prescription line is refused.
  r = await doctor.post(`/staff/doctor/appointments/${booked.id}/complete`, {
    presenting_complaint: 'Fever', diagnosis: 'Malaria', drug_name: 'Paracetamol', dosage: '', frequency: '', duration: '',
  }, `/staff/doctor/appointments/${booked.id}/consult`);
  assert.equal(r.status, 400);

  const followUp = t.toDate(t.addDays(new Date(), 7));
  r = await doctor.post(`/staff/doctor/appointments/${booked.id}/complete`, {
    presenting_complaint: 'Fever for two days', diagnosis: 'Uncomplicated malaria', plan: 'Rest and fluids',
    drug_name: ['Artemether-lumefantrine', 'Paracetamol'], dosage: ['1 tablet', '1 g'], frequency: ['12-hourly', '8-hourly'],
    duration: ['3 days', '3 days'], instructions: ['With food', ''],
    follow_up_date: followUp, follow_up_note: 'Message me if the fever continues.',
  }, `/staff/doctor/appointments/${booked.id}/consult`);
  assert.equal(r.status, 302, r.text.slice(0, 800));
  assert.equal((await db.get('SELECT status FROM appointments WHERE id = ?', booked.id)).status, 'completed');
  const consult = await db.get('SELECT * FROM consultations WHERE appointment_id = ?', booked.id);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM prescriptions WHERE consultation_id = ?', consult.id)).n, 2);

  // 5. Patient sees the record, prescription, follow-up message and notification.
  const records = await patient.get('/patient/records');
  assert.match(records.text, /Uncomplicated malaria/);
  assert.match(records.text, /Artemether-lumefantrine/);
  assert.equal((await patient.get(`/patient/prescriptions/${consult.id}`)).status, 200);
  const thread = `/messages/${booked.patient_id}/${doctorId}`;
  assert.match((await patient.get('/messages')).text, new RegExp(`href="${thread}"`));
  assert.match((await patient.get(thread)).text, /Message me if the fever continues/);
  assert.match((await patient.get('/notifications')).text, /Consultation summary available/);

  // 6. Patient replies to the doctor.
  r = await patient.post(thread, { body: 'Thank you doctor' }, thread);
  assert.equal(r.status, 302);
  assert.match((await doctor.get(`/staff${thread}`)).text, /Thank you doctor/);
  // A doctor following the patient-side link is sent to the staff portal.
  assert.equal((await doctor.get(thread)).location, `/staff${thread}`);

  // Another patient cannot read this thread.
  const other = new Client(base);
  await other.post('/register', { ...patientForm, full_name: 'Bayo Other', id_number: '300200', date_of_birth: '2001-01-01', phone: '08099999999', email: 'bayo@stu.ui.edu.ng' }, '/register');
  await other.get(await verifyLink((await db.get("SELECT id FROM users WHERE email = 'bayo@stu.ui.edu.ng'")).id));
  assert.equal((await other.get(thread)).status, 404);
});

test('notifications open their content, clear when the page is opened directly, and update live', async () => {
  const patient = new Client(base);
  await patient.post('/register', {
    ...patientForm, full_name: 'Kemi Adeyemi', id_number: '300400', date_of_birth: '1999-04-04', phone: '08066666666', email: 'kemi@stu.ui.edu.ng',
  }, '/register');
  await patient.get(await verifyLink((await db.get("SELECT id FROM users WHERE email = 'kemi@stu.ui.edu.ng'")).id));
  const doctor = new Client(base);
  await doctor.staffLogin('doctor@test.ng');
  const doctorSince = (await doctor.live('/staff/live')).json.lastNotificationId;

  // Booking notifies both sides, each linking to the appointment itself.
  const date = nextClinicDay();
  const slots = JSON.parse((await patient.get(`/api/slots?date=${date}`)).text);
  await patient.post('/patient/book', { mode: 'video', date, time: slots.slots[0].time, reason: 'Live update check', doctor_id: String(doctorId) }, '/patient/book');
  const appt = await db.get("SELECT * FROM appointments WHERE reason = 'Live update check'");

  // The patient's page learns about it without reloading.
  let live = await patient.live('/live?since=0');
  assert.equal(live.status, 200);
  assert.equal(live.json.unreadNotifications, 1);
  const [booked] = live.json.notifications;
  assert.equal(booked.title, 'Appointment booked');
  assert.equal(booked.url, `/notifications/${booked.id}/open`);

  // "Open" goes straight to the appointment.
  let r = await patient.get(booked.url);
  assert.equal(r.location, `/patient/appointments#appt-${appt.id}`);
  assert.match((await patient.get('/patient/appointments')).text, new RegExp(`id="appt-${appt.id}"`));
  assert.equal((await patient.live('/live')).json.unreadNotifications, 0);

  // The doctor opens the queue for that day directly instead of through the notification: it is cleared too.
  live = await doctor.live(`/staff/live?since=${doctorSince}`);
  assert.equal(live.json.notifications[0].title, 'New appointment');
  const unread = live.json.unreadNotifications;
  // The queue refreshing itself on an open page is not the doctor looking at it: still unread.
  await doctor.request('GET', `/staff/doctor?date=${date}`, null, { 'x-live': '1', accept: '*/*' });
  assert.equal((await doctor.live('/staff/live')).json.unreadNotifications, unread);
  const queue = await doctor.get(`/staff/doctor?date=${date}`);
  assert.match(queue.text, new RegExp(`id="appt-${appt.id}"`));
  assert.ok((await doctor.live('/staff/live')).json.unreadNotifications < unread);
  assert.ok((await db.get('SELECT read_at FROM notifications WHERE id = ?', live.json.notifications[0].id)).read_at);

  // Live conversation: the doctor writes (as the page's script does), the patient sees "typing…" and the message.
  const thread = `/messages/${appt.patient_id}/${doctorId}`;
  r = await patient.post(`${thread}/typing`, { typing: '1' }, thread, { accept: 'application/json' });
  assert.equal(r.status, 204);
  let updates = await doctor.live(`/staff${thread}/updates?after=0`);
  assert.equal(updates.json.thread.typing, true);
  r = await doctor.post(`/staff${thread}`, { body: 'See you on the call' }, `/staff${thread}`, { accept: 'application/json' });
  assert.equal(r.status, 201);
  const sent = JSON.parse(r.text).message;
  assert.equal(sent.mine, true);
  assert.equal(sent.read, false);
  // An empty message gets an error the page can show, not a redirect.
  r = await doctor.post(`/staff${thread}`, { body: ' ' }, `/staff${thread}`, { accept: 'application/json' });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error, /Type a message/);

  // In a background tab the message stays unread...
  updates = await patient.live(`${thread}/updates?after=0`);
  assert.deepEqual(updates.json.thread.messages.map((m) => m.body), ['See you on the call']);
  assert.equal(updates.json.thread.messages[0].mine, false);
  assert.equal(updates.json.unreadMessages, 1);
  // ...and is read, with its notification, once the conversation is on screen.
  updates = await patient.live(`${thread}/updates?after=0&active=1`);
  assert.equal(updates.json.unreadMessages, 0);
  assert.equal(updates.json.unreadNotifications, 0);
  updates = await doctor.live(`/staff${thread}/updates?after=${sent.id}`);
  assert.equal(updates.json.thread.lastReadId, sent.id);
  assert.equal(updates.json.thread.messages.length, 0);
  assert.equal(updates.json.thread.typing, true); // the patient has not sent typing=0 yet
  await patient.post(`${thread}/typing`, { typing: '0' }, thread, { accept: 'application/json' });
  assert.equal((await doctor.live(`/staff${thread}/updates`)).json.thread.typing, false);

  // Photos: the doctor sends a picture without text; only the two members of the conversation can open it.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const photo = await doctor.postJson(`/staff${thread}`, { body: '', image: `data:image/png;base64,${png}` }, `/staff${thread}`);
  assert.equal(photo.status, 201);
  assert.equal(photo.json.message.image, `/staff${thread}/images/1`);
  updates = await patient.live(`${thread}/updates?after=${sent.id}`);
  const seen = updates.json.thread.messages.at(-1);
  assert.equal(seen.image, `${thread}/images/1`);
  const pic = await patient.getBytes(seen.image);
  assert.equal(pic.status, 200);
  assert.equal(pic.type, 'image/png');
  assert.deepEqual(pic.bytes, Buffer.from(png, 'base64'));
  assert.match((await patient.get(thread)).text, new RegExp(`src="${thread}/images/1"`));
  assert.match((await patient.get('/messages')).text, /fa-image[^>]*><\/i> Photo/);
  assert.equal((await new Client(base).getBytes(seen.image)).status, 302); // signed out: sent to sign in
  // Something that only claims to be a picture is refused.
  r = await patient.postJson(thread, { body: 'look', image: `data:image/png;base64,${Buffer.from('not a picture').toString('base64')}` }, thread);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not a valid picture/);
  r = await patient.postJson(thread, { body: '', image: 'data:text/html;base64,PGI+' }, thread);
  assert.equal(r.status, 400);
  // Too large for the request limit: a message the page can show, not an error page.
  r = await patient.postJson(thread, { body: '', image: `data:image/jpeg;base64,${'A'.repeat(4.5 * 1024 * 1024)}` }, thread);
  assert.equal(r.status, 413);
  assert.match(r.json.error, /too large/);

  // Without a session, the script is told to reload instead of being sent the sign-in page.
  r = await new Client(base).live('/live');
  assert.equal(r.status, 401);
});

test('live updates in the background do not keep an idle user signed in', async () => {
  const doctor = new Client(base);
  await doctor.staffLogin('doctor@test.ng');
  const sid = decodeURIComponent(doctor.cookie.split('=')[1]).slice(2).split('.')[0];
  const expires = async () => (await db.get('SELECT expires FROM sessions WHERE sid = ?', sid)).expires;
  await doctor.get('/staff/doctor');
  const before = await expires();
  await new Promise((r) => setTimeout(r, 20));
  const poll = await doctor.live('/staff/live');
  assert.equal(poll.status, 200);
  assert.equal(await expires(), before); // polling is not activity...
  await doctor.get('/staff/doctor');
  assert.ok(await expires() > before); // ...opening a page is

  // Once the idle time has passed, the next poll finds the session signed out.
  await db.run('UPDATE sessions SET expires = ? WHERE sid = ?', Date.now() - 1000, sid);
  assert.equal((await doctor.live('/staff/live')).status, 401);
  assert.equal((await doctor.get('/staff/doctor')).location, '/staff/login');
});

test('records office registers a walk-in, flags duplicates and records vitals', async () => {
  const nurse = new Client(base);
  await nurse.staffLogin('nurse@test.ng');
  const form = { full_name: 'Musa Danjuma', category: 'student', id_number: '400100', date_of_birth: '2002-02-02', gender: 'male', phone: '08055555555' };
  let r = await nurse.post('/staff/records/patients/new', form, '/staff/records/patients/new');
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const pid = Number(r.location.split('/').pop());

  // Same name + DOB with a different ID number: warning first, allowed after confirmation.
  r = await nurse.post('/staff/records/patients/new', { ...form, id_number: '400101', phone: '' }, '/staff/records/patients/new');
  assert.equal(r.status, 400);
  assert.match(r.text, /Possible duplicate/);
  r = await nurse.post('/staff/records/patients/new', { ...form, id_number: '400101', phone: '', confirm_not_duplicate: '1' }, '/staff/records/patients/new');
  assert.equal(r.status, 302);

  // Same ID number is always blocked.
  r = await nurse.post('/staff/records/patients/new', { ...form, full_name: 'Someone Different', confirm_not_duplicate: '1' }, '/staff/records/patients/new');
  assert.equal(r.status, 400);

  r = await nurse.post(`/staff/records/patients/${pid}/walk-in`, { reason: 'Headache', doctor_id: '' }, `/staff/patients/${pid}`);
  assert.equal(r.location, '/staff/records');
  assert.equal((await db.get("SELECT status FROM appointments WHERE patient_id = ? AND booked_via = 'walk_in'", pid)).status, 'checked_in');

  r = await nurse.post(`/staff/records/patients/${pid}/vitals`, { systolic: '120', diastolic: '80', temperature: '37.2' }, `/staff/patients/${pid}`);
  assert.equal(r.status, 302);
  assert.ok(await db.get('SELECT id FROM vitals WHERE patient_id = ?', pid));

  // Out-of-range vitals are refused.
  await nurse.post(`/staff/records/patients/${pid}/vitals`, { temperature: '98.6' }, `/staff/patients/${pid}`);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM vitals WHERE patient_id = ?', pid)).n, 1);

  // Nurses do not see consultation notes.
  const page = await nurse.get(`/staff/patients/${pid}`);
  assert.match(page.text, /visible to doctors only/);

  // Enabling online access issues a temporary password that must be changed.
  r = await nurse.post(`/staff/records/patients/${pid}/online-access`, { email: 'musa@stu.ui.edu.ng' }, `/staff/patients/${pid}`);
  const temp = r.text.match(/class="secret">([^<]+)</)[1];
  const musa = new Client(base);
  await musa.login('musa@stu.ui.edu.ng', temp);
  r = await musa.get('/patient');
  assert.equal(r.location, '/account/password');
  r = await musa.post('/account/password', { current_password: temp, new_password: 'MyNewPass1', confirm_password: 'MyNewPass1' }, '/account/password');
  assert.equal(r.location, '/patient');
});

test('admin dashboard, user management and audit log', async () => {
  const admin = new Client(base);
  await admin.staffLogin('admin@test.ng');
  const dash = await admin.get('/staff/admin');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Peak hours/);
  assert.equal((await admin.get('/staff/admin/audit')).status, 200);
  assert.equal((await admin.get('/staff/admin/outbox')).status, 200);

  let r = await admin.post('/staff/admin/users/new', { role: 'doctor', full_name: 'Dr New Person', email: 'new.doc@test.ng', specialty: 'GP' }, '/staff/admin/users/new');
  assert.equal(r.status, 200);
  assert.match(r.text, /Temporary password/);
  assert.match(r.text, /\/staff\/login/);
  // The new staff member is emailed the sign-in address, never the password.
  const welcome = await db.get("SELECT body FROM email_outbox WHERE to_email = 'new.doc@test.ng'");
  assert.match(welcome.body, /\/staff\/login/);
  assert.doesNotMatch(welcome.body, new RegExp(r.text.match(/class="secret">([^<]+)</)[1]));

  // The test-email button records an email to the administrator.
  r = await admin.post('/staff/admin/outbox/test', {}, '/staff/admin/outbox');
  assert.equal(r.location, '/staff/admin/outbox');
  assert.ok(await db.get("SELECT id FROM email_outbox WHERE to_email = 'admin@test.ng' AND subject = 'UHS Telemedicine test email'"));

  // Deactivated accounts cannot sign in.
  const id = (await db.get("SELECT id FROM users WHERE email = 'new.doc@test.ng'")).id;
  r = await admin.post(`/staff/admin/users/${id}/toggle`, {}, '/staff/admin/users');
  assert.equal((await db.get('SELECT is_active FROM users WHERE id = ?', id)).is_active, 0);

  // Admins never see clinical records.
  assert.equal((await admin.get('/staff/patients/1')).status, 403);
});

test('patients and staff sign in on separate pages', async () => {
  const c = new Client(base);
  assert.match((await c.get('/staff/login')).text, /Staff sign in/);
  // Signed-out visitors to the staff portal go to the staff sign-in page.
  assert.equal((await c.get('/staff/admin')).location, '/staff/login');
  // Old staff addresses still work.
  assert.equal((await c.get('/doctor?date=2026-01-05')).location, '/staff/doctor?date=2026-01-05');

  // Staff cannot sign in on the patient website...
  let r = await c.login('doctor@test.ng');
  assert.equal(r.status, 403);
  assert.match(r.text, /staff portal/);
  assert.equal((await c.get('/staff/doctor')).location, '/staff/login');
  // ...and patients cannot sign in to the staff portal.
  await makeUser('patient', 'portal.patient@test.ng');
  r = await c.staffLogin('portal.patient@test.ng');
  assert.equal(r.status, 403);
  assert.ok(await db.get("SELECT id FROM audit_log WHERE action = 'login_wrong_portal'"));

  // Signing out from the staff portal returns to the staff sign-in page.
  const doctor = new Client(base);
  await doctor.staffLogin('doctor@test.ng');
  assert.equal((await doctor.get('/messages')).location, '/staff/messages');
  // The staff portal's "Patient website" link opens the public home page, not the staff dashboard again.
  assert.match((await doctor.get('/staff/doctor')).text, /href="\/" class="staff-site-link"/);
  r = await doctor.get('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /href="\/staff"[^>]*>Staff Portal/);
  r = await doctor.post('/logout', {}, '/staff/doctor');
  assert.equal(r.location, '/staff/login');
});

test('patient resets a forgotten password by email', async () => {
  const userId = await makeUser('patient', 'reset.me@test.ng', { full_name: 'Reset Me' });
  const signedIn = new Client(base);
  assert.equal((await signedIn.login('reset.me@test.ng')).status, 302);

  // Requesting a link: same answer for patients, staff and unknown addresses.
  const c = new Client(base);
  for (const email of ['reset.me@test.ng', 'doctor@test.ng', 'nobody@test.ng']) {
    const r = await c.post('/forgot-password', { email }, '/forgot-password');
    assert.equal(r.status, 200);
    assert.match(r.text, /we have sent it a link/);
  }
  assert.ok(await db.get('SELECT id FROM password_resets WHERE user_id = ?', userId));
  assert.equal(await db.get('SELECT id FROM password_resets WHERE user_id = ?', doctorId), undefined);
  // The outbox never shows the secret link.
  const mail = await db.get("SELECT body FROM email_outbox WHERE to_email = 'reset.me@test.ng' AND subject = 'Reset your UHS Telemedicine password'");
  assert.match(mail.body, /\[reset link hidden\]/);
  assert.doesNotMatch(mail.body, /reset-password\//);
  assert.match((await db.get("SELECT body FROM email_outbox WHERE to_email = 'doctor@test.ng' ORDER BY id DESC")).body, /reset by the UHS administrator/);

  // Use a link with a known token (the real one only exists in the email).
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.run('DELETE FROM password_resets WHERE user_id = ?', userId);
  await db.insert('password_resets', { user_id: userId, token_hash: hash, expires_at: t.toDateTime(t.addMinutes(new Date(), 30), true) });
  assert.equal((await c.get(`/reset-password/${token}`)).status, 200);
  let r = await c.post(`/reset-password/${token}`, { password: 'NewSecret9', confirm_password: 'Different9' }, `/reset-password/${token}`);
  assert.equal(r.status, 400);
  r = await c.post(`/reset-password/${token}`, { password: 'NewSecret9', confirm_password: 'NewSecret9' }, `/reset-password/${token}`);
  assert.equal(r.location, '/login');

  // The link works once, other sessions are signed out, and the new password works.
  assert.equal((await c.get(`/reset-password/${token}`)).status, 410);
  assert.equal((await signedIn.get('/notifications')).location, '/login');
  assert.equal((await new Client(base).login('reset.me@test.ng', 'NewSecret9')).location, '/patient');

  // Expired links are refused.
  const old = crypto.randomBytes(32).toString('base64url');
  await db.insert('password_resets', {
    user_id: userId,
    token_hash: crypto.createHash('sha256').update(old).digest('hex'),
    expires_at: t.toDateTime(t.addMinutes(new Date(), -1), true),
  });
  assert.equal((await c.get(`/reset-password/${old}`)).status, 410);
});

test('self-registered patients confirm their email before using the service', async () => {
  const form = {
    ...patientForm, full_name: 'Chidi Verify Nnamdi', id_number: '300900', date_of_birth: '2002-02-02',
    phone: '08077777777', email: 'chidi.typo@stu.ui.edu.ng',
  };
  const c = new Client(base);
  let r = await c.post('/register', form, '/register');
  assert.equal(r.location, '/verify-email', r.text.slice(0, 500));
  const user = await db.get("SELECT id, email_verified FROM users WHERE email = 'chidi.typo@stu.ui.edu.ng'");
  assert.equal(user.email_verified, 0);

  // Every patient page, including shared ones and the API, waits for the confirmation.
  for (const path of ['/patient', '/patient/book', '/messages', '/api/slots?date=2030-01-01']) {
    assert.equal((await c.get(path)).location, '/verify-email', path);
  }
  const page = await c.get('/verify-email');
  assert.equal(page.status, 200);
  assert.match(page.text, /chidi\.typo@stu\.ui\.edu\.ng/);

  // The outbox never shows the secret link.
  const mail = await db.get("SELECT body FROM email_outbox WHERE to_email = 'chidi.typo@stu.ui.edu.ng' AND subject LIKE 'Confirm your email%'");
  assert.match(mail.body, /\[confirmation link hidden\]/);
  assert.doesNotMatch(mail.body, /verify-email\//);

  // A mistyped address can be corrected, but not to one that is already in use.
  r = await c.post('/verify-email/change', { email: 'doctor@test.ng' }, '/verify-email');
  assert.equal(r.status, 400);
  r = await c.post('/verify-email/change', { email: 'chidi@stu.ui.edu.ng' }, '/verify-email');
  assert.equal(r.location, '/verify-email');
  assert.equal((await db.get('SELECT email FROM users WHERE id = ?', user.id)).email, 'chidi@stu.ui.edu.ng');
  assert.equal((await db.get('SELECT email FROM patients WHERE user_id = ?', user.id)).email, 'chidi@stu.ui.edu.ng');
  assert.ok(await db.get("SELECT id FROM email_outbox WHERE to_email = 'chidi@stu.ui.edu.ng' AND subject LIKE 'Confirm your email%'"));

  // Only the newest link works, and expired links are refused.
  const older = await verifyLink(user.id);
  r = await c.post('/verify-email/resend', {}, '/verify-email');
  assert.equal(r.location, '/verify-email');
  assert.equal((await c.get(older)).status, 410);
  assert.equal((await c.get(await verifyLink(user.id, -1))).status, 410);

  // The link works from another device too (e.g. opened on a phone while signed in on a laptop).
  r = await new Client(base).get(await verifyLink(user.id));
  assert.equal(r.location, '/login');
  assert.equal((await db.get('SELECT email_verified FROM users WHERE id = ?', user.id)).email_verified, 1);
  assert.equal((await c.get('/patient')).status, 200);
  assert.equal((await c.get('/verify-email')).location, '/patient');

  // The resend button cannot be used to flood an inbox.
  const floodId = await makeUser('patient', 'flood@test.ng', { email_verified: 0 });
  const f = new Client(base);
  await f.login('flood@test.ng');
  for (let i = 0; i < 5; i++) assert.equal((await f.post('/verify-email/resend', {}, '/verify-email')).status, 302);
  assert.equal((await f.post('/verify-email/resend', {}, '/verify-email')).status, 429);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?', floodId)).n, 5);

  // Accounts created any other way (by staff, or before this change) count as verified.
  assert.equal((await db.get("SELECT email_verified FROM users WHERE email = 'nurse@test.ng'")).email_verified, 1);
});
