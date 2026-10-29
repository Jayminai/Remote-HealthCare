const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, t, appts, makeUser, nextClinicDay } = require('./helpers');
const patients = require('../src/services/patients');
const { runReminders } = require('../src/services/reminders');
const { localPath, passwordProblem } = require('../src/utils/validate');

const nurse = makeUser('nurse', 'nurse@test.ng');
const docA = makeUser('doctor', 'a@test.ng', { full_name: 'Dr A' });
const docB = makeUser('doctor', 'b@test.ng', { full_name: 'Dr B' });
const base = { category: 'student', gender: 'female', date_of_birth: '2003-04-12' };
const p1 = patients.createPatient({ ...base, full_name: 'Tolulope Grace Adeyemi', id_number: '215634', phone: '+2348031234567' }, nurse);
const p2 = patients.createPatient({ ...base, full_name: 'Second Patient', id_number: '215635' }, nurse);

test('time helpers format and validate dates', () => {
  assert.equal(t.isValidDate('2026-02-30'), false);
  assert.equal(t.isValidDate('2026-02-28'), true);
  assert.equal(t.fmtDate('2026-10-29'), 'Thu 29 Oct 2026');
  assert.equal(t.minutesBetween('2026-10-29 08:00', '2026-10-29 09:15'), 75);
});

test('UHS numbers are generated in sequence', () => {
  const p = db.get('SELECT uhs_number FROM patients WHERE id = ?', p1);
  assert.match(p.uhs_number, /^UHS-\d{4}-000001$/);
});

test('duplicate detection matches ID, reordered names and phone formats', () => {
  const byName = patients.findPossibleDuplicates({ full_name: 'adeyemi tolulope-grace', date_of_birth: '2003-04-12' });
  assert.equal(byName.length, 1);
  assert.deepEqual(byName[0].reasons, ['Same name and date of birth']);

  const byPhone = patients.findPossibleDuplicates({ full_name: 'Someone Else', date_of_birth: '1990-01-01', phone: '0803 123 4567' });
  assert.deepEqual(byPhone[0].reasons, ['Same phone number']);

  const byId = patients.findPossibleDuplicates({ id_number: '215634' });
  assert.equal(byId[0].patient.id, p1);

  assert.equal(patients.findPossibleDuplicates({ full_name: 'New Person', date_of_birth: '2001-01-01' }).length, 0);
});

test('patient form validation requires an ID number for students', () => {
  const { errors } = patients.readPatientForm({ full_name: 'Abc Def', category: 'student', gender: 'male', date_of_birth: '2002-01-01' });
  assert.ok(errors.some((e) => e.includes('matric')));
});

test('slots respect clinic hours and the booking window', () => {
  const times = appts.slotTimes();
  assert.equal(times[0], '08:00');
  assert.equal(times.at(-1), '15:40'); // last 20-minute slot that ends by 16:00
  assert.ok(appts.dateProblem('2000-01-01'));
  assert.ok(appts.dateProblem(t.toDate(t.addDays(new Date(), 60))));
});

test('booking assigns the least busy doctor and prevents double-booking', () => {
  const date = nextClinicDay();
  const first = appts.book({ patientId: p1, mode: 'video', date, time: '09:00', reason: 'Fever', bookedVia: 'online', createdBy: nurse });
  const second = appts.book({ patientId: p2, mode: 'in_person', date, time: '09:00', reason: 'Cough', bookedVia: 'phone', createdBy: nurse });
  const a1 = db.get('SELECT * FROM appointments WHERE id = ?', first);
  const a2 = db.get('SELECT * FROM appointments WHERE id = ?', second);
  assert.notEqual(a1.doctor_id, a2.doctor_id, 'two doctors share the 09:00 slot');
  assert.ok(a1.room_id, 'remote appointments get a private room');
  assert.equal(a2.room_id, null);

  // Both doctors are now busy at 09:00.
  assert.ok(!appts.availableSlots(date).some((s) => s.time === '09:00'));
  assert.throws(
    () => appts.book({ patientId: p2, mode: 'video', date, time: '09:00', reason: 'Again', bookedVia: 'online', createdBy: nurse }),
    appts.BookingError
  );
  // The database itself refuses a clash even if application checks are bypassed.
  assert.throws(() => db.insert('appointments', {
    patient_id: p2, doctor_id: a1.doctor_id, mode: 'video', scheduled_at: a1.scheduled_at, reason: 'x', booked_via: 'online',
  }), /UNIQUE/);
  // Cancelling frees the slot again.
  appts.cancel(appts.getFull(first), 'test');
  assert.ok(appts.availableSlots(date, a1.doctor_id).some((s) => s.time === '09:00'));
});

test('a patient cannot book two appointments at the same time', () => {
  const date = nextClinicDay();
  appts.book({ patientId: p1, doctorId: docA, mode: 'in_person', date, time: '10:00', reason: 'Visit', bookedVia: 'online', createdBy: nurse });
  assert.throws(
    () => appts.book({ patientId: p1, doctorId: docB, mode: 'in_person', date, time: '10:00', reason: 'Visit', bookedVia: 'online', createdBy: nurse }),
    /already has an appointment/
  );
});

test('reminders are sent once per appointment and kind', () => {
  const inTwoHours = t.addMinutes(new Date(), 120);
  const id = db.insert('appointments', {
    patient_id: p2, doctor_id: docB, mode: 'video', scheduled_at: t.toDateTime(inTwoHours),
    reason: 'Reminder test', booked_via: 'online', status: 'booked',
  });
  const before = db.get("SELECT COUNT(*) AS n FROM reminders_sent WHERE ref_id = ? AND ref_type = 'appointment'", id).n;
  runReminders();
  runReminders();
  const after = db.all("SELECT kind FROM reminders_sent WHERE ref_id = ? AND ref_type = 'appointment'", id);
  assert.equal(before, 0);
  assert.deepEqual(after.map((r) => r.kind), ['24h']);
  // An hour later the 1-hour reminder goes out too.
  runReminders(t.addMinutes(new Date(), 65));
  assert.deepEqual(db.all("SELECT kind FROM reminders_sent WHERE ref_id = ? AND ref_type = 'appointment' ORDER BY id", id).map((r) => r.kind), ['24h', '1h']);
});

test('only local redirect paths are allowed', () => {
  assert.equal(localPath('/patient', '/x'), '/patient');
  assert.equal(localPath('//evil.example', '/x'), '/x');
  assert.equal(localPath('/\\evil.example', '/x'), '/x');
  assert.equal(localPath('https://evil.example', '/x'), '/x');
});

test('password policy', () => {
  assert.ok(passwordProblem('short1'));
  assert.ok(passwordProblem('lettersonly'));
  assert.equal(passwordProblem('Letters123'), null);
});

test('doctor title is added once', () => {
  assert.equal(appts.doctorTitle('Adewale Adebayo'), 'Dr Adewale Adebayo');
  assert.equal(appts.doctorTitle('Dr. Adewale Adebayo'), 'Dr. Adewale Adebayo');
  assert.equal(appts.doctorTitle('Dr Ada Obi'), 'Dr Ada Obi');
  assert.equal(appts.doctorTitle('Drake Bello'), 'Dr Drake Bello');
});
