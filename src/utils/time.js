// Date helpers. All dates are stored as local-time strings so they sort
// correctly as text:  date 'YYYY-MM-DD', datetime 'YYYY-MM-DD HH:MM[:SS]'.

const pad = (n) => String(n).padStart(2, '0');

function toDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toDateTime(d = new Date(), withSeconds = false) {
  const base = `${toDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

/** Current local timestamp with seconds, used for created_at etc. */
function now() {
  return toDateTime(new Date(), true);
}

/** Parse 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM[:SS]' as local time. */
function parse(str) {
  if (!str) return null;
  const [datePart, timePart = '00:00:00'] = String(str).split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss = 0] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, ss);
}

function addMinutes(d, minutes) {
  return new Date(d.getTime() + minutes * 60 * 1000);
}

function addDays(d, days) {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function isValidDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return false;
  const d = parse(str);
  return toDate(d) === str;
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(min) {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

function minutesBetween(a, b) {
  return Math.round((parse(b) - parse(a)) / 60000);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Wed 29 Oct 2026' */
function fmtDate(str) {
  const d = parse(str);
  if (!d || isNaN(d)) return '';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** 'Wed 29 Oct 2026, 09:20' */
function fmtDateTime(str) {
  if (!str) return '';
  return `${fmtDate(str)}, ${String(str).slice(11, 16)}`;
}

function age(dob) {
  const d = parse(dob);
  if (!d) return '';
  const today = new Date();
  let a = today.getFullYear() - d.getFullYear();
  if (today.getMonth() < d.getMonth() || (today.getMonth() === d.getMonth() && today.getDate() < d.getDate())) a--;
  return a;
}

module.exports = {
  toDate, toDateTime, now, parse, addMinutes, addDays, isValidDate,
  timeToMinutes, minutesToTime, minutesBetween, fmtDate, fmtDateTime, age,
};
