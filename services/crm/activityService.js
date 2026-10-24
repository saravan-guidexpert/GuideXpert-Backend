'use strict';

const mongoose = require('mongoose');
const CrmAuditLog = require('../../models/CrmAuditLog');
const CrmAuthAuditLog = require('../../models/CrmAuthAuditLog');
const { CRM_ACCESS_SECTION } = require('../../constants/crmUsers');
const { CrmError } = require('../../utils/crmError');
const { escapeRegex, parseObjectId, parsePageLimit } = require('../../utils/crmHttp');
const { businessAuditScope } = require('./auditService');
const { assignedConsultancyIds } = require('./crmAccess');

const ASSIGNMENT_ACTIONS = Object.freeze(['crm_assignment.created', 'crm_assignment.revoked']);
const AUTHENTICATION_ACTIONS = Object.freeze([
  'crm_user.login_succeeded',
  'crm_user.login_failed',
  'crm_user.login_inactive',
  'crm_user.logout',
  'crm_session.revoked',
  'crm_session.revoked_all',
]);
const NO_MATCH = Object.freeze({ _id: { $exists: false } });
const QUERY_KEYS = Object.freeze([
  'page',
  'limit',
  'from',
  'to',
  'actorId',
  'actorType',
  'action',
  'source',
  'entityType',
  'entityId',
  'consultancyId',
  'q',
]);
const SECRET_KEY = /password|token|otp|secret|authorization|mongodb|connection|cookie|csrf|sessiontoken|resetcode/i;
const SUMMARIES = Object.freeze({
  'consultancy.created': 'Consultancy created.',
  'consultancy.updated': 'Consultancy updated.',
  'contact.created': 'Consultancy contact created.',
  'contact.updated': 'Consultancy contact updated.',
  'contact.deactivated': 'Consultancy contact deactivated.',
  'student.created': 'Student created.',
  'student.updated': 'Student updated.',
  'referral.created': 'Referral recorded.',
  'referral.source_corrected': 'Referral source corrected.',
  'crm_assignment.created': 'Consultancy assignment created.',
  'crm_assignment.revoked': 'Consultancy assignment revoked.',
  'crm_user.created': 'CRM account created.',
  'crm_user.invited': 'CRM account invited.',
  'crm_user.updated': 'CRM account updated.',
  'crm_user.deactivated': 'CRM account deactivated.',
  'crm_user.reset_issued': 'Password reset code issued.',
  'crm_user.password_reset': 'Password reset by an administrator.',
  'crm_user.login_succeeded': 'Sign-in succeeded.',
  'crm_user.login_failed': 'Sign-in failed.',
  'crm_user.login_inactive': 'Sign-in denied for an inactive account.',
  'crm_user.logout': 'Signed out.',
  'crm_session.revoked': 'CRM session revoked.',
  'crm_session.revoked_all': 'CRM sessions revoked.',
  'crm_user.reset_requested': 'Password reset requested.',
  'crm_user.reset_completed': 'Password reset completed.',
  'crm_permission.updated': 'CRM admin access updated.',
  'crm_permission.revoked': 'CRM admin access revoked.',
});

function canViewAccountSecurity(actor) {
  if (!actor) return false;
  if (actor.actorType === 'crm-user') {
    return Array.isArray(actor.permissions) && actor.permissions.includes('crm.roles.manage');
  }
  if (actor.actorType === 'admin') {
    if (actor.isSuperAdmin === true) return true;
    return Array.isArray(actor.sectionAccess) && actor.sectionAccess.includes(CRM_ACCESS_SECTION);
  }
  return false;
}

function andFilters(parts) {
  const present = parts.filter(Boolean);
  if (present.length === 0) return {};
  if (present.length === 1) return present[0];
  return { $and: present };
}

function parseTimestamp(value, label, bound) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new CrmError(400, `${label} is not valid.`, 'invalid_query');
  }
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const suffix = bound === 'to' ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    return new Date(`${text}${suffix}`);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new CrmError(400, `${label} is not a valid UTC timestamp.`, 'invalid_query');
  }
  return parsed;
}

function parseActivityQuery(query) {
  const sourceQuery = query || {};
  if (Object.prototype.hasOwnProperty.call(sourceQuery, 'outcome')) {
    throw new CrmError(400, 'outcome is not stored on audit events.', 'unsupported_filter');
  }
  Object.keys(sourceQuery).forEach((key) => {
    if (!QUERY_KEYS.includes(key)) {
      throw new CrmError(400, `${key} is not a supported activity filter.`, 'unsupported_filter');
    }
  });
  const from = parseTimestamp(sourceQuery.from, 'from', 'from');
  const to = parseTimestamp(sourceQuery.to, 'to', 'to');
  if (from && to && from.getTime() > to.getTime()) {
    throw new CrmError(400, 'from must be before to.', 'invalid_query');
  }
  let source = 'both';
  if (sourceQuery.source != null && sourceQuery.source !== '') {
    if (sourceQuery.source !== 'business' && sourceQuery.source !== 'security') {
      throw new CrmError(400, 'source must be business or security.', 'invalid_query');
    }
    source = sourceQuery.source;
  }
  let actorType = '';
  if (sourceQuery.actorType != null && sourceQuery.actorType !== '') {
    if (sourceQuery.actorType !== 'admin' && sourceQuery.actorType !== 'crm-user') {
      throw new CrmError(400, 'actorType must be admin or crm-user.', 'invalid_query');
    }
    actorType = sourceQuery.actorType;
  }
  let action = '';
  if (sourceQuery.action != null && sourceQuery.action !== '') {
    if (typeof sourceQuery.action !== 'string' || !/^[a-z0-9._]{1,80}$/i.test(sourceQuery.action)) {
      throw new CrmError(400, 'action is not valid.', 'invalid_query');
    }
    action = sourceQuery.action;
  }
  let entityType = '';
  if (sourceQuery.entityType != null && sourceQuery.entityType !== '') {
    if (typeof sourceQuery.entityType !== 'string' || !/^[a-z0-9_]{1,40}$/i.test(sourceQuery.entityType)) {
      throw new CrmError(400, 'entityType is not valid.', 'invalid_query');
    }
    entityType = sourceQuery.entityType;
  }
  if ((entityType || sourceQuery.entityId) && source === 'security') {
    throw new CrmError(400, 'Security events have no entity id.', 'unsupported_filter');
  }
  let q = '';
  if (sourceQuery.q != null && sourceQuery.q !== '') {
    if (typeof sourceQuery.q !== 'string') {
      throw new CrmError(400, 'q is not valid.', 'invalid_query');
    }
    q = sourceQuery.q.trim();
    if (q.length < 2 || q.length > 80) {
      throw new CrmError(400, 'q must be 2–80 characters.', 'invalid_query');
    }
  }
  return {
    from,
    to,
    source,
    actorType,
    actorId: sourceQuery.actorId ? parseObjectId(sourceQuery.actorId, 'Actor id') : null,
    action,
    entityType,
    entityId: sourceQuery.entityId ? parseObjectId(sourceQuery.entityId, 'Entity id') : null,
    consultancyId: sourceQuery.consultancyId ? String(parseObjectId(sourceQuery.consultancyId, 'Consultancy id')) : '',
    q,
  };
}

function actorClause(parsed) {
  if (parsed.actorType === 'admin') {
    return parsed.actorId
      ? { actorAdminId: parsed.actorId }
      : { actorAdminId: { $type: 'objectId' } };
  }
  if (parsed.actorType === 'crm-user') {
    return parsed.actorId
      ? { actorCrmUserId: parsed.actorId }
      : { actorCrmUserId: { $type: 'objectId' } };
  }
  if (parsed.actorId) {
    return { $or: [{ actorAdminId: parsed.actorId }, { actorCrmUserId: parsed.actorId }] };
  }
  return null;
}

function rangeClause(parsed) {
  if (!parsed.from && !parsed.to) return null;
  const createdAt = {};
  if (parsed.from) createdAt.$gte = parsed.from;
  if (parsed.to) createdAt.$lte = parsed.to;
  return { createdAt };
}

function searchClause(parsed) {
  if (!parsed.q) return null;
  const pattern = new RegExp(escapeRegex(parsed.q), 'i');
  return { $or: [{ action: pattern }, { reason: pattern }] };
}

function assignmentClause(idStrings) {
  if (!idStrings.length) return NO_MATCH;
  return {
    action: { $in: ASSIGNMENT_ACTIONS },
    'after.consultancyId': { $in: idStrings },
    $expr: {
      $or: [
        { $eq: [{ $ifNull: ['$before.consultancyId', null] }, null] },
        { $eq: ['$before.consultancyId', '$after.consultancyId'] },
      ],
    },
  };
}

function securityScope(actor, consultancyIds, consultancyConstrained) {
  const unrestricted = consultancyIds == null;
  const idStrings = unrestricted ? [] : consultancyIds.map(String);
  const assignment = unrestricted
    ? { action: { $in: ASSIGNMENT_ACTIONS } }
    : assignmentClause(idStrings);
  if (consultancyConstrained) return assignment;
  if (canViewAccountSecurity(actor)) {
    if (unrestricted) return {};
    return { $or: [assignment, { action: { $nin: ASSIGNMENT_ACTIONS } }] };
  }
  if (unrestricted) return assignment;
  return assignment;
}

// Platform admins are not CRM users and have no consultancy assignments.
// Their business activity stays module-wide, matching the existing /api/admin/crm contract.
// A CRM user only receives business events for consultancies assigned to that user.
// Consultancy-crm staff do not receive authentication events unless they are Super Admin
// or also have crm-access-management.
async function resolveConsultancyIds(actor, consultancyId) {
  const assigned = await assignedConsultancyIds(actor);
  if (!consultancyId) {
    return { consultancyIds: assigned, consultancyConstrained: false };
  }
  if (assigned != null && !assigned.some((id) => String(id) === consultancyId)) {
    throw new CrmError(404, 'Consultancy not found.', 'not_found');
  }
  return {
    consultancyIds: [new mongoose.Types.ObjectId(consultancyId)],
    consultancyConstrained: true,
  };
}

async function authorizedFilters(actor, parsed) {
  const scope = await resolveConsultancyIds(actor, parsed.consultancyId);
  const common = [actorClause(parsed), rangeClause(parsed), searchClause(parsed)];
  if (parsed.action) common.push({ action: parsed.action });
  let business = andFilters([
    await businessAuditScope(scope.consultancyIds),
    ...common,
  ]);
  let security = andFilters([
    securityScope(actor, scope.consultancyIds, scope.consultancyConstrained),
    ...common,
  ]);
  if (parsed.entityType) business = andFilters([business, { entityType: parsed.entityType }]);
  if (parsed.entityId) business = andFilters([business, { entityId: parsed.entityId }]);
  if (parsed.entityType || parsed.entityId) security = NO_MATCH;
  if (parsed.source === 'business') security = NO_MATCH;
  if (parsed.source === 'security') business = NO_MATCH;
  return { business, security };
}

function redactValue(value, depth) {
  const level = depth || 0;
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (level > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, level + 1));
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((key) => {
      if (SECRET_KEY.test(key) || (key.startsWith('_') && key !== '_id')) return;
      out[key] = redactValue(value[key], level + 1);
    });
    return out;
  }
  return null;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffSnapshots(before, after) {
  const beforeObject = before && typeof before === 'object' && !Array.isArray(before) ? before : null;
  const afterObject = after && typeof after === 'object' && !Array.isArray(after) ? after : null;
  if (!beforeObject && !afterObject) return null;
  const keys = new Set([
    ...(beforeObject ? Object.keys(beforeObject) : []),
    ...(afterObject ? Object.keys(afterObject) : []),
  ]);
  const changes = [];
  [...keys].sort().forEach((field) => {
    const hasBefore = Boolean(beforeObject) && Object.prototype.hasOwnProperty.call(beforeObject, field);
    const hasAfter = Boolean(afterObject) && Object.prototype.hasOwnProperty.call(afterObject, field);
    const beforeValue = hasBefore ? beforeObject[field] : null;
    const afterValue = hasAfter ? afterObject[field] : null;
    if (hasBefore && hasAfter && sameValue(beforeValue, afterValue)) return;
    changes.push({
      field,
      before: beforeValue,
      beforeMissing: !hasBefore,
      after: afterValue,
      afterMissing: !hasAfter,
    });
  });
  return changes;
}

function storedId(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value) ? value : null;
}

function snapshotConsultancyId(before, after) {
  const afterId = storedId(after && after.consultancyId);
  const beforeId = storedId(before && before.consultancyId);
  if (beforeId && afterId && beforeId !== afterId) return null;
  return afterId || beforeId || null;
}

function categoryFor(source, action, entityType) {
  if (entityType === 'admin' || action === 'crm_permission.updated' || action === 'crm_permission.revoked') {
    return 'permission';
  }
  if (ASSIGNMENT_ACTIONS.includes(action)) return 'assignment';
  if (AUTHENTICATION_ACTIONS.includes(action)) return 'authentication';
  if (typeof action === 'string' && action.startsWith('crm_user.')) return 'account';
  if (source === 'security') return 'security';
  return 'business';
}

function presentEvent(row, source) {
  const before = redactValue(row.before == null ? null : row.before);
  const after = redactValue(row.after == null ? null : row.after);
  const actorAdminId = row.actorAdminId ? String(row.actorAdminId) : null;
  const actorCrmUserId = row.actorCrmUserId ? String(row.actorCrmUserId) : null;
  let actorType = null;
  let actorId = null;
  if (actorCrmUserId && !actorAdminId) {
    actorType = 'crm-user';
    actorId = actorCrmUserId;
  } else if (actorAdminId && !actorCrmUserId) {
    actorType = 'admin';
    actorId = actorAdminId;
  }
  const entityType = source === 'business' ? row.entityType : null;
  const consultancyId = entityType === 'consultancy' && row.entityId
    ? String(row.entityId)
    : snapshotConsultancyId(before, after);
  return {
    id: String(row._id),
    source,
    createdAt: row.createdAt,
    actorId,
    actorType,
    actorAdminId,
    actorCrmUserId,
    action: row.action,
    category: categoryFor(source, row.action, entityType),
    entityType,
    entityId: source === 'business' && row.entityId ? String(row.entityId) : null,
    targetUserId: source === 'security' && row.targetUserId ? String(row.targetUserId) : null,
    consultancyId,
    outcome: null,
    summary: SUMMARIES[row.action] || row.action,
    reason: row.reason || '',
    changes: diffSnapshots(before, after),
    before,
    after,
    requestId: null,
  };
}

// Offset pages match the other CRM lists. MongoDB sorts and limits the merged
// ids, so the process does not load either collection. A newer insert can shift
// later pages; page numbers are not a stable cursor.
async function pageRows(businessFilter, securityFilter, source, skip, limit) {
  const businessStages = [
    { $match: businessFilter },
    { $project: { createdAt: 1, source: { $literal: 'business' }, sourceRank: { $literal: 0 } } },
  ];
  const securityStages = [
    { $match: securityFilter },
    { $project: { createdAt: 1, source: { $literal: 'security' }, sourceRank: { $literal: 1 } } },
  ];
  let model = CrmAuditLog;
  let pipeline = businessStages;
  if (source === 'security') {
    model = CrmAuthAuditLog;
    pipeline = securityStages;
  } else if (source === 'both') {
    pipeline = businessStages.concat([
      { $unionWith: { coll: 'crmAuthAuditLogs', pipeline: securityStages } },
    ]);
  }
  pipeline.push(
    { $sort: { createdAt: -1, sourceRank: 1, _id: -1 } },
    { $skip: skip },
    { $limit: limit }
  );
  return model.aggregate(pipeline);
}

async function countRows(source, businessFilter, securityFilter) {
  if (source === 'business') return CrmAuditLog.countDocuments(businessFilter);
  if (source === 'security') return CrmAuthAuditLog.countDocuments(securityFilter);
  const [businessCount, securityCount] = await Promise.all([
    CrmAuditLog.countDocuments(businessFilter),
    CrmAuthAuditLog.countDocuments(securityFilter),
  ]);
  return businessCount + securityCount;
}

async function loadScoped(model, ids, filter) {
  if (!ids.length) return [];
  return model.find(andFilters([filter, { _id: { $in: ids } }])).lean();
}

async function listActivity(query, actor) {
  const { page, limit, skip } = parsePageLimit(query);
  const parsed = parseActivityQuery(query);
  const filters = await authorizedFilters(actor, parsed);
  const [rows, total] = await Promise.all([
    pageRows(filters.business, filters.security, parsed.source, skip, limit),
    countRows(parsed.source, filters.business, filters.security),
  ]);
  const businessIds = rows.filter((row) => row.source === 'business').map((row) => row._id);
  const securityIds = rows.filter((row) => row.source === 'security').map((row) => row._id);
  const [businessDocs, securityDocs] = await Promise.all([
    loadScoped(CrmAuditLog, businessIds, filters.business),
    loadScoped(CrmAuthAuditLog, securityIds, filters.security),
  ]);
  const byId = new Map();
  businessDocs.forEach((doc) => byId.set(`business:${String(doc._id)}`, presentEvent(doc, 'business')));
  securityDocs.forEach((doc) => byId.set(`security:${String(doc._id)}`, presentEvent(doc, 'security')));
  return {
    items: rows.map((row) => byId.get(`${row.source}:${String(row._id)}`)).filter(Boolean),
    page,
    limit,
    total,
    order: 'createdAt_desc,source_asc,id_desc',
  };
}

async function getActivity(source, id, actor) {
  if (source !== 'business' && source !== 'security') {
    throw new CrmError(404, 'Activity event not found.', 'not_found');
  }
  const eventId = parseObjectId(id, 'Activity id');
  const filters = await authorizedFilters(actor, {
    from: null,
    to: null,
    source,
    actorType: '',
    actorId: null,
    action: '',
    entityType: '',
    entityId: null,
    consultancyId: '',
    q: '',
  });
  const model = source === 'business' ? CrmAuditLog : CrmAuthAuditLog;
  const filter = source === 'business' ? filters.business : filters.security;
  const doc = await model.findOne(andFilters([filter, { _id: eventId }])).lean();
  if (!doc) throw new CrmError(404, 'Activity event not found.', 'not_found');
  return presentEvent(doc, source);
}

function actionCount(rows, name) {
  const found = rows.find((row) => row._id === name);
  return found ? found.count : 0;
}

async function activityScope(query, actor) {
  return authorizedFilters(actor, parseActivityQuery(query || {}));
}

async function summarizeActivity(query, actor) {
  const sourceQuery = { ...(query || {}) };
  if (Object.prototype.hasOwnProperty.call(sourceQuery, 'page')) {
    throw new CrmError(400, 'page is not a supported activity summary filter.', 'unsupported_filter');
  }
  if (Object.prototype.hasOwnProperty.call(sourceQuery, 'limit')) {
    const limit = Number(sourceQuery.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new CrmError(400, 'limit must be an integer from 1 to 20.', 'invalid_query');
    }
    delete sourceQuery.limit;
  }
  const recentLimit = query && query.limit != null && query.limit !== '' ? Number(query.limit) : 10;
  const filters = await activityScope(sourceQuery, actor);
  const accountEventsIncluded = canViewAccountSecurity(actor);
  const [businessTotal, securityTotal, businessActions, securityActions, recent] = await Promise.all([
    CrmAuditLog.countDocuments(filters.business),
    CrmAuthAuditLog.countDocuments(filters.security),
    CrmAuditLog.aggregate([{ $match: filters.business }, { $group: { _id: '$action', count: { $sum: 1 } } }]),
    CrmAuthAuditLog.aggregate([{ $match: filters.security }, { $group: { _id: '$action', count: { $sum: 1 } } }]),
    listActivity({ ...sourceQuery, page: '1', limit: String(recentLimit) }, actor),
  ]);
  const byAction = (rows) => rows
    .map((row) => ({ action: row._id, count: row.count }))
    .sort((left, right) => right.count - left.count || String(left.action).localeCompare(String(right.action)));
  return {
    visibility: 'visible_to_caller',
    accountEventsIncluded,
    order: recent.order,
    business: { total: businessTotal, byAction: byAction(businessActions) },
    security: {
      total: securityTotal,
      byAction: byAction(securityActions),
      signInFailed: accountEventsIncluded ? actionCount(securityActions, 'crm_user.login_failed') : null,
      signInInactive: accountEventsIncluded ? actionCount(securityActions, 'crm_user.login_inactive') : null,
      sessionRevocations: accountEventsIncluded
        ? actionCount(securityActions, 'crm_session.revoked') + actionCount(securityActions, 'crm_session.revoked_all')
        : null,
      assignmentCreated: actionCount(securityActions, 'crm_assignment.created'),
      assignmentRevoked: actionCount(securityActions, 'crm_assignment.revoked'),
    },
    recent: recent.items,
  };
}

module.exports = {
  listActivity,
  getActivity,
  summarizeActivity,
  activityScope,
  canViewAccountSecurity,
};
