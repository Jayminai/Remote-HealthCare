-- UHS Telemedicine database schema (SQLite).
-- All timestamps are local time (Africa/Lagos) text: 'YYYY-MM-DD HH:MM[:SS]'.

-- Every person who can sign in: patients, doctors, nurses/records officers, admins.
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  role                 TEXT NOT NULL CHECK (role IN ('patient', 'doctor', 'nurse', 'admin')),
  full_name            TEXT NOT NULL,
  email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone                TEXT,
  specialty            TEXT,                       -- doctors only
  password_hash        TEXT NOT NULL,
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0, -- set for accounts created by staff
  email_verified       INTEGER NOT NULL DEFAULT 1, -- 0 until a self-registered patient confirms their email
  last_login_at        TEXT,
  created_at           TEXT NOT NULL
);

-- The electronic medical record "folder". A patient may exist without an online
-- account (e.g. a walk-in registered by the records office).
CREATE TABLE IF NOT EXISTS patients (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 INTEGER UNIQUE REFERENCES users(id),
  uhs_number              TEXT NOT NULL UNIQUE,     -- e.g. UHS-2026-000012
  id_number               TEXT UNIQUE COLLATE NOCASE, -- matric or staff number
  category                TEXT NOT NULL CHECK (category IN ('student', 'staff', 'dependant', 'other')),
  full_name               TEXT NOT NULL,
  date_of_birth           TEXT NOT NULL,
  gender                  TEXT NOT NULL CHECK (gender IN ('male', 'female')),
  phone                   TEXT,
  email                   TEXT,
  address                 TEXT,
  faculty_department      TEXT,
  blood_group             TEXT,
  genotype                TEXT,
  allergies               TEXT,
  chronic_conditions      TEXT,
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  legacy_file_no          TEXT,                     -- number on the old paper folder
  digitised_at            TEXT,                     -- when the paper file was fully captured
  created_by              INTEGER REFERENCES users(id),
  updated_at              TEXT,
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patients_dob ON patients(date_of_birth);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(full_name);

CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id    INTEGER NOT NULL REFERENCES patients(id),
  doctor_id     INTEGER REFERENCES users(id),       -- NULL = walk-in not yet picked by a doctor
  mode          TEXT NOT NULL CHECK (mode IN ('video', 'audio', 'in_person')),
  scheduled_at  TEXT NOT NULL,                      -- booked slots 'YYYY-MM-DD HH:MM'; walk-ins include seconds
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'booked'
                CHECK (status IN ('booked', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show')),
  booked_via    TEXT NOT NULL CHECK (booked_via IN ('online', 'phone', 'walk_in')),
  room_id       TEXT UNIQUE,                        -- private video room for remote consultations
  checked_in_at TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  cancel_reason TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appt_time ON appointments(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);
-- A doctor can never be double-booked into the same slot.
CREATE UNIQUE INDEX IF NOT EXISTS ux_doctor_slot ON appointments(doctor_id, scheduled_at)
  WHERE status <> 'cancelled';

-- Triage / vital signs, usually taken by a nurse at check-in.
CREATE TABLE IF NOT EXISTS vitals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id       INTEGER NOT NULL REFERENCES patients(id),
  appointment_id   INTEGER REFERENCES appointments(id),
  systolic         INTEGER,
  diastolic        INTEGER,
  temperature      REAL,
  pulse            INTEGER,
  respiratory_rate INTEGER,
  weight_kg        REAL,
  height_cm        REAL,
  notes            TEXT,
  recorded_by      INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL
);

-- Doctor's clinical note for one encounter.
CREATE TABLE IF NOT EXISTS consultations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id       INTEGER UNIQUE REFERENCES appointments(id),
  patient_id           INTEGER NOT NULL REFERENCES patients(id),
  doctor_id            INTEGER NOT NULL REFERENCES users(id),
  presenting_complaint TEXT NOT NULL,
  history              TEXT,
  examination          TEXT,
  diagnosis            TEXT NOT NULL,
  plan                 TEXT,
  follow_up_date       TEXT,
  follow_up_note       TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consult_patient ON consultations(patient_id);

CREATE TABLE IF NOT EXISTS prescriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_id INTEGER NOT NULL REFERENCES consultations(id),
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  doctor_id       INTEGER NOT NULL REFERENCES users(id),
  drug_name       TEXT NOT NULL,
  dosage          TEXT NOT NULL,
  frequency       TEXT NOT NULL,
  duration        TEXT NOT NULL,
  instructions    TEXT,
  created_at      TEXT NOT NULL
);

-- History captured from the old paper folders (digitisation) or other sources.
CREATE TABLE IF NOT EXISTS record_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  INTEGER NOT NULL REFERENCES patients(id),
  entry_date  TEXT NOT NULL,
  entry_type  TEXT NOT NULL CHECK (entry_type IN
              ('past_visit', 'diagnosis', 'medication', 'lab_result', 'immunisation', 'surgery', 'note')),
  summary     TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('paper_file', 'patient_report', 'external')),
  recorded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);

-- Secure messages between a patient and a doctor (one thread per pair).
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id  INTEGER NOT NULL REFERENCES users(id),
  sender_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(patient_id, doctor_id);

-- A photo sent in a conversation (e.g. a medicine the patient bought). Kept in the database because serverless
-- hosting has no lasting file storage. The browser shrinks photos before sending, so each is small.
CREATE TABLE IF NOT EXISTS message_images (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL UNIQUE REFERENCES messages(id),
  content_type TEXT NOT NULL,  -- image/jpeg, image/png, image/webp or image/gif
  data         BLOB NOT NULL,
  created_at   TEXT NOT NULL
);

-- A quick video or audio call a doctor starts from a conversation with a patient. Only doctors can start one;
-- the patient is notified and joins. Each call has its own private room, and counts as over once the doctor
-- ends it or an hour after it started.
CREATE TABLE IF NOT EXISTS quick_calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id  INTEGER NOT NULL REFERENCES users(id),
  mode       TEXT NOT NULL CHECK (mode IN ('video', 'audio')),
  room_id    TEXT NOT NULL UNIQUE,  -- 24 random hex characters
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quick_calls_thread ON quick_calls(patient_id, doctor_id);

-- "Typing…" indicator for an open conversation. Kept in the database (not in memory) because
-- on serverless hosting the two people may be served by different instances.
CREATE TABLE IF NOT EXISTS typing (
  patient_id INTEGER NOT NULL,
  doctor_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  at         INTEGER NOT NULL,  -- milliseconds since epoch
  PRIMARY KEY (patient_id, doctor_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

-- Guarantees each reminder is sent only once, even if the job runs repeatedly.
CREATE TABLE IF NOT EXISTS reminders_sent (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type   TEXT NOT NULL,   -- 'appointment' | 'consultation'
  ref_id     INTEGER NOT NULL,
  kind       TEXT NOT NULL,   -- '24h' | '1h' | 'follow_up'
  created_at TEXT NOT NULL,
  UNIQUE (ref_type, ref_id, kind)
);

-- Every email the system sends (or would send if SMTP is not configured).
CREATE TABLE IF NOT EXISTS email_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('logged', 'sent', 'failed')),
  error      TEXT,
  created_at TEXT NOT NULL
);

-- Who did what, and when. Used for accountability on patient records.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  details    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);

-- Login sessions (so users stay signed in when the server restarts).
CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,  -- milliseconds since epoch
  data    TEXT NOT NULL
);

-- One-time "forgot password" links for patients. Only a hash of the token is stored,
-- so the link cannot be rebuilt from the database.
CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

-- "Confirm your email" links sent to patients who register themselves. Only the newest
-- link for a user works; the rows are deleted once the address is confirmed.
CREATE TABLE IF NOT EXISTS email_verifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
