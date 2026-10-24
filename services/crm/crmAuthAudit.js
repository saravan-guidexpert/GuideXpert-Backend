'use strict';

const CrmAuthAuditLog = require('../../models/CrmAuthAuditLog');
const { sanitizeAuditValue } = require('./auditService');
const { requestMeta } = require('../../utils/crmHttp');

async function insertAuthAuditDocument(doc, session) {
  const created = await CrmAuthAuditLog.create([doc], session ? { session } : undefined);
  return created[0];
}

let writeAuthAuditDocument = insertAuthAuditDocument;

function setAuthAuditWriterForTests(writer) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CRM test auth audit writer is refused in production.');
  }
  writeAuthAuditDocument = writer || insertAuthAuditDocument;
}

function resetAuthAuditWriterForTests() {
  if (process.env.NODE_ENV === 'production') return;
  writeAuthAuditDocument = insertAuthAuditDocument;
}

async function writeAuthAudit(entry, req, session) {
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
  return writeAuthAuditDocument(doc, session);
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
  setAuthAuditWriterForTests,
  resetAuthAuditWriterForTests,
};
