const db = require('../db');

/**
 * Record an action in the audit log.
 * `req` may be null for system actions (e.g. the reminder job).
 */
async function audit(req, action, entity = null, entityId = null, details = null) {
  await db.insert('audit_log', {
    user_id: req?.user?.id ?? null,
    action,
    entity,
    entity_id: entityId,
    details: details && typeof details === 'object' ? JSON.stringify(details) : details,
    ip: req?.ip ?? null,
  });
}

module.exports = { audit };
