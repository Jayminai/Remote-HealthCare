// Test helpers. Each test file runs in its own process with its own temporary
// database file, deleted when the process exits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbFile = path.join(os.tmpdir(), `uhs-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
process.env.SESSION_SECRET = 'test-secret';
delete process.env.TURSO_DATABASE_URL; // never run tests against a hosted database

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const t = require('../src/utils/time');
const appts = require('../src/services/appointments');

process.on('exit', () => {
  db.client.close();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(dbFile + suffix, { force: true }); } catch { /* still locked on Windows; temp dir is cleaned by the OS */ }
  }
});

const HASH = bcrypt.hashSync('Passw0rd1', 4);

async function makeUser(role, email, extra = {}) {
  return db.insert('users', { role, full_name: extra.full_name || `Test ${role}`, email, password_hash: HASH, ...extra });
}

/** Next clinic day strictly after today (so every slot is in the future). */
function nextClinicDay() {
  for (let i = 1; i <= 10; i++) {
    const d = t.toDate(t.addDays(new Date(), i));
    if (appts.isClinicDay(d)) return d;
  }
  throw new Error('No clinic day found in the next 10 days');
}

/** Minimal browser: keeps the session cookie and reads CSRF tokens from pages. */
class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async request(method, path, form) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
        else params.append(k, v);
      }
      body = params.toString();
    }
    const res = await fetch(this.base + path, { method, headers, body, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text };
  }

  get(path) {
    return this.request('GET', path);
  }

  /** GET a page to obtain a CSRF token, then POST the form with it. */
  async post(path, form = {}, tokenPage = '/login') {
    const page = await this.get(tokenPage);
    const m = page.text.match(/name="_csrf" value="([a-f0-9]+)"/);
    return this.request('POST', path, { _csrf: m ? m[1] : '', ...form });
  }

  /** Sign in on the patient website (loginPath '/login') or the staff portal ('/staff/login'). */
  async login(email, password = 'Passw0rd1', loginPath = '/login') {
    const page = await this.get(loginPath);
    const token = page.text.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
    return this.request('POST', loginPath, { _csrf: token, email, password });
  }

  staffLogin(email, password = 'Passw0rd1') {
    return this.login(email, password, '/staff/login');
  }
}

module.exports = { db, t, appts, makeUser, nextClinicDay, Client };
