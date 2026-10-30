const db = require('../db');

/** Load the signed-in user (if any) onto req.user for every request. */
async function loadUser(req, res, next) {
  const id = req.session?.userId;
  if (id) {
    const user = await db.get(
      'SELECT id, role, full_name, email, phone, specialty, is_active, must_change_password, email_verified FROM users WHERE id = ?',
      id
    );
    if (user && user.is_active) {
      req.user = user;
    } else {
      // Account removed or deactivated since login: end the session.
      return req.session.destroy(() => res.redirect(loginPathFor(res.locals.portal)));
    }
  }
  res.locals.currentUser = req.user || null;
  next();
}

/** Patients sign in on the public site, staff in the staff portal. */
function loginPathFor(portal) {
  return portal === 'staff' ? '/staff/login' : '/login';
}

/**
 * Requests a page makes by itself, as opposed to user actions: live updates (they send "X-Live: 1") and the
 * photos in a conversation, which the browser loads as they arrive.
 */
function isBackground(req) {
  return req.get('x-live') === '1' || /^(\/staff)?\/messages\/\d+\/\d+\/images\/\d+$/.test(req.path);
}

/** A page the user opened (a browser asks for HTML), not something a script or image tag fetched. */
function isPageView(req) {
  return req.method === 'GET' && !isBackground(req) && (req.get('accept') || '').includes('text/html');
}

function requireAuth(req, res, next) {
  if (!req.user) {
    // Return there after signing in, unless it was a script's request for data, which is no page to land on.
    if (req.accepts(['html', 'json']) === 'html') req.session.returnTo = req.originalUrl;
    return res.redirect(loginPathFor(res.locals.portal));
  }
  // Staff-created accounts start with a temporary password that must be changed.
  const passwordPage = `${res.locals.base}/account/password`;
  const path = req.originalUrl.split('?')[0];
  if (req.user.must_change_password && path !== passwordPage && path !== '/logout') {
    return res.redirect(passwordPage);
  }
  // Patients who registered themselves confirm their email address before using the service.
  if (req.user.role === 'patient' && !req.user.email_verified && path !== '/logout' && !path.startsWith('/verify-email')) {
    return res.redirect('/verify-email');
  }
  next();
}

/** Allow only the given roles. Use after requireAuth. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).render('error', { title: 'Access denied', message: 'You do not have permission to view this page.' });
    }
    next();
  };
}

/** Where each role lands after signing in. */
function homeFor(user) {
  return { patient: '/patient', doctor: '/staff/doctor', nurse: '/staff/records', admin: '/staff/admin' }[user.role] || '/';
}

module.exports = { loadUser, requireAuth, requireRole, homeFor, loginPathFor, isBackground, isPageView };
