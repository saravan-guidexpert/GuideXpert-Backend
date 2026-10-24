'use strict';

const CrmAuthAuditLog = require('../../models/CrmAuthAuditLog');
const { sanitizeAuditValue } = require('./auditService');
const { requestMeta } = require('../../utils/crmHttp');

async function writeAuthAudit(entry, req) {
  const meta = requestMeta(req);
  const doc = {
    actorAdminId: entry.actorAdminId || null,
    actorCrmUserId: entry.actorCrmUserId || null,
    targetUserId: entry.targetUserId || null,
    action: String(entry.action || '').slice(0, 80),
    reason: entry.reason ? String(entry.reason).slice(0, 500) : '',
    before: sanitizeAuditValue(entry.before),
    after: sanitizeAuditValue(entry.after),
    ip: meta.ip,
    userAgent: meta.userAgent,
  };
  const created = await CrmAuthAuditLog.create(doc);
  return created;
}

function accountSnapshot(user) {
  if (!user) return null;
  return {
    fullName: user.fullName,
    email: user.email,
    username: user.username,
    role: user.role,
    permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
    status: user.status,
  };
}

module.exports = {
  writeAuthAudit,
  accountSnapshot,
};
