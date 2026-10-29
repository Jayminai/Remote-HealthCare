// End-to-end tests through HTTP, covering each role's main workflow.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, t, makeUser, nextClinicDay, Client } = require('./helpers');
const { createApp } = require('../src/app');

let server;
let base;
let doctorId;

before(async () => {
  makeUser('admin', 'admin@test.ng');
  makeUser('nurse', 'nurse@test.ng');
  doctorId = makeUser('doctor', 'doctor@test.ng', { full_name: 'Dr Test' });
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
  assert.ok(db.get("SELECT id FROM audit_log WHERE action = 'login_failed'"));
});

test('full journey: register, book, consult, prescribe, follow up', async () => {
  // 1. Patient self-registers.
  const patient = new Client(base);
  let r = await patient.post('/register', patientForm, '/register');
  assert.equal(r.status, 302, r.text.slice(0, 500));
  assert.equal(r.location, '/patient');
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
  const booked = db.get("SELECT * FROM appointments WHERE reason = 'Fever for two days'");
  assert.equal(booked.doctor_id, doctorId);
  assert.ok(booked.room_id);

  // The patient cannot open clinical staff pages.
  assert.equal((await patient.get('/patients/1')).status, 403);
  assert.equal((await patient.get('/admin')).status, 403);

  // 3. Move the appointment to today so the doctor can start it now.
  db.update('appointments', booked.id, { scheduled_at: `${t.toDate()} 00:00` });

  // 4. Doctor starts and completes the consultation with a prescription.
  const doctor = new Client(base);
  r = await doctor.login('doctor@test.ng');
  assert.equal(r.location, '/doctor');
  assert.match((await doctor.get('/doctor')).text, /Ada Lovelace Okoro/);
  r = await doctor.post(`/doctor/appointments/${booked.id}/start`, {}, '/doctor');
  assert.equal(r.location, `/doctor/appointments/${booked.id}/consult`);
  const consultPage = await doctor.get(r.location);
  assert.equal(consultPage.status, 200);
  assert.match(consultPage.text, /data-room="UHS-/);

  // Validation: an incomplete prescription line is refused.
  r = await doctor.post(`/doctor/appointments/${booked.id}/complete`, {
    presenting_complaint: 'Fever', diagnosis: 'Malaria', drug_name: 'Paracetamol', dosage: '', frequency: '', duration: '',
  }, `/doctor/appointments/${booked.id}/consult`);
  assert.equal(r.status, 400);

  const followUp = t.toDate(t.addDays(new Date(), 7));
  r = await doctor.post(`/doctor/appointments/${booked.id}/complete`, {
    presenting_complaint: 'Fever for two days', diagnosis: 'Uncomplicated malaria', plan: 'Rest and fluids',
    drug_name: ['Artemether-lumefantrine', 'Paracetamol'], dosage: ['1 tablet', '1 g'], frequency: ['12-hourly', '8-hourly'],
    duration: ['3 days', '3 days'], instructions: ['With food', ''],
    follow_up_date: followUp, follow_up_note: 'Message me if the fever continues.',
  }, `/doctor/appointments/${booked.id}/consult`);
  assert.equal(r.status, 302, r.text.slice(0, 800));
  assert.equal(db.get('SELECT status FROM appointments WHERE id = ?', booked.id).status, 'completed');
  const consult = db.get('SELECT * FROM consultations WHERE appointment_id = ?', booked.id);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM prescriptions WHERE consultation_id = ?', consult.id).n, 2);

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
  assert.match((await doctor.get(thread)).text, /Thank you doctor/);

  // Another patient cannot read this thread.
  const other = new Client(base);
  await other.post('/register', { ...patientForm, full_name: 'Bayo Other', id_number: '300200', date_of_birth: '2001-01-01', phone: '08099999999', email: 'bayo@stu.ui.edu.ng' }, '/register');
  assert.equal((await other.get(thread)).status, 404);
});

test('records office registers a walk-in, flags duplicates and records vitals', async () => {
  const nurse = new Client(base);
  await nurse.login('nurse@test.ng');
  const form = { full_name: 'Musa Danjuma', category: 'student', id_number: '400100', date_of_birth: '2002-02-02', gender: 'male', phone: '08055555555' };
  let r = await nurse.post('/records/patients/new', form, '/records/patients/new');
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const pid = Number(r.location.split('/').pop());

  // Same name + DOB with a different ID number: warning first, allowed after confirmation.
  r = await nurse.post('/records/patients/new', { ...form, id_number: '400101', phone: '' }, '/records/patients/new');
  assert.equal(r.status, 400);
  assert.match(r.text, /Possible duplicate/);
  r = await nurse.post('/records/patients/new', { ...form, id_number: '400101', phone: '', confirm_not_duplicate: '1' }, '/records/patients/new');
  assert.equal(r.status, 302);

  // Same ID number is always blocked.
  r = await nurse.post('/records/patients/new', { ...form, full_name: 'Someone Different', confirm_not_duplicate: '1' }, '/records/patients/new');
  assert.equal(r.status, 400);

  r = await nurse.post(`/records/patients/${pid}/walk-in`, { reason: 'Headache', doctor_id: '' }, `/patients/${pid}`);
  assert.equal(r.location, '/records');
  assert.equal(db.get("SELECT status FROM appointments WHERE patient_id = ? AND booked_via = 'walk_in'", pid).status, 'checked_in');

  r = await nurse.post(`/records/patients/${pid}/vitals`, { systolic: '120', diastolic: '80', temperature: '37.2' }, `/patients/${pid}`);
  assert.equal(r.status, 302);
  assert.ok(db.get('SELECT id FROM vitals WHERE patient_id = ?', pid));

  // Out-of-range vitals are refused.
  await nurse.post(`/records/patients/${pid}/vitals`, { temperature: '98.6' }, `/patients/${pid}`);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM vitals WHERE patient_id = ?', pid).n, 1);

  // Nurses do not see consultation notes.
  const page = await nurse.get(`/patients/${pid}`);
  assert.match(page.text, /visible to doctors only/);

  // Enabling online access issues a temporary password that must be changed.
  r = await nurse.post(`/records/patients/${pid}/online-access`, { email: 'musa@stu.ui.edu.ng' }, `/patients/${pid}`);
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
  await admin.login('admin@test.ng');
  const dash = await admin.get('/admin');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Peak hours/);
  assert.equal((await admin.get('/admin/audit')).status, 200);
  assert.equal((await admin.get('/admin/outbox')).status, 200);

  let r = await admin.post('/admin/users/new', { role: 'doctor', full_name: 'Dr New Person', email: 'new.doc@test.ng', specialty: 'GP' }, '/admin/users/new');
  assert.equal(r.status, 200);
  assert.match(r.text, /Temporary password/);

  // Deactivated accounts cannot sign in.
  const id = db.get("SELECT id FROM users WHERE email = 'new.doc@test.ng'").id;
  r = await admin.post(`/admin/users/${id}/toggle`, {}, '/admin/users');
  assert.equal(db.get('SELECT is_active FROM users WHERE id = ?', id).is_active, 0);

  // Admins never see clinical records.
  assert.equal((await admin.get('/patients/1')).status, 403);
});
