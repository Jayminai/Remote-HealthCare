// Patient record helpers: creation with a unique UHS number, input checks and
// duplicate detection (a key problem with the paper-based system).
const crypto = require('node:crypto');
const db = require('../db');
const v = require('../utils/validate');
const { isValidDate, toDate } = require('../utils/time');

const CATEGORIES = ['student', 'staff', 'dependant', 'other'];
const GENDERS = ['male', 'female'];
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const GENOTYPES = ['AA', 'AS', 'AC', 'SS', 'SC'];

/** "Adeyemi  Tolu-Grace" and "tolu grace adeyemi" both become "adeyemi grace tolu". */
function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** Last 10 digits, so +2348031234567 and 08031234567 compare equal. */
function normalisePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Find existing records that may belong to the same person.
 * Returns [{ patient, reasons: [...] }].
 */
async function findPossibleDuplicates({ id_number, full_name, date_of_birth, phone }, excludeId = null) {
  const found = new Map();
  const add = (p, reason) => {
    if (p.id === excludeId) return;
    if (!found.has(p.id)) found.set(p.id, { patient: p, reasons: [] });
    found.get(p.id).reasons.push(reason);
  };

  if (id_number) {
    const p = await db.get('SELECT * FROM patients WHERE id_number = ?', id_number);
    if (p) add(p, 'Same matric/staff number');
  }
  if (date_of_birth && full_name) {
    const target = normaliseName(full_name);
    for (const p of await db.all('SELECT * FROM patients WHERE date_of_birth = ?', date_of_birth)) {
      if (normaliseName(p.full_name) === target) add(p, 'Same name and date of birth');
    }
  }
  const ph = normalisePhone(phone);
  if (ph.length >= 10) {
    for (const p of await db.all('SELECT * FROM patients WHERE phone IS NOT NULL')) {
      if (normalisePhone(p.phone) === ph) add(p, 'Same phone number');
    }
  }
  return [...found.values()];
}

/** Read and validate patient demographic fields from a form body. */
function readPatientForm(body) {
  const data = {
    full_name: v.str(body.full_name, 120),
    id_number: v.opt(body.id_number, 40)?.toUpperCase() ?? null,
    category: v.str(body.category),
    date_of_birth: v.str(body.date_of_birth, 10),
    gender: v.str(body.gender),
    phone: v.opt(body.phone, 20),
    email: v.opt(body.email, 120)?.toLowerCase() ?? null,
    address: v.opt(body.address, 300),
    faculty_department: v.opt(body.faculty_department, 120),
    blood_group: v.opt(body.blood_group, 3),
    genotype: v.opt(body.genotype, 2),
    allergies: v.opt(body.allergies, 500),
    chronic_conditions: v.opt(body.chronic_conditions, 500),
    emergency_contact_name: v.opt(body.emergency_contact_name, 120),
    emergency_contact_phone: v.opt(body.emergency_contact_phone, 20),
    legacy_file_no: v.opt(body.legacy_file_no, 40),
  };

  const errors = [];
  if (data.full_name.length < 3) errors.push('Enter the full name.');
  if (!CATEGORIES.includes(data.category)) errors.push('Choose a patient category.');
  if (!GENDERS.includes(data.gender)) errors.push('Choose a gender.');
  if (!isValidDate(data.date_of_birth) || data.date_of_birth > toDate()) errors.push('Enter a valid date of birth.');
  if ((data.category === 'student' || data.category === 'staff') && !data.id_number) {
    errors.push('Students and staff must provide a matric or staff number.');
  }
  if (data.phone && !v.isPhone(data.phone)) errors.push('Enter a valid phone number.');
  if (data.email && !v.isEmail(data.email)) errors.push('Enter a valid email address.');
  if (data.emergency_contact_phone && !v.isPhone(data.emergency_contact_phone)) errors.push('Enter a valid emergency contact phone.');
  if (data.blood_group && !BLOOD_GROUPS.includes(data.blood_group)) errors.push('Invalid blood group.');
  if (data.genotype && !GENOTYPES.includes(data.genotype)) errors.push('Invalid genotype.');
  return { data, errors };
}

/** Insert a patient and assign the next UHS number. Returns the new id. */
async function createPatient(data, createdBy) {
  return db.tx(async () => {
    const id = await db.insert('patients', {
      ...data,
      uhs_number: `TMP-${crypto.randomUUID()}`,
      created_by: createdBy,
    });
    const year = new Date().getFullYear();
    await db.update('patients', id, { uhs_number: `UHS-${year}-${String(id).padStart(6, '0')}` });
    return id;
  });
}

async function patientForUser(userId) {
  return db.get('SELECT * FROM patients WHERE user_id = ?', userId);
}

/** Search by name, UHS number, matric/staff number, phone or old paper file number. */
async function searchPatients(q) {
  const like = `%${q}%`;
  return db.all(
    `SELECT * FROM patients
      WHERE full_name LIKE ? OR uhs_number LIKE ? OR id_number LIKE ? OR phone LIKE ? OR legacy_file_no LIKE ?
      ORDER BY full_name LIMIT 50`,
    like, like, like, like, like
  );
}

module.exports = {
  CATEGORIES, GENDERS, BLOOD_GROUPS, GENOTYPES,
  normaliseName, normalisePhone, findPossibleDuplicates, readPatientForm, createPatient, patientForUser, searchPatients,
};
