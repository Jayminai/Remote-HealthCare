// Small input-validation helpers used by the route handlers.

/** Trim a form value; returns '' for missing values and caps the length. */
function str(v, max = 500) {
  if (Array.isArray(v)) v = v[0];
  return v == null ? '' : String(v).trim().slice(0, max);
}

/** Like str() but returns null for empty strings (for optional DB columns). */
function opt(v, max = 500) {
  const s = str(v, max);
  return s === '' ? null : s;
}

/** Form fields that may repeat (e.g. prescription rows) arrive as string or array. */
function arr(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function int(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function num(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');
const isPhone = (s) => /^\+?[0-9 ()-]{7,20}$/.test(s || '') && (s.match(/\d/g) || []).length >= 7;

/** Returns an error message, or null if the password is acceptable. */
function passwordProblem(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain both letters and numbers.';
  return null;
}

/** Only allow redirects to paths on this site (blocks '//evil.com' and '/\evil.com'). */
function localPath(s, fallback) {
  s = str(s, 300);
  return /^\/(?![/\\])/.test(s) ? s : fallback;
}

module.exports = { str, opt, arr, int, num, isEmail, isPhone, passwordProblem, localPath };
