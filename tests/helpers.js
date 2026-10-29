// Test helpers. Each test file runs in its own process with an in-memory database.
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const t = require('../src/utils/time');
const appts = require('../src/services/appointments');

const HASH = bcrypt.hashSync('Passw0rd1', 4);

function makeUser(role, email, extra = {}) {
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

  async login(email, password = 'Passw0rd1') {
    const page = await this.get('/login');
    const token = page.text.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
    return this.request('POST', '/login', { _csrf: token, email, password });
  }
}

module.exports = { db, t, appts, makeUser, nextClinicDay, Client };
