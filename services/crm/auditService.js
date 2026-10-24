'use strict';

const mongoose = require('mongoose');
const CrmAuditLog = require('../../models/CrmAuditLog');
const CrmConsultancyContact = require('../../models/CrmConsultancyContact');
const CrmReferral = require('../../models/CrmReferral');
const { parsePageLimit } = require('../../utils/crmHttp');
const { assignedConsultancyIds } = require('./crmAccess');

const SECRET_KEY = /password|token|otp|secret|authorization|mongodb|connection/i;

function sanitizeAuditValue(value, depth) {
  const level = depth || 0;
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (level > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeAuditValue(item, level + 1));
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((key) => {
      if (SECRET_KEY.test(key)) return;
      if (key.startsWith('_') && key !== '_id') return;
      out[key] = sanitizeAuditValue(value[key], level + 1);
    });
    return out;
  }
  return null;
}

let insertAuditDocument = async function insertAuditDocument(doc, session) {
  const options = session ? { session } : undefined;
  const created = await CrmAuditLog.create([doc], options);
  return created[0];
};

function setAuditWriterForTests(writer) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CRM test audit writer is refused in production.');
  }
  insertAuditDocument = writer || insertAuditDocument;
}

async function writeAudit(entry, session) {
  const doc = {
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    reason: entry.reason ? String(entry.reason).slice(0, 500) : '',
    before: sanitizeAuditValue(entry.before),
    after: sanitizeAuditValue(entry.after),
    ip: entry.ip || null,
    userAgent: entry.userAgent || null,
  };
  if (entry.actorAdminId) doc.actorAdminId = entry.actorAdminId;
  if (entry.actorCrmUserId) doc.actorCrmUserId = entry.actorCrmUserId;
  return insertAuditDocument(doc, session);
}

function resetAuditWriterForTests() {
  if (process.env.NODE_ENV === 'production') return;
  insertAuditDocument = async function defaultInsert(doc, session) {
    const options = session ? { session } : undefined;
    const created = await CrmAuditLog.create([doc], options);
    return created[0];
  };
}

async function businessAuditScope(consultancyIds) {
  if (consultancyIds == null) return {};
  const [contactIds, referrals] = await Promise.all([
    CrmConsultancyContact.find({ consultancyId: { $in: consultancyIds } }).distinct('_id'),
    CrmReferral.find({ consultancyId: { $in: consultancyIds } }).select('_id crmStudentId').lean(),
  ]);
  return {
    $or: [
      { entityType: 'consultancy', entityId: { $in: consultancyIds } },
      { entityType: 'consultancy_contact', entityId: { $in: contactIds } },
      { entityType: 'crmReferral', entityId: { $in: referrals.map((row) => row._id) } },
      { entityType: 'crmStudent', entityId: { $in: referrals.map((row) => row.crmStudentId) } },
    ],
  };
}

async function scopedAuditFilter(actor) {
  const consultancyIds = await assignedConsultancyIds(actor);
  return businessAuditScope(consultancyIds);
}

async function listAudits(query, actor) {
  const { page, limit, skip } = parsePageLimit(query);
  const filter = await scopedAuditFilter(actor);
  const [rows, total] = await Promise.all([
    CrmAuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    CrmAuditLog.countDocuments(filter),
  ]);
  return {
    items: rows.map((row) => ({
      id: String(row._id),
      actorAdminId: row.actorAdminId ? String(row.actorAdminId) : null,
      actorCrmUserId: row.actorCrmUserId ? String(row.actorCrmUserId) : null,
      action: row.action,
      entityType: row.entityType,
      entityId: String(row.entityId),
      reason: row.reason || '',
      before: row.before || null,
      after: row.after || null,
      createdAt: row.createdAt,
    })),
    page,
    limit,
    total,
  };
}

module.exports = {
  writeAudit,
  listAudits,
  businessAuditScope,
  sanitizeAuditValue,
  setAuditWriterForTests,
  resetAuditWriterForTests,
};
