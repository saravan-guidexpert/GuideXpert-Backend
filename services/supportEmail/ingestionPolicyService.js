'use strict';

const Admin = require('../../models/Admin');
const EmailIngestionPolicy = require('../../models/EmailIngestionPolicy');
const SupportEmailAuditLog = require('../../models/SupportEmailAuditLog');
const { APPROVED_MAILBOX } = require('./mailboxScopeService');
const { ACTIVATION_TIME_ZONE, formatActivationLocal, parseActivationInput } = require('./activationTime');

const EARLIEST_ACTIVATION = Date.UTC(2020, 0, 1);
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

function coded(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status || 400;
  return error;
}

function inRange(date) {
  return date.getTime() >= EARLIEST_ACTIVATION && date.getTime() <= Date.now() + MAX_FUTURE_MS;
}

function sameInstant(left, right) {
  if (!left || !right) return false;
  return new Date(left).getTime() === new Date(right).getTime();
}

function publicPolicy(doc, configuredBy) {
  if (!doc) return null;
  const activationAt = doc.activationAt ? new Date(doc.activationAt) : null;
  return {
    mailbox: doc.mailbox,
    enabled: doc.enabled === true,
    status: doc.enabled === true ? 'enabled' : 'disabled',
    activationAt: activationAt && !Number.isNaN(activationAt.getTime()) ? activationAt : null,
    activationTimeZone: ACTIVATION_TIME_ZONE,
    activationLocal: activationAt ? formatActivationLocal(activationAt) : '',
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
    activationApprovedAt: doc.activationApprovedAt || null,
    configuredBy: configuredBy || null
  };
}

async function actorFor(adminId) {
  if (!adminId) return null;
  const admin = await Admin.findById(adminId).select('name username').lean();
  if (!admin) return { id: String(adminId), name: 'admin' };
  return { id: String(admin._id), name: admin.name || admin.username };
}

async function present(doc) {
  return publicPolicy(doc, await actorFor(doc && doc.activationApprovedBy));
}

function mailboxOf(body) {
  const mailbox = String(body.mailbox == null ? '' : body.mailbox).trim().toLowerCase();
  if (mailbox !== APPROVED_MAILBOX) throw coded('invalid_mailbox');
  return mailbox;
}

function explicitEnabled(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'enabled')) return undefined;
  if (typeof body.enabled !== 'boolean') throw coded('enabled_required');
  return body.enabled;
}

/**
 * Reads an activation value the caller supplied. An empty value means "not supplied",
 * never "use the current time".
 */
function readActivation(body) {
  if (body.activationAt == null || String(body.activationAt).trim() === '') return undefined;
  if (body.approveActivation !== true) throw coded('activation_not_approved');
  const activationAt = parseActivationInput(body.activationAt, body.timeZone || ACTIVATION_TIME_ZONE);
  if (!activationAt || !inRange(activationAt)) throw coded('activation_invalid');
  return activationAt;
}

async function writeAudit(admin, action, policy, before) {
  await SupportEmailAuditLog.create({
    adminId: admin && admin._id,
    action,
    targetType: 'ingestion_policy',
    targetId: policy.mailbox,
    metadata: {
      mailbox: policy.mailbox,
      enabled: policy.enabled === true,
      activationAt: policy.activationAt ? new Date(policy.activationAt).toISOString() : null,
      activationLocal: policy.activationAt ? formatActivationLocal(new Date(policy.activationAt)) : '',
      activationTimeZone: ACTIVATION_TIME_ZONE,
      approved: true,
      beforeEnabled: before ? before.enabled === true : undefined,
      beforeActivationAt: before && before.activationAt ? new Date(before.activationAt).toISOString() : undefined
    }
  });
}

async function getPolicy() {
  const doc = await EmailIngestionPolicy.findOne({ mailbox: APPROVED_MAILBOX }).lean();
  return present(doc);
}

async function createPolicy(admin, body = {}) {
  const mailbox = mailboxOf(body);
  const enabled = explicitEnabled(body);
  const activationAt = readActivation(body);
  if (activationAt === undefined) throw coded('activation_missing');
  const existing = await EmailIngestionPolicy.findOne({ mailbox }).select('_id').lean();
  if (existing) throw coded('policy_exists', 409);
  const now = new Date();
  try {
    const doc = await EmailIngestionPolicy.create({
      mailbox,
      enabled: enabled === true,
      activationAt,
      activationTimeZone: ACTIVATION_TIME_ZONE,
      createdBy: admin && admin._id,
      updatedBy: admin && admin._id,
      activationApprovedAt: now,
      activationApprovedBy: admin && admin._id
    });
    await writeAudit(admin, 'ingestion_policy_created', doc, null);
    return present(doc);
  } catch (error) {
    if (error && error.code === 11000) throw coded('policy_exists', 409);
    throw error;
  }
}

async function updatePolicy(admin, body = {}) {
  const mailbox = mailboxOf(body);
  const doc = await EmailIngestionPolicy.findOne({ mailbox });
  if (!doc) throw coded('policy_missing', 404);
  const before = { enabled: doc.enabled === true, activationAt: doc.activationAt };
  const enabled = explicitEnabled(body);
  const activationAt = readActivation(body);
  const boundaryChange = activationAt !== undefined && !sameInstant(before.activationAt, activationAt);
  if (boundaryChange && body.confirmBoundaryChange !== true) throw coded('boundary_change_not_confirmed', 409);
  const enabledChange = enabled !== undefined && enabled !== before.enabled;
  if (!boundaryChange && !enabledChange) return present(doc);

  if (enabledChange) doc.enabled = enabled;
  doc.updatedBy = admin && admin._id;
  if (boundaryChange) {
    doc.activationAt = activationAt;
    doc.activationTimeZone = ACTIVATION_TIME_ZONE;
    doc.activationApprovedAt = new Date();
    doc.activationApprovedBy = admin && admin._id;
  }
  await doc.save();
  await writeAudit(admin, boundaryChange ? 'ingestion_policy_activation_changed' : 'ingestion_policy_updated', doc, before);
  return present(doc);
}

module.exports = {
  APPROVED_MAILBOX,
  ACTIVATION_TIME_ZONE,
  getPolicy,
  createPolicy,
  updatePolicy,
  publicPolicy
};
