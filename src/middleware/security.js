const crypto = require('node:crypto');
const config = require('../config');

/** Security headers, including a Content Security Policy that only allows the video service. */
function securityHeaders(req, res, next) {
  const jitsi = `https://${config.jitsiDomain}`;
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      `script-src 'self' ${jitsi}`,
      `frame-src ${jitsi}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Camera/microphone are needed for consultations, delegated to the video service.
  res.setHeader('Permissions-Policy', `camera=(self "${jitsi}"), microphone=(self "${jitsi}"), display-capture=(self "${jitsi}"), geolocation=()`);
  // Never cache pages containing patient information.
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/** CSRF protection: every POST form must include the session's token. */
function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (req.method === 'POST') {
    const sent = String(req.body?._csrf || req.get('x-csrf-token') || '');
    const expected = req.session.csrfToken;
    const ok = sent.length === expected.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
    if (!ok) {
      return res.status(403).render('error', {
        title: 'Form expired',
        message: 'Your form session expired or was invalid. Please go back, refresh the page and try again.',
      });
    }
  }
  next();
}

/** Very small in-memory rate limiter for sign-in attempts. */
/**
 * Counts failed attempts per IP address and email. onLimit renders the page shown once the
 * limit is reached (by default the patient sign-in page).
 */
function loginLimiter({ max = 5, windowMs = 15 * 60 * 1000, onLimit } = {}) {
  const hits = new Map();
  const limiter = (req, res, next) => {
    const key = `${req.ip}|${String(req.body?.email || '').toLowerCase()}`;
    const nowMs = Date.now();
    const entry = hits.get(key);
    if (entry && nowMs - entry.first < windowMs && entry.count >= max) {
      const mins = Math.ceil((windowMs - (nowMs - entry.first)) / 60000);
      const error = `Too many attempts. Try again in ${mins} minute(s).`;
      res.status(429);
      if (onLimit) return onLimit(req, res, error);
      return res.render('auth/login', { title: 'Sign in', email: req.body?.email || '', error });
    }
    next();
  };
  limiter.fail = (req) => {
    const key = `${req.ip}|${String(req.body?.email || '').toLowerCase()}`;
    const nowMs = Date.now();
    const entry = hits.get(key);
    if (!entry || nowMs - entry.first >= windowMs) hits.set(key, { first: nowMs, count: 1 });
    else entry.count++;
  };
  limiter.reset = (req) => hits.delete(`${req.ip}|${String(req.body?.email || '').toLowerCase()}`);
  return limiter;
}

module.exports = { securityHeaders, csrf, loginLimiter };
