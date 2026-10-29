// Resets the database and fills it with realistic demo data:
// staff accounts, patients (some only on "paper"), 30 days of appointment
// history for the dashboard, today's queue and upcoming bookings.
//
//   npm run seed
//
// WARNING: this deletes the existing database file.
const fs = require('node:fs');
const config = require('../config');

if (config.dbPath !== ':memory:') {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
}

const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const db = require('./index');
const t = require('../utils/time');
const appts = require('../services/appointments');
const { createPatient } = require('../services/patients');

// Deterministic random numbers so every seed produces the same data.
let seed = 20261029;
function rand() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const PASSWORDS = { admin: 'Admin@1234', doctor: 'Doctor@1234', nurse: 'Nurse@1234', patient: 'Patient@1234' };
const hashes = Object.fromEntries(Object.entries(PASSWORDS).map(([k, v]) => [k, bcrypt.hashSync(v, 10)]));
const created = t.toDateTime(t.addDays(new Date(), -60), true);

function user(role, full_name, email, extra = {}) {
  return db.insert('users', { role, full_name, email, password_hash: hashes[role], created_at: created, ...extra });
}

db.tx(() => {
  // ---- Staff ----------------------------------------------------------------
  user('admin', 'Mrs. Funmilayo Akinola', 'admin@uhs.ui.edu.ng', { phone: '08030000001' });
  const doctors = [
    user('doctor', 'Dr. Adewale Adebayo', 'dr.adebayo@uhs.ui.edu.ng', { specialty: 'General Practice', phone: '08030000002' }),
    user('doctor', 'Dr. Chiamaka Okafor', 'dr.okafor@uhs.ui.edu.ng', { specialty: 'Family Medicine', phone: '08030000003' }),
    user('doctor', 'Dr. Ibrahim Bello', 'dr.bello@uhs.ui.edu.ng', { specialty: 'Mental Health', phone: '08030000004' }),
  ];
  const nurse = user('nurse', 'Nurse Bisola Ojo', 'nurse.ojo@uhs.ui.edu.ng', { phone: '08030000005' });

  // ---- Patients -------------------------------------------------------------
  const people = [
    // [name, category, id_number, dob, gender, online?]
    ['Tolulope Adeyemi', 'student', '215634', '2003-04-12', 'female', true],
    ['Emeka Nwosu', 'student', '219871', '2002-11-03', 'male', true],
    ['Dr. Kehinde Oladipo', 'staff', 'UI/ST/04521', '1979-06-21', 'male', true],
    ['Aisha Mohammed', 'student', '220145', '2004-01-30', 'female', true],
    ['Oluwaseun Fashola', 'student', '217733', '2001-08-09', 'male', true],
    ['Ngozi Eze', 'staff', 'UI/ST/07812', '1985-02-14', 'female', true],
    ['Bukola Adesanya', 'student', '221009', '2004-09-17', 'female', true],
    ['Chinedu Obi', 'student', '218450', '2002-05-25', 'male', true],
    ['Yetunde Bakare', 'dependant', null, '2012-03-08', 'female', false],
    ['Musa Abdullahi', 'student', '216302', '2001-12-01', 'male', false],
    ['Folake Ogunleye', 'staff', 'UI/ST/03390', '1972-10-19', 'female', false],
    ['Ifeanyi Okeke', 'student', '222781', '2005-07-04', 'male', false],
    ['Grace Etim', 'student', '219004', '2003-02-22', 'female', false],
    ['Samuel Ajayi', 'staff', 'UI/ST/05127', '1968-04-30', 'male', false],
  ];
  // More students so the history looks like a real clinic population.
  const first = [['Adaeze', 'female'], ['Babatunde', 'male'], ['Damilola', 'female'], ['Femi', 'male'], ['Halima', 'female'],
    ['Kelechi', 'male'], ['Mariam', 'female'], ['Oluwatobi', 'male'], ['Precious', 'female'], ['Segun', 'male'],
    ['Temitope', 'female'], ['Uche', 'male'], ['Zainab', 'female'], ['Abiodun', 'male'], ['Funke', 'female'], ['Ikenna', 'male']];
  const last = ['Ogunbiyi', 'Okonkwo', 'Lawal', 'Balogun', 'Ibrahim', 'Nnamdi', 'Afolabi', 'Usman', 'Oyelaran', 'Chukwu', 'Adekunle', 'Salami'];
  for (let i = 0; i < 36; i++) {
    const [fn, gender] = first[i % first.length];
    const name = `${fn} ${last[(i * 5) % last.length]}`;
    const dob = `${between(1999, 2006)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`;
    people.push([name, 'student', String(223000 + i * 37), dob, gender, i % 3 !== 0]);
  }
  const patientIds = [];
  const onlinePatientIds = [];
  people.forEach(([name, category, idNo, dob, gender, online], i) => {
    const phone = `080${String(31000000 + i * 7919).padStart(8, '0')}`;
    const email = online
      ? `${name.toLowerCase().replace(/^dr\. /, '').split(' ').join('.')}${i >= 14 ? i : ''}@${category === 'student' ? 'stu.ui.edu.ng' : 'ui.edu.ng'}`
      : (i % 2 ? `${name.toLowerCase().split(' ')[0]}${i}@gmail.com` : null);
    const userId = online ? user('patient', name, email, { phone }) : null;
    const id = createPatient({
      user_id: userId, id_number: idNo, category, full_name: name, date_of_birth: dob, gender, phone, email,
      address: category === 'student' ? pick(['Independence Hall', 'Queen Elizabeth Hall', 'Mellanby Hall', 'Idia Hall', 'Kuti Hall', 'Tedder Hall']) : 'Staff Quarters, UI',
      faculty_department: category === 'dependant' ? null : pick(['Faculty of Science', 'Faculty of Arts', 'Faculty of Technology', 'Faculty of Law', 'College of Medicine', 'Faculty of Education']),
      blood_group: pick(['O+', 'O+', 'A+', 'B+', 'AB+', 'O-', null]),
      genotype: pick(['AA', 'AA', 'AS', 'AC', null]),
      allergies: i === 0 ? 'Penicillin' : i === 6 ? 'Sulfonamides' : null,
      chronic_conditions: i === 2 ? 'Hypertension' : i === 4 ? 'Asthma' : null,
      emergency_contact_name: 'Parent / spouse', emergency_contact_phone: `0809${String(5000000 + i * 131).padStart(7, '0')}`,
      legacy_file_no: online && i > 3 ? null : `UHS/PF/${1000 + i * 37}`,
      digitised_at: i < 4 || i === 9 ? created : null,
    }, nurse);
    db.run('UPDATE patients SET created_at = ? WHERE id = ?', created, id);
    patientIds.push(id);
    if (online) onlinePatientIds.push(id);
  });

  // History captured from paper files.
  const history = [
    [0, '2022-03-14', 'past_visit', 'Treated for malaria. Artemether-lumefantrine given.'],
    [0, '2021-10-02', 'immunisation', 'Hepatitis B vaccine, dose 2.'],
    [2, '2019-07-11', 'diagnosis', 'Diagnosed with essential hypertension.'],
    [2, '2023-01-20', 'medication', 'Amlodipine 5 mg daily (long-term).'],
    [4, '2020-09-05', 'diagnosis', 'Mild intermittent asthma. Salbutamol inhaler as needed.'],
    [9, '2023-05-18', 'lab_result', 'Full blood count normal. Widal test negative.'],
    [10, '2018-02-09', 'surgery', 'Appendicectomy at UCH, Ibadan.'],
  ];
  for (const [pi, date, type, summary] of history) {
    db.insert('record_entries', {
      patient_id: patientIds[pi], entry_date: date, entry_type: type, summary,
      source: type === 'surgery' ? 'external' : 'paper_file', recorded_by: nurse, created_at: created,
    });
  }

  // ---- Appointments ---------------------------------------------------------
  const cases = [
    ['Fever, headache and body aches for 3 days', 'Uncomplicated malaria', [['Artemether-lumefantrine 80/480 mg', '1 tablet', '12-hourly', '3 days', 'Take with food'], ['Paracetamol', '1 g', '8-hourly', '3 days', '']]],
    ['Cough, sore throat and catarrh', 'Upper respiratory tract infection', [['Paracetamol', '1 g', '8-hourly', '3 days', ''], ['Vitamin C', '200 mg', 'daily', '7 days', '']]],
    ['Epigastric pain, worse at night', 'Peptic ulcer disease', [['Omeprazole', '20 mg', 'daily before breakfast', '14 days', 'Avoid NSAIDs']]],
    ['Persistent headache during exams', 'Tension-type headache', [['Paracetamol', '1 g', 'as needed, max 4 g/day', '5 days', '']]],
    ['Diarrhoea and abdominal cramps', 'Acute gastroenteritis', [['Oral rehydration salts', '1 sachet in 1 L water', 'after each loose stool', '3 days', ''], ['Metronidazole', '400 mg', '8-hourly', '5 days', 'Avoid alcohol']]],
    ['Sneezing and itchy eyes', 'Allergic rhinitis', [['Loratadine', '10 mg', 'daily', '7 days', '']]],
    ['Poor sleep and worry about results', 'Anxiety related to academic stress', []],
    ['Blood pressure review', 'Hypertension – controlled', [['Amlodipine', '5 mg', 'daily', '30 days', 'Continue']]],
    ['Painful menstruation', 'Primary dysmenorrhoea', [['Ibuprofen', '400 mg', '8-hourly with food', '3 days', '']]],
    ['Itchy rash on the groin', 'Tinea cruris (fungal skin infection)', [['Clotrimazole 1% cream', 'thin layer', 'twice daily', '2 weeks', 'Keep area dry']]],
    ['Prolonged fever, abdominal discomfort', 'Suspected typhoid fever – for lab tests', [['Ciprofloxacin', '500 mg', '12-hourly', '7 days', '']]],
  ];
  // At most one appointment per patient per day, like a real clinic.
  const busy = new Set();
  function freePatient(date, pool) {
    for (let tries = 0; tries < 10; tries++) {
      const id = pick(pool);
      if (!busy.has(`${id}|${date}`)) {
        busy.add(`${id}|${date}`);
        return id;
      }
    }
    return null;
  }
  const hourWeight = (h) => (h < 10 ? 0.55 : h < 12 ? 0.38 : h < 14 ? 0.22 : 0.15);
  const nowDate = new Date();
  const nowStr = t.toDateTime(nowDate);

  function complete(apptId, patientId, doctorId, scheduled, mode) {
    const sched = t.parse(scheduled);
    const peak = sched.getHours() < 11;
    const checkedIn = t.addMinutes(sched, mode === 'in_person' ? -between(0, 15) : -between(0, 5));
    const wait = mode === 'in_person' ? between(peak ? 25 : 8, peak ? 70 : 30) : between(1, 9);
    const started = t.addMinutes(checkedIn, wait);
    const ended = t.addMinutes(started, between(8, 20));
    db.update('appointments', apptId, {
      status: 'completed', checked_in_at: t.toDateTime(checkedIn, true), started_at: t.toDateTime(started, true), ended_at: t.toDateTime(ended, true),
    });
    const [complaint, diagnosis, rx] = pick(cases);
    const cid = db.insert('consultations', {
      appointment_id: apptId, patient_id: patientId, doctor_id: doctorId, presenting_complaint: complaint,
      history: 'See complaint. No danger signs.', examination: mode === 'in_person' ? 'Alert, not pale, afebrile at review.' : 'Assessed by video/audio; patient alert and comfortable.',
      diagnosis, plan: 'Medication as prescribed. Return if symptoms worsen.', created_at: t.toDateTime(ended, true),
    });
    for (const [drug, dose, freq, dur, ins] of rx) {
      db.insert('prescriptions', { consultation_id: cid, patient_id: patientId, doctor_id: doctorId, drug_name: drug, dosage: dose, frequency: freq, duration: dur, instructions: ins || null, created_at: t.toDateTime(ended, true) });
    }
  }

  for (let offset = -30; offset <= 4; offset++) {
    const date = t.toDate(t.addDays(nowDate, offset));
    if (!appts.isClinicDay(date)) continue;
    for (const doctorId of doctors) {
      for (const time of appts.slotTimes()) {
        const scheduled = `${date} ${time}`;
        const past = scheduled < nowStr;
        const prob = hourWeight(Number(time.slice(0, 2))) * (past ? 1 : offset === 0 ? 0.8 : 0.35);
        if (rand() > prob) continue;

        let mode = pick(['in_person', 'in_person', 'in_person', 'video', 'video', 'audio']);
        const patientId = freePatient(date, mode === 'in_person' ? patientIds : onlinePatientIds);
        if (!patientId) continue;
        const hasAccount = onlinePatientIds.includes(patientId);
        if (!hasAccount) mode = 'in_person';
        const id = db.insert('appointments', {
          patient_id: patientId, doctor_id: doctorId, mode, scheduled_at: scheduled,
          reason: pick(cases)[0], status: 'booked',
          booked_via: hasAccount && rand() < 0.75 ? 'online' : 'phone',
          room_id: mode === 'in_person' ? null : crypto.randomBytes(12).toString('hex'),
          created_by: nurse,
          created_at: t.toDateTime(t.addDays(t.parse(scheduled), -between(1, 5)), true),
        });
        const r = rand();
        if (past) {
          if (r < 0.08) db.update('appointments', id, { status: 'no_show' });
          else if (r < 0.15) db.update('appointments', id, { status: 'cancelled', cancel_reason: 'Cancelled by patient' });
          else complete(id, patientId, doctorId, scheduled, mode);
        } else if (r < 0.05) {
          db.update('appointments', id, { status: 'cancelled', cancel_reason: 'Cancelled by patient' });
        }
      }
    }
    // Walk-ins on past days (mostly in the morning rush).
    if (offset < 0) {
      for (let w = between(2, 5); w > 0; w--) {
        const at = t.parse(`${date} ${String(between(8, 12)).padStart(2, '0')}:${String(between(0, 59)).padStart(2, '0')}:${String(between(0, 59)).padStart(2, '0')}`);
        const patientId = freePatient(date, patientIds);
        if (!patientId) continue;
        const doctorId = pick(doctors);
        const scheduled = t.toDateTime(at, true);
        const id = db.insert('appointments', {
          patient_id: patientId, doctor_id: doctorId, mode: 'in_person', scheduled_at: scheduled, reason: pick(cases)[0],
          status: 'checked_in', booked_via: 'walk_in', checked_in_at: scheduled, created_by: nurse, created_at: scheduled,
        });
        complete(id, patientId, doctorId, scheduled, 'in_person');
      }
    }
  }

  // A walk-in waiting in today's queue (only during clinic hours).
  if (appts.isClinicDay(t.toDate()) && nowStr.slice(11) >= config.clinic.open && nowStr.slice(11) < config.clinic.close) {
    const walkInPatient = patientIds.find((id) => !busy.has(`${id}|${t.toDate()}`));
    appts.walkIn({ patientId: walkInPatient, reason: 'Twisted ankle while playing football', createdBy: nurse });
    db.insert('vitals', { patient_id: walkInPatient, systolic: 118, diastolic: 76, temperature: 36.7, pulse: 82, weight_kg: 68, recorded_by: nurse });
  }

  // A follow-up conversation between the first patient and a doctor.
  const tolu = patientIds[0];
  const lastWithTolu = db.get(
    "SELECT doctor_id FROM appointments WHERE patient_id = ? AND status = 'completed' ORDER BY scheduled_at DESC LIMIT 1", tolu
  );
  const msgDoctor = lastWithTolu ? lastWithTolu.doctor_id : doctors[0];
  const tUser = db.get('SELECT user_id FROM patients WHERE id = ?', tolu).user_id;
  const msgs = [
    [msgDoctor, 3, 'Good morning Tolulope. How are you feeling after starting the medication?'],
    [tUser, 3, 'Good morning doctor. The fever has gone down but I still feel a bit weak.'],
    [msgDoctor, 2, 'That is expected for a few days. Complete the full course, drink plenty of fluids and rest. Book a review if you are not better by Friday.'],
  ];
  msgs.forEach(([sender, daysAgo, body], i) => {
    db.insert('messages', {
      patient_id: tolu, doctor_id: msgDoctor, sender_id: sender, body,
      read_at: i < 2 ? t.now() : null, created_at: t.toDateTime(t.addMinutes(t.addDays(nowDate, -daysAgo), i * 17), true),
    });
  });
});

const count = (sql) => db.get(sql).n;
console.log('Demo database created at', config.dbPath);
console.log(`  ${count('SELECT COUNT(*) AS n FROM patients')} patients, ${count('SELECT COUNT(*) AS n FROM appointments')} appointments, ${count('SELECT COUNT(*) AS n FROM consultations')} consultations`);
console.log('\nDemo sign-in accounts:');
console.log(`  Admin   admin@uhs.ui.edu.ng            ${PASSWORDS.admin}`);
console.log(`  Doctor  dr.adebayo@uhs.ui.edu.ng       ${PASSWORDS.doctor}   (also dr.okafor@, dr.bello@)`);
console.log(`  Nurse   nurse.ojo@uhs.ui.edu.ng        ${PASSWORDS.nurse}`);
console.log(`  Patient tolulope.adeyemi@stu.ui.edu.ng ${PASSWORDS.patient}   (also emeka.nwosu@stu.ui.edu.ng)`);
