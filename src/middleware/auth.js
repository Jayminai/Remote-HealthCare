const db = require('../db');

/** Load the signed-in user (if any) onto req.user for every request. */
async function loadUser(req, res, next) {
  const id = req.session?.userId;
  if (id) {
    const user = await db.get(
      'SELECT id, role, full_name, email, phone, specialty, is_active, must_change_password FROM users WHERE id = ?',
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

function requireAuth(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect(loginPathFor(res.locals.portal));
  }
  // Staff-created accounts start with a temporary password that must be changed.
  const passwordPage = `${res.locals.base}/account/password`;
  const path = req.originalUrl.split('?')[0];
  if (req.user.must_change_password && path !== passwordPage && path !== '/logout') {
    return res.redirect(passwordPage);
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

module.exports = { loadUser, requireAuth, requireRole, homeFor, loginPathFor };
